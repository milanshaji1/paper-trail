import test from "node:test";
import assert from "node:assert/strict";
import { scorePost, marketSession, BAND_MEDIUM } from "../lib/djt/impact.js";

const score = (text, ctx) => scorePost({ text }, ctx);

test("retruths and media-only posts are skipped, not scored", () => {
  for (const t of ["", "   ", "RT"]) {
    const r = score(t);
    assert.equal(r.score, 0);
    assert.equal(r.skipped, true);
  }
});

test("a committed, specific tariff announcement lands in the alert band", () => {
  const r = score(
    "I am announcing a 50% TARIFF on Copper, effective August 1, 2025, after receiving a robust NATIONAL SECURITY ASSESSMENT."
  );
  assert.ok(r.score >= BAND_MEDIUM, `expected alert-worthy, got ${r.score}`);
  assert.equal(r.mechanisms[0].key, "tariffs");
  assert.equal(r.components.modality, 15, "committed language should max modality");
  assert.ok(r.components.specificity >= 5, "a named rate and date should score specificity");
});

test("regression: a copper tariff hits copper miners, not semiconductors", () => {
  // The naive version tagged every tariff post with the whole semi complex
  // because "tariffs" nominally touches chips. Attribution must be evidence-led.
  const r = score("I am imposing a 50% TARIFF on Copper, effective August 1.");
  assert.ok(r.bullish.includes("FCX"), "domestic copper producers are protected");
  assert.ok(!r.tickers.includes("NVDA"), "must not attribute copper policy to NVDA");
  assert.ok(!r.tickers.includes("ASML"), "must not attribute copper policy to ASML");
  assert.deepEqual(r.subjects, ["copper"]);
});

test("a restriction protects domestic producers and hurts consumers of the input", () => {
  const r = score("I will be imposing a 25% Tariff on all STEEL coming into the United States.");
  assert.ok(r.bullish.includes("NUE"), "domestic steel benefits");
  assert.ok(r.bearish.includes("F") || r.bearish.includes("GM"), "steel consumers are hurt");
});

test("lifting a restriction flips the direction", () => {
  const applied = score("I am imposing new Tariffs on Chinese semiconductors.");
  const lifted = score("I am removing the Tariffs on Chinese semiconductors.");
  assert.equal(applied.direction, "bearish");
  assert.equal(lifted.direction, "bullish");
});

test("an announcement with a rate is 'applied' even with no imposing verb", () => {
  // "I am announcing a 50% TARIFF on Copper, effective August 1" has no
  // impose/raise verb, and the naive rule called it unclear.
  const r = score("I am announcing a 50% TARIFF on Copper, effective August 1, 2025.");
  assert.equal(r.direction, "bearish");
});

test("polarity reads the first matching sentence, not every one", () => {
  // The second sentence's "drop their Tariff" must not cancel the first
  // sentence's announcement.
  const r = score(
    "I have instructed my Secretary of Commerce to add an ADDITIONAL 25% Tariff on all STEEL from Canada. " +
    "Also, Canada must immediately drop their Anti-American Farmer Tariff of 250%."
  );
  assert.equal(r.direction, "bearish");
  assert.ok(r.bullish.includes("NUE"));
});

test("a ticker on both sides is reported as mixed, never as both", () => {
  // Steel tariffs protect steelmakers and hurt carmakers; a post naming autos
  // too must not claim autos are simultaneously helped and hurt.
  const r = score("I am imposing a 25% Tariff on all STEEL and on foreign cars and trucks.");
  const overlap = r.bullish.filter((s) => r.bearish.includes(s));
  assert.deepEqual(overlap, [], "bullish and bearish must be disjoint");
  assert.ok(r.mixed.length > 0, "the contested names should be surfaced as mixed");
});

test("hedged musing scores far below the equivalent commitment", () => {
  const committed = score("I am imposing a 50% tariff on semiconductors, effective immediately.");
  const hedged = score("We are thinking about maybe looking at tariffs on semiconductors.");
  assert.ok(committed.score > hedged.score + 10, `${committed.score} vs ${hedged.score}`);
  assert.equal(hedged.components.modality, 2);
});

test("no mechanism and no named company is capped below the alert band", () => {
  const r = score(
    "I have signed an order, effective immediately, on the Reflecting Pool at the National Mall, a 100% disgrace!"
  );
  assert.ok(r.score <= 25, `expected cap, got ${r.score}`);
  assert.ok(r.score < BAND_MEDIUM);
});

test("direction is reported as unclear rather than guessed", () => {
  const r = score("For decades our Trade Policies encouraged Companies to build overseas.");
  assert.ok(["unclear", "n/a"].includes(r.direction));
});

test("repeating a recent post collapses the novelty component", () => {
  const text = "I am imposing a 50% tariff on copper, effective August 1, a great day for America.";
  const fresh = score(text, { recentTexts: ["Congratulations to the Great State of Ohio."] });
  const repeat = score(text, { recentTexts: [text] });
  assert.equal(repeat.components.novelty, 0);
  assert.ok(fresh.components.novelty > repeat.components.novelty);
});

