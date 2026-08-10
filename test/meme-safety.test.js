import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, evaluateEvm, LIMITS, canVerify } from "../lib/meme/safety.js";

// A Solana report that clears every check, to mutate per-case.
const goodSol = () => ({
  rugged: false,
  mintAuthority: null,
  freezeAuthority: null,
  totalHolders: 5000,
  score_normalised: 5,
  topHolders: Array.from({ length: 10 }, () => ({ pct: 2 })), // 20% total
  markets: [{ lp: { lpLockedPct: 90 } }],
  insiderNetworks: [],
  risks: [],
});

// An EVM report that clears every check.
const goodEvm = () => ({
  is_honeypot: "0", cannot_sell_all: "0", transfer_pausable: "0", is_mintable: "0",
  can_take_back_ownership: "0", hidden_owner: "0", selfdestruct: "0", is_blacklisted: "0",
  honeypot_with_same_creator: "0", is_open_source: "1", is_proxy: "0",
  buy_tax: "0", sell_tax: "0", owner_percent: "0.01", creator_percent: "0.01",
  holder_count: "5000", lp_holder_count: "20",
});

const token = { liquidityUsd: 50000, network: "solana" };

test("a clean Solana token passes", () => {
  const r = evaluate(goodSol(), token);
  assert.equal(r.pass, true, r.reasons.join("; "));
  assert.deepEqual(r.reasons, []);
});

test("live mint or freeze authority is disqualifying", () => {
  for (const field of ["mintAuthority", "freezeAuthority"]) {
    const r = evaluate({ ...goodSol(), [field]: "SomeAuthorityPubkey" }, token);
    assert.equal(r.pass, false);
    assert.match(r.reasons.join(" "), /authority still live/);
  }
});

test("an already-rugged token is disqualifying", () => {
  const r = evaluate({ ...goodSol(), rugged: true }, token);
  assert.equal(r.pass, false);
  assert.match(r.reasons.join(" "), /already rugged/);
});

test("concentrated supply is disqualifying", () => {
  const rep = { ...goodSol(), topHolders: Array.from({ length: 10 }, () => ({ pct: 9 })) }; // 90%
  const r = evaluate(rep, token);
  assert.equal(r.pass, false);
  assert.match(r.reasons.join(" "), /top-10 hold 90%/);
});

test("too few holders and thin liquidity are disqualifying", () => {
  assert.equal(evaluate({ ...goodSol(), totalHolders: 3 }, token).pass, false);
  assert.equal(evaluate(goodSol(), { ...token, liquidityUsd: 100 }).pass, false);
});

test("insider networks warn but do not disqualify", () => {
  // Regression: rejecting on this filtered out BONK (2.0M holders, risk 7) and
  // WIF (770k holders, risk 1) — i.e. every token that has actually worked.
  const r = evaluate({ ...goodSol(), insiderNetworks: [{}, {}], graphInsidersDetected: 2 }, token);
  assert.equal(r.pass, true, r.reasons.join("; "));
  assert.match(r.warnings.join(" "), /insider network/);
});

test("RugCheck danger rejects, warn only warns", () => {
  const danger = evaluate({ ...goodSol(), risks: [{ name: "LP Unlocked", level: "danger" }] }, token);
  assert.equal(danger.pass, false);

  const warn = evaluate({ ...goodSol(), risks: [{ name: "Low amount of LP", level: "warn" }] }, token);
  assert.equal(warn.pass, true);
  assert.match(warn.warnings.join(" "), /Low amount of LP/);
});

test("a clean EVM token passes", () => {
  const r = evaluateEvm(goodEvm(), { liquidityUsd: 50000 });
  assert.equal(r.pass, true, r.reasons.join("; "));
});

test("honeypots and unsellable tokens are disqualifying", () => {
  for (const field of ["is_honeypot", "cannot_sell_all", "transfer_pausable", "is_blacklisted"]) {
    const r = evaluateEvm({ ...goodEvm(), [field]: "1" }, { liquidityUsd: 50000 });
    assert.equal(r.pass, false, `${field} should disqualify`);
  }
});

test("a confiscatory sell tax is disqualifying, a small one only warns", () => {
  const big = evaluateEvm({ ...goodEvm(), sell_tax: "0.5" }, { liquidityUsd: 50000 });
  assert.equal(big.pass, false);
  assert.match(big.reasons.join(" "), /sell tax 50\.0%/);

  const small = evaluateEvm({ ...goodEvm(), sell_tax: "0.02" }, { liquidityUsd: 50000 });
  assert.equal(small.pass, true);
  assert.match(small.warnings.join(" "), /tax/);
});

test("an unverified contract is disqualifying", () => {
  const r = evaluateEvm({ ...goodEvm(), is_open_source: "0" }, { liquidityUsd: 50000 });
  assert.equal(r.pass, false);
  assert.match(r.reasons.join(" "), /source not verified/);
});

test("GoPlus 0/1 flags are read as both strings and numbers", () => {
  assert.equal(evaluateEvm({ ...goodEvm(), is_honeypot: 1 }, { liquidityUsd: 5e4 }).pass, false);
  assert.equal(evaluateEvm({ ...goodEvm(), is_honeypot: "1" }, { liquidityUsd: 5e4 }).pass, false);
});

test("only chains with a safety provider are verifiable", () => {
  assert.equal(canVerify("solana"), true);
  assert.equal(canVerify("base"), true);
  assert.equal(canVerify("sui"), false);
});

test("thresholds are configurable and sane by default", () => {
  assert.ok(LIMITS.minLiquidityUsd > 0);
  assert.ok(LIMITS.maxTop10Pct > 0 && LIMITS.maxTop10Pct <= 100);
});

test("bidi/zero-width characters in a token name are disqualifying", async () => {
  const { nameRisk } = await import("../lib/meme/safety.js");
  // Caught live on GeckoTerminal: a pool named with U+202E (RTL override).
  assert.ok(nameRisk({ name: "‮WW", symbol: "WW" }).length > 0);
  assert.ok(nameRisk({ name: "SOL​test", symbol: "X" }).length > 0);
  assert.deepEqual(nameRisk({ name: "Bonk", symbol: "BONK" }), []);
});
