// Paper-trading autopilot — 100% SIMULATED. Fake money, no brokerage, no real
// orders, ever. It follows the dashboard's own conviction/entry signals so the
// system builds an honest track record (win rate, P&L, drawdown) you can judge
// before risking anything real.
//
// Pure decision functions are exported for tests; PaperEngine owns state and
// JSON-file persistence and is driven by the server's refresh cycles.

import fs from "node:fs";
import path from "node:path";

export const FEE_RATE = 0.001; // 0.1% per side — keeps results understated

export const RISK_PROFILES = {
  low: { minRating: 5, kinds: ["buyzone"], pct: 0.05, maxPositions: 8, maxCrypto: 2, skipEarningsDays: 7 },
  medium: { minRating: 4, kinds: ["buyzone"], pct: 0.08, maxPositions: 10, maxCrypto: 3, skipEarningsDays: 3 },
  high: { minRating: 4, kinds: ["buyzone", "breakout"], pct: 0.12, maxPositions: 12, maxCrypto: 4, skipEarningsDays: 0 },
};

const MIN_NOTIONAL = 500; // don't open dust positions

// Does this quote qualify for a new position under the given risk profile?
// Returns { kind, reason } or null.
export function decideEntry(q, profile) {
  const rating = q?.conviction?.rating;
  const entry = q?.entry;
  if (!rating || !entry || q.price == null) return null;
  if (rating < profile.minRating) return null;

  // Earnings gate (low/medium skip imminent reports; high takes them, tagged).
  const days = q.earnings?.daysAway;
  const earningsSoon = days != null && days >= 0 && days <= 14;
  if (profile.skipEarningsDays > 0 && days != null && days >= 0 && days <= profile.skipEarningsDays) return null;

  let kind = null;
  if (q.isCrypto) {
    if (entry.verdict === "BUY_NOW") kind = "buyzone";
  } else if (entry.verdict === "BUY_NOW") {
    kind = "buyzone";
  } else if (
    entry.verdict === "WAIT_BREAKOUT" &&
    profile.kinds.includes("breakout") &&
    entry.levels?.breakoutTrigger != null &&
    q.price >= entry.levels.breakoutTrigger
  ) {
    kind = "breakout";
  }
  if (!kind) return null;

  const reason =
    (kind === "breakout"
      ? `Crossed breakout trigger $${entry.levels.breakoutTrigger} at ${rating}/5 conviction`
      : `${rating}/5 conviction in buy zone (${entry.reason || entry.headline || "constructive setup"})`) +
    (earningsSoon && profile.skipEarningsDays === 0 ? ` — earnings in ${days}d (high-risk: taken anyway)` : "");
  return { kind, reason };
}

// Initial protective stop for a new position.
export function initialStop(q) {
  if (q.isCrypto) return q.price * 0.85; // fixed -15%
  return q.entry?.levels?.invalidation ?? q.sma50 ?? q.price * 0.92; // fallback -8%
}

// Trail stops upward only. Equities follow the rising 50-day average; crypto
// ratchets to breakeven once up 10%.
//
// `mode` exists so the backtester can test the stop as a hypothesis rather than
// an assumption: "trail" (default, hug the 50-day), "buffer" (trail 5% below it,
// leaving room for normal wobble), "fixed" (never trail; original stop stands).
// Crypto ignores mode — it has its own rule.
export const STOP_BUFFER = 0.95;
export function updateStop(pos, q, mode = "trail") {
  if (pos.isCrypto) {
    if (q.price >= pos.entryPrice * 1.10) pos.stop = Math.max(pos.stop, pos.entryPrice);
  } else if (mode !== "fixed" && q.sma50 != null) {
    const target = mode === "buffer" ? q.sma50 * STOP_BUFFER : q.sma50;
    pos.stop = Math.max(pos.stop, target);
  }
  return pos.stop;
}

// Should an open position be closed? Returns { reason } or null.
export function decideExit(pos, q) {
  if (q.price != null && q.price <= pos.stop) return { reason: "stop" };
  if (q.entry?.verdict === "AVOID") return { reason: "avoid-flip" };
  const rating = q.conviction?.rating;
  if (rating != null && rating <= 2) return { reason: "conviction-collapse" };
  return null;
}

// Change in equity since the start of the current (local) day. Baseline is
// yesterday's last snapshot when one exists, else today's first snapshot.
export function dayChange(history, currentEquity, now = Date.now()) {
  if (!history?.length) return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const sod = d.getTime();
  let base = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].t < sod) { base = history[i]; break; }
  }
  if (!base) base = history.find((p) => p.t >= sod && p.t < now) || null;
  if (!base || !base.equity) return null;
  const abs = currentEquity - base.equity;
  return { abs, pct: (abs / base.equity) * 100 };
}

// Portfolio metrics from the closed-trade log and equity history.
export function computeMetrics(closed, equityHistory, startingCash, currentEquity) {
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  let peak = -Infinity, maxDrawdown = 0;
  for (const p of equityHistory) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - p.equity) / peak);
  }
  return {
    totalReturnPct: startingCash ? ((currentEquity - startingCash) / startingCash) * 100 : 0,
    trades: closed.length,
    winRate: closed.length ? wins.length / closed.length : null,
    avgWinPct: wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : null,
    avgLossPct: losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? null : null,
    maxDrawdown,
  };
}