test("explicitly named companies are extracted", () => {
  const r = score("I have long ago informed Tim Cook of Apple that iPhones must be built in America, or face a 25% Tariff.");
  assert.ok(r.named.includes("AAPL"));
});

test("every score component stays inside its documented range", () => {
  const samples = [
    "I am imposing a 100% tariff on all semiconductors from China, effective immediately, $500 billion.",
    "Happy Birthday to a great friend!",
    "The Federal Reserve must cut interest rates by 300 basis points NOW. Powell is a disaster.",
  ];
  for (const s of samples) {
    const c = score(s).components;
    assert.ok(c.mechanism >= 0 && c.mechanism <= 40, `mechanism ${c.mechanism}`);
    assert.ok(c.entities >= 0 && c.entities <= 25, `entities ${c.entities}`);
    assert.ok(c.modality >= 0 && c.modality <= 15, `modality ${c.modality}`);
    assert.ok(c.specificity >= 0 && c.specificity <= 10, `specificity ${c.specificity}`);
    assert.ok(c.novelty >= 0 && c.novelty <= 10, `novelty ${c.novelty}`);
  }
});

test("marketSession maps timestamps to US trading sessions", () => {
  // 14:30 UTC on a Wednesday = 10:30 ET = regular hours.
  assert.equal(marketSession("2026-08-05T14:30:00Z"), "market hours");
  // 09:00 UTC = 05:00 ET = pre-market.
  assert.equal(marketSession("2026-08-05T09:00:00Z"), "pre-market");
  // Saturday.
  assert.equal(marketSession("2026-08-01T16:00:00Z"), "weekend");
});

test("the partial-JSON walker is not fooled by braces inside strings", async () => {
  const { parsePartialArray } = await import("../lib/djt/sources.js");
  const chunk = '[\n {"id":"1","content":"a }, b","created_at":"2026-01-01T00:00:00Z","url":"u"},\n {"id":"2","content":"trunc';
  const out = parsePartialArray(chunk);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, "a }, b", "a '}, ' inside a string must not end the object");
});

test("entity decoding handles numeric and hex entities generically", async () => {
  const { decode } = await import("../lib/djt/sources.js");
  // The White House feed is full of these; enumerating them one at a time
  // always misses one, so the decoder is generic.
  assert.equal(decode("1.&#160;Section 338"), "1. Section 338");
  // U+2019 is a curly right single quote — decoded faithfully, not flattened
  // to an ASCII apostrophe.
  assert.equal(decode("Trump&#8217;s plan"), "Trump’s plan");
  assert.equal(decode("&#x27;quoted&#x27;"), "'quoted'");
  assert.equal(decode("<p>tags <b>stripped</b></p>"), "tags stripped");
  // &amp; is unescaped last so a double-escaped entity survives intact.
  assert.equal(decode("Tom &amp;lt; Jerry"), "Tom &lt; Jerry");
});

test("byte-range fetch yields usable newest-first posts", async () => {
  const { parsePartialArray } = await import("../lib/djt/sources.js");
  assert.deepEqual(parsePartialArray("[\n {\"id\":\"trunc"), [], "no complete object yet");
  assert.deepEqual(parsePartialArray(""), []);
});

test("market holidays are not reported as trading sessions", () => {
  // Regression: the naive version returned "market hours" on Christmas Day.
  assert.equal(marketSession("2026-12-25T15:00:00Z"), "market holiday");
  assert.equal(marketSession("2026-11-26T15:00:00Z"), "market holiday", "Thanksgiving");
  assert.equal(marketSession("2026-04-03T15:00:00Z"), "market holiday", "Good Friday");
  assert.equal(marketSession("2026-01-19T15:00:00Z"), "market holiday", "MLK Day");
  // July 4 2026 falls on a Saturday, so the market closes Friday July 3.
  assert.equal(marketSession("2026-07-03T15:00:00Z"), "market holiday", "observed July 4");
  // A normal trading day must still read as trading.
  assert.equal(marketSession("2026-08-05T15:00:00Z"), "market hours");
});

test("marketSession degrades instead of throwing on bad input", () => {
  assert.equal(marketSession("not-a-date"), "unknown");
  assert.equal(marketSession(undefined), "unknown");
});

test("the company-name index tracks a universe that grows at runtime", async () => {
  // Regression: the index was built once at import, so every symbol added by
  // registerSymbols() at boot (~1,400 of them) was invisible to the scorer.
  const u = await import("../lib/universe.js");
  const text = "I am imposing a 50% tariff on Acme Widget Corporation products.";
  assert.deepEqual(score(text).named, [], "unknown company before registration");
  u.registerSymbols([{ symbol: "ACME", name: "Acme Widget Corporation" }]);
  assert.deepEqual(score(text).named, ["ACME"], "index must pick up the new symbol");
});

test("company names that are ordinary words never auto-match", () => {
  for (const t of [
    "We will target the Radical Left and close the gap on crime.",
    "Our capital and energy sectors have never been stronger. A great value!",
  ]) {
    assert.deepEqual(score(t).named, [], `false positive on: ${t}`);
  }
});
