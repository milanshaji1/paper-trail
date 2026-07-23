// Tests for the LIVE momentum book (H1 traded forward), written before the impl.
// This is the honest test of H1: no survivorship, no hindsight — stocks are
// picked before anyone knows the outcome. The engine must therefore be boring
// and exact: rank in, equal-weight out, monthly, no stops.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MomentumEngine, FEE } from "../lib/momentum.js";

const DAY = 864e5;
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mom-")), "momentum.json");
const engine = (over = {}) => new MomentumEngine({ file: tmpFile(), topN: 3, ...over });
// ranked candidates, strongest first
const ranked = (n = 5, from = 0) =>
  Array.from({ length: n }, (_, i) => ({
    symbol: `S${from + i}`, name: `Stock ${from + i}`,
    price: 100, momentum: 100 - i * 10,
  }));

// ---------- rebalance timing ----------
test("is due immediately on a fresh book, then not until the interval passes", () => {
  const e = engine({ rebalanceDays: 28 });
  const t0 = Date.UTC(2026, 0, 1);
  assert.equal(e.isDue(t0), true);
  e.rebalance(ranked(), t0);
  assert.equal(e.isDue(t0 + 27 * DAY), false);
  assert.equal(e.isDue(t0 + 28 * DAY), true);
});

// ---------- rebalance mechanics ----------
test("rebalance buys exactly topN, equal-weight, and spends no more than it has", () => {
  const e = engine({ topN: 3 });
  e.rebalance(ranked(5), 1);
  assert.equal(e.state.positions.length, 3);
  assert.deepEqual(e.state.positions.map((p) => p.symbol), ["S0", "S1", "S2"]);
  const vals = e.state.positions.map((p) => p.qty * p.entryPrice);
  assert.ok(Math.max(...vals) - Math.min(...vals) < 1e-6, "equal weight");
  assert.ok(e.state.cash >= -1e-6, "never overdrawn");
});

test("rebalance sells names that dropped out of the top and keeps those that stayed", () => {
  const e = engine({ topN: 3 });
  const t0 = Date.UTC(2026, 0, 1);
  e.rebalance(ranked(5), t0);            // holds S0,S1,S2
  // next month S0 and S1 survive, S2 drops out, S9 enters
  const next = [
    { symbol: "S1", name: "Stock 1", price: 120, momentum: 90 },
    { symbol: "S0", name: "Stock 0", price: 110, momentum: 80 },
    { symbol: "S9", name: "Stock 9", price: 50, momentum: 70 },
    { symbol: "S2", name: "Stock 2", price: 90, momentum: 10 },
  ];
  e.mark({ S0: 110, S1: 120, S2: 90 }, t0 + 28 * DAY);
  e.rebalance(next, t0 + 28 * DAY);
  const held = e.state.positions.map((p) => p.symbol).sort();
  assert.deepEqual(held, ["S0", "S1", "S9"]);
  assert.equal(e.state.closed.length, 1);
  assert.equal(e.state.closed[0].symbol, "S2");
  assert.equal(e.state.closed[0].reason, "rank-drop");
});

test("a winner is TRIMMED back to equal weight — systematic sell-high is the strategy", () => {
  const e = engine({ topN: 3 });
  e.rebalance(ranked(3), 1);            // S0,S1,S2 each ~1/3 of 100k
  const before = e.state.positions.find((p) => p.symbol === "S0").qty;
  e.mark({ S0: 200, S1: 100, S2: 100 }, 2); // S0 doubles → now overweight
  e.rebalance(
    [
      { symbol: "S0", name: "Stock 0", price: 200, momentum: 99 },
      { symbol: "S1", name: "Stock 1", price: 100, momentum: 50 },
      { symbol: "S2", name: "Stock 2", price: 100, momentum: 40 },
    ],
    2 + 28 * DAY
  );
  const after = e.state.positions.find((p) => p.symbol === "S0");
  assert.ok(after.qty < before, "winner should be trimmed, not left to run");
  // all three back to ~equal value
  const vals = e.state.positions.map((p) => p.qty * p.lastPrice);
  assert.ok((Math.max(...vals) - Math.min(...vals)) / Math.max(...vals) < 0.02, "re-equalized");
  // Trims are logged separately — they're maintenance, not trade decisions,
  // so they must not distort win rate / profit factor.
  assert.ok(e.state.trims.some((c) => c.reason === "trim" && c.pnl > 0), "trim books a real gain");
  assert.equal(e.state.closed.length, 0, "a trim is not a closed trade");
});

