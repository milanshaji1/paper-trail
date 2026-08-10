// The set of instruments the dashboard tracks, in CNBC symbology.
// (CNBC's quote/chart APIs work reliably server-side with no key or auth.)

// Macro strip shown at the top of the dashboard.
// `unit` marks values that render as a percentage (yields) rather than a price.
export const INDICES = [
  { symbol: ".SPX", name: "S&P 500", group: "index" },
  { symbol: ".IXIC", name: "Nasdaq Composite", group: "index" },
  { symbol: ".DJI", name: "Dow Jones", group: "index" },
  { symbol: ".RUT", name: "Russell 2000", group: "index" },
  { symbol: ".VIX", name: "Volatility (VIX)", group: "index" },
  { symbol: "US10Y", name: "US 10Y Yield", group: "rate", unit: "%" },
  { symbol: "@GC.1", name: "Gold", group: "commodity" },
  { symbol: "@CL.1", name: "Crude Oil (WTI)", group: "commodity" },
  { symbol: ".DXY", name: "US Dollar Index", group: "fx" },
];

// Company / instrument names for the tracked equity universe (keyed by CNBC symbol).
export const NAMES = {
  AAPL: "Apple", MSFT: "Microsoft", NVDA: "NVIDIA", AMZN: "Amazon",
  GOOGL: "Alphabet (A)", META: "Meta Platforms", TSLA: "Tesla",
  AVGO: "Broadcom", AMD: "Advanced Micro Devices", NFLX: "Netflix",
  ADBE: "Adobe", CRM: "Salesforce", ORCL: "Oracle", INTC: "Intel",
  QCOM: "Qualcomm", MU: "Micron", TXN: "Texas Instruments", CSCO: "Cisco",
  IBM: "IBM", NOW: "ServiceNow", SNOW: "Snowflake", PLTR: "Palantir",
  UBER: "Uber", ABNB: "Airbnb", SHOP: "Shopify", SQ: "Block",
  PYPL: "PayPal", COIN: "Coinbase", MSTR: "MicroStrategy", HOOD: "Robinhood",
  SOFI: "SoFi", ARM: "Arm Holdings", SMCI: "Super Micro", DELL: "Dell",
  MRVL: "Marvell", ASML: "ASML", TSM: "TSMC", AMAT: "Applied Materials",
  LRCX: "Lam Research", MPWR: "Monolithic Power", ANET: "Arista Networks",
  CRWD: "CrowdStrike", PANW: "Palo Alto Networks", ZS: "Zscaler",
  DDOG: "Datadog", NET: "Cloudflare", MDB: "MongoDB", TTD: "The Trade Desk",
  JPM: "JPMorgan Chase", BAC: "Bank of America", WFC: "Wells Fargo",
  GS: "Goldman Sachs", MS: "Morgan Stanley", V: "Visa", MA: "Mastercard",
  "BRK.B": "Berkshire Hathaway", XOM: "ExxonMobil", CVX: "Chevron",
  JNJ: "Johnson & Johnson", LLY: "Eli Lilly", UNH: "UnitedHealth",
  PFE: "Pfizer", MRK: "Merck", ABBV: "AbbVie", TMO: "Thermo Fisher",
  WMT: "Walmart", COST: "Costco", HD: "Home Depot", MCD: "McDonald's",
  NKE: "Nike", SBUX: "Starbucks", DIS: "Disney", KO: "Coca-Cola",
  PEP: "PepsiCo", PG: "Procter & Gamble", BA: "Boeing", CAT: "Caterpillar",
  GE: "GE Aerospace", HON: "Honeywell", RTX: "RTX Corp", LMT: "Lockheed Martin",
  F: "Ford", GM: "General Motors", RIVN: "Rivian", LCID: "Lucid",
  NIO: "NIO", PLUG: "Plug Power", RIOT: "Riot Platforms", MARA: "MARA Holdings",
  CVNA: "Carvana", AFRM: "Affirm", RBLX: "Roblox", DKNG: "DraftKings",
  SPY: "S&P 500 ETF", QQQ: "Nasdaq 100 ETF", IWM: "Russell 2000 ETF",
  SMH: "Semiconductor ETF", ARKK: "ARK Innovation ETF",
  // The largest ETFs by AUM with genuinely distinct exposure — US large-cap,
  // developed international, gold, investment-grade bonds. VOO/IVV/SPY track
  // the same 500 companies, so only one of them adds anything.
  VOO: "Vanguard S&P 500 ETF", IEFA: "iShares Core MSCI EAFE ETF",
  GLD: "SPDR Gold Shares", BND: "Vanguard Total Bond Market ETF",
  VTI: "Vanguard Total Stock Market ETF", QUAL: "iShares MSCI USA Quality Factor ETF",
  QQQM: "Invesco Nasdaq 100 ETF", IYW: "iShares U.S. Technology ETF",
  IGV: "iShares Expanded Tech-Software ETF",
  DIA: "SPDR Dow Jones Industrial Average ETF",
  // ASX-listed and quoted in AUD, not USD. Everything downstream assumes USD,
  // so this is converted at mark time via CURRENCY below — never treated as a
  // bare number.
  "VAS.AX": "Vanguard Australian Shares ETF",
  // Major international names trading in New York as ADRs / US listings.
  BHP: "BHP Group", RIO: "Rio Tinto", NVO: "Novo Nordisk", TM: "Toyota",
  SONY: "Sony", SAP: "SAP", SHEL: "Shell", BP: "BP", UL: "Unilever",
  AZN: "AstraZeneca", NVS: "Novartis", HSBC: "HSBC", TTE: "TotalEnergies",
  BABA: "Alibaba", JD: "JD.com", PDD: "PDD Holdings", BIDU: "Baidu",
  SE: "Sea Limited", SPOT: "Spotify", MELI: "MercadoLibre", GRAB: "Grab",
  MUFG: "Mitsubishi UFJ", SAN: "Banco Santander", IBN: "ICICI Bank",
};

