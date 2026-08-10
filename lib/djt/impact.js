// Market-impact scoring for Trump posts and presidential actions.
//
// Answers one question: "is this worth interrupting someone for, and what does
// it hit?" It does NOT predict direction of price, magnitude, or duration.
//
// Deterministic and key-free by design — every point is attributable to a named
// component so the UI can show its work (see PRODUCT.md, "show the work, not
// the verdict"). An optional LLM pass may add a rationale line later; it never
// replaces this score.

import { THEMES } from "../catalysts.js";
import { NAMES } from "../universe.js";

// ---------------------------------------------------------------------------
// Mechanisms — levers that actually reprice assets, with who they land on.
// `weight` is the max mechanism points a match can contribute.
// `sign` is the direction for the EXPOSED names when the lever is APPLIED
// (tariffs imposed hurt exposed names → -1). Removal flips it (see polarity()).
// ---------------------------------------------------------------------------
export const MECHANISMS = [
  {
    key: "tariffs", label: "Tariffs / Trade", weight: 40, sign: -1, theme: "tariffs",
    patterns: [
      /\btariffs?\b/i, /\btrade war\b/i, /\bimport (?:tax|duty|duties)\b/i, /\breciprocal\b/i, /\btrade barrier/i,
      // Formal register. The Federal Register and WH proclamations never say
      // "tariff" — they say "adjustment to competition from imports". Without
      // these, the highest-signal source scores as noise.
      /\bsection (?:201|232|301|338)\b/i, /\badjustment to (?:competition from )?imports?\b/i,
      /\bcompetition from imports\b/i, /\bsafeguard measure/i, /\bantidumping\b/i,
      /\bcountervailing dut/i, /\bimport quota/i, /\bduties (?:on|to)\b/i,
      /\bunfair trade practice/i, /\btrade act of 19\d\d\b/i,
    ],
  },
  {
    // Separated from tariffs: a deal that OPENS a market is the opposite trade.
    key: "trade_deal", label: "Trade deal", weight: 34, sign: +1, theme: "tariffs",
    patterns: [/\btrade (?:deal|agreement|pact)\b/i, /\bopens? up\b.{0,40}\bmarket/i, /\bfree trade\b/i],
  },
  {
    key: "fed", label: "Fed / Rates", weight: 40, sign: +1, theme: "fed",
    patterns: [/\bfederal reserve\b/i, /\binterest rates?\b/i, /\brate (?:cut|hike)\b/i, /\bpowell\b/i, /\bfomc\b/i, /\bmonetary policy\b/i, /\bbasis points?\b/i],
  },
  {
    key: "export_controls", label: "Export controls / Chips", weight: 38, sign: -1, theme: "ai_chips",
    patterns: [/\bexport controls?\b/i, /\bchip (?:ban|curb|restriction)/i, /\bentity list\b/i, /\bsemiconductor (?:ban|restriction|policy)/i, /\badvanced chips?\b/i],
  },
  {
    key: "sanctions", label: "Sanctions", weight: 34, sign: -1, theme: "geopolitics",
    patterns: [
      /\bsanctions?\b/i, /\bembargo\b/i, /\bprice cap\b/i, /\bsecondary tariffs?\b/i,
      // The legal instrument behind most sanctions and export controls.
      /\bnational emergency with respect to\b/i, /\bieepa\b/i, /\bblocked property\b/i,
    ],
  },
  {
    key: "energy", label: "Energy / Oil", weight: 32, sign: -1, theme: "energy",
    patterns: [/\bopec\b/i, /\boil price/i, /\bdrill(?:ing)?\b/i, /\bstrategic petroleum\b/i, /\bcrude\b/i, /\bpipeline\b/i, /\blng\b/i],
  },
  {
    key: "crypto", label: "Crypto policy", weight: 32, sign: +1, theme: "crypto_policy",
    patterns: [/\bbitcoin\b/i, /\bcrypto(?:currency)?\b/i, /\bstablecoin\b/i, /\bdigital assets?\b/i, /\bstrategic (?:bitcoin|crypto) reserve\b/i],
  },
  {
    key: "pharma", label: "Drug pricing", weight: 30, sign: -1, theme: null,
    patterns: [/\bdrug pric/i, /\bmost favored nation\b/i, /\bprescription (?:drug|price)/i, /\bbig pharma\b/i],
  },
  {
    key: "defense", label: "Defense", weight: 28, sign: +1, theme: "geopolitics",
    patterns: [
      /\bdefen[cs]e spending\b/i, /\bmilitary budget\b/i, /\bnato\b/i, /\barms (?:deal|sale)/i,
      /\bmissile defen[cs]e\b/i, /\bdefense production act\b/i, /\bmunitions?\b/i,
    ],
  },
  {
    key: "antitrust", label: "Antitrust / Regulatory", weight: 28, sign: -1, theme: null,
    patterns: [/\bantitrust\b/i, /\bbreak (?:up|them up)\b/i, /\bmonopol/i, /\b(?:doj|ftc|sec) (?:will|is|has|should)/i],
  },
  {
    key: "immigration", label: "Immigration / Labor", weight: 24, sign: -1, theme: null,
    patterns: [/\bh-?1b\b/i, /\bwork visas?\b/i, /\bmass deportation/i, /\bimmigration (?:raid|enforcement)/i],
  },
  {
    key: "fiscal", label: "Tax / Fiscal", weight: 30, sign: +1, theme: null,
    patterns: [/\btax (?:cut|hike|rate|reform)/i, /\bcorporate tax\b/i, /\bdebt ceiling\b/i, /\bgovernment shutdown\b/i, /\bstimulus\b/i, /\btariff (?:revenue|dividend)\b/i],
  },
];

