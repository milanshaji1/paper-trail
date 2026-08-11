// Plain-English "so what" for a scored item.
//
// The alert already shows a score, tickers and a component breakdown, but that
// asks the reader to do the interpretation at the exact moment they are least
// able to — on a lock screen, half asleep. This turns the structured output of
// the scorer into two sentences: what happened, and who it lands on.
//
// Deterministic and key-free, built only from what the scorer already derived.
// Nothing here predicts a price. It describes the MECHANISM's direction of
// pressure on exposed companies, which is a statement about cause and effect,
// not a forecast — and when the wording does not support even that, it says so
// rather than inventing a direction.

const SOURCE_VERB = {
  truth_social: "Trump posted",
  whitehouse: "The White House published",
  federal_register: "A Federal Register filing records",
};

// "Tariffs / Trade" → "tariff", for use mid-sentence.
const MECH_NOUN = {
  tariffs: "a tariff measure",
  trade_deal: "a trade deal",
  fed: "comment on the Fed or interest rates",
  export_controls: "an export-control measure",
  sanctions: "a sanctions measure",
  energy: "an energy or oil measure",
  crypto: "a crypto-policy statement",
  pharma: "a drug-pricing measure",
  defense: "a defence measure",
  antitrust: "an antitrust or regulatory action",
  immigration: "an immigration or labour measure",
  fiscal: "a tax or fiscal measure",
};

const FIRMNESS = {
  15: "stated as a firm commitment",
  8: "stated with mixed commitment",
  6: "stated without a clear commitment",
  2: "floated rather than committed to",
};

const list = (xs, max = 4) => {
  const a = xs.slice(0, max);
  const more = xs.length - a.length;
  const joined = a.length > 1 ? `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}` : a[0];
  return more > 0 ? `${joined} (+${more} more)` : joined;
};

/**
 * @returns {string} two sentences, or one when there is genuinely nothing to add.
 */
export function explain(post, scored) {
  const mech = scored.mechanisms?.[0];
  const subject = scored.subjects?.[0];
  const bullish = scored.bullish || [];
  const bearish = scored.bearish || [];
  const named = scored.named || [];

  // --- Sentence 1: what this actually is ------------------------------------
  const verb = SOURCE_VERB[post.source] || "An official source published";
  const rate = post.text.match(/(\d+(?:\.\d+)?)\s?%/)?.[0];
  const amount = post.text.match(/\$\s?\d[\d,.]*\s?(?:billion|trillion|million)?/i)?.[0];

  const what = mech ? MECH_NOUN[mech.key] || "a market-relevant measure" : "a market-relevant statement";
  const about = subject ? ` on ${subject}` : "";
  const size = rate ? ` at ${rate}` : amount ? ` involving ${amount}` : "";
  // For a published instrument the phrasing is about force of law, not intent.
  const isInstrument = post.source === "whitehouse" || post.source === "federal_register";
  const firm = isInstrument ? "already in force as published" : FIRMNESS[scored.components?.modality] || "";

  const first = `${verb} ${what}${about}${size}${firm ? `, ${firm}` : ""}.`;

  // --- Sentence 2: who it lands on, and which way ---------------------------
  let second;
  const unclear = scored.direction === "unclear";

  if (bullish.length && bearish.length) {
    second =
      `On the stated mechanism that is a tailwind for ${list(bullish)} ` +
      `and a headwind for ${list(bearish)}` +
      (unclear ? ", though the wording does not make clear whether the measure is being applied or lifted, which would flip both sides." : ".");
  } else if (bullish.length) {
    second = `That points favourably at ${list(bullish)}${unclear ? ", if the measure is in fact being applied — the wording is ambiguous." : "."}`;
  } else if (bearish.length) {
    second = `That points unfavourably at ${list(bearish)}${unclear ? ", if the measure is in fact being applied — the wording is ambiguous." : "."}`;
  } else if (named.length) {
    second = `It names ${list(named)} directly, but the wording does not imply a clear direction for them.`;
  } else if (mech) {
    second = `No specific companies or goods are named, so this is sector-level context rather than a single-name signal.`;
  } else {
    second = `No market mechanism or company is named.`;
  }

  return `${first} ${second}`;
}

/** Same idea for a token-launch alert, where the "so what" is different. */
export function explainLaunch(post, launch) {
  const ticker = launch.cashtags?.[0] ? `$${launch.cashtags[0]}` : "a token";
  const hasAddress = launch.addresses?.length > 0;

  const first = hasAddress
    ? `This post contains a live contract address for ${ticker}, which is how a token launch is announced.`
    : `This post reads as a token-launch announcement for ${ticker}, but carries no contract address to verify.`;

  const second =
    `Launches like this repriced violently within minutes historically, and this alert is 5-20 minutes behind the post — ` +
    `treat it as notice that it happened, not as a chance to be early.`;

  return `${first} ${second}`;
}
