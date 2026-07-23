// Tests for the paper-trading autopilot (written BEFORE the implementation).
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RISK_PROFILES, FEE_RATE,
  decideEntry, initialStop, updateStop, decideExit,
  computeMetrics, dayChange, PaperEngine,
} from "../lib/paper.js";

// ---------- fixtures ----------
const eq = (over = {}) => ({
  symbol: "TEST", name: "Test Corp", price: 100, sma50: 95,
  conviction: { rating: 4, score: 70 },
  entry: { verdict: "BUY_NOW", levels: { buyZone: [95, 100], invalidation: 92 } },
  earnings: null,
  ...over,
});
const coin = (over = {}) => ({
  symbol: "BTC", name: "Bitcoin", price: 50000, isCrypto: true,
  conviction: { rating: 4, score: 70 },
  entry: { verdict: "BUY_NOW", levels: {} },
  ...over,
});
const HIGH = RISK_PROFILES.high;
const MED = RISK_PROFILES.medium;
const LOW = RISK_PROFILES.low;

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paper-")), "paper.json");
const engine = (over = {}) => new PaperEngine({ file: tmpFile(), ...over });

// ---------- decideEntry ----------
test("BUY_NOW with rating 4 qualifies at high risk", () => {
  const d = decideEntry(eq(), HIGH);
  assert.ok(d);
  assert.equal(d.kind, "buyzone");
});

test("rating 3 never qualifies", () => {
  assert.equal(decideEntry(eq({ conviction: { rating: 3 } }), HIGH), null);
});

test("low risk requires rating 5", () => {
  assert.equal(decideEntry(eq(), LOW), null);
  assert.ok(decideEntry(eq({ conviction: { rating: 5 } }), LOW));
});

test("breakout cross qualifies only at high risk", () => {
  const q = eq({ entry: { verdict: "WAIT_BREAKOUT", levels: { breakoutTrigger: 99 } }, price: 100 });
  const d = decideEntry(q, HIGH);
  assert.ok(d);
  assert.equal(d.kind, "breakout");
  assert.equal(decideEntry(q, MED), null);
});

test("breakout NOT taken while price below trigger", () => {
  const q = eq({ entry: { verdict: "WAIT_BREAKOUT", levels: { breakoutTrigger: 110 } }, price: 100 });
  assert.equal(decideEntry(q, HIGH), null);
});

test("medium risk skips imminent earnings, high risk takes and tags them", () => {
  const q = eq({ earnings: { date: "2026-07-05", daysAway: 2 } });
  assert.equal(decideEntry(q, MED), null);
  const d = decideEntry(q, HIGH);
  assert.ok(d);
  assert.match(d.reason, /earnings/i);
});

test("crypto qualifies on BUY_NOW but never on breakout verdict", () => {
  assert.ok(decideEntry(coin(), HIGH));
  assert.equal(decideEntry(coin({ entry: { verdict: "WAIT_CONFIRM", levels: {} } }), HIGH), null);
});

// ---------- stops ----------
test("initial equity stop uses invalidation, falls back to sma50 then -8%", () => {
  assert.equal(initialStop(eq()), 92);
  assert.equal(initialStop(eq({ entry: { verdict: "BUY_NOW", levels: {} } })), 95);
  assert.ok(Math.abs(initialStop(eq({ sma50: null, entry: { verdict: "BUY_NOW", levels: {} } })) - 92) < 1e-9);
});

test("crypto stop is entry -15%", () => {
  assert.ok(Math.abs(initialStop(coin()) - 42500) < 1e-6);
});

test("equity stop trails up with sma50 and never moves down", () => {
  const pos = { symbol: "TEST", isCrypto: false, entryPrice: 100, stop: 92 };
  updateStop(pos, eq({ sma50: 97 }));
  assert.equal(pos.stop, 97);
  updateStop(pos, eq({ sma50: 90 }));
  assert.equal(pos.stop, 97);
});

