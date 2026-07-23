// Market news via Google News RSS (no key). We fetch a few topical feeds,
// merge, de-dupe and sort newest-first.

import { THEMES, classifyHeadline } from "./catalysts.js";

const UA = "Mozilla/5.0 (compatible; MarketPulseDashboard/1.0)";

const FEEDS = [
  { topic: "Markets", q: "stock market" },
  { topic: "S&P 500", q: "S%26P%20500" },
  { topic: "Crypto", q: "cryptocurrency%20bitcoin" },
  { topic: "Earnings", q: "earnings%20report%20stocks" },
];

function decode(str = "") {
  return str
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decode(m[1]) : "";
}

async function fetchFeed(topic, q) {
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`News HTTP ${res.status}`);
  const xml = await res.text();
  const items = xml.split(/<item>/).slice(1, 13);
  return items.map((block) => {
    let title = pick(block, "title");
    let source = pick(block, "source");
    // Google appends " - Source" to titles; strip when we already have source.
    if (source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(source.length + 3));
    }
    const pub = pick(block, "pubDate");
    return {
      topic,
      title,
      link: pick(block, "link"),
      source: source || "Google News",
      published: pub ? new Date(pub).getTime() : Date.now(),
    };
  });
}

// Per-symbol headlines. Cached briefly so opening the same stock repeatedly
// doesn't re-hit the feed.
const symCache = new Map(); // symbol -> { at, items }
export async function fetchSymbolNews(symbol, name) {
  const key = symbol.toUpperCase();
  const hit = symCache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.items;
  // Bias the query toward finance coverage of this specific ticker.
  const q = encodeURIComponent(`${symbol} ${name || ""} stock`.trim());
  let items = [];
  try {
    const raw = await fetchFeed(name || symbol, q);
    const seen = new Set();
    for (const it of raw) {
      const k = it.title.toLowerCase().slice(0, 60);
      if (!it.title || seen.has(k)) continue;
      seen.add(k);
      items.push({ ...it, ...classifyHeadline(it.title) }); // tag type + sentiment
    }
    items = items.slice(0, 10);
  } catch { /* best-effort */ }
  symCache.set(key, { at: Date.now(), items });
  return items;
}

// Macro / policy wire — tariffs, Fed, chips, crypto policy, energy, geopolitics.
let macroCache = { at: 0, items: [] };
export async function fetchMacroNews() {
  if (Date.now() - macroCache.at < 5 * 60_000 && macroCache.items.length) return macroCache.items;
  const entries = Object.entries(THEMES);
  const settled = await Promise.allSettled(
    entries.map(([key, t]) =>
      fetchFeed(t.label, encodeURIComponent(t.query)).then((items) =>
        items.slice(0, 6).map((it) => ({ ...it, theme: key, themeLabel: t.label, ...classifyHeadline(it.title) }))
      )
    )
  );
  const seen = new Set();
  const all = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const it of r.value) {
      const k = it.title.toLowerCase().slice(0, 60);
      if (!it.title || seen.has(k)) continue;
      seen.add(k);
      all.push(it);
    }
  }
  all.sort((a, b) => b.published - a.published);
  const items = all.slice(0, 24);
  macroCache = { at: Date.now(), items };
  return items;
}

export async function fetchNews() {
  const settled = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f.topic, f.q)));
  const seen = new Set();
  const all = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value) {
      const key = item.title.toLowerCase().slice(0, 60);
      if (!item.title || seen.has(key)) continue;
      seen.add(key);
      all.push(item);
    }
  }
  all.sort((a, b) => b.published - a.published);
  return all.slice(0, 30);
}