// Sector buckets → tickers.
const GROUP_SYMBOLS = {
  semis: ["NVDA", "AMD", "AVGO", "QCOM", "MU", "TXN", "ASML", "TSM", "AMAT", "LRCX", "INTC", "SMH"],
  china: ["BABA", "JD", "PDD", "BIDU", "NIO", "TSM"],
  autos: ["TSLA", "F", "GM", "RIVN", "LCID", "TM"],
  retail: ["WMT", "COST", "HD", "NKE", "TGT"],
  industrials: ["CAT", "BA", "GE", "HON", "DE"],
  banks: ["JPM", "BAC", "WFC", "GS", "MS"],
  growth: ["PLTR", "SNOW", "CRWD", "PANW", "NET", "SHOP", "RBLX", "AFRM", "SOFI", "ARKK"],
  housing: ["DHI", "LEN", "HD"],
  energy: ["XOM", "CVX", "SHEL", "BP", "OXY"],
  crypto: ["COIN", "MSTR", "MARA", "RIOT", "HOOD"],
  pharma: ["LLY", "PFE", "MRK", "ABBV", "JNJ", "NVO", "AZN"],
  defense: ["LMT", "RTX", "BA", "GE", "NOC"],
  bigtech: ["AAPL", "MSFT", "GOOGL", "META", "AMZN", "NFLX"],
  agriculture: ["DE", "ADM"],
  steel: ["NUE", "STLD", "X", "CLF"],
  copper: ["FCX", "SCCO"],
  aluminum: ["AA", "CENX"],
  lumber: ["WY"],
  shipping: ["FDX", "UPS"],
};

