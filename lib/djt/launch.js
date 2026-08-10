// Token-launch detection in Trump's posts.
//
// The $TRUMP launch (17 Jan 2025) is the case this exists for: a Truth Social
// post, a contract address, and a move from ~$1.20 to $75 inside two days. The
// post itself was the only public signal, and it preceded every news cycle.
//
// What this can and cannot do, stated plainly because it changes how you should
// use the alert:
//   - CAN: tell you within one polling cycle that he has posted a contract
//     address or launchpad link, ahead of mainstream coverage.
//   - CANNOT: front-run it. Our floor is GitHub Actions' 5-20 min schedule,
//     and the $TRUMP repricing happened in minutes. Trump Media sells a
//     millisecond feed to trading firms for ~$100k/mo precisely because that
//     gap is where the money was.
// Treat a hit as "find out fast", not "get in first".
//
// A launch hit bypasses the normal scoring bands entirely — a contract address
// in a presidential post is categorically alert-worthy whatever else it scored.

// Solana mint: base58 (no 0/O/I/l), 32-44 chars. English prose never produces a
// 32-char unbroken base58 run, but we additionally require a digit or mixed
// case so a long hashtag or slug can't trip it.
const SOLANA_ADDR = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const EVM_ADDR = /\b0x[a-fA-F0-9]{40}\b/g;

const looksLikeMint = (s) => /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);

// The archive strips HTML, which welds hyperlinks to whatever followed them.
// The real $MELANIA post arrives as "Melaniameme.comFUAfBo2jgks6gB4Z4..." — the
// mint is there, but with no word boundary in front of it, so a \b-anchored
// match never sees it. Re-introduce the boundary the markup used to provide.
// The boundary must be followed by an UPPERCASE letter or a digit. Two reasons:
// a welded mint looks like ".comFUAfBo…", and a lowercase lookahead lets the
// alternation backtrack — ".com/solana" matched ".co" + "m" and split the URL.
const TLD_RUN_ON = /\.(finance|money|com|net|org|app|xyz|fun|gg|io|so|ag|co|me)(?=[A-Z0-9])/g;

export function normalizeForAddresses(text = "") {
  return text.replace(TLD_RUN_ON, ".$1 ").replace(/ /g, " ");
}

// Launchpads and DEX/explorer links. A URL to any of these in his feed is as
// strong a tell as a bare address.
const PLATFORM_LINKS = [
  { key: "pump.fun", re: /\bpump\.fun\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})?/i },
  { key: "dexscreener", re: /\bdexscreener\.com\/(\w+)\/(\w+)/i },
  { key: "birdeye", re: /\bbirdeye\.so\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/i },
  { key: "solscan", re: /\bsolscan\.io\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/i },
  { key: "jupiter", re: /\bjup\.ag\b/i },
  { key: "raydium", re: /\braydium\.io\b/i },
  { key: "uniswap", re: /\bapp\.uniswap\.org\b/i },
  { key: "moonshot", re: /\bmoonshot\.(?:money|com)\b/i },
];

// Phrasing that accompanied the real thing: "my Official Trump Meme is HERE".
const LAUNCH_PHRASES = [
  /\bofficial\s+(?:\w+\s+){0,2}(?:coin|token|meme|memecoin|crypto)\b/i,
  /\bmy\s+(?:new\s+)?(?:coin|token|memecoin)\b/i,
  /\b(?:launch(?:ing|ed)?|introduc\w+|announc\w+)\s+(?:my|our|the)\s+(?:\w+\s+){0,2}(?:coin|token|memecoin)\b/i,
  /\b(?:buy|get)\s+\$[A-Z]{2,10}\b/,
  /\bcontract address\b/i,
  /\bCA:\s*[1-9A-HJ-NP-Za-km-z0x]{20,}/i,
];

// Cashtags, but only the plausible ones — $1, $100 and $B are not tickers.
const CASHTAG = /\$([A-Z][A-Z0-9]{1,9})\b/g;

/**
 * @returns {{found:boolean, confidence:"high"|"medium", addresses:{chain:string,address:string}[],
 *            platforms:string[], cashtags:string[], reasons:string[]}}
 */
export function detectLaunch(rawText = "") {
  const reasons = [];
  const addresses = [];
  const platforms = [];
  const text = normalizeForAddresses(rawText);

  for (const m of text.matchAll(EVM_ADDR)) {
    addresses.push({ chain: "evm", address: m[0] });
  }
  for (const m of text.matchAll(SOLANA_ADDR)) {
    // 0x-prefixed hex already captured above; skip the overlap.
    if (/^0x/i.test(m[0]) || !looksLikeMint(m[0])) continue;
    addresses.push({ chain: "solana", address: m[0] });
  }
  if (addresses.length) reasons.push(`contract address in post (${addresses.length})`);

  for (const p of PLATFORM_LINKS) {
    if (!p.re.test(text)) continue;
    platforms.push(p.key);
    const hit = text.match(p.re);
    // pump.fun/<mint> and birdeye/solscan carry the mint in the path.
    const captured = hit?.[1];
    if (captured && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(captured) && !addresses.some((a) => a.address === captured)) {
      addresses.push({ chain: "solana", address: captured });
    }
  }
  if (platforms.length) reasons.push(`launchpad/DEX link: ${platforms.join(", ")}`);

  const phraseHit = LAUNCH_PHRASES.some((re) => re.test(text));
  if (phraseHit) reasons.push("token-launch phrasing");

  const cashtags = [...new Set([...text.matchAll(CASHTAG)].map((m) => m[1]))]
    .filter((t) => !/^(USD|USA|AM|PM)$/.test(t));
  if (cashtags.length && phraseHit) reasons.push(`cashtag: ${cashtags.map((c) => `$${c}`).join(" ")}`);

  // An address or a launchpad link is dispositive on its own. Phrasing plus a
  // cashtag is suggestive but not proof — he says "$TRUMP" about himself.
  const hard = addresses.length > 0 || platforms.length > 0;
  const soft = phraseHit && cashtags.length > 0;

  return {
    found: hard || soft,
    confidence: hard ? "high" : "medium",
    addresses,
    platforms,
    cashtags,
    reasons,
  };
}

/**
 * Best-effort confirmation that a detected address has a live market.
 * Deliberately short-timeout and failure-tolerant: the alert must go out on the
 * post alone, and must never wait on a third party to decide whether to fire.
 */
export async function confirmMarket({ chain, address }, { timeoutMs = 6000 } = {}) {
  const networks = chain === "solana" ? ["solana"] : ["base", "ethereum"];
  for (const network of networks) {
    try {
      const res = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=1`,
        { headers: { Accept: "application/json;version=20230302" }, signal: AbortSignal.timeout(timeoutMs) }
      );
      if (!res.ok) continue;
      const json = await res.json();
      const pool = (json.data || [])[0];
      if (!pool) continue;
      const a = pool.attributes || {};
      return {
        live: true,
        network,
        name: a.name,
        priceUsd: Number(a.base_token_price_usd) || null,
        liquidityUsd: Number(a.reserve_in_usd) || null,
        fdvUsd: Number(a.fdv_usd) || null,
        url: `https://www.geckoterminal.com/${network}/pools/${a.address}`,
      };
    } catch { /* best-effort only */ }
  }
  return { live: false };
}
