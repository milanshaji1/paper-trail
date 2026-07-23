// Company summaries via Wikipedia's public REST API (no key). Results are
// cached in-process for a day since descriptions rarely change.

const UA = "Mozilla/5.0 (compatible; MarketPulseDashboard/1.0)";
const cache = new Map(); // symbol -> { at, data }
const DAY = 86_400_000;

// Curated Wikipedia titles where the plain company name is ambiguous.
const WIKI_TITLES = {
  AAPL: "Apple Inc.", MSFT: "Microsoft", GOOGL: "Alphabet Inc.", META: "Meta Platforms",
  AMZN: "Amazon (company)", TSLA: "Tesla, Inc.", NVDA: "Nvidia", AMD: "AMD",
  ORCL: "Oracle Corporation", CRM: "Salesforce", ADBE: "Adobe Inc.", INTC: "Intel",
  IBM: "IBM", "BRK.B": "Berkshire Hathaway", V: "Visa Inc.", MA: "Mastercard",
  JPM: "JPMorgan Chase", BAC: "Bank of America", GS: "Goldman Sachs", MS: "Morgan Stanley",
  WFC: "Wells Fargo", DIS: "The Walt Disney Company", KO: "Coca-Cola", PEP: "PepsiCo",
  PG: "Procter & Gamble", F: "Ford Motor Company", GM: "General Motors", BA: "Boeing",
  GE: "GE Aerospace", XOM: "ExxonMobil", CVX: "Chevron Corporation", SQ: "Block, Inc.",
  PYPL: "PayPal", NKE: "Nike, Inc.", MCD: "McDonald's", SBUX: "Starbucks",
  WMT: "Walmart", COST: "Costco", HD: "The Home Depot", NFLX: "Netflix",
  UBER: "Uber", ABNB: "Airbnb", COIN: "Coinbase", PLTR: "Palantir Technologies",
  HOOD: "Robinhood Markets", SOFI: "SoFi", MSTR: "Strategy (company)", RIVN: "Rivian",
  LCID: "Lucid Motors", NIO: "Nio (car company)", SHOP: "Shopify", ARM: "Arm Holdings",
  SMCI: "Supermicro", TSM: "TSMC", ASML: "ASML Holding", QCOM: "Qualcomm",
  MU: "Micron Technology", AVGO: "Broadcom", CSCO: "Cisco", TXN: "Texas Instruments",
  LLY: "Eli Lilly and Company", JNJ: "Johnson & Johnson", UNH: "UnitedHealth Group",
  PFE: "Pfizer", MRK: "Merck & Co.", ABBV: "AbbVie", CAT: "Caterpillar Inc.",
  RTX: "RTX Corporation", LMT: "Lockheed Martin", HON: "Honeywell",
  SPY: "SPDR S&P 500 ETF Trust", QQQ: "Invesco QQQ", ARKK: "ARK Investment Management",
};

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function resolveTitle(name) {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(name + " company")}&limit=1&namespace=0&format=json`;
  const data = await getJson(url);
  return data?.[1]?.[0] || name;
}

async function summaryFor(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?redirect=true`;
  const j = await getJson(url);
  if (!j || j.type === "disambiguation" || !j.extract) return null;
  return { title: j.title, extract: j.extract, url: j.content_urls?.desktop?.page || null };
}

// symbol: CNBC symbol, name: friendly display name.
export async function fetchProfile(symbol, name) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < DAY) return hit.data;

  let data = null;
  try {
    let title = WIKI_TITLES[symbol];
    if (title) data = await summaryFor(title);
    if (!data && name) {
      title = await resolveTitle(name);
      if (title) data = await summaryFor(title);
    }
  } catch { /* best-effort */ }

  cache.set(symbol, { at: Date.now(), data });
  return data;
}
