import test from "node:test";
import assert from "node:assert/strict";
import { scorePost } from "../lib/djt/impact.js";
import { explain, explainLaunch } from "../lib/djt/explain.js";
import { detectLaunch } from "../lib/djt/launch.js";

const summarise = (text, source = "truth_social") => {
  const post = { text, source, sourceLabel: source };
  return explain(post, scorePost(post));
};

test("names the mechanism, the subject and the rate", () => {
  const s = summarise("I am imposing a 50% TARIFF on Copper, effective August 1, 2025.");
  assert.match(s, /tariff measure on copper/i);
  assert.match(s, /50%/);
});

test("says who it helps and who it hurts, in plain words", () => {
  const s = summarise("I am imposing a 25% Tariff on all STEEL coming into the United States.");
  assert.match(s, /tailwind for/i);
  assert.match(s, /headwind for/i);
  assert.match(s, /NUE/);
});

test("attributes the post to the right source", () => {
  assert.match(summarise("I am imposing a 50% tariff on copper.", "truth_social"), /^Trump posted/);
  assert.match(summarise("Adjusting Imports of Aluminum.", "whitehouse"), /^The White House published/);
  assert.match(summarise("Adjusting Imports of Aluminum.", "federal_register"), /^A Federal Register filing/);
});

test("a published instrument is described as in force, not as musing", () => {
  // Regression: a Section 232 proclamation read as "stated without a clear
  // commitment" because the modality cues are tuned to "I am imposing".
  const s = summarise("Further Strengthening Actions Taken to Adjust Imports of Aluminum.", "whitehouse");
  assert.match(s, /already in force/i);
  assert.doesNotMatch(s, /without a clear commitment/i);
});

test("a floated idea is not described as a commitment", () => {
  const s = summarise("We are thinking about maybe looking at tariffs on semiconductors.");
  assert.match(s, /floated rather than committed/i);
});

test("an ambiguous direction is flagged, not papered over", () => {
  // Names the lever but not whether it is being applied or lifted. The summary
  // must say so, because the exposure lists flip entirely on that answer.
  const s = summarise("The tariff situation with steel is complicated and has many angles.");
  assert.match(s, /does not make clear whether the measure is being applied or lifted/i);
  assert.match(s, /flip both sides/i);
});

test("a post naming no mechanism at all is described as such", () => {
  // "Trade Policies" matches no mechanism pattern, so there is genuinely
  // nothing to attribute — and the summary should not manufacture one.
  const s = summarise("For decades our Trade Policies encouraged Companies to build overseas.");
  assert.match(s, /No market mechanism or company is named/i);
});

test("never claims a price will move", () => {
  const samples = [
    "I am imposing a 50% TARIFF on Copper, effective August 1.",
    "The Federal Reserve must cut interest rates by 300 basis points NOW.",
    "I have long informed Tim Cook of Apple that iPhones must be built in America.",
    "Further Strengthening Actions Taken to Adjust Imports of Aluminum.",
  ];
  for (const text of samples) {
    const s = summarise(text);
    // Language of forecast, as opposed to language of mechanism.
    assert.doesNotMatch(s, /\bwill (rise|fall|go up|go down|rally|drop|surge|crash)\b/i, s);
    assert.doesNotMatch(s, /\b(buy|sell|short|long) (this|it|now)\b/i, s);
    assert.doesNotMatch(s, /\bguarantee|\bcertain to\b|\bsure thing\b/i, s);
  }
});

test("is always at most two sentences", () => {
  const samples = [
    "I am imposing a 50% TARIFF on Copper and STEEL and cars, effective August 1, $500 billion.",
    "Happy Birthday to a great friend!",
    "The Federal Reserve must cut interest rates NOW. Powell is a disaster.",
  ];
  for (const text of samples) {
    const sentences = summarise(text).split(/(?<=[.!?])\s+/).filter(Boolean);
    assert.ok(sentences.length <= 2, `expected <=2 sentences, got ${sentences.length}: ${summarise(text)}`);
  }
});

test("handles a post with no mechanism and no company without inventing one", () => {
  const s = summarise("Happy Birthday to a great American patriot!");
  assert.match(s, /No market mechanism or company is named/i);
});

test("long exposure lists are truncated rather than dumped", () => {
  const s = summarise("I am imposing a 25% Tariff on all STEEL from Canada.");
  const plus = s.match(/\(\+(\d+) more\)/);
  if (plus) assert.ok(Number(plus[1]) > 0);
  assert.ok(s.length < 400, `summary should stay readable on a lock screen, got ${s.length} chars`);
});

test("launch summary states the latency limit rather than implying an edge", () => {
  const post = { text: "My Official Coin is HERE! Buy $TRUMP now.", source: "truth_social" };
  const s = explainLaunch(post, detectLaunch(post.text));
  assert.match(s, /\$TRUMP/);
  assert.match(s, /5-20 minutes behind/);
  assert.match(s, /not as a chance to be early/i);
});
