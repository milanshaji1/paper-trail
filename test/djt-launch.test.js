import test from "node:test";
import assert from "node:assert/strict";
import { detectLaunch } from "../lib/djt/launch.js";

// The real $TRUMP mint, from the 17 Jan 2025 launch.
const TRUMP_MINT = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";

test("a bare Solana mint address is a high-confidence launch", () => {
  const r = detectLaunch(`My Official Trump Meme is HERE! ${TRUMP_MINT}`);
  assert.equal(r.found, true);
  assert.equal(r.confidence, "high");
  assert.deepEqual(r.addresses, [{ chain: "solana", address: TRUMP_MINT }]);
});

test("an EVM contract address is detected", () => {
  const r = detectLaunch("Get in now: 0x532f27101965dd16442E59d40670FaF5eBB142E4");
  assert.equal(r.confidence, "high");
  assert.deepEqual(r.addresses, [{ chain: "evm", address: "0x532f27101965dd16442E59d40670FaF5eBB142E4" }]);
});

test("a launchpad link is dispositive and yields the mint from its path", () => {
  const r = detectLaunch(`Live now https://pump.fun/coin/${TRUMP_MINT} — the GREATEST!`);
  assert.equal(r.confidence, "high");
  assert.ok(r.platforms.includes("pump.fun"));
  assert.ok(r.addresses.some((a) => a.address === TRUMP_MINT));
});

test("dexscreener and birdeye links count as launch signals", () => {
  assert.equal(detectLaunch("https://dexscreener.com/solana/abc123").found, true);
  assert.equal(detectLaunch(`https://birdeye.so/token/${TRUMP_MINT}`).found, true);
});

test("launch phrasing plus a cashtag is medium confidence, not high", () => {
  const r = detectLaunch("My Official Coin is here! Buy $TRUMP now, the greatest of them all!");
  assert.equal(r.found, true);
  assert.equal(r.confidence, "medium", "no address means it is not confirmable");
  assert.ok(r.cashtags.includes("TRUMP"));
});

test("ordinary political posts are not launches", () => {
  const posts = [
    "The Radical Left has done nothing but obstruct. We will WIN BIG in November!",
    "I am imposing a 50% TARIFF on Copper, effective August 1, 2025.",
    "Happy Birthday to a great American patriot!",
    "Our economy added 250,000 jobs and the market is up $2 Trillion Dollars.",
  ];
  for (const p of posts) assert.equal(detectLaunch(p).found, false, `false positive: ${p}`);
});

test("a bare cashtag without launch phrasing is not a launch", () => {
  // He says "$TRUMP" about himself and about the economy constantly.
  const r = detectLaunch("The $TRUMP economy is the greatest in history!");
  assert.equal(r.found, false);
});

test("long non-address tokens do not trip the base58 matcher", () => {
  const posts = [
    "Visit https://www.whitehouse.gov/presidential-actions/restoring-american-maritime-dominance/",
    "#MakeAmericaGreatAgainAndAgainAndAgainForever2026",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // 36 chars, single case, no digits
  ];
  for (const p of posts) {
    assert.deepEqual(detectLaunch(p).addresses, [], `false address in: ${p}`);
  }
});

test("dollar amounts and common words are not treated as cashtags", () => {
  const r = detectLaunch("My Official Coin! We saved $100 Billion and $2 Trillion in USD.");
  assert.ok(!r.cashtags.includes("USD"));
  assert.deepEqual(r.cashtags.filter((c) => /^\d/.test(c)), []);
});

test("every detection reports why it fired", () => {
  const r = detectLaunch(`Official Trump Meme! ${TRUMP_MINT} on pump.fun`);
  assert.ok(r.reasons.length > 0);
  assert.match(r.reasons.join(" "), /contract address/);
});

test("regression: a mint welded to a stripped hyperlink is still extracted", () => {
  // Verbatim from the archive — the real $MELANIA launch, 19 Jan 2025. HTML
  // stripping removed the <a> tag, leaving "Melaniameme.com" fused to the mint
  // with no word boundary, which a \b-anchored match cannot see.
  const post =
    "RT @MelaniaTrumpThe Official Melania Meme is live!You can buy $MELANIA now.  " +
    "Melaniameme.comFUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P";
  const r = detectLaunch(post);
  assert.equal(r.confidence, "high");
  assert.deepEqual(r.addresses, [
    { chain: "solana", address: "FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P" },
  ]);
});

test("the real $TRUMP launch post is caught, at the confidence it deserves", () => {
  // Verbatim, 18 Jan 2025. Note it contains NO contract address — just a
  // website — so medium is the honest verdict, not a miss.
  const post =
    "My NEW Official Trump Meme is HERE! It's time to celebrate everything we " +
    "stand for: WINNING! Join my very special Trump Community. GET YOUR $TRUMP " +
    "NOW. Go to http://gettrumpmemes.com/ — Have Fun!";
  const r = detectLaunch(post);
  assert.equal(r.found, true);
  assert.equal(r.confidence, "medium");
  assert.ok(r.cashtags.includes("TRUMP"));
});
