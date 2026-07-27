// H1: cross-sectional momentum (12-1), the most-replicated anomaly in finance.
//
// Rank stocks by their 12-month return SKIPPING the most recent month, buy the
// top decile equal-weight, rebalance monthly, no stops. The skip matters: the
// last month carries short-term REVERSAL, which is the opposite effect and
// contaminates the signal if included (Jegadeesh & Titman, 1993).
//
// This is a separate strategy from lib/backtest.js, not a knob on it. That one
// traded daily breakouts with tight stops; this holds ranked winners for a
// month at a time and ignores price action in between.
//
// Same non-negotiable as the other engine: NO LOOK-AHEAD. Every decision at
// index i reads bars[0..i-SKIP] only, and a test proves rewriting the future
// can't change a past decision.
//
// Disclosed biases (not fixable for free):
//   - Survivorship: the universe is TODAY's index members with 10yr history, so
//     companies that failed and delisted are absent. Results skew optimistic.
//   - It also silently excludes younger companies (no 10yr history).
//   - Weekly closes: no intraday fills; monthly rebalance assumed at the close.

import fs from "node:fs";
import path from "node:path";
import { computeMetrics } from "./paper.js";

export const LOOKBACK = 52; // weeks (~12 months)
export const SKIP = 4;      // weeks (~1 month) — excluded on purpose
export const FEE = 0.001;   // 0.1% per side

// Return over [i-LOOKBACK-SKIP, i-SKIP]. Deliberately blind to the last SKIP
// weeks and to everything after i. Pure.
export function formationReturn(bars, i, lookback = LOOKBACK, skip = SKIP) {
  const end = i - skip;
  const start = i - lookback - skip;
  if (!bars || start < 0 || end >= bars.length || end <= start) return null;
  const a = bars[start]?.c, b = bars[end]?.c;
  if (!a || !b) return null;
  return ((b - a) / a) * 100;
}

// Strongest-first ranking across the cross-section at index i.
export function rankByMomentum(books, i, lookback = LOOKBACK, skip = SKIP) {
  return books
    .map((bk) => ({ ...bk, momentum: formationReturn(bk.bars, i, lookback, skip) }))
    .filter((x) => x.momentum != null)
    .sort((a, b) => b.momentum - a.momentum);
}

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