export class PaperEngine {
  constructor({ file, startingCash = 100_000, risk = "high", stopMode = "trail" } = {}) {
    this.file = file;
    this.stopMode = stopMode;
    this.state = this.#load() || {
      version: 1,
      createdAt: Date.now(),
      startingCash,
      cash: startingCash,
      risk,
      positions: [],
      closed: [],
      equityHistory: [],
      lastEvalAt: null,
    };
  }

  get profile() {
    return RISK_PROFILES[this.state.risk] || RISK_PROFILES.high;
  }

  equity() {
    return this.state.cash + this.state.positions.reduce((a, p) => a + p.qty * (p.lastPrice ?? p.entryPrice), 0);
  }

  // One decision pass over the latest data. Returns the actions taken.
  evaluate({ stocks = [], crypto = [], now = Date.now() } = {}) {
    const s = this.state;
    const profile = this.profile;
    const actions = [];
    const bySym = new Map();
    for (const q of stocks) bySym.set(q.symbol, q);
    for (const c of crypto) bySym.set(c.symbol, { ...c, isCrypto: true });

    // --- manage open positions: mark, trail, exit ---
    const closedThisCycle = new Set(); // no same-cycle re-entry churn
    for (const pos of [...s.positions]) {
      const q = bySym.get(pos.symbol);
      if (!q || q.price == null) continue; // no fresh price this cycle — hold
      pos.lastPrice = q.price;
      updateStop(pos, q, this.stopMode);
      const exit = decideExit(pos, q);
      if (exit) {
        const proceeds = pos.qty * q.price * (1 - FEE_RATE);
        const pnl = proceeds - pos.cost;
        s.cash += proceeds;
        s.positions = s.positions.filter((p) => p !== pos);
        s.closed.push({
          symbol: pos.symbol, name: pos.name, isCrypto: !!pos.isCrypto,
          qty: pos.qty, entryPrice: pos.entryPrice, exitPrice: q.price,
          openedAt: pos.openedAt, closedAt: now,
          reason: exit.reason, entryReason: pos.reason, kind: pos.kind,
          pnl, pnlPct: (pnl / pos.cost) * 100,
        });
        actions.push({ type: "close", symbol: pos.symbol, price: q.price, reason: exit.reason, pnl });
        closedThisCycle.add(pos.symbol);
      }
    }

    // --- new entries, best conviction first ---
    const held = new Set(s.positions.map((p) => p.symbol));
    const candidates = [];
    for (const q of bySym.values()) {
      if (held.has(q.symbol) || closedThisCycle.has(q.symbol)) continue;
      const d = decideEntry(q, profile);
      if (d) candidates.push({ q, d });
    }
    candidates.sort(
      (a, b) =>
        (b.q.conviction?.rating || 0) - (a.q.conviction?.rating || 0) ||
        (b.q.conviction?.score || 0) - (a.q.conviction?.score || 0)
    );
    for (const { q, d } of candidates) {
      if (s.positions.length >= profile.maxPositions) break;
      if (q.isCrypto && s.positions.filter((p) => p.isCrypto).length >= profile.maxCrypto) continue;
      const notional = this.equity() * profile.pct;
      const cost = notional * (1 + FEE_RATE);
      if (notional < MIN_NOTIONAL || cost > s.cash) continue;
      const pos = {
        symbol: q.symbol, name: q.name || q.symbol, isCrypto: !!q.isCrypto,
        qty: notional / q.price, entryPrice: q.price, lastPrice: q.price,
        cost, stop: initialStop(q), openedAt: now, kind: d.kind, reason: d.reason,
        ratingAtEntry: q.conviction?.rating ?? null,
      };
      s.cash -= cost;
      s.positions.push(pos);
      held.add(q.symbol);
      actions.push({ type: "open", symbol: q.symbol, price: q.price, kind: d.kind, reason: d.reason });
    }

    // --- equity history (throttled) + persist ---
    const eq = this.equity();
    const last = s.equityHistory[s.equityHistory.length - 1];
    if (!last || now - last.t >= 5 * 60_000 || Math.abs(eq - last.equity) / (last.equity || 1) > 0.001) {
      s.equityHistory.push({ t: now, equity: eq });
      if (s.equityHistory.length > 2000) s.equityHistory.splice(0, s.equityHistory.length - 2000);
    }
    s.lastEvalAt = now;
    this.#save();
    return actions;
  }

  summary() {
    const s = this.state;
    const equity = this.equity();
    return {
      simulated: true,
      risk: s.risk,
      startingCash: s.startingCash,
      cash: s.cash,
      equity,
      createdAt: s.createdAt,
      lastEvalAt: s.lastEvalAt,
      positions: s.positions,
      closed: s.closed.slice(-100).reverse(),
      equityHistory: s.equityHistory.slice(-300),
      metrics: computeMetrics(s.closed, s.equityHistory, s.startingCash, equity),
      dayChange: dayChange(s.equityHistory, equity),
    };
  }

  reset(risk) {
    const startingCash = this.state.startingCash || 100_000;
    this.state = {
      version: 1, createdAt: Date.now(), startingCash, cash: startingCash,
      risk: RISK_PROFILES[risk] ? risk : this.state.risk,
      positions: [], closed: [], equityHistory: [], lastEvalAt: null,
    };
    this.#save();
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
    } catch { /* persistence is best-effort */ }
  }
}
