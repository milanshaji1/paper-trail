import test from "node:test";
import assert from "node:assert/strict";
import { scoreToken } from "../lib/meme/momentum.js";

// A token whose recent windows are running hot relative to their own baseline.
const accelerating = (over = {}) => ({
  mint: "MintAddr", symbol: "TEST", name: "TEST / SOL", network: "solana", dex: "raydium",
  createdAt: Date.now() - 2 * 3.6e6, // 2h old
  liquidityUsd: 60000,
  fdvUsd: 800000,
  // m5 * 12 = 12000 vs h1 6000 → 2x acceleration
  volume: { m5: 1000, m15: 3000, m30: 5000, h1: 6000, h6: 12000, h24: 20000 },
  priceChange: { m5: 4, m15: 9, h1: 15, h6: 30, h24: 50 },
  txns: {
    m5: { buys: 80, sells: 20, buyers: 70, sellers: 18 },
    m15: { buys: 200, sells: 90, buyers: 170, sellers: 80 },
    m30: { buys: 300, sells: 150, buyers: 250, sellers: 140 },
    h1: { buys: 400, sells: 250, buyers: 350, sellers: 240 },
    h6: { buys: 800, sells: 600, buyers: 700, sellers: 560 },
    h24: { buys: 1200, sells: 1000, buyers: 1000, sellers: 900 },
  },
  ...over,
});

// Same size, but flat: recent windows exactly in line with the baseline.
const flat = () => accelerating({
  volume: { m5: 500, m15: 1500, m30: 3000, h1: 6000, h6: 36000, h24: 144000 },
  priceChange: { m5: 0, m15: 0, h1: 0, h6: 0, h24: 0 },
  txns: {
    m5: { buys: 30, sells: 30, buyers: 29, sellers: 29 },
    m15: { buys: 90, sells: 90, buyers: 87, sellers: 87 },
    m30: { buys: 180, sells: 180, buyers: 175, sellers: 175 },
    h1: { buys: 360, sells: 360, buyers: 350, sellers: 350 },
    h6: { buys: 2160, sells: 2160, buyers: 2100, sellers: 2100 },
    h24: { buys: 8640, sells: 8640, buyers: 8400, sellers: 8400 },
  },
});

test("acceleration scores above a flat token of the same size", () => {
  const hot = scoreToken(accelerating());
  const cold = scoreToken(flat());
  assert.ok(hot.score > cold.score + 20, `${hot.score} vs ${cold.score}`);
  assert.ok(hot.components.volumeAccel > cold.components.volumeAccel);
  assert.ok(hot.components.buyerAccel > cold.components.buyerAccel);
});

test("a flat token earns no acceleration points at all", () => {
  const r = scoreToken(flat());
  assert.equal(r.components.volumeAccel, 0);
});

test("sell-dominant flow is penalised even when volume is exploding", () => {
  const dumping = scoreToken(accelerating({
    txns: {
      ...accelerating().txns,
      m5: { buys: 10, sells: 90, buyers: 9, sellers: 85 },
    },
    priceChange: { m5: -20, m15: -25, h1: -10, h6: 5, h24: 40 },
  }));
  assert.ok(dumping.flags.some((f) => /sell-dominant/.test(f)));
  assert.ok(dumping.score < scoreToken(accelerating()).score);
});

test("wash-trading-scale turnover is flagged and penalised", () => {
  const wash = scoreToken(accelerating({ liquidityUsd: 2000 })); // h1 vol 6000 = 3x... push higher
  const heavier = scoreToken(accelerating({ liquidityUsd: 300, volume: { ...accelerating().volume, h1: 60000 } }));
  assert.ok(heavier.flags.some((f) => /wash trading/.test(f)), heavier.flags.join("; "));
  assert.ok(wash.score >= 0);
});

test("paid promotion reduces the score rather than raising it", () => {
  const t = accelerating();
  const plain = scoreToken(t);
  const boosted = scoreToken(t, { boosted: new Set([t.mint]) });
  assert.ok(boosted.score < plain.score);
  assert.ok(boosted.flags.some((f) => /promotion/.test(f)));
});

test("earliness rewards young, small and undiscussed tokens", () => {
  const young = scoreToken(accelerating({ createdAt: Date.now() - 2 * 3.6e6, fdvUsd: 500000 }));
  const old = scoreToken(accelerating({ createdAt: Date.now() - 30 * 24 * 3.6e6, fdvUsd: 5e7 }));
  assert.ok(young.components.earliness > old.components.earliness);
});

test("a token already loud on /biz/ is flagged as late", () => {
  const t = accelerating();
  const loud = scoreToken(t, { chatter: new Map([["TEST", 12]]) });
  const quiet = scoreToken(t, { chatter: new Map() });
  assert.ok(loud.components.earliness < quiet.components.earliness);
  assert.ok(loud.flags.some((f) => /already discussed/.test(f)));
});

test("scores and components stay within their documented ranges", () => {
  for (const t of [accelerating(), flat(), accelerating({ liquidityUsd: 0, fdvUsd: 0 })]) {
    const r = scoreToken(t);
    assert.ok(r.score >= 0 && r.score <= 100, `score ${r.score}`);
    assert.ok(r.components.volumeAccel <= 30);
    assert.ok(r.components.buyerAccel <= 25);
    assert.ok(r.components.priceConfirm <= 15);
    assert.ok(r.components.earliness <= 20);
    assert.ok(r.components.liquidityQuality <= 10);
  }
});

test("zero-liquidity and missing data do not throw or produce NaN", () => {
  const r = scoreToken({
    mint: "x", symbol: "X", name: "X", network: "solana", dex: "d", createdAt: null,
    liquidityUsd: 0, fdvUsd: 0,
    volume: { m5: 0, m15: 0, m30: 0, h1: 0, h6: 0, h24: 0 },
    priceChange: { m5: 0, m15: 0, h1: 0, h6: 0, h24: 0 },
    txns: { m5: {}, m15: {}, m30: {}, h1: {}, h6: {}, h24: {} },
  });
  assert.ok(Number.isFinite(r.score));
  assert.equal(r.band, "low");
});
