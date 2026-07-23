// Historical backtest engine.
//
// Replays real daily bars through the SAME decision logic the live autopilot
// uses (lib/paper.js), so the question "do these signals actually work?" gets
// answered from history instead of waiting months for forward results.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: no look-ahead. Every decision at day t
// is computed from bars[0..t] only. `buildQuoteAt` is pure and slices the past;
// a test proves that rewriting future bars cannot change a past decision.
//
// Honest limitations, by construction:
//   - Technical signals only. Historical fundamentals and analyst consensus
//     aren't available to us, and using TODAY's values on OLD prices would be
//     cheating, so quality/value/analyst are left unscored (null).
//   - Survivorship bias: the universe is today's index membership. Companies
//     that failed and were delisted aren't here, so results skew optimistic.
//   - Daily closes only — no intraday fills, gaps, or slippage beyond the fee.
// Treat the output as a sanity check, not a promise.

import { sma, rsi, macd, returnPct } from "./indicators.js";
import { computeConviction, computeEntry } from "./conviction.js";
import { PaperEngine, FEE_RATE } from "./paper.js";

// SMA200 needs 200 prior closes; below that the trend read is meaningless.
export const WARMUP = 200;
const VOL_WINDOW = 20;
const YEAR_BARS = 252;

// Build a quote for `symbol` as it would have looked at bars[i], using only
// bars[0..i]. Returns null before warmup. Pure: no I/O, no clock, no future.
export function buildQuoteAt(bars, i, { symbol, name } = {}) {
  if (!bars || i < WARMUP || i >= bars.length) return null;

  const past = bars.slice(0, i + 1); // the only data that exists "now"
  const closes = past.map((b) => b.c);
  const price = closes[closes.length - 1];
  if (!price) return null;

  const volWin = past.slice(-VOL_WINDOW);
  const avgVol = volWin.reduce((a, b) => a + (b.v || 0), 0) / (volWin.length || 1);
  const volume = past[past.length - 1].v ?? null;

  const year = closes.slice(-YEAR_BARS);
  const hi52 = Math.max(...year);
  const lo52 = Math.min(...year);

  const m = macd(closes);
  const metrics = {
    price,
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    rsi: rsi(closes, 14),
    macdHist: m?.hist ?? null,
    ret1m: returnPct(closes, 21),
    ret3m: returnPct(closes, 63),
    ret6m: returnPct(closes, 126),
    volRatio: avgVol ? volume / avgVol : null,
    changePct: closes.length > 1 ? ((price - closes[closes.length - 2]) / closes[closes.length - 2]) * 100 : null,
    pctFrom52wHigh: hi52 ? ((price - hi52) / hi52) * 100 : null,
    rangePos: hi52 > lo52 ? (price - lo52) / (hi52 - lo52) : null,
    fiftyTwoWeekHigh: hi52,
    fiftyTwoWeekLow: lo52,
    // Deliberately absent: fund + analyst + earnings. See header.
    fund: null,
    analyst: null,
    earnings: null,
    isCrypto: false,
  };

  return {
    symbol, name: name || symbol,
    ...metrics,
    volume, avgVol10: avgVol,
    conviction: computeConviction(metrics),
    entry: computeEntry(metrics),
  };
}

// Buy at bars[from], hold to bars[to], net of one round trip of fees.
export function buyAndHold(bars, from = 0, to = bars.length - 1) {
  const entry = bars[from]?.c, exit = bars[to]?.c;
  if (!entry || !exit) return { returnPct: 0 };
  const gross = exit / entry;
  const net = gross * (1 - FEE_RATE) * (1 - FEE_RATE);
  return { returnPct: (net - 1) * 100, entry, exit, bars: to - from + 1 };
}

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

// Replay the universe day by day through the live PaperEngine decision logic.
export function runBacktest({ symbols = [], benchmarkBars = [], startingCash = 100_000, risk = "high", stopMode = "trail" } = {}) {
  // Index each symbol's bars by date so we can walk a shared calendar.
  const books = symbols
    .filter((s) => s.bars && s.bars.length > WARMUP)
    .map((s) => ({
      ...s,
      index: new Map(s.bars.map((b, i) => [dayKey(b.t), i])),
    }));

  // Trading calendar: the benchmark's dates when usable, else the longest book.
  const calendarSrc = benchmarkBars.length > WARMUP
    ? benchmarkBars
    : books.slice().sort((a, b) => b.bars.length - a.bars.length)[0]?.bars || [];
  const calendar = calendarSrc.slice(WARMUP);

  if (!books.length || !calendar.length) {
    return {
      days: 0, startingCash, finalEquity: startingCash, openAtEnd: 0,
      metrics: { totalReturnPct: 0, trades: 0, winRate: null, avgWinPct: null, avgLossPct: null, profitFactor: null, maxDrawdown: 0 },
      benchmark: { returnPct: 0 }, vsBenchmarkPct: 0, equityHistory: [], trades: [],
      warning: `Not enough history to backtest — need more than ${WARMUP} daily bars per symbol (SMA200 warm-up).`,
    };
  }

  // In-memory engine (file: null → no persistence), same rules as live.
  const engine = new PaperEngine({ file: null, startingCash, risk, stopMode });
  const equityHistory = [];

  for (const bar of calendar) {
    const key = dayKey(bar.t);
    const quotes = [];
    for (const book of books) {
      const i = book.index.get(key);
      if (i == null) continue; // symbol didn't trade that day
      const q = buildQuoteAt(book.bars, i, book);
      if (q) quotes.push(q);
    }
    if (!quotes.length) continue;
    engine.evaluate({ stocks: quotes, crypto: [], now: bar.t });
    equityHistory.push({ t: bar.t, equity: engine.equity() });
  }

  const finalEquity = engine.equity();
  const s = engine.state;
  const benchIdx = benchmarkBars.length > WARMUP ? WARMUP : 0;
  const benchmark = benchmarkBars.length > benchIdx + 1
    ? buyAndHold(benchmarkBars, benchIdx, benchmarkBars.length - 1)
    : { returnPct: 0 };

  const totalReturnPct = ((finalEquity - startingCash) / startingCash) * 100;
  return {
    days: equityHistory.length,
    from: calendar[0]?.t ?? null,
    to: calendar[calendar.length - 1]?.t ?? null,
    universe: books.length,
    risk,
    stopMode,
    startingCash,
    finalEquity,
    openAtEnd: s.positions.length,
    metrics: { ...engine.summary().metrics, totalReturnPct },
    benchmark,
    vsBenchmarkPct: totalReturnPct - benchmark.returnPct,
    equityHistory,
    trades: s.closed.slice(-50).reverse(),
  };
}