// ---------------------------------------------------------------------------
// Subject detection — what the post is actually ABOUT.
//
// This is the fix for the naive version's worst failure: attributing a copper
// tariff to semiconductor stocks because "tariffs" nominally touches chips.
// Tickers are only attributed on positive evidence, and a trade restriction on
// a good is read correctly as *protective* for domestic producers of that good
// and *costly* for the industries that consume it.
// ---------------------------------------------------------------------------
const SUBJECTS = [
  { key: "copper", patterns: [/\bcopper\b/i], protects: ["copper"], harms: ["industrials", "autos"] },
  { key: "steel", patterns: [/\bsteel\b/i], protects: ["steel"], harms: ["autos", "industrials"] },
  { key: "aluminum", patterns: [/\baluminium\b|\baluminum\b/i], protects: ["aluminum"], harms: ["autos", "industrials"] },
  { key: "lumber", patterns: [/\blumber\b|\btimber\b/i], protects: ["lumber"], harms: ["housing"] },
  { key: "semiconductors", patterns: [/\bsemiconductors?\b/i, /\bchips?\b/i, /\bmicrochips?\b/i], protects: [], harms: ["semis"] },
  { key: "pharmaceuticals", patterns: [/\bpharmaceutical/i, /\bmedicines?\b/i, /\bdrugs?\b/i], protects: [], harms: ["pharma"] },
  { key: "autos", patterns: [/\bautomobiles?\b/i, /\bcars?\b/i, /\btrucks?\b/i, /\bauto (?:parts|industry)\b/i, /\bvehicles?\b/i], protects: ["autos"], harms: [] },
  { key: "agriculture", patterns: [/\bfarmers?\b/i, /\bsoybeans?\b/i, /\bagricultur/i, /\bbeef\b/i, /\bcrops?\b/i], protects: ["agriculture"], harms: [] },
  { key: "energy", patterns: [/\boil\b/i, /\bgas\b/i, /\bcrude\b/i, /\benergy\b/i], protects: ["energy"], harms: [] },
  { key: "bigtech", patterns: [/\bbig tech\b/i, /\btech (?:companies|giants)\b/i, /\bdigital (?:services )?tax\b/i], protects: [], harms: ["bigtech"] },
];

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

// Company name → ticker, built once from the app's own universe. Short or
// ambiguous names are excluded: matching "Block", "Arm" or "Sea" as English
// words would fire on almost every post.
// Company names that are also ordinary English words, or too generic to match
// on safely. "Target announced" is a company; "target the tariffs at China" is
// not, and a regex cannot tell them apart — so these never auto-match.
const AMBIGUOUS = new Set([
  "Block", "Arm Holdings", "Sea Limited", "Grab", "GE Aerospace", "Sony", "Shell", "BP", "Visa",
  "Target", "Gap", "Booking", "Match", "Ball", "Host", "Hess", "Corning", "Centene", "Assurant",
  "Best Buy", "First Solar", "Union Pacific", "Public Storage", "Dollar General",
]);
const COMMON_WORD = /^(?:value|growth|energy|health|capital|global|american|national|united|general|standard|premier|liberty|freedom|patriot|victory|advance|equity|principal|paramount|masco|news corp)$/i;

// Built lazily and re-derived whenever the universe grows. server.js calls
// registerSymbols() at boot, expanding NAMES from ~150 curated names to the
// full S&P 1500; an index frozen at import time silently ignored all of them.
let _index = null;
let _indexSize = -1;

function nameIndex() {
  const size = Object.keys(NAMES).length;
  if (_index && _indexSize === size) return _index;

  const out = [];
  for (const [sym, name] of Object.entries(NAMES)) {
    if (!name || AMBIGUOUS.has(name) || COMMON_WORD.test(name)) continue;
    // "Alphabet (A)" -> "Alphabet"; ETFs are never named in posts.
    const clean = name.replace(/\s*\(.*?\)\s*/g, "").replace(/[.,]+$/, "").trim();
    if (clean.length < 5 || /\bETF\b/i.test(clean)) continue;
    out.push([clean, sym]);
  }
  // Colloquial names the formal entries miss - what a post actually says.
  for (const [n, sym] of [["Google", "GOOGL"], ["Alphabet", "GOOGL"], ["Facebook", "META"],
    ["Nvidia", "NVDA"], ["Exxon", "XOM"], ["Boeing", "BA"], ["Apple", "AAPL"],
    ["Amazon", "AMZN"], ["Tesla", "TSLA"], ["Taiwan Semiconductor", "TSM"],
    ["Goldman", "GS"], ["JPMorgan", "JPM"], ["Walmart", "WMT"], ["Micron", "MU"],
    ["Intel", "INTC"], ["Pfizer", "PFE"], ["Eli Lilly", "LLY"]]) out.push([n, sym]);

  // Longest match first, and compile each pattern once rather than per post --
  // at 1,552 names a per-post compile was the scorer's entire cost.
  _index = out
    .sort((a, b) => b[0].length - a[0].length)
    .map(([name, sym]) => [new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), name, sym]);
  _indexSize = size;
  return _index;
}

