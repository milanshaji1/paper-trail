// Catalyst & macro radar.
//
// Classifies news headlines (type + sentiment) with keyword heuristics, maps
// which macro/policy themes a stock is EXPOSED to, and flags moves that look
// news-driven (unusual volume + price). This contextualizes headline-driven
// volatility — it does NOT predict how markets will react to a future event.

// ---- Macro / policy themes (label + the news query that surfaces them) ----
export const THEMES = {
  tariffs: { label: "Tariffs / Trade", query: "Trump tariffs trade war stocks", keywords: ["tariff", "trade war", "import tax", "trade deal", "china trade", "export ban"] },
  fed: { label: "Fed / Rates", query: "Federal Reserve interest rates inflation", keywords: ["federal reserve", "interest rate", "rate cut", "rate hike", "powell", "inflation", "cpi", "fomc"] },
  ai_chips: { label: "AI / Chip curbs", query: "semiconductor chip export controls Nvidia China", keywords: ["chip export", "semiconductor ban", "ai chip", "export control", "chip curb", "china chip"] },
  crypto_policy: { label: "Crypto policy", query: "crypto regulation SEC bitcoin ETF stablecoin", keywords: ["crypto regulation", "sec crypto", "bitcoin etf", "stablecoin", "crypto bill", "digital asset"] },
  energy: { label: "Energy / Oil", query: "oil prices OPEC energy policy", keywords: ["oil price", "opec", "crude", "energy policy", "drilling"] },
  geopolitics: { label: "Geopolitics / Defense", query: "geopolitics war sanctions defense spending", keywords: ["war", "sanction", "geopolit", "military", "defense spending", "conflict", "middle east"] },
};

// ---- Which themes each part of the universe is exposed to ----
const GROUPS = {
  semis: { syms: ["NVDA", "AMD", "AVGO", "QCOM", "MU", "TXN", "ASML", "TSM", "AMAT", "LRCX", "MPWR", "SMCI", "ARM", "MRVL", "INTC", "SMH"], themes: ["ai_chips", "tariffs"] },
  china: { syms: ["NIO", "TSM", "BABA"], themes: ["tariffs", "geopolitics"] },
  banks: { syms: ["JPM", "BAC", "WFC", "GS", "MS", "V", "MA"], themes: ["fed"] },
  growth: { syms: ["PLTR", "SNOW", "CRWD", "PANW", "ZS", "DDOG", "NET", "MDB", "TTD", "SHOP", "RBLX", "AFRM", "SOFI", "ARKK"], themes: ["fed"] },
  energy: { syms: ["XOM", "CVX"], themes: ["energy", "geopolitics"] },
  defense: { syms: ["LMT", "RTX", "BA", "GE", "HON", "CAT"], themes: ["geopolitics"] },
  autos: { syms: ["TSLA", "F", "GM", "RIVN", "LCID", "NIO"], themes: ["tariffs"] },
  crypto: { syms: ["COIN", "MSTR", "MARA", "RIOT", "HOOD"], themes: ["crypto_policy", "fed"] },
};

const SYMBOL_THEMES = (() => {
  const m = {};
  for (const g of Object.values(GROUPS)) for (const s of g.syms) m[s] = [...new Set([...(m[s] || []), ...g.themes])];
  return m;
})();

export function themesForSymbol(symbol, { isCrypto = false } = {}) {
  const keys = isCrypto ? ["crypto_policy", "fed"] : SYMBOL_THEMES[symbol] || ["fed"]; // rates touch ~everything
  return keys.map((k) => ({ key: k, label: THEMES[k].label }));
}

// ---- Headline classification (keyword heuristics) ----
const POS = ["surge", "soar", "jump", "rally", "beat", "beats", "upgrade", "raises", "record", "wins", "approval", "outperform", "buy rating", "price target raised", "tops", "strong", "growth", "bullish", "gains", "rebound", "high"];
const NEG = ["plunge", "sink", "tumble", "falls", "drop", "miss", "misses", "downgrade", "cuts", "lawsuit", "probe", "investigation", "recall", "warns", "layoff", "ban", "tariff", "sanction", "sells off", "bearish", "slump", "weak", "loss", "crash", "halt"];
const TYPES = [
  ["Earnings", ["earnings", "revenue", "eps", "quarter", "guidance", "forecast", "outlook"]],
  ["Analyst", ["upgrade", "downgrade", "price target", "rating", "analyst", "initiated"]],
  ["Deal", ["acquire", "acquisition", "merger", "buyout", "stake", "deal", "partnership"]],
  ["Regulatory", ["sec", "ftc", "doj", "lawsuit", "probe", "investigation", "regulat", "antitrust", "fine"]],
  ["Policy", ["trump", "tariff", "fed", "rate", "biden", "white house", "congress", "sanction", "election"]],
  ["Product", ["launch", "unveil", "product", "chip", "model", "release", "ai"]],
];

export function classifyHeadline(title = "") {
  const t = title.toLowerCase();
  let pos = 0, neg = 0;
  for (const w of POS) if (t.includes(w)) pos++;
  for (const w of NEG) if (t.includes(w)) neg++;
  const sentiment = pos > neg ? "pos" : neg > pos ? "neg" : "neutral";
  let type = "News";
  for (const [name, kws] of TYPES) if (kws.some((k) => t.includes(k))) { type = name; break; }
  return { sentiment, type };
}

// Aggregate sentiment across recent classified headlines.
export function newsSentiment(items = []) {
  let pos = 0, neg = 0;
  for (const it of items) {
    if (it.sentiment === "pos") pos++;
    else if (it.sentiment === "neg") neg++;
  }
  const net = pos - neg;
  const label = net >= 2 ? "Positive" : net <= -2 ? "Negative" : "Mixed";
  const tone = net >= 2 ? "good" : net <= -2 ? "bad" : "warn";
  return { pos, neg, net, label, tone };
}

// Is today's move likely news/event-driven? (unusual volume + notable price move)
export function eventRisk(quote) {
  const vr = quote.volRatio, chg = Math.abs(quote.changePct ?? 0);
  if (vr != null && vr >= 1.8 && chg >= 4) return { flag: true, label: `Unusual activity — ${vr.toFixed(1)}× volume on a ${quote.changePct >= 0 ? "+" : ""}${quote.changePct.toFixed(1)}% move`, tone: quote.changePct >= 0 ? "good" : "bad" };
  if (vr != null && vr >= 2.5) return { flag: true, label: `Volume spike — ${vr.toFixed(1)}× average`, tone: "warn" };
  return { flag: false };
}
