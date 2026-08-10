import test from "node:test";
import assert from "node:assert/strict";
import { PaperEngine, decideExit, FEE_RATE } from "../lib/paper.js";

const engine = (cash = 10_000) => new PaperEngine({ file: null, startingCash: cash });

test("a manual position opens with fractional quantity and charges the fee", () => {
  const e = engine();
  const r = e.openManual({ symbol: "VOO", name: "Vanguard S&P 500 ETF", price: 710.81, notional: 250 });
  assert.equal(r.ok, true, r.reason);
  const p = r.position;
  assert.ok(Math.abs(p.qty - 250 / 710.81) < 1e-9, "fractional shares — $250 does not buy a whole $710 share");
  assert.ok(Math.abs(p.cost - 250 * (1 + FEE_RATE)) < 1e-9);
  assert.equal(p.manual, true);
  assert.equal(p.stop, null, "a pinned hold carries no stop it would never act on");
});

test("cash is debited and the position is held", () => {
  const e = engine(1000);
  e.openManual({ symbol: "GLD", price: 399.08, notional: 250 });
  assert.ok(Math.abs(e.state.cash - (1000 - 250 * (1 + FEE_RATE))) < 1e-9);
  assert.equal(e.state.positions.length, 1);
});

test("an order larger than available cash is refused, not partially filled", () => {
  const e = engine(100);
  const r = e.openManual({ symbol: "VOO", price: 710.81, notional: 250 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /insufficient cash/);
  assert.equal(e.state.positions.length, 0);
  assert.equal(e.state.cash, 100, "cash untouched on a refused order");
});

test("bad input is rejected", () => {
  const e = engine();
  assert.equal(e.openManual({ symbol: "", price: 10, notional: 250 }).ok, false);
  assert.equal(e.openManual({ symbol: "VOO", price: 0, notional: 250 }).ok, false);
  assert.equal(e.openManual({ symbol: "VOO", price: 10, notional: 0 }).ok, false);
});

test("decideExit never closes a pinned hold, whatever the quote says", () => {
  const pinned = { symbol: "VOO", manual: true, stop: 1e9, entryPrice: 700 };
  // Every exit trigger at once: below stop, AVOID verdict, conviction collapse.
  const brutal = { price: 1, entry: { verdict: "AVOID" }, conviction: { rating: 1 } };
  assert.equal(decideExit(pinned, brutal), null);

  // The same quote must still close an ordinary engine position.
  const auto = { symbol: "VOO", stop: 700, entryPrice: 700 };
  assert.notEqual(decideExit(auto, brutal), null);
});

test("evaluate marks a pinned hold to market but never exits it", () => {
  const e = engine();
  e.openManual({ symbol: "VOO", price: 700, notional: 250 });
  const crash = [{
    symbol: "VOO", name: "Vanguard S&P 500 ETF", price: 350, sma50: 900,
    entry: { verdict: "AVOID" }, conviction: { rating: 1, score: 5 },
  }];
  e.evaluate({ stocks: crash, crypto: [] });

  assert.equal(e.state.positions.length, 1, "a 50% drawdown must not close a pinned hold");
  assert.equal(e.state.positions[0].lastPrice, 350, "but it must still be marked to market");
  assert.equal(e.state.positions[0].stop, null, "and never gains a trailing stop");
  assert.equal(e.state.closed.length, 0);
});

test("equity reflects the marked-down pinned position", () => {
  const e = engine(10_000);
  e.openManual({ symbol: "VOO", price: 700, notional: 700 });
  assert.ok(Math.abs(e.equity() - (10_000 - 700 * FEE_RATE)) < 1e-6, "at entry, equity is start minus fee");
  e.evaluate({ stocks: [{ symbol: "VOO", price: 350, sma50: 900, conviction: { rating: 1 } }], crypto: [] });
  // Position halved: 700 of value became 350.
  assert.ok(Math.abs(e.equity() - (10_000 - 700 * FEE_RATE - 350)) < 1e-6);
});

test("summary separates pinned holds from engine positions", () => {
  const e = engine();
  e.openManual({ symbol: "GLD", price: 399.08, notional: 250 });
  e.state.positions.push({ symbol: "AAPL", qty: 1, entryPrice: 100, lastPrice: 100, cost: 100 });
  const s = e.summary();
  assert.equal(s.simulated, true);
  assert.deepEqual(s.manualPositions.map((p) => p.symbol), ["GLD"]);
  assert.deepEqual(s.autoPositions.map((p) => p.symbol), ["AAPL"]);
  assert.equal(s.positions.length, 2, "the combined list still holds both");
});

test("a foreign listing is booked in USD, not at its local price", () => {
  const e = engine(10_000);
  // VAS trades on the ASX in AUD. At 0.706 USD/AUD, A$114.38 ≈ US$80.75.
  const r = e.openManual({ symbol: "VAS.AX", price: 114.38, notional: 250, currency: "AUD", fxRate: 0.706 });
  assert.equal(r.ok, true, r.reason);
  const p = r.position;
  assert.ok(Math.abs(p.entryPrice - 114.38 * 0.706) < 1e-9, "entry stored in USD");
  assert.equal(p.localPrice, 114.38, "local price kept for reference");
  // Booking it raw would have bought 250/114.38 = 2.19 shares; correct is 3.10.
  assert.ok(Math.abs(p.qty - 250 / (114.38 * 0.706)) < 1e-9);
  assert.ok(p.qty > 3 && p.qty < 3.2, `expected ~3.10 shares, got ${p.qty}`);
});

test("a foreign position without an FX rate is refused, not guessed", () => {
  const e = engine();
  const r = e.openManual({ symbol: "VAS.AX", price: 114.38, notional: 250, currency: "AUD", fxRate: 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no FX rate/);
});

test("marks convert every cycle and fall back to the entry rate if FX drops out", () => {
  const e = engine(10_000);
  e.openManual({ symbol: "VAS.AX", price: 100, notional: 250, currency: "AUD", fxRate: 0.70 });
  const quote = [{ symbol: "VAS.AX", price: 110, currency: "AUD", conviction: { rating: 5 } }];

  e.evaluate({ stocks: quote, crypto: [], fx: { AUD: 0.65 } });
  assert.ok(Math.abs(e.state.positions[0].lastPrice - 110 * 0.65) < 1e-9, "marked at the live rate");

  // FX unavailable this cycle: hold the last known rate rather than reverting
  // to 1, which would revalue the position by ~54%.
  e.evaluate({ stocks: quote, crypto: [], fx: {} });
  assert.ok(Math.abs(e.state.positions[0].lastPrice - 110 * 0.65) < 1e-9, "stale rate, correct units");
});

test("the autopilot never opens its own position in a foreign listing", () => {
  const e = engine(50_000);
  const tempting = [{
    symbol: "VAS.AX", name: "Vanguard Australian Shares ETF", price: 100, currency: "AUD",
    sma50: 80, sma20: 95, rsi: 55, changePct: 1,
    entry: { verdict: "BUY", kind: "buyzone", levels: { invalidation: 90 } },
    conviction: { rating: 5, score: 95 },
  }];
  e.evaluate({ stocks: tempting, crypto: [], fx: { AUD: 0.706 } });
  assert.equal(e.state.positions.length, 0, "USD-only auto-entry: prices are compared raw");
});
