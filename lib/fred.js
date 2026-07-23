// Optional FRED integration (free). Activates only when FRED_API_KEY is set.
// Pulls real US macro series — rates, inflation, yield curve, jobs — so the
// macro section is backed by hard numbers, not just headlines.
// Get a free key: https://fredaccount.stlouisfed.org/apikeys

const BASE = "https://api.stlouisfed.org/fred/series/observations";
const key = () => process.env.FRED_API_KEY || "";
export const hasFred = () => !!key();

// units=pc1 asks FRED for the % change from a year ago (i.e. YoY inflation).
const SERIES = [
  { id: "DFF", label: "Fed Funds Rate", unit: "%" },
  { id: "DGS10", label: "10Y Treasury", unit: "%" },
  { id: "T10Y2Y", label: "10Y–2Y Spread", unit: "%", invertGood: true },
  { id: "CPIAUCSL", label: "CPI (YoY)", unit: "%", units: "pc1" },
  { id: "CPILFESL", label: "Core CPI (YoY)", unit: "%", units: "pc1" },
  { id: "UNRATE", label: "Unemployment", unit: "%" },
];

async function obs(s) {
  const u = `${BASE}?series_id=${s.id}&api_key=${key()}&file_type=json&sort_order=desc&limit=2${s.units ? `&units=${s.units}` : ""}`;
  const j = await fetch(u, { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
  const o = (j.observations || []).filter((x) => x.value !== "."); // FRED uses "." for missing
  if (!o.length) return null;
  const value = parseFloat(o[0].value);
  const prev = o[1] ? parseFloat(o[1].value) : null;
  return {
    id: s.id, label: s.label, unit: s.unit,
    value, prev, change: prev != null ? value - prev : null,
    date: o[0].date, invertGood: !!s.invertGood,
  };
}

export async function fetchMacroIndicators() {
  if (!hasFred()) return [];
  const res = await Promise.allSettled(SERIES.map(obs));
  return res.filter((r) => r.status === "fulfilled" && r.value).map((r) => r.value);
}