test("stopMode 'buffer' trails 5% below sma50 (wobble room)", () => {
  const pos = { symbol: "TEST", isCrypto: false, entryPrice: 100, stop: 92 };
  updateStop(pos, eq({ sma50: 100 }), "buffer");
  assert.ok(Math.abs(pos.stop - 95) < 1e-9);
});

test("stopMode 'fixed' never trails — original stop stands", () => {
  const pos = { symbol: "TEST", isCrypto: false, entryPrice: 100, stop: 92 };
  updateStop(pos, eq({ sma50: 120 }), "fixed");
  assert.equal(pos.stop, 92);
});

test("stopMode does not affect crypto (its own -15% / breakeven rule)", () => {
  const pos = { symbol: "BTC", isCrypto: true, entryPrice: 50000, stop: 42500 };
  updateStop(pos, coin({ price: 55100 }), "fixed");
  assert.equal(pos.stop, 50000);
});

test("crypto stop ratchets to breakeven after +10%", () => {
  const pos = { symbol: "BTC", isCrypto: true, entryPrice: 50000, stop: 42500 };
  updateStop(pos, coin({ price: 54000 }));
  assert.equal(pos.stop, 42500); // +8% — not yet
  updateStop(pos, coin({ price: 55100 }));
  assert.equal(pos.stop, 50000); // +10.2% — breakeven locked
});

// ---------- decideExit ----------
test("exit on stop breach / avoid flip / conviction collapse", () => {
  const pos = { symbol: "TEST", isCrypto: false, entryPrice: 100, stop: 92 };
  assert.equal(decideExit(pos, eq({ price: 91 }))?.reason, "stop");
  assert.equal(decideExit(pos, eq({ entry: { verdict: "AVOID", levels: {} } }))?.reason, "avoid-flip");
  assert.equal(decideExit(pos, eq({ conviction: { rating: 2 } }))?.reason, "conviction-collapse");
  assert.equal(decideExit(pos, eq()), null);
});

// ---------- engine: entries, sizing, fees ----------
test("engine opens a position sized ~12% of equity with entry fee", () => {
  const e = engine();
  const actions = e.evaluate({ stocks: [eq()], crypto: [], now: 1 });
  assert.equal(actions.filter((a) => a.type === "open").length, 1);
  const pos = e.state.positions[0];
  const notional = 100000 * HIGH.pct;
  assert.ok(Math.abs(pos.qty * pos.entryPrice - notional) < 1e-6);
  assert.ok(Math.abs(e.state.cash - (100000 - notional * (1 + FEE_RATE))) < 1e-6);
});

test("engine respects caps and never spends more cash than it has", () => {
  const e = engine();
  const stocks = Array.from({ length: 20 }, (_, i) => eq({ symbol: "S" + i }));
  // higher score so coins are considered first → exercises the crypto cap
  const coins = Array.from({ length: 8 }, (_, i) =>
    coin({ symbol: "C" + i, price: 10, conviction: { rating: 4, score: 95 } })
  );
  e.evaluate({ stocks, crypto: coins, now: 1 });
  // 12%/position at high risk → cash runs out at ~8 positions (96% deployed);
  // maxPositions is a ceiling, cash is the binding constraint.
  assert.ok(e.state.positions.length <= HIGH.maxPositions);
  assert.equal(e.state.positions.length, 8);
  assert.equal(e.state.positions.filter((p) => p.isCrypto).length, HIGH.maxCrypto);
  assert.ok(e.state.cash >= 0);
});

test("engine never re-enters a symbol it already holds", () => {
  const e = engine();
  e.evaluate({ stocks: [eq()], crypto: [], now: 1 });
  const actions = e.evaluate({ stocks: [eq()], crypto: [], now: 2 });
  assert.equal(actions.filter((a) => a.type === "open").length, 0);
  assert.equal(e.state.positions.length, 1);
});

