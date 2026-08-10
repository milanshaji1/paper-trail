#!/usr/bin/env node
// The watcher. Fetch → dedupe → score → alert → persist.
//
//   node scripts/djt-watch.js --dry-run   # fetch and score, send nothing
//   node scripts/djt-watch.js --verbose   # show every post considered
//   node scripts/djt-watch.js             # live
//
// Designed to be run from cron (GitHub Actions every 5 min). Exits non-zero
// only on a total failure — a single dead source is logged, not fatal.

import { fetchAll } from "../lib/djt/sources.js";
import { scorePost, marketSession, BAND_MEDIUM } from "../lib/djt/impact.js";
import { detectLaunch, confirmMarket } from "../lib/djt/launch.js";
import * as state from "../lib/djt/state.js";
import * as notify from "../lib/djt/notify.js";

const flags = new Set(process.argv.slice(2));
const DRY = flags.has("--dry-run");
const VERBOSE = flags.has("--verbose");

const log = (m) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);

const s = state.load();
const bootstrap = state.isBootstrap(s);

const { posts, meta, errors, unchanged } = await fetchAll(s.meta);
s.meta = meta;

for (const e of errors) log(`⚠ ${e}`);
if (!posts.length && !errors.length) {
  log(unchanged ? "no change since last poll (304)" : "no posts returned");
}

// The RSS feeds carry a rolling window that can span weeks. Without an age
// guard, any loss of state would fire a burst of three-week-old proclamations
// as if they had just happened.
const MAX_AGE_MS = Number(process.env.DJT_MAX_AGE_H || 48) * 3.6e6;

const unseen = posts.filter((p) => state.isNew(s, p));
const fresh = unseen.filter((p) => Date.now() - p.ts <= MAX_AGE_MS);
const stale = unseen.length - fresh.length;
log(
  `${posts.length} fetched · ${fresh.length} new` +
  `${stale ? ` · ${stale} skipped as stale (>${MAX_AGE_MS / 3.6e6}h)` : ""}` +
  `${unchanged ? " · archive unchanged" : ""}`
);

// First ever run: adopt the current window as history rather than firing a
// notification for every post in the backlog.
if (bootstrap) {
  state.markSeen(s, posts);
  s.recentTexts = posts.slice(0, 60).map((p) => p.text);
  s.lastRun = Date.now();
  if (!DRY) log(`bootstrapped with ${posts.length} posts — no alerts sent on first run`);
  state.prune(s);
  if (!DRY) state.save(s);
  process.exit(0);
}

const recentTexts = s.recentTexts || [];
const alerts = [];
let sent = 0;
let sentLaunches = 0;
const retry = [];

const launches = [];

for (const post of fresh) {
  const scored = scorePost(post, { recentTexts });
  const session = marketSession(post.ts);

  // A contract address or launchpad link in a presidential post is
  // categorically alert-worthy — it bypasses the scoring bands entirely, since
  // "My NEW Official Trump Meme is HERE" scores near zero on policy mechanisms.
  const launch = detectLaunch(post.text);
  if (launch.found) {
    log(`  [LAUNCH] ${launch.confidence} — ${launch.reasons.join(" | ")}`);
    launches.push({ post, launch, session });
    continue;
  }

  if (VERBOSE || scored.score >= BAND_MEDIUM) {
    log(`  [${String(scored.score).padStart(3)}] ${scored.band.padEnd(6)} ${post.sourceLabel} — ${post.text.replace(/\s+/g, " ").slice(0, 90)}`);
  }
  if (scored.score >= BAND_MEDIUM) alerts.push({ post, scored, session });
}

// Launches go out first and on their own path.
for (const l of launches) {
  // Best-effort market confirmation; never blocks or gates the alert.
  l.market = l.launch.addresses.length
    ? await confirmMarket(l.launch.addresses[0]).catch(() => ({ live: false }))
    : { live: false };

  if (DRY) {
    process.stdout.write(`\n--- would send (LAUNCH) ---\n${notify.formatLaunchAlert(l)}\n`);
    continue;
  }
  const r = await notify.sendLaunchAlert(l);
  if (r.sent) sentLaunches++;
  else {
    log(`⚠ launch send failed: ${r.reason}`);
    if (r.retryable) retry.push(l.post.id);
  }
  state.recordAlert(s, {
    id: l.post.id, ts: l.post.ts, source: l.post.source, sourceLabel: l.post.sourceLabel,
    url: l.post.url, text: l.post.text.slice(0, 600), session: l.session,
    score: 100, band: "high", kind: "launch",
    launch: { confidence: l.launch.confidence, addresses: l.launch.addresses, cashtags: l.launch.cashtags },
    market: l.market, why: l.launch.reasons,
    components: {}, named: [], bullish: [], bearish: [], mechanisms: [], direction: "n/a",
  });
}

// Oldest first, so a burst arrives in the order he actually posted it.
alerts.reverse();

for (const a of alerts) {
  if (DRY) {
    process.stdout.write(`\n--- would send ---\n${notify.formatAlert(a)}\n`);
    continue;
  }
  const r = await notify.sendAlert(a);
  if (r.sent) sent++;
  else {
    log(`⚠ send failed: ${r.reason}`);
    // A transient Telegram failure must not cost us the alert. Leaving the id
    // unseen means the next cycle retries it; the 48h staleness guard bounds
    // how long that can go on, so a sustained outage cannot loop forever.
    if (r.retryable) retry.push(a.post.id);
  }

  state.recordAlert(s, {
    id: a.post.id,
    ts: a.post.ts,
    source: a.post.source,
    sourceLabel: a.post.sourceLabel,
    url: a.post.url,
    text: a.post.text.slice(0, 600),
    session: a.session,
    score: a.scored.score,
    band: a.scored.band,
    components: a.scored.components,
    named: a.scored.named,
    bullish: a.scored.bullish,
    bearish: a.scored.bearish,
    mechanisms: a.scored.mechanisms,
    direction: a.scored.direction,
    why: a.scored.why,
  });
}

log(`${launches.length} launch · ${alerts.length} alert-worthy · ${DRY ? "0 sent (dry run)" : `${sent + sentLaunches} sent`}`);

if (!DRY) {
  state.markSeen(s, posts);
  for (const id of retry) delete s.seen[id]; // re-offer on the next cycle
  if (retry.length) log(`${retry.length} alert(s) held for retry`);
  s.recentTexts = [...fresh.map((p) => p.text), ...recentTexts].filter(Boolean).slice(0, 60);
  s.lastRun = Date.now();
  s.stats = {
    lastFetched: posts.length,
    lastNew: fresh.length,
    lastAlerts: alerts.length,
    lastLaunches: launches.length,
    errors,
    telegram: notify.configured() ? "configured" : "not configured",
  };
  state.prune(s);
  log(`state → ${state.save(s)}`);
}

// Every source down is a real failure worth a red run in Actions.
if (errors.length === 3) process.exit(1);