// Countries that imply a tradeable basket.
const COUNTRY_GROUPS = {
  china: { patterns: [/\bchina\b/i, /\bchinese\b/i, /\bbeijing\b/i], groups: ["china", "semis"] },
  taiwan: { patterns: [/\btaiwan\b/i], groups: ["semis"] },
  mexico: { patterns: [/\bmexico\b/i], groups: ["autos", "agriculture"] },
  canada: { patterns: [/\bcanada\b/i, /\bcanadian\b/i], groups: ["autos", "energy"] },
  eu: { patterns: [/\beuropean union\b/i, /\bthe eu\b/i, /\bgermany\b/i], groups: ["autos", "industrials"] },
  russia: { patterns: [/\brussia\b/i, /\bmoscow\b/i, /\bputin\b/i], groups: ["energy", "defense"] },
  iran: { patterns: [/\biran\b/i], groups: ["energy", "defense"] },
  japan: { patterns: [/\bjapan\b/i], groups: ["autos"] },
  india: { patterns: [/\bindia\b/i], groups: ["bigtech"] },
};

function extractEntities(text) {
  const named = new Set();
  const reasons = [];

  for (const m of text.matchAll(/\$([A-Z]{1,5})\b/g)) { named.add(m[1]); reasons.push(`$${m[1]}`); }

  for (const [re, name, sym] of nameIndex()) {
    if (re.test(text)) {
      named.add(sym);
      reasons.push(name);
      if (named.size >= 6) break;
    }
  }

  // Countries imply a basket only where the trade relationship is concrete.
  const countryGroups = new Set();
  for (const [key, c] of Object.entries(COUNTRY_GROUPS)) {
    if (c.patterns.some((p) => p.test(text))) { c.groups.forEach((g) => countryGroups.add(g)); reasons.push(key); }
  }

  // What the post is about, and who that helps vs hurts.
  const protects = new Set();
  const harms = new Set();
  const subjects = [];
  for (const s of SUBJECTS) {
    if (!s.patterns.some((p) => p.test(text))) continue;
    subjects.push(s.key);
    s.protects.forEach((g) => protects.add(g));
    s.harms.forEach((g) => harms.add(g));
  }

  return { named, countryGroups, protects, harms, subjects, reasons };
}

const expand = (groups) => {
  const out = new Set();
  for (const g of groups) for (const s of GROUP_SYMBOLS[g] || []) out.add(s);
  return out;
};

// ---------------------------------------------------------------------------
// Modality — committed action vs musing. The single biggest noise filter:
// "I am imposing a 50% tariff" and "maybe we should look at tariffs" share
// every keyword and are worlds apart in market consequence.
// ---------------------------------------------------------------------------
const COMMITTED = [
  /\bi (?:am|will be) (?:impos|sign|order|instruct|direct|announc|sett?ing)/i,
  /\bhereby\b/i, /\beffective (?:immediately|at|on)\b/i, /\bhas been signed\b/i,
  /\bi have (?:signed|instructed|directed|ordered|authorized)\b/i,
  /\bexecutive order\b/i, /\bwill be (?:imposed|implemented|enacted|charged)\b/i,
  /\bwill (?:impose|charge|pay|apply|take effect)\b/i, /\bstarting (?:on )?[A-Z]/,
  /\bas of\b/i, /\bi am (?:pleased to )?announc/i, /\bwe are imposing\b/i,
];
const HEDGED = [
  /\bthinking about\b/i, /\bconsidering\b/i, /\bmight\b/i, /\bmaybe\b/i, /\bperhaps\b/i,
  /\bwe'll see\b/i, /\bshould (?:be|have)\b/i, /\bi think\b/i, /\bwould like to\b/i,
  /\blooking (?:at|into)\b/i, /\bprobably\b/i, /\bcould be\b/i,
];