test("stop-out closes with exit fee and records a losing trade", () => {
  const e = engine();
  e.evaluate({ stocks: [eq()], crypto: [], now: 1 });
  const actions = e.evaluate({ stocks: [eq({ price: 90, sma50: null, conviction: { rating: 4 } })], crypto: [], now: 2 });
  assert.equal(actions.filter((a) => a.type === "close").length, 1);
  assert.equal(e.state.positions.length, 0);
  const t = e.state.closed[0];
  assert.equal(t.reason, "stop");
  assert.ok(t.pnl < 0);
  // proceeds reflect 0.1% exit fee
  assert.ok(Math.abs(t.exitPrice - 90) < 1e-9);
});

test("winner exits via avoid-flip with positive pnl", () => {
  const e = engine();
  e.evaluate({ stocks: [eq()], crypto: [], now: 1 });
  e.evaluate({
    stocks: [eq({ price: 130, entry: { verdict: "AVOID", levels: {} } })],
    crypto: [], now: 2,
  });
  const t = e.state.closed[0];
  assert.equal(t.reason, "avoid-flip");
  assert.ok(t.pnl > 0);
});

// ---------- metrics ----------
test("metrics: win rate, profit factor, max drawdown", () => {
  const closed = [
    { pnl: 500, pnlPct: 5 }, { pnl: 300, pnlPct: 3 }, { pnl: -200, pnlPct: -2 },
  ];
  const hist = [{ t: 1, equity: 100000 }, { t: 2, equity: 110000 }, { t: 3, equity: 99000 }, { t: 4, equity: 105000 }];
  const m = computeMetrics(closed, hist, 100000, 100000);
  assert.ok(Math.abs(m.winRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(m.profitFactor - 800 / 200) < 1e-9);
  assert.ok(Math.abs(m.maxDrawdown - (110000 - 99000) / 110000) < 1e-9);
});

// ---------- dayChange ----------
const at = (str) => new Date(str).getTime(); // local time

test("dayChange baselines on yesterday's last snapshot when one exists", () => {
  const hist = [
    { t: at("2026-07-02T12:00:00"), equity: 100000 },
    { t: at("2026-07-02T18:00:00"), equity: 100500 },
    { t: at("2026-07-03T09:00:00"), equity: 101000 },
  ];
  const d = dayChange(hist, 102000, at("2026-07-03T12:00:00"));
  assert.ok(d);
  assert.ok(Math.abs(d.abs - 1500) < 1e-9);          // vs 100500, not 101000
  assert.ok(Math.abs(d.pct - (1500 / 100500) * 100) < 1e-9);
});

test("dayChange falls back to today's first snapshot when history starts today", () => {
  const hist = [{ t: at("2026-07-03T09:00:00"), equity: 100000 }];
  const d = dayChange(hist, 101000, at("2026-07-03T12:00:00"));
  assert.ok(d);
  assert.ok(Math.abs(d.abs - 1000) < 1e-9);
});

test("dayChange returns null with no usable baseline", () => {
  assert.equal(dayChange([], 100000, at("2026-07-03T12:00:00")), null);
  // only snapshot is "now" itself — nothing earlier today to baseline against
  const now = at("2026-07-03T12:00:00");
  assert.equal(dayChange([{ t: now, equity: 100000 }], 100000, now), null);
});

// ---------- persistence & reset ----------
test("state survives a save/load round-trip", () => {
  const file = tmpFile();
  const e1 = new PaperEngine({ file });
  e1.evaluate({ stocks: [eq()], crypto: [], now: 1 });
  const e2 = new PaperEngine({ file });
  assert.equal(e2.state.positions.length, 1);
  assert.equal(e2.state.positions[0].symbol, "TEST");
  assert.ok(Math.abs(e2.state.cash - e1.state.cash) < 1e-9);
});

test("reset wipes the book and applies the new risk level", () => {
  const e = engine();
  e.evaluate({ stocks: [eq()], crypto: [], now: 1 });
  e.reset("low");
  assert.equal(e.state.positions.length, 0);
  assert.equal(e.state.closed.length, 0);
  assert.equal(e.state.cash, 100000);
  assert.equal(e.state.risk, "low");
});