// The scannable equity/ETF universe (keys of NAMES).
export const EQUITIES = Object.keys(NAMES);

// Everything the background stock refresher pulls each cycle.
export const ALL_STOCK_SYMBOLS = [
  ...INDICES.map((i) => i.symbol),
  ...EQUITIES,
];

// Grow the scan universe at runtime (e.g. with live S&P 500 constituents).
// Mutates the exported arrays in place so every importer sees the update.
export function registerSymbols(list) {
  let added = 0;
  for (const { symbol, name } of list) {
    if (!symbol || NAMES[symbol]) continue;
    NAMES[symbol] = name || symbol;
    EQUITIES.push(symbol);
    ALL_STOCK_SYMBOLS.push(symbol);
    added++;
  }
  return added;
}

// Non-USD listings. A symbol absent here is assumed to quote in USD.
// The paper book is denominated in USD, so any symbol listed here must have its
// price converted before it is compared with, or added to, anything else.
export const CURRENCY = { "VAS.AX": "AUD" };
export const currencyOf = (symbol) => CURRENCY[symbol] || "USD";
export const isForeign = (symbol) => currencyOf(symbol) !== "USD";

const INDEX_META = Object.fromEntries(INDICES.map((i) => [i.symbol, i]));

export function displayName(symbol) {
  return NAMES[symbol] || INDEX_META[symbol]?.name || symbol;
}
export function unitFor(symbol) {
  return INDEX_META[symbol]?.unit || null;
}

// Normalize user-typed tickers (watchlist / detail) into CNBC symbology.
export function normalizeSymbol(raw) {
  let s = (raw || "").trim().toUpperCase();
  if (!s) return s;
  if (s.startsWith("^")) s = "." + s.slice(1); // ^VIX -> .VIX
  if (s === "BRK-B" || s === "BRKB") s = "BRK.B";
  if (s === "BRK-A") s = "BRK.A";
  return s;
}