// Applied vs lifted — flips a mechanism's sign.
const APPLY = /\b(?:impos|rais|increas|expand|add(?:ing|ed|s)?\b|hike|introduc|slap|charg|announc|plac|putting|put a|set(?:ting)? a|will be)/i;
const LIFT = /\b(?:remov|lift|cut|lower|reduc|exempt|paus|delay|drop|suspend|waiv|roll(?:ing)? back)/i;

// Mechanisms that work by restricting something. For these, "applied" helps the
// domestic producers of the restricted good and hurts everyone who buys it.
const RESTRICTIVE = new Set(["tariffs", "export_controls", "sanctions", "antitrust", "pharma", "immigration"]);

// Alert threshold, tuned against the full 35k-post archive (scripts/djt-calibrate.js).
//
// The score distribution is bimodal with a natural valley at 30-39 (9 posts in
// 90 days), so anywhere in 30-40 behaves identically. 40 sits in that valley and
// yields ~0.9 alerts/day. Dropping to 25 would roughly double the rate purely by
// admitting the 20-29 band, which on inspection is Daylight Saving Time, book
// plugs and polling numbers — volume that would cost the alert its credibility.
// Override with DJT_BAND_MEDIUM if you want a noisier feed.
export const BAND_MEDIUM = Number(process.env.DJT_BAND_MEDIUM || 40);

