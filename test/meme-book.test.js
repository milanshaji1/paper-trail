import test from "node:test";
import assert from "node:assert/strict";
import { emptyBook, openPosition, markToMarket, summary, RULES } from "../lib/meme/book.js";

const cand = (over = {}) => ({
  token: { network: "solana", mint: "MINT1", symbol: "AAA", poolAddress: "POOL1", priceUsd: 1, url: "u", ...over.token },
  scored: { score: 75, band: "high", ...over.scored },
  safety: { details: { provider: "rugcheck" } },
});

test("an alert opens one simulated position, and only one", () => {
  const b = emptyBook();
  assert.ok(openPosition(b, cand()));
  assert.equal(openPosition(b, cand()), null, "must not double-open the same token");
  assert.equal(b.open.length, 1);
  assert.equal(b.open[0].entryPrice, 1);
});

test("a position with no usable price is never opened", () => {
  const b = emptyBook();
  assert.equal(openPosition(b, cand({ token: { priceUsd: 0 } })), null);
  assert.equal(b.open.length, 0);
});

test("hitting the target closes the position as a win", () => {
  const b = emptyBook();
  openPosition(b, cand());
  markToMarket(b, new Map([["solana:MINT1", 1 + RULES.targetPct / 100 + 0.01]]));
  assert.equal(b.open.length, 0);
  assert.equal(b.closed.length, 1);
  assert.equal(b.closed[0].reason, "target");
  assert.equal(b.closed[0].win, true);
});

test("hitting the stop closes the position as a loss", () => {
  const b = emptyBook();
  openPosition(b, cand());
  markToMarket(b, new Map([["solana:MINT1", 0.5]])); // -50%, past the -40% stop
  assert.equal(b.closed[0].reason, "stop");
  assert.equal(b.closed[0].win, false);
  assert.ok(b.closed[0].netPct < -40, "costs make the net loss worse than the gross");
});

test("costs are charged on both sides, so a flat trade loses money", () => {
  const b = emptyBook();
  openPosition(b, cand());
  const now = Date.now() + (RULES.maxHoldHours + 1) * 3.6e6;
  markToMarket(b, new Map([["solana:MINT1", 1]]), now); // exits flat on time
  const c = b.closed[0];
  assert.equal(c.grossPct, 0);
  assert.ok(c.netPct < 0, `flat gross must net negative, got ${c.netPct}`);
  assert.ok(Math.abs(c.netPct + 2 * RULES.costPctPerSide) < 1.5, "≈ two sides of cost");
});

test("the time stop fires and records the hold duration", () => {
  const b = emptyBook();
  openPosition(b, cand());
  const later = Date.now() + (RULES.maxHoldHours + 2) * 3.6e6;
  markToMarket(b, new Map([["solana:MINT1", 1.2]]), later);
  assert.equal(b.closed[0].reason, "time");
  assert.ok(b.closed[0].holdHours >= RULES.maxHoldHours);
});

test("a position that can no longer be priced is closed, not silently dropped", () => {
  const b = emptyBook();
  openPosition(b, cand());
  const later = Date.now() + (RULES.maxHoldHours + 1) * 3.6e6;
  markToMarket(b, new Map(), later); // pool gone — no quote at all
  assert.equal(b.open.length, 0);
  assert.equal(b.closed[0].reason, "unpriceable");
});

test("peak price is tracked so a good signal with a bad exit is distinguishable", () => {
  const b = emptyBook();
  openPosition(b, cand());
  markToMarket(b, new Map([["solana:MINT1", 2.2]])); // +120%, under the target
  markToMarket(b, new Map([["solana:MINT1", 0.5]])); // round-trips into the stop
  const c = b.closed[0];
  assert.equal(c.reason, "stop");
  assert.ok(c.mfePct >= 100, `MFE should record the +120% it offered, got ${c.mfePct}`);
  assert.ok(c.netPct < 0, "but the realised result is still a loss");
});

test("summary refuses to claim significance on a thin sample", () => {
  const b = emptyBook();
  openPosition(b, cand());
  markToMarket(b, new Map([["solana:MINT1", 0.5]]));
  const s = summary(b);
  assert.equal(s.closedCount, 1);
  assert.equal(s.significant, false, "one trade is not a track record");
  assert.equal(s.simulated, true);
});

test("summary reports win rate, medians and exit-reason mix", () => {
  const b = emptyBook();
  for (let i = 0; i < 4; i++) {
    openPosition(b, cand({ token: { mint: `M${i}` }, scored: { band: i < 2 ? "high" : "medium", score: 60 } }));
  }
  // Two winners, two losers.
  markToMarket(b, new Map([["solana:M0", 3], ["solana:M1", 0.4], ["solana:M2", 3], ["solana:M3", 0.4]]));
  const s = summary(b);
  assert.equal(s.closedCount, 4);
  assert.equal(s.winRate, 50);
  assert.equal(s.exitReasons.target, 2);
  assert.equal(s.exitReasons.stop, 2);
  assert.equal(s.byBand.high.n, 2);
  assert.equal(s.byBand.medium.n, 2);
});

test("open positions report unrealised P&L without closing", () => {
  const b = emptyBook();
  openPosition(b, cand());
  markToMarket(b, new Map([["solana:MINT1", 1.5]])); // +50%, between stop and target
  const s = summary(b);
  assert.equal(s.openCount, 1);
  assert.equal(s.closedCount, 0);
  assert.equal(s.open[0].unrealisedPct, 50);
});