export function runMomentumBacktest({
  books = [], benchmarkBars = [], topN = 15,
  lookback = LOOKBACK, skip = SKIP, rebalanceEvery = 4,
  startingCash = 100_000, fee = FEE,
} = {}) {
  const warmup = lookback + skip;

  // Index every book by date so the cross-section walks one shared calendar.
  const indexed = books
    .filter((b) => b.bars?.length > warmup)
    .map((b) => ({ ...b, index: new Map(b.bars.map((x, i) => [dayKey(x.t), i])) }));

  const calSrc = benchmarkBars.length > warmup
    ? benchmarkBars
    : indexed.slice().sort((a, b) => b.bars.length - a.bars.length)[0]?.bars || [];
  const calendar = calSrc.slice(warmup);

  const empty = {
    rebalances: 0, startingCash, finalEquity: startingCash, holdings: [],
    metrics: { totalReturnPct: 0, trades: 0, winRate: null, avgWinPct: null, avgLossPct: null, profitFactor: null, maxDrawdown: 0 },
    benchmark: { returnPct: 0 }, vsBenchmarkPct: 0, equityHistory: [], closed: [],
  };
  if (!indexed.length || calendar.length < rebalanceEvery) {
    return { ...empty, warning: `Not enough history — need more than ${warmup} weekly bars (12-month formation + 1-month skip).` };
  }

  let cash = startingCash;
  let positions = []; // { symbol, name, qty, entryPrice, lastPrice, cost, openedAt }
  const closed = [];
  const equityHistory = [];
  let rebalances = 0;

  const priceAt = (book, key) => {
    const i = book.index.get(key);
    return i == null ? null : book.bars[i].c;
  };
  const equity = () => cash + positions.reduce((a, p) => a + p.qty * p.lastPrice, 0);

  for (let step = 0; step < calendar.length; step++) {
    const key = dayKey(calendar[step].t);

    // Mark to market every week (so drawdown is honest, not just at rebalances).
    for (const p of positions) {
      const bk = indexed.find((b) => b.symbol === p.symbol);
      const px = bk && priceAt(bk, key);
      if (px) p.lastPrice = px;
    }

    if (step % rebalanceEvery === 0) {
      // Rank the cross-section using ONLY data available at this date.
      const ranked = [];
      for (const bk of indexed) {
        const i = bk.index.get(key);
        if (i == null || i < warmup) continue;
        const momentum = formationReturn(bk.bars, i, lookback, skip);
        if (momentum != null) ranked.push({ bk, momentum, price: bk.bars[i].c });
      }
      if (ranked.length >= topN) {
        ranked.sort((a, b) => b.momentum - a.momentum);
        const target = ranked.slice(0, topN);
        const targetSyms = new Set(target.map((t) => t.bk.symbol));

        // Sell anything that fell out of the top decile.
        for (const p of [...positions]) {
          if (targetSyms.has(p.symbol)) continue;
          const proceeds = p.qty * p.lastPrice * (1 - fee);
          const pnl = proceeds - p.cost;
          cash += proceeds;
          positions = positions.filter((x) => x !== p);
          closed.push({
            symbol: p.symbol, name: p.name, entryPrice: p.entryPrice, exitPrice: p.lastPrice,
            openedAt: p.openedAt, closedAt: calendar[step].t, reason: "rank-drop",
            pnl, pnlPct: (pnl / p.cost) * 100,
          });
        }

        // TRUE equal weight: trim winners and top up laggards back to equity/topN
        // every month. Trimming IS the strategy (systematic sell-high) — letting
        // winners ride indefinitely is a different, unregistered strategy.
        const slice = equity() / topN / (1 + fee);

        // Trim overweight names first so the cash exists for the buys.
        for (const t of target) {
          const p = positions.find((x) => x.symbol === t.bk.symbol);
          if (!p) continue;
          p.lastPrice = t.price;
          const excess = p.qty - slice / t.price;
          if (excess <= 1e-9) continue;
          const proceeds = excess * t.price * (1 - fee);
          p.cost -= p.cost * (excess / p.qty);
          p.qty -= excess;
          cash += proceeds; // realized trim gain stays in equity, not the trade log
        }

        // Top up / open the rest.
        for (const t of target) {
          const held = positions.find((p) => p.symbol === t.bk.symbol);
          const addQty = slice / t.price - (held ? held.qty : 0);
          if (addQty <= 1e-9) continue;
          const buyQty = Math.min(addQty, cash / (t.price * (1 + fee)));
          if (buyQty <= 1e-9) continue;
          const cost = buyQty * t.price * (1 + fee);
          cash -= cost;
          if (held) { held.qty += buyQty; held.cost += cost; held.lastPrice = t.price; }
          else {
            positions.push({
              symbol: t.bk.symbol, name: t.bk.name || t.bk.symbol,
              qty: buyQty, entryPrice: t.price, lastPrice: t.price,
              cost, openedAt: calendar[step].t,
            });
          }
        }
        rebalances++;
      }
    }

    equityHistory.push({ t: calendar[step].t, equity: equity() });
  }

  const finalEquity = equity();
  const benchIdx = benchmarkBars.length > warmup ? warmup : 0;
  const bEntry = benchmarkBars[benchIdx]?.c;
  const bExit = benchmarkBars[benchmarkBars.length - 1]?.c;
  const benchmark = bEntry && bExit
    ? { returnPct: (((bExit / bEntry) * (1 - fee) * (1 - fee)) - 1) * 100, entry: bEntry, exit: bExit }
    : { returnPct: 0 };

  const totalReturnPct = ((finalEquity - startingCash) / startingCash) * 100;
  return {
    rebalances,
    from: calendar[0]?.t ?? null,
    to: calendar[calendar.length - 1]?.t ?? null,
    universe: indexed.length,
    topN,
    startingCash,
    finalEquity,
    holdings: positions,
    metrics: { ...computeMetrics(closed, equityHistory, startingCash, finalEquity), totalReturnPct },
    benchmark,
    vsBenchmarkPct: totalReturnPct - benchmark.returnPct,
    equityHistory,
    closed: closed.slice(-60).reverse(),
  };
}