// Scoped to the sentence naming the mechanism. Scanning the whole post got this
// backwards constantly — a tariff announcement that also contains the word
// "reduce" three sentences later is still a tariff announcement.
function polarity(text, mech, { committed = false, hasRate = false } = {}) {
  // FIRST matching sentence only. Using every matching sentence read these
  // backwards constantly: "I am adding a 25% Tariff ... Canada must drop their
  // 250% Tariff" contains both cues, and only the first one is the announcement.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const scope = sentences.find((s) => mech.patterns.some((p) => p.test(s))) || text;

  const applied = APPLY.test(scope);
  const lifted = LIFT.test(scope);

  if (applied !== lifted) {
    return lifted
      ? { sign: -mech.sign, cue: "lifted/reduced", confident: true }
      : { sign: mech.sign, cue: "imposed/raised", confident: true };
  }

  // No explicit verb either way. A committed statement naming a rate is an
  // imposition — "a 50% TARIFF on Copper, effective August 1" needs no verb.
  if (!lifted && committed && hasRate) {
    return { sign: mech.sign, cue: "imposed/raised", confident: true };
  }
  return { sign: mech.sign, cue: "direction unclear", confident: false };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
const STOP = new Set("the a an and or but of to in on for with is are was were be been it this that they we you i he she at as by from will would have has had not no so if then than there here what who which when how".split(" "));

function tokens(text) {
  return new Set((text.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !STOP.has(w)));
}

// Jaccard overlap against recent posts; 1.0 = said this before.
function repetition(text, recentTexts) {
  const t = tokens(text);
  if (t.size < 4) return 0;
  let worst = 0;
  for (const prev of recentTexts) {
    const p = tokens(prev);
    if (!p.size) continue;
    let inter = 0;
    for (const w of t) if (p.has(w)) inter++;
    const j = inter / (t.size + p.size - inter);
    if (j > worst) worst = j;
  }
  return worst;
}

/**
 * Score one post.
 * @param {{text:string, ts?:number|string, source?:string}} post
 * @param {{recentTexts?:string[]}} ctx  Prior posts, for the novelty component.
 * @returns {{score:number, band:string, components:object, tickers:string[], mechanisms:object[], direction:string, why:string[]}}
 */
export function scorePost(post, ctx = {}) {
  const text = (post.text || "").trim();
  const why = [];

  // A third of the archive is retruths / media-only with no text. Nothing to score.
  if (text.length < 15) {
    return { score: 0, band: "low", components: {}, tickers: [], mechanisms: [], direction: "n/a", why: ["no text content"], skipped: true };
  }

  // --- 1. Mechanism (0-40): the strongest lever named wins, others add a little.
  const hits = MECHANISMS.filter((m) => m.patterns.some((p) => p.test(text)));
  let mechanism = 0;
  if (hits.length) {
    hits.sort((a, b) => b.weight - a.weight);
    mechanism = hits[0].weight + Math.min(8, (hits.length - 1) * 4);
    mechanism = Math.min(40, mechanism);
    why.push(`mechanism: ${hits.map((h) => h.label).join(" + ")}`);
  }

  // --- 2. Entities (0-25): evidence-led attribution.
  // A mechanism on its own attributes NOTHING. "Tariffs" with no subject and no
  // counterparty is a talking point, not a trade — the earlier version's habit
  // of tagging every tariff post with the whole semiconductor complex was the
  // single worst thing about it.
  const ent = extractEntities(text);
  const primary = hits[0];

  // Needed by polarity, so computed before the components that report them.
  const committedFlag = COMMITTED.some((p) => p.test(text));
  const hedgedFlag = HEDGED.some((p) => p.test(text));
  const hasRate = /\d+(?:\.\d+)?\s?%/.test(text);

  const pol = primary
    ? polarity(text, primary, { committed: committedFlag, hasRate })
    : { sign: 0, cue: "n/a", confident: false };

  const bullish = new Set();
  const bearish = new Set();

  if (primary && RESTRICTIVE.has(primary.key)) {
    const applied = pol.cue !== "lifted/reduced";
    expand(applied ? ent.protects : ent.harms).forEach((s) => bullish.add(s));
    expand(applied ? ent.harms : ent.protects).forEach((s) => bearish.add(s));
    // The counterparty economy takes the other side of an applied restriction.
    expand(ent.countryGroups).forEach((s) => (applied ? bearish : bullish).add(s));
  } else if (primary) {
    expand(ent.countryGroups).forEach((s) => (pol.sign > 0 ? bullish : bearish).add(s));
  }

  // A post can name a good that protects an industry AND a good that industry
  // consumes (steel + autos in one tariff). Claiming both sides for the same
  // ticker is worse than claiming neither — net them out and say so.
  const mixed = [...bullish].filter((s) => bearish.has(s));
  for (const s of mixed) { bullish.delete(s); bearish.delete(s); }
  if (mixed.length) why.push(`mixed exposure: ${mixed.slice(0, 5).join(" ")}`);

  let entities = 0;
  if (ent.named.size) entities += Math.min(18, 10 + ent.named.size * 4);
  if (ent.subjects.length) entities += Math.min(7, ent.subjects.length * 4);
  else if (ent.countryGroups.size) entities += 3;
  entities = Math.min(25, entities);
  if (ent.reasons.length) why.push(`names: ${[...new Set(ent.reasons)].slice(0, 5).join(", ")}`);
  if (ent.subjects.length) why.push(`subject: ${ent.subjects.join(", ")}`);

  // --- 3. Modality (0-15)
  let modality = 0;
  if (committedFlag && !hedgedFlag) { modality = 15; why.push("committed language"); }
  else if (committedFlag && hedgedFlag) { modality = 8; why.push("mixed commitment"); }
  else if (hedgedFlag) { modality = 2; why.push("hedged / musing"); }
  else modality = 6;

  // --- 4. Specificity (0-10)
  let specificity = 0;
  if (hasRate) { specificity += 5; why.push("names a rate"); }
  if (/\$\s?\d/.test(text) || /\b\d+\s?(?:billion|trillion|million)\b/i.test(text)) { specificity += 3; why.push("names an amount"); }
  if (/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/i.test(text) || /\bdeadline\b/i.test(text)) { specificity += 2; why.push("names a date"); }
  specificity = Math.min(10, specificity);

  // --- 5. Novelty (0-10): recurring talking points decay toward zero.
  const rep = repetition(text, ctx.recentTexts || []);
  const novelty = Math.round(10 * (1 - Math.min(1, rep / 0.55)));
  if (rep > 0.4) why.push("repeats a recent post");

  const raw = mechanism + entities + modality + specificity + novelty;

  // No mechanism and no named company means it isn't market news, whatever else
  // it scored on. Cap hard rather than letting modality + specificity carry a
  // rant about a golf tournament into the alert band.
  const score = (!hits.length && !ent.named.size) ? Math.min(raw, 25) : raw;

  const direction = !primary ? "n/a" : !pol.confident ? "unclear" : pol.sign > 0 ? "bullish" : "bearish";
  if (primary) why.push(`${pol.cue}${pol.confident ? ` → ${direction} for exposed names` : ""}`);

  const named = [...ent.named];
  const tickers = [...new Set([...named, ...bullish, ...bearish])].slice(0, 12);

  return {
    score,
    band: score >= 70 ? "high" : score >= BAND_MEDIUM ? "medium" : "low",
    components: { mechanism, entities, modality, specificity, novelty },
    tickers,
    named,
    bullish: [...bullish].slice(0, 8),
    bearish: [...bearish].slice(0, 8),
    mixed,
    subjects: ent.subjects,
    mechanisms: hits.map((h) => ({ key: h.key, label: h.label, theme: h.theme ? THEMES[h.theme]?.label : null })),
    direction,
    why,
  };
}

// Easter Sunday (Anonymous Gregorian algorithm) — only needed for Good Friday,
// the one NYSE holiday that isn't a fixed date or an nth weekday.
function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return { month, day: ((h + l - 7 * m + 114) % 31) + 1 };
}

