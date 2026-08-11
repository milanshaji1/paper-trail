#!/usr/bin/env node
// Memecoin early-momentum radar.
//
//   node scripts/meme-watch.js --dry-run    # score + gate, send nothing
//   node scripts/meme-watch.js --show-all   # include everything the gate rejected
//   node scripts/meme-watch.js              # live
//
// Order matters: cheap local filters first, then momentum scoring, and only
// then the safety gate — RugCheck is free and rate-limited, so we spend those
// calls only on tokens that already look interesting.

// Load .env before anything reads process.env. Without this the watcher
// runs fine but silently never sends: GitHub Actions injects secrets as real
// environment variables, so the gap only ever shows up locally.
import "../lib/config.js";
import { fetchCandidates, fetchBoosted, fetchBizChatter, fetchQuotes } from "../lib/meme/sources.js";
import * as book from "../lib/meme/book.js";
import { scoreToken, BANDS } from "../lib/meme/momentum.js";
import { checkAll, LIMITS, canVerify } from "../lib/meme/safety.js";
import * as state from "../lib/meme/state.js";
import * as notify from "../lib/meme/notify.js";

const flags = new Set(process.argv.slice(2));
const DRY = flags.has("--dry-run");
const SHOW_ALL = flags.has("--show-all");

const log = (m) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);

const s = state.load();
log(`telegram: ${notify.configured() ? "configured" : "NOT configured — alerts will not be delivered"}`);

const [{ tokens, errors }, boosted, { counts: chatter, ok: chatterOk }] = await Promise.all([
  fetchCandidates(),
  fetchBoosted(),
  fetchBizChatter(),
]);
if (!chatterOk) log("⚠ /biz/ chatter unavailable — earliness bonus withheld this run");
for (const e of errors) log(`⚠ ${e}`);
log(`${tokens.length} pools · ${boosted.size} boosted · ${chatter.size} /biz/ tickers${chatterOk ? "" : " (FETCH FAILED)"}`);

if (!tokens.length) {
  log("no pools returned — nothing to do");
  process.exit(errors.length ? 1 : 0);
}

// --- Paper book: mark open positions BEFORE opening new ones ---------------
// Prices come free from the pools we already fetched; only positions that have
// fallen out of new/trending need a lookup, and those are disproportionately
// the ones going to zero, so they are exactly the ones worth paying for.
s.book = s.book || book.emptyBook();
const priceMap = new Map(tokens.filter((t) => t.priceUsd > 0).map((t) => [`${t.network}:${t.mint}`, t.priceUsd]));
const stale = s.book.open.filter((p) => !priceMap.has(p.key));
let unmarked = 0;
if (stale.length) {
  const q = await fetchQuotes(stale);
  for (const [k, v] of q.prices) priceMap.set(k, v);
  unmarked = q.unmarked;
}
const exits = book.markToMarket(s.book, priceMap);
for (const e of exits) log(`  📕 closed ${e.pos.symbol} — ${e.reason}`);
if (unmarked) log(`  ⚠ ${unmarked} open position(s) could not be priced this cycle`);

// --- Cheap pre-filter: don't spend a safety call on something unfundable ----
const prefiltered = tokens.filter((t) => {
  if (!t.mint) return false;
  if (t.liquidityUsd < LIMITS.minLiquidityUsd) return false;
  if (t.volume.h1 <= 0) return false;
  const ageH = t.createdAt ? (Date.now() - t.createdAt) / 3.6e6 : 999;
  return ageH <= Number(process.env.MEME_MAX_AGE_H || 168); // a week
});

const scored = prefiltered
  .map((t) => ({ token: t, scored: scoreToken(t, { chatter, chatterOk, boosted }) }))
  .sort((a, b) => b.scored.score - a.scored.score);

const interesting = scored.filter((c) => c.scored.score >= BANDS.medium);
log(`${prefiltered.length} passed pre-filter · ${interesting.length} scored >= ${BANDS.medium}`);

