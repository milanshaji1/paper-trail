// Optional Finnhub integration (free tier). Activates only when
// FINNHUB_API_KEY is set in .env. Adds REAL analyst data — recommendation
// trends and price targets — i.e. the actual Wall Street consensus, to sit
// beside the built-in heuristic outlook. Get a free key: https://finnhub.io

const BASE = "https://finnhub.io/api/v1";
const key = () => process.env.FINNHUB_API_KEY || "";
export const hasFinnhub = () => !!key();

async function fh(pathq) {
  const sep = pathq.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}${pathq}${sep}token=${key()}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
  return res.json();
}

// Real-time quote (free tier) — { c: current, d: change, dp: %change }.
export async function fetchRealtimeQuote(symbol) {
  if (!hasFinnhub()) return null;
  try {
    const q = await fh(`/quote?symbol=${encodeURIComponent(symbol)}`);
    if (q && q.c) return { price: q.c, change: q.d, changePct: q.dp, high: q.h, low: q.l, open: q.o, prevClose: q.pc };
  } catch { /* ignore */ }
  return null;
}

// Next scheduled earnings date (within ~90 days).
export async function fetchEarnings(symbol) {
  if (!hasFinnhub()) return null;
  try {
    const today = new Date();
    const fmt = (d) => d.toISOString().slice(0, 10);
    const to = new Date(today.getTime() + 90 * 864e5);
    const j = await fh(`/calendar/earnings?from=${fmt(today)}&to=${fmt(to)}&symbol=${encodeURIComponent(symbol)}`);
    const arr = (j?.earningsCalendar || []).filter((e) => e.date);
    if (!arr.length) return null;
    arr.sort((a, b) => new Date(a.date) - new Date(b.date));
    const todayStr = fmt(today);
    const next = arr.find((e) => e.date >= todayStr) || arr[0];
    if (!next) return null;
    const daysAway = Math.round((new Date(next.date + "T00:00:00") - new Date(todayStr + "T00:00:00")) / 864e5);
    return { date: next.date, daysAway, epsEstimate: next.epsEstimate ?? null, hour: next.hour || null };
  } catch { return null; }
}

// Analyst recommendation trend + price target.
export async function fetchAnalyst(symbol, currentPrice) {
  if (!hasFinnhub()) return null;
  const out = {};
  try {
    const rec = await fh(`/stock/recommendation?symbol=${encodeURIComponent(symbol)}`);
    if (Array.isArray(rec) && rec.length) {
      const r = rec[0];
      out.reco = { period: r.period, strongBuy: r.strongBuy || 0, buy: r.buy || 0, hold: r.hold || 0, sell: r.sell || 0, strongSell: r.strongSell || 0 };
      const bull = out.reco.strongBuy + out.reco.buy;
      const bear = out.reco.sell + out.reco.strongSell;
      const total = bull + bear + out.reco.hold || 1;
      out.total = total;
      out.consensus = bull / total >= 0.6 ? "Buy" : bull > bear ? "Moderate Buy" : bear / total >= 0.5 ? "Sell" : "Hold";
    }
  } catch { /* recommendation may be unavailable */ }
  try {
    const pt = await fh(`/stock/price-target?symbol=${encodeURIComponent(symbol)}`);
    if (pt && pt.targetMean) {
      out.target = { high: pt.targetHigh, low: pt.targetLow, mean: pt.targetMean, median: pt.targetMedian };
      if (currentPrice) out.upsidePct = ((pt.targetMean - currentPrice) / currentPrice) * 100;
    }
  } catch { /* price target is premium on some plans */ }
  return Object.keys(out).length ? out : null;
}