// nth (1-indexed) given weekday of a month; n = -1 means the last one.
function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDate = new Date(Date.UTC(year, month, 0));
  return lastDate.getUTCDate() - ((lastDate.getUTCDay() - weekday + 7) % 7);
}

// Saturday holidays observe Friday, Sunday holidays observe Monday.
function observed(year, month, day) {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (dow === 6) return [month, day - 1];
  if (dow === 0) return [month, day + 1];
  return [month, day];
}

// NYSE full-day closures. Half days (July 3, day after Thanksgiving, Christmas
// Eve) still trade, so they are deliberately not here.
function isMarketHoliday(year, month, day) {
  const fixed = [[1, 1], [6, 19], [7, 4], [12, 25]].map(([m, d]) => observed(year, m, d));
  const e = easter(year);
  const goodFriday = new Date(Date.UTC(year, e.month - 1, e.day - 2));
  const floating = [
    [1, nthWeekday(year, 1, 1, 3)],   // MLK Day — 3rd Monday of January
    [2, nthWeekday(year, 2, 1, 3)],   // Presidents' Day — 3rd Monday of February
    [5, nthWeekday(year, 5, 1, -1)],  // Memorial Day — last Monday of May
    [9, nthWeekday(year, 9, 1, 1)],   // Labor Day — 1st Monday of September
    [11, nthWeekday(year, 11, 4, 4)], // Thanksgiving — 4th Thursday of November
    [goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate()],
  ];
  return [...fixed, ...floating].some(([m, d]) => m === month && d === day);
}

// US market session for a timestamp — changes how a headline should be read.
export function marketSession(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";

  // Read the wall clock in New York. Intl gives the parts directly, which
  // avoids the locale-string round-trip the first version relied on.
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour12: false,
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short",
    }).formatToParts(d).map((x) => [x.type, x.value])
  );

  if (p.weekday === "Sat" || p.weekday === "Sun") return "weekend";
  if (isMarketHoliday(+p.year, +p.month, +p.day)) return "market holiday";

  const mins = (+p.hour % 24) * 60 + +p.minute;
  if (mins < 240) return "overnight";
  if (mins < 570) return "pre-market";   // 04:00–09:29
  if (mins < 960) return "market hours"; // 09:30–15:59
  if (mins < 1200) return "after-hours"; // 16:00–19:59
  return "overnight";
}