// --- Safety gate ------------------------------------------------------------
const SAFETY_BUDGET = Number(process.env.MEME_SAFETY_BUDGET || 12);
const checked = await checkAll(interesting.map((c) => c.token), { max: SAFETY_BUDGET });
// Key by network+mint: the same address can exist on two EVM chains, and a
// bare-mint key would let one chain's verdict stand in for the other's.
const key = (t) => `${t.network}:${t.mint}`;
const safetyByToken = new Map(checked.map((c) => [key(c.token), c.safety]));

const passed = [];
const rejected = [];
const unchecked = [];
for (const c of interesting) {
  const safety = safetyByToken.get(key(c.token));
  if (!safety) { unchecked.push(c); continue; }
  (safety.pass ? passed : rejected).push({ ...c, safety });
}

log(
  `safety: ${passed.length} passed · ${rejected.length} rejected` +
  // Never let candidates vanish silently — an unchecked token is not a safe
  // one, and if this number is routinely non-zero the budget is too small.
  (unchecked.length ? ` · ${unchecked.length} UNCHECKED (budget ${SAFETY_BUDGET}, re-seen next cycle)` : "")
);
for (const c of unchecked) log(`  ? ${(c.token.symbol || "?").padEnd(12)} scored ${c.scored.score}, not verified this run`);
for (const r of rejected) {
  log(`  ✗ ${(r.token.symbol || "?").padEnd(12)} ${r.safety.reasons[0]}`);
}
if (SHOW_ALL) {
  for (const r of rejected) log(`     all reasons: ${r.safety.reasons.join(" | ")}`);
}

// --- Alert ------------------------------------------------------------------
let sent = 0;
const fresh = passed.filter((c) => state.shouldAlert(s, key(c.token), c.scored.band));
log(`${fresh.length} past cooldown`);

for (const c of fresh) {
  if (DRY) {
    process.stdout.write(`\n--- would send ---\n${notify.formatAlert(c)}\n`);
    continue;
  }
  const r = await notify.sendAlert(c);
  if (r.sent) { sent++; state.recordAlert(s, key(c.token), c.scored.band, c.scored.score); }
  else log(`⚠ send failed: ${r.reason}`);

  // Every alert is graded, whether or not the notification got through — the
  // record is of what the radar claimed, not of what Telegram delivered.
  if (book.openPosition(s.book, c)) log(`  📗 opened SIM position ${c.token.symbol} @ $${c.token.priceUsd}`);
}

log(`${DRY ? "0 sent (dry run)" : `${sent} sent`}`);

const bk = book.summary(s.book);
log(
  `book[SIM]: ${bk.openCount} open · ${bk.closedCount} closed` +
  (bk.closedCount ? ` · win ${bk.winRate}% · median ${bk.medianReturnPct}%` : "") +
  (bk.closedCount && !bk.significant ? " (too few trades to mean anything)" : "")
);

if (!DRY) {
  state.setBoard(
    s,
    passed.map((c) => ({
      mint: c.token.mint, symbol: c.token.symbol, name: c.token.name,
      network: c.token.network, dex: c.token.dex, url: c.token.url,
      liquidityUsd: c.token.liquidityUsd, fdvUsd: c.token.fdvUsd,
      volumeH1: c.token.volume.h1, priceChange: c.token.priceChange,
      score: c.scored.score, band: c.scored.band, components: c.scored.components,
      metrics: c.scored.metrics, why: c.scored.why, flags: c.scored.flags,
      safety: c.safety.details, ts: Date.now(),
    })),
    rejected.map((c) => ({
      mint: c.token.mint, symbol: c.token.symbol, network: c.token.network,
      score: c.scored.score, reasons: c.safety.reasons, ts: Date.now(),
    }))
  );
  s.lastRun = Date.now();
  s.stats = {
    pools: tokens.length,
    prefiltered: prefiltered.length,
    interesting: interesting.length,
    passedSafety: passed.length,
    rejectedSafety: rejected.length,
    alerted: sent,
    errors,
    telegram: notify.configured() ? "configured" : "not configured",
    unmarkedPositions: unmarked,
  };
  s.bookSummary = book.summary(s.book);
  state.prune(s);
  log(`state → ${state.save(s)}`);
}