test("an underweight holding is topped up rather than left small", () => {
  const e = engine({ topN: 2 });
  e.rebalance([
    { symbol: "A", name: "A", price: 100, momentum: 9 },
    { symbol: "B", name: "B", price: 100, momentum: 8 },
  ], 1);
  e.mark({ A: 50, B: 100 }, 2); // A halves → underweight
  const before = e.state.positions.find((p) => p.symbol === "A").qty;
  e.rebalance([
    { symbol: "A", name: "A", price: 50, momentum: 9 },
    { symbol: "B", name: "B", price: 100, momentum: 8 },
  ], 2 + 28 * DAY);
  const after = e.state.positions.find((p) => p.symbol === "A").qty;
  assert.ok(after > before, "should buy more of the underweight name");
});

test("rebalance is a no-op when the cross-section is too thin to fill topN", () => {
  const e = engine({ topN: 15 });
  const acted = e.rebalance(ranked(4), 1);
  assert.equal(acted, false);
  assert.equal(e.state.positions.length, 0);
});

test("fees are charged on entry and exit", () => {
  const e = engine({ topN: 1, startingCash: 100_000 });
  e.rebalance([{ symbol: "A", name: "A", price: 100, momentum: 5 }], 1);
  const pos = e.state.positions[0];
  // cost = slice*(1+FEE); slice sized fee-inclusive so it fits in cash
  assert.ok(Math.abs(pos.cost - pos.qty * pos.entryPrice * (1 + FEE)) < 1e-6);
  assert.ok(e.state.cash >= -1e-6);
});

// ---------- mark to market ----------
test("mark updates equity and never invents prices for unknown symbols", () => {
  const e = engine({ topN: 3 });
  e.rebalance(ranked(3), 1);
  const before = e.equity();
  e.mark({ S0: 200, S1: 200, S2: 200 }, 2);
  assert.ok(e.equity() > before);
  const stale = e.equity();
  e.mark({}, 3); // no prices this cycle — hold last known, don't zero out
  assert.equal(e.equity(), stale);
});

test("equity history accumulates for drawdown math", () => {
  const e = engine({ topN: 3 });
  e.rebalance(ranked(3), 1);
  e.mark({ S0: 110, S1: 110, S2: 110 }, 10 * DAY);
  e.mark({ S0: 90, S1: 90, S2: 90 }, 20 * DAY);
  assert.ok(e.state.equityHistory.length >= 2);
  assert.ok(e.summary().metrics.maxDrawdown > 0);
});

// ---------- persistence ----------
test("book survives a restart", () => {
  const file = tmpFile();
  const a = new MomentumEngine({ file, topN: 3 });
  a.rebalance(ranked(5), 1);
  const b = new MomentumEngine({ file, topN: 3 });
  assert.equal(b.state.positions.length, 3);
  assert.ok(Math.abs(b.state.cash - a.state.cash) < 1e-9);
});

test("summary exposes the strategy label and holdings for the UI", () => {
  const e = engine({ topN: 3 });
  e.rebalance(ranked(3), 1);
  const s = e.summary();
  assert.equal(s.simulated, true);
  assert.equal(s.strategy, "12-1 momentum");
  assert.equal(s.positions.length, 3);
  assert.ok("nextRebalanceAt" in s);
});
