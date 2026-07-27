// Tests for the historical backtest engine (written BEFORE the implementation).
// The test that matters most here is the look-ahead guard: a decision on day t
// must be provably unable to see day t+1. Every other number is worthless if
// that one fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildQuoteAt, WARMUP, runBacktest, buyAndHold } from "../lib/backtest.js";

// ---------- fixtures ----------
const DAY = 864e5;
// Deterministic synthetic series: a steady uptrend with a shallow wobble.
function series(n = 400, { start = 100, drift = 0.3, wobble = 4 } = {}) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    bars.push({
      t: Date.UTC(2024, 0, 1) + i * DAY,
      c: start + i * drift + Math.sin(i / 7) * wobble,
      v: 1_000_000 + (i % 5) * 10_000,
    });
  }
  return bars;
}
const meta = { symbol: "TEST", name: "Test Corp" };

// ---------- look-ahead guard (the one that matters) ----------
test("a quote at day t is unchanged when FUTURE bars are altered", () => {
  const bars = series();
  const i = 300;
  const before = buildQuoteAt(bars, i, meta);

  // Violently rewrite everything after day i — a look-ahead bug would notice.
  const tampered = bars.map((b, j) => (j > i ? { ...b, c: b.c * 10, v: b.v * 50 } : b));
  const after = buildQuoteAt(tampered, i, meta);

  assert.deepEqual(after, before);
});

test("a quote at day t DOES change when past bars are altered (guard is not vacuous)", () => {
  const bars = series();
  const i = 300;
  const before = buildQuoteAt(bars, i, meta);
  const tampered = bars.map((b, j) => (j < i ? { ...b, c: b.c * 0.5 } : b));
  const after = buildQuoteAt(tampered, i, meta);
  assert.notDeepEqual(after, before);
});

test("quote uses only bars up to i for price", () => {
  const bars = series();
  const q = buildQuoteAt(bars, 250, meta);
  assert.equal(q.price, bars[250].c);
});

// ---------- warmup ----------
test("returns null before warmup (not enough history for SMA200)", () => {
  const bars = series();
  assert.equal(buildQuoteAt(bars, 10, meta), null);
  assert.equal(buildQuoteAt(bars, WARMUP - 1, meta), null);
  assert.ok(buildQuoteAt(bars, WARMUP, meta));
});

// ---------- quote shape (what PaperEngine needs) ----------
test("quote carries the fields the paper engine consumes", () => {
  const q = buildQuoteAt(series(), 300, meta);
  for (const k of ["symbol", "name", "price", "sma50", "conviction", "entry"]) {
    assert.ok(k in q, `missing ${k}`);
  }
  assert.ok(q.conviction.rating >= 1 && q.conviction.rating <= 5);
  assert.equal(q.isCrypto, false);
});

test("no look-ahead into fundamentals: quality/value/analyst are never scored", () => {
  const q = buildQuoteAt(series(), 300, meta);
  // Historical fundamentals + analyst consensus aren't available, so scoring
  // them would mean using today's data on old prices — cheating.
  assert.equal(q.conviction.sub.quality, null);
  assert.equal(q.conviction.sub.value, null);
  assert.equal(q.conviction.analystIncluded, false);
});

// ---------- buyAndHold benchmark ----------
test("buyAndHold measures first-to-last close, net of one round trip of fees", () => {
  const bars = [
    { t: 1, c: 100, v: 1 }, { t: 2, c: 150, v: 1 }, { t: 3, c: 200, v: 1 },
  ];
  const r = buyAndHold(bars, 0, 2);
  // +100% gross, minus ~0.2% round-trip fees
  assert.ok(r.returnPct > 99 && r.returnPct < 100, `got ${r.returnPct}`);
});

test("buyAndHold on a flat series returns slightly negative (fees are real)", () => {
  const bars = [{ t: 1, c: 100, v: 1 }, { t: 2, c: 100, v: 1 }];
  assert.ok(buyAndHold(bars, 0, 1).returnPct < 0);
});

// ---------- full replay ----------
test("runBacktest replays an uptrend and reports coherent metrics", () => {
  const bars = series(400);
  const r = runBacktest({
    symbols: [{ ...meta, bars }],
    benchmarkBars: bars,
    startingCash: 100_000,
    risk: "high",
  });
  assert.ok(r.days > 0, "should have traded some days");
  assert.ok(r.finalEquity > 0);
  assert.equal(typeof r.metrics.totalReturnPct, "number");
  assert.ok(r.benchmark.returnPct > 0, "uptrend benchmark should be positive");
  assert.ok("vsBenchmarkPct" in r, "must report performance against buy-and-hold");
  assert.ok(Array.isArray(r.equityHistory) && r.equityHistory.length > 1);
});

test("runBacktest on a downtrend never opens a position (rules refuse it)", () => {
  const down = series(400, { drift: -0.3 });
  const r = runBacktest({ symbols: [{ symbol: "DWN", name: "Down", bars: down }], benchmarkBars: down });
  assert.equal(r.metrics.trades + r.openAtEnd, 0);
});

test("runBacktest is deterministic — same input, same result", () => {
  const bars = series(400);
  const args = { symbols: [{ ...meta, bars }], benchmarkBars: bars };
  assert.deepEqual(runBacktest(args).metrics, runBacktest(args).metrics);
});

test("runBacktest refuses a universe with no usable history", () => {
  const r = runBacktest({ symbols: [{ symbol: "X", name: "X", bars: series(20) }], benchmarkBars: series(20) });
  assert.equal(r.days, 0);
  assert.ok(r.warning, "should explain why nothing ran");
});