// ---------------------------------------------------------------------------
// LIVE book: H1 traded FORWARD, in simulation.
//
// This is the only honest test of H1. The backtest was inflated by survivorship
// (today's index members) and by an alphabet that handed us the best sector of
// the decade. Running forward removes both: these stocks are picked before
// anyone knows the outcome.
//
// Deliberately boring: rank in, equal-weight out, monthly, NO stops. Every knob
// we could turn here is a knob we could use to fool ourselves.
// Fake money. No brokerage. It cannot place a real order.
// ---------------------------------------------------------------------------
export class MomentumEngine {
  constructor({ file, startingCash = 100_000, topN = 15, rebalanceDays = 28 } = {}) {
    this.file = file;
    this.topN = topN;
    this.rebalanceDays = rebalanceDays;
    this.state = this.#load() || {
      version: 1,
      strategy: "12-1 momentum",
      createdAt: Date.now(),
      startingCash,
      cash: startingCash,
      topN,
      rebalanceDays,
      positions: [],
      closed: [],
      trims: [],
      equityHistory: [],
      lastRebalanceAt: null,
      rebalances: 0,
    };
  }

  equity() {
    return this.state.cash + this.state.positions.reduce((a, p) => a + p.qty * (p.lastPrice ?? p.entryPrice), 0);
  }

  get nextRebalanceAt() {
    const last = this.state.lastRebalanceAt;
    return last == null ? null : last + this.rebalanceDays * 864e5;
  }

  isDue(now = Date.now()) {
    const next = this.nextRebalanceAt;
    return next == null || now >= next;
  }

  // ranked: [{ symbol, name, price, momentum }] strongest-first.
  // Returns true if it actually traded.
  rebalance(ranked = [], now = Date.now()) {
    const usable = ranked.filter((r) => r.price > 0 && r.momentum != null);
    if (usable.length < this.topN) return false; // too thin to fill the book honestly

    const s = this.state;
    const target = usable.slice(0, this.topN);
    const keep = new Map(target.map((t) => [t.symbol, t]));

    // 1. Sell whatever fell out of the top decile (frees cash first).
    for (const p of [...s.positions]) {
      if (keep.has(p.symbol)) continue;
      const px = p.lastPrice ?? p.entryPrice;
      this.#sell(p, px, p.qty, now, "rank-drop");
    }

    // 2. True equal weight: every held name is trimmed or topped up to equity/topN.
    //    Trimming winners IS the strategy (systematic sell-high), not churn.
    //    Slice is fee-inclusive so topN buys fit inside equity.
    const slice = this.equity() / this.topN / (1 + FEE);

    // 2a. Trim overweight names first so the cash exists for the buys.
    for (const p of [...s.positions]) {
      const t = keep.get(p.symbol);
      if (!t) continue;
      p.lastPrice = t.price;
      const excessQty = p.qty - slice / t.price;
      if (excessQty > 1e-9) this.#sell(p, t.price, excessQty, now, "trim");
    }

    // 2b. Top up / open the rest with whatever cash is available.
    for (const t of target) {
      const held = s.positions.find((p) => p.symbol === t.symbol);
      const haveQty = held ? held.qty : 0;
      const wantQty = slice / t.price;
      const addQty = wantQty - haveQty;
      if (addQty <= 1e-9) continue;
      const affordable = Math.min(addQty, s.cash / (t.price * (1 + FEE)));
      if (affordable <= 1e-9) continue;
      const cost = affordable * t.price * (1 + FEE);
      s.cash -= cost;
      if (held) {
        held.qty += affordable;
        held.cost += cost;
        held.lastPrice = t.price;
      } else {
        s.positions.push({
          symbol: t.symbol, name: t.name || t.symbol,
          qty: affordable, entryPrice: t.price, lastPrice: t.price,
          cost, openedAt: now, momentumAtEntry: t.momentum,
        });
      }
    }

    s.lastRebalanceAt = now;
    s.rebalances++;
    this.#snapshot(now);
    this.#save();
    return true;
  }

  // Mark to market from whatever prices this cycle has. Unknown symbols keep
  // their last known price rather than being zeroed.
  mark(priceMap = {}, now = Date.now()) {
    for (const p of this.state.positions) {
      const px = priceMap[p.symbol];
      if (px > 0) p.lastPrice = px;
    }
    this.#snapshot(now);
    this.#save();
  }

  summary() {
    const s = this.state;
    const equity = this.equity();
    return {
      simulated: true,
      strategy: s.strategy,
      topN: this.topN,
      rebalanceDays: this.rebalanceDays,
      rebalances: s.rebalances,
      startingCash: s.startingCash,
      cash: s.cash,
      equity,
      createdAt: s.createdAt,
      lastRebalanceAt: s.lastRebalanceAt,
      nextRebalanceAt: this.nextRebalanceAt,
      positions: s.positions,
      closed: s.closed.slice(-60).reverse(),
      equityHistory: s.equityHistory.slice(-300),
      metrics: computeMetrics(s.closed, s.equityHistory, s.startingCash, equity),
    };
  }

  reset() {
    const startingCash = this.state.startingCash || 100_000;
    this.state = {
      version: 1, strategy: "12-1 momentum", createdAt: Date.now(),
      startingCash, cash: startingCash, topN: this.topN, rebalanceDays: this.rebalanceDays,
      positions: [], closed: [], trims: [], equityHistory: [], lastRebalanceAt: null, rebalances: 0,
    };
    this.#save();
  }

  // Sell `qty` of a position at `px`. Partial sells (trims) keep the position
  // open and shrink its cost basis proportionally; full sells close it and log
  // the realized trade.
  #sell(p, px, qty, now, reason) {
    const s = this.state;
    const q = Math.min(qty, p.qty);
    if (q <= 1e-9 || !(px > 0)) return;
    const proceeds = q * px * (1 - FEE);
    const costPart = p.cost * (q / p.qty);
    s.cash += proceeds;
    p.qty -= q;
    p.cost -= costPart;
    const pnl = proceeds - costPart;
    if (p.qty <= 1e-9) s.positions = s.positions.filter((x) => x !== p);
    const record = {
      symbol: p.symbol, name: p.name, qty: q,
      entryPrice: p.entryPrice, exitPrice: px,
      openedAt: p.openedAt, closedAt: now, reason,
      pnl, pnlPct: costPart > 0 ? (pnl / costPart) * 100 : 0,
    };
    // Trims are position maintenance, not trade decisions. Their P&L is real
    // (cash + reduced basis) but counting them as "trades" would distort win
    // rate and profit factor, so they live in their own log.
    if (reason === "trim") {
      s.trims = s.trims || [];
      s.trims.push(record);
      if (s.trims.length > 500) s.trims.splice(0, s.trims.length - 500);
    } else {
      s.closed.push(record);
    }
  }

  #snapshot(now) {
    const s = this.state;
    const eq = this.equity();
    const last = s.equityHistory[s.equityHistory.length - 1];
    if (!last || now - last.t >= 60 * 60_000 || Math.abs(eq - last.equity) / (last.equity || 1) > 0.002) {
      s.equityHistory.push({ t: now, equity: eq });
      if (s.equityHistory.length > 2000) s.equityHistory.splice(0, s.equityHistory.length - 2000);
    }
  }

  #load() {
    try {
      if (this.file && fs.existsSync(this.file)) return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch { /* corrupt file → fresh book */ }
    return null;
  }

  #save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch { /* best-effort */ }
  }
}
