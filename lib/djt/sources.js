// Source adapters. Each yields the same normalised record:
//   { id, source, sourceLabel, ts, text, url }
//
// All three sources are free, keyless and public. The Truth Social adapter is
// the interesting one: the archive is a 19 MB newest-first JSON array, and
// polling that every five minutes would move ~5 GB/day for nothing. Instead we
// send a conditional GET (304 on no change, which is the common case) and only
// then pull the first few KB with a Range request, which is enough for the
// newest ~20 posts.

const UA = "Mozilla/5.0 (compatible; PaperTrailDJT/1.0)";
// Hard cap on posts accepted from one poll. 24 KB normally yields ~47.
const MAX_POSTS_PER_POLL = Number(process.env.DJT_MAX_POSTS || 80);
const TRUTH_ARCHIVE = "https://ix.cnn.io/data/truth-social/truth_archive.json";
const WH_ACTIONS = "https://www.whitehouse.gov/presidential-actions/feed/";
const FED_REGISTER =
  "https://www.federalregister.gov/api/v1/documents.json?per_page=20&order=newest" +
  "&conditions%5Btype%5D%5B%5D=PRESDOCU" +
  "&fields%5B%5D=title&fields%5B%5D=abstract&fields%5B%5D=publication_date" +
  "&fields%5B%5D=html_url&fields%5B%5D=document_number&fields%5B%5D=subtype";

// ---------------------------------------------------------------------------
// Extract only the complete objects from a partial JSON array.
// Brace-depth walk with string/escape awareness — a naive lastIndexOf("},")
// breaks on any post whose text happens to contain that sequence.
// ---------------------------------------------------------------------------
export function parsePartialArray(text) {
  let depth = 0, inStr = false, esc = false, start = -1, end = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") { depth--; if (depth === 0) end = i; }
  }
  if (end === -1) return [];
  try {
    return JSON.parse(`[${text.slice(text.indexOf("{"), end + 1)}]`);
  } catch {
    return [];
  }
}

/**
 * Newest Truth Social posts. Returns `{ posts, meta }`; `meta` must be handed
 * back on the next call for the conditional GET to work.
 */
export async function fetchTruthSocial(meta = {}, { bytes = 24576 } = {}) {
  const head = await fetch(TRUTH_ARCHIVE, {
    method: "HEAD",
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  const lastModified = head.headers.get("last-modified");
  const etag = head.headers.get("etag");

  // Unchanged since we last looked — nothing to do, and it cost us one HEAD.
  if (lastModified && meta.lastModified === lastModified && meta.etag === etag) {
    return { posts: [], meta, unchanged: true };
  }

  const res = await fetch(TRUTH_ARCHIVE, {
    headers: { "User-Agent": UA, Range: `bytes=0-${bytes - 1}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok && res.status !== 206) throw new Error(`truth archive HTTP ${res.status}`);

  const body = await res.text();
  // A 200 means the CDN ignored the Range header and handed us all 19 MB —
  // ~35k posts. Parsing that is fine, but letting it through would write every
  // id in the archive into state on a single run. Cap it: the window only ever
  // needs the newest handful, and 24 KB normally yields ~47 (about 30 hours).
  const truncated = res.status !== 206;
  const raw = parsePartialArray(body).slice(0, MAX_POSTS_PER_POLL);

  const posts = raw.map((p) => ({
    id: `ts_${p.id}`,
    source: "truth_social",
    sourceLabel: "Truth Social",
    ts: new Date(p.created_at).getTime(),
    text: (p.content || "").trim(),
    url: p.url,
    engagement: {
      replies: p.replies_count ?? 0,
      reblogs: p.reblogs_count ?? 0,
      favourites: p.favourites_count ?? 0,
    },
  }));

  return { posts, meta: { lastModified, etag }, unchanged: false, truncated };
}

// ---------------------------------------------------------------------------
// RSS / API adapters
// ---------------------------------------------------------------------------
export function decode(s = "") {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/<[^>]+>/g, " ")
    // Numeric entities generically — the WH feed is full of &#160; and &#8217;,
    // and enumerating them one at a time always misses one.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ").replace(/&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&") // last, so "&amp;lt;" doesn't become "<"
    .replace(/\s+/g, " ")
    .trim();
}

const pick = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decode(m[1]) : "";
};

/** Executive orders, proclamations and memoranda as published by the WH. */
export async function fetchWhiteHouseActions() {
  const res = await fetch(WH_ACTIONS, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`whitehouse HTTP ${res.status}`);
  const xml = await res.text();
  return xml.split(/<item>/).slice(1, 21).map((block) => {
    const title = pick(block, "title");
    const link = pick(block, "link");
    const pub = pick(block, "pubDate");
    const body = pick(block, "description");
    return {
      id: `wh_${link.split("/").filter(Boolean).pop() || title.slice(0, 40)}`,
      source: "whitehouse",
      sourceLabel: "White House",
      ts: pub ? new Date(pub).getTime() : Date.now(),
      // Title first: it carries the policy, the body is often boilerplate.
      text: body ? `${title}. ${body}` : title,
      url: link,
    };
  }).filter((r) => r.text);
}

/** Presidential documents from the Federal Register (official, structured). */
export async function fetchFederalRegister() {
  const res = await fetch(FED_REGISTER, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`federal register HTTP ${res.status}`);
  const json = await res.json();
  return (json.results || []).map((d) => ({
    id: `fr_${d.document_number}`,
    source: "federal_register",
    sourceLabel: `Federal Register — ${d.subtype || "Presidential Document"}`,
    ts: new Date(`${d.publication_date}T14:00:00Z`).getTime(),
    text: d.abstract ? `${d.title}. ${d.abstract}` : d.title,
    url: d.html_url,
  }));
}

/**
 * Every source, best-effort. One failing source must never take the watcher
 * down — a Truth Social outage still leaves the official feeds working.
 */
export async function fetchAll(meta = {}) {
  const [ts, wh, fr] = await Promise.allSettled([
    fetchTruthSocial(meta.truth_social || {}),
    fetchWhiteHouseActions(),
    fetchFederalRegister(),
  ]);

  const errors = [];
  const posts = [];

  if (ts.status === "fulfilled") posts.push(...ts.value.posts);
  else errors.push(`truth_social: ${ts.reason?.message}`);

  if (wh.status === "fulfilled") posts.push(...wh.value);
  else errors.push(`whitehouse: ${wh.reason?.message}`);

  if (fr.status === "fulfilled") posts.push(...fr.value);
  else errors.push(`federal_register: ${fr.reason?.message}`);

  posts.sort((a, b) => b.ts - a.ts);

  return {
    posts,
    meta: { ...meta, truth_social: ts.status === "fulfilled" ? ts.value.meta : meta.truth_social },
    errors,
    unchanged: ts.status === "fulfilled" && ts.value.unchanged,
  };
}
