// Fetches live index constituent lists (symbol + company name) from Wikipedia
// at startup, so the scan universe tracks the real indices instead of a
// hardcoded snapshot. Covers the S&P 1500: large caps (500), mid caps (400)
// and small caps (600). Failure of any list is non-fatal — the curated
// built-in universe in universe.js keeps working as the fallback.

const UA = "Mozilla/5.0 (compatible; MarketPulseDashboard/1.0)";

const PAGES = [
  { key: "sp500", label: "S&P 500", page: "List_of_S%26P_500_companies" },
  { key: "sp400", label: "MidCap 400", page: "List_of_S%26P_400_companies" },
  { key: "sp600", label: "SmallCap 600", page: "List_of_S%26P_600_companies" },
];

async function fetchConstituents(page) {
  const res = await fetch(`https://en.wikipedia.org/wiki/${page}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const table = html.match(/<table[^>]*id="constituents"[\s\S]*?<\/table>/)?.[0];
  if (!table) throw new Error("constituents table not found");
  const out = [];
  for (const row of table.split("<tr").slice(2)) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
      .map((c) => c[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim());
    const sym = cells[0];
    if (sym && /^[A-Z]{1,5}(\.[A-Z])?$/.test(sym) && cells[1]) {
      out.push({ symbol: sym, name: cells[1] });
    }
  }
  if (out.length < 300) throw new Error(`only parsed ${out.length} rows — layout changed?`);
  return out;
}

// Returns { list, breakdown } — merged constituents plus per-index counts for
// the startup banner. Partial failures are reported, not fatal.
export async function fetchScanUniverse() {
  const results = await Promise.allSettled(PAGES.map((p) => fetchConstituents(p.page)));
  const list = [];
  const breakdown = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      list.push(...r.value);
      breakdown.push(`${PAGES[i].label}: ${r.value.length}`);
    } else {
      breakdown.push(`${PAGES[i].label}: failed`);
    }
  });
  return { list, breakdown };
}

// Kept for compatibility: just the S&P 500.
export async function fetchSP500() {
  return fetchConstituents(PAGES[0].page);
}
