// Memecoin data sources. All free, all keyless.
//
// GeckoTerminal is the backbone: it returns m5/m15/m30/h1/h6/h24 windows for
// volume, price change AND buyer/seller counts in one call, which means
// acceleration is computable from a single snapshot rather than from a series
// we'd have to accumulate for hours before the tool said anything useful.
//
// Free tier is ~30 calls/min. We use 2-3 per network per cycle.

const GT = "https://api.geckoterminal.com/api/v2";
const DS = "https://api.dexscreener.com";
const GT_HEADERS = { Accept: "application/json;version=20230302" };

export const NETWORKS = (process.env.MEME_NETWORKS || "solana,base").split(",").map((s) => s.trim());

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** GeckoTerminal pool → our normalised token record. */
function normalizePool(p, network) {
  const a = p.attributes || {};
  const rel = p.relationships || {};
  // "solana_6a4TCQ..." → "6a4TCQ..."
  const baseId = rel.base_token?.data?.id || "";
  const mint = baseId.includes("_") ? baseId.slice(baseId.indexOf("_") + 1) : baseId;

  const vol = a.volume_usd || {};
  const txns = a.transactions || {};
  const chg = a.price_change_percentage || {};

  return {
    poolAddress: a.address,
    network,
    dex: rel.dex?.data?.id || "unknown",
    mint,
    name: a.name || "",
    symbol: (a.name || "").split("/")[0].trim(),
    createdAt: a.pool_created_at ? new Date(a.pool_created_at).getTime() : null,
    priceUsd: num(a.base_token_price_usd),
    liquidityUsd: num(a.reserve_in_usd),
    fdvUsd: num(a.fdv_usd),
    volume: { m5: num(vol.m5), m15: num(vol.m15), m30: num(vol.m30), h1: num(vol.h1), h6: num(vol.h6), h24: num(vol.h24) },
    priceChange: { m5: num(chg.m5), m15: num(chg.m15), h1: num(chg.h1), h6: num(chg.h6), h24: num(chg.h24) },
    txns: {
      m5: txns.m5 || {}, m15: txns.m15 || {}, m30: txns.m30 || {},
      h1: txns.h1 || {}, h6: txns.h6 || {}, h24: txns.h24 || {},
    },
    url: `https://www.geckoterminal.com/${network}/pools/${a.address}`,
  };
}

async function gt(path, network) {
  const res = await fetch(`${GT}${path}`, { headers: GT_HEADERS, signal: AbortSignal.timeout(25000) });
  if (res.status === 429) throw new Error("geckoterminal rate limited");
  if (!res.ok) throw new Error(`geckoterminal HTTP ${res.status}`);
  const json = await res.json();
  return (json.data || []).map((p) => normalizePool(p, network));
}

export const fetchNewPools = (network) => gt(`/networks/${network}/new_pools?page=1`, network);
export const fetchTrendingPools = (network) => gt(`/networks/${network}/trending_pools`, network);

/**
 * Tokens someone is paying DexScreener to promote. Treated as a *caution*
 * signal, not a bullish one: paid promotion is what a coordinated pump looks
 * like from the outside.
 */
export async function fetchBoosted() {
  try {
    const res = await fetch(`${DS}/token-boosts/latest/v1`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return new Set();
    const json = await res.json();
    return new Set((Array.isArray(json) ? json : []).map((b) => b.tokenAddress).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Ticker-shaped mentions on 4chan /biz/. Free and genuinely early, but noisy —
 * used only to tell "already being discussed" from "not yet", never as a buy
 * signal on its own.
 */
export async function fetchBizChatter() {
  const counts = new Map();
  let ok = false;
  try {
    const res = await fetch("https://a.4cdn.org/biz/catalog.json", {
      headers: { "User-Agent": "PaperTrail/1.0" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { counts, ok: false };
    const pages = await res.json();
    ok = true;
    for (const page of pages) {
      for (const t of page.threads || []) {
        const blob = `${t.sub || ""} ${t.com || ""}`;
        for (const m of blob.matchAll(/\$([A-Za-z]{2,10})\b/g)) {
          const k = m[1].toUpperCase();
          counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
    }
  } catch { /* best-effort */ }
  // `ok` distinguishes "fetched, nobody is talking about it" from "the fetch
  // died". Both produce an empty map, but only the first is evidence of
  // anything — conflating them made every token look undiscovered whenever
  // 4chan was down, inflating the earliness score across the board.
  return { counts, ok };
}

/**
 * Current prices for specific pools, batched (GeckoTerminal accepts up to 30
 * addresses per call). Used by the paper book to mark positions that have
 * dropped out of the new/trending lists.
 *
 * This matters for honesty, not completeness: a token that collapses is exactly
 * the one that falls off trending, so marking only from the lists we already
 * fetch would quietly close losers at their last good price and flatter the
 * book. Failure is tolerated — the position stays unmarked and is counted.
 *
 * @param {Array<{network:string, poolAddress:string, mint:string}>} positions
 * @returns {Promise<{prices: Map<string, number>, unmarked: number}>}
 */
export async function fetchQuotes(positions = []) {
  const prices = new Map();
  const byNetwork = new Map();
  for (const p of positions) {
    if (!p.poolAddress) continue;
    if (!byNetwork.has(p.network)) byNetwork.set(p.network, []);
    byNetwork.get(p.network).push(p);
  }

  for (const [network, list] of byNetwork) {
    for (let i = 0; i < list.length; i += 30) {
      const batch = list.slice(i, i + 30);
      try {
        const res = await fetch(
          `${GT}/networks/${network}/pools/multi/${batch.map((p) => p.poolAddress).join(",")}`,
          { headers: GT_HEADERS, signal: AbortSignal.timeout(20000) }
        );
        if (!res.ok) continue;
        const json = await res.json();
        for (const pool of json.data || []) {
          const addr = pool.attributes?.address;
          const price = num(pool.attributes?.base_token_price_usd);
          const pos = batch.find((p) => p.poolAddress === addr);
          if (pos && price > 0) prices.set(`${pos.network}:${pos.mint}`, price);
        }
      } catch { /* leave this batch unmarked */ }
    }
  }
  return { prices, unmarked: positions.length - prices.size };
}

/** Every network's new + trending pools, de-duplicated by pool address. */
export async function fetchCandidates(networks = NETWORKS) {
  const jobs = [];
  for (const n of networks) {
    jobs.push(fetchNewPools(n).then((r) => ({ kind: "new", r })));
    jobs.push(fetchTrendingPools(n).then((r) => ({ kind: "trending", r })));
  }
  const settled = await Promise.allSettled(jobs);

  const byPool = new Map();
  const errors = [];
  for (const s of settled) {
    if (s.status !== "fulfilled") { errors.push(s.reason?.message || String(s.reason)); continue; }
    for (const t of s.value.r) {
      const prev = byPool.get(t.poolAddress);
      if (prev) prev.sources.push(s.value.kind);
      else byPool.set(t.poolAddress, { ...t, sources: [s.value.kind] });
    }
  }
  return { tokens: [...byPool.values()], errors };
}
