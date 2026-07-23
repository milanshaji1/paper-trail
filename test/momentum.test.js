// Tests for the cross-sectional momentum engine (H1), written BEFORE the impl.
// Same load-bearing guard as the other backtester: a decision at time t must be
// provably blind to t+1 — and here also blind to the skipped recent month.
import { test } from "node:test";
import assert from "node:assert/strict";

import { formationReturn, rankByMomentum, runMomentumBacktest, LOOKBACK, SKIP } from "../lib/momentum.js";

const WEEK = 7 * 864e5;
// Deterministic weekly series.
function bars(n, fn) {
  return Array.from({ length: n }, (_, i) => ({ t: Date.UTC(2016, 0, 4) + i * WEEK, c: fn(i) }));
}
const flat = (n = 120) => bars(n, () => 100);
const riser = (n = 120, rate = 1) => bars(n, (i) => 100 + i * rate);

// ---------- formationReturn ----------
test("formationReturn measures lookback→skip window, not the recent month", () => {
  // Flat for the formation window, then a spike ONLY in the skipped last 4 weeks.
  const b = bars(120, (i) => (i >= 116 ? 500 : 100));
  const r = formationReturn(b, 119);
  // The spike lives inside the skip window, so momentum must not see it.
  assert.equal(r, 0);
});

test("formationReturn is positive for a stock that rose during the formation window", () => {
  const b = riser(120, 1);
  const r = formationReturn(b, 119);
  // from i-52-4=63 (c=163) to i-4=115 (c=215)
  assert.ok(Math.abs(r - ((215 - 163) / 163) * 100) < 1e-9);
});

test("formationReturn returns null before enough history", () => {
  assert.equal(formationReturn(riser(120), LOOKBACK + SKIP - 1), null);
  assert.ok(formationReturn(riser(120), LOOKBACK + SKIP) !== null);
});

test("look-ahead guard: rewriting FUTURE bars cannot change momentum at t", () => {
  const b = riser(120);
  const i = 100;
  const before = formationReturn(b, i);
  const tampered = b.map((x, j) => (j > i ? { ...x, c: x.c * 99 } : x));
  assert.equal(formationReturn(tampered, i), before);
});

// ---------- ranking ----------
test("rankByMomentum orders strongest-first and drops stocks lacking history", () => {
  const books = [
    { symbol: "SLOW", bars: riser(120, 0.2) },
    { symbol: "FAST", bars: riser(120, 3) },
    { symbol: "NEW", bars: riser(20, 5) }, // too short — must be excluded
  ];
  const ranked = rankByMomentum(books, 119);
  assert.deepEqual(ranked.map((r) => r.symbol), ["FAST", "SLOW"]);
  assert.ok(ranked[0].momentum > ranked[1].momentum);
});

// ---------- backtest ----------
const universe = (n = 20) =>
  Array.from({ length: n }, (_, k) => ({
    symbol: `S${k}`, name: `Stock ${k}`,
    // staggered growth rates so ranking is unambiguous
    bars: riser(160, 0.2 + k * 0.15),
  }));

test("runMomentumBacktest holds exactly topN names, equal-weight", () => {
  const r = runMomentumBacktest({ books: universe(20), benchmarkBars: riser(160, 1), topN: 5 });
  assert.equal(r.holdings.length, 5);
  const values = r.holdings.map((h) => h.qty * h.lastPrice);
  const spread = Math.max(...values) - Math.min(...values);
  assert.ok(spread / Math.max(...values) < 0.35, "positions should be roughly equal-weight");
});

test("runMomentumBacktest picks the strongest names, not the weakest", () => {
  const r = runMomentumBacktest({ books: universe(20), benchmarkBars: riser(160, 1), topN: 3 });
  // S19/S18/S17 grow fastest by construction
  assert.deepEqual(r.holdings.map((h) => h.symbol).sort(), ["S17", "S18", "S19"]);
});

test("runMomentumBacktest reports rebalances, metrics and a benchmark comparison", () => {
  const r = runMomentumBacktest({ books: universe(20), benchmarkBars: riser(160, 1), topN: 5 });
  assert.ok(r.rebalances > 1);
  assert.ok(r.finalEquity > 0);
  assert.equal(typeof r.metrics.totalReturnPct, "number");
  assert.ok("vsBenchmarkPct" in r);
  assert.ok(r.equityHistory.length > 1);
});

test("fees make a zero-alpha (flat) universe lose money", () => {
  const books = Array.from({ length: 10 }, (_, k) => ({ symbol: `F${k}`, name: `F${k}`, bars: flat(160) }));
  const r = runMomentumBacktest({ books, benchmarkBars: flat(160), topN: 3 });
  assert.ok(r.metrics.totalReturnPct <= 0, "flat prices + fees cannot make money");
});

test("runMomentumBacktest is deterministic", () => {
  const args = { books: universe(20), benchmarkBars: riser(160, 1), topN: 5 };
  assert.deepEqual(runMomentumBacktest(args).metrics, runMomentumBacktest(args).metrics);
});

test("runMomentumBacktest warns instead of lying when history is too short", () => {
  const r = runMomentumBacktest({ books: [{ symbol: "X", name: "X", bars: riser(30) }], benchmarkBars: riser(30) });
  assert.equal(r.rebalances, 0);
  assert.ok(r.warning);
});
