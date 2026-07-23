// Stock/index data provider backed by CNBC's public quote + chart services.
// No API key or auth required, and it tolerates server/datacenter IPs well.
//
//   - Batch quotes:  quote.cnbc.com/quote-html-webservice/... (many symbols/call)
//   - Daily charts:  ts-api.cnbc.com/harmony/app/charts/<range>.json?symbol=...
//
// Quotes are cheap and batched (a few requests cover the whole universe); charts
// are heavier so we only pull them for the subset we actually display.

import { sma, rsi, macd, returnPct, opportunityScore } from "./indicators.js";
import { displayName } from "./universe.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const QUOTE_BASE =
  "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol";
const CHART_BASE = "https://ts-api.cnbc.com/harmony/app/charts";

// Parse CNBC's formatted strings ("+2.70%", "60,120,224", "289.36") into numbers.
function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[,%+\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Parse compact strings with magnitude suffixes ("32.20M", "1.2B") into numbers.
function numCompact(v) {
  if (v == null) return null;
  const str = String(v).trim().replace(/[,%+\s]/g, "");
  const m = str.match(/^(-?\d*\.?\d+)([KMBT])?$/i);
  if (!m) return num(v);
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[(m[2] || "").toUpperCase()] || 1;
  return parseFloat(m[1]) * mult;
}

function marketStateFrom(cnbc) {
  switch ((cnbc || "").toUpperCase()) {
    case "REG_MKT": return "REGULAR";
    case "PRE_MKT": return "PRE";
    case "POST_MKT": return "POST";
    default: return "CLOSED";
  }
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Turn one CNBC FormattedQuote into our normalized quote shape.
function normalizeQuote(q) {
  const price = num(q.last);
  const prevClose = num(q.previous_day_closing);
  let changePct = num(q.change_pct);
  if (changePct == null && price != null && prevClose) {
    changePct = ((price - prevClose) / prevClose) * 100;
  }
  const change = num(q.change) ?? (price != null && prevClose != null ? price - prevClose : null);
  const volume = num(q.volume);
  const avgVol = numCompact(q.tendayavgvol);
  // pcttendayvol is already today's volume / 10-day-average ratio.
  const volRatio = num(q.pcttendayvol) ?? (volume != null && avgVol ? volume / avgVol : null);
  const hi52 = num(q.yrhiprice);
  const lo52 = num(q.yrloprice);
  const pctFrom52wHigh = hi52 && price ? ((price - hi52) / hi52) * 100 : null;
  const rangePos =
    hi52 != null && lo52 != null && hi52 > lo52 && price != null
      ? (price - lo52) / (hi52 - lo52)
      : null;

  const metrics = { price, volRatio, changePct, pctFrom52wHigh, rangePos };
  return {
    symbol: q.symbol,
    name: displayName(q.symbol) || q.name || q.symbol,
    price,
    prevClose,
    change,
    changePct,
    open: num(q.open),
    dayHigh: num(q.high),
    dayLow: num(q.low),
    volume,
    avgVol10: avgVol,
    volRatio,
    fiftyTwoWeekHigh: hi52,
    fiftyTwoWeekLow: lo52,
    pctFrom52wHigh,
    rangePos,
    marketCap: q.mktcapView || null,
    pe: num(q.pe),
    beta: num(q.beta),
    // Fundamentals used by the long-horizon (5Y/10Y) outlook.
    fund: {
      pe: num(q.pe), fpe: num(q.fpe), eps: num(q.eps), feps: num(q.feps),
      revenue: numCompact(q.revenuettm), fsales: numCompact(q.fsales),
      psales: num(q.psales), fpsales: num(q.fpsales),
      roe: num(q.ROETTM), netMargin: num(q.NETPROFTTM), grossMargin: num(q.GROSMGNTTM),
      debtEquity: num(q.DEBTEQTYQ), dividendYield: num(q.dividendyield), beta: num(q.beta),
    },
    exchange: q.exchange || "",
    currency: q.currencyCode || "USD",
    marketState: marketStateFrom(q.curmktstatus),
    lastTime: q.last_timedate || null,
    // Enriched later from chart history; null until then.
    rsi: null, sma20: null, sma50: null, ret1m: null, ret3m: null, spark: null,
    opportunity: opportunityScore(metrics),
    updated: Date.now(),
  };
}

// Fetch quotes for many symbols, chunked (and mildly parallel) so a ~1,500
// symbol universe still refreshes in a few seconds.
export async function fetchQuotes(symbols, { chunk = 40, concurrency = 3 } = {}) {
  const groups = [];
  for (let i = 0; i < symbols.length; i += chunk) groups.push(symbols.slice(i, i + chunk));
  const out = [];
  let idx = 0;
  await Promise.all(
    new Array(Math.min(concurrency, groups.length)).fill(0).map(async () => {
      while (idx < groups.length) {
        const group = groups[idx++];
        const url =
          `${QUOTE_BASE}?symbols=${group.map(encodeURIComponent).join("|")}` +
          `&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;
        try {
          const json = await getJson(url);
          const list = json?.FormattedQuoteResult?.FormattedQuote || [];
          for (const q of list) {
            if (!q || q.code !== 0) continue;
            out.push(normalizeQuote(q));
          }
        } catch {
          // Skip a failed chunk; other chunks still populate the dashboard.
        }
      }
    })
  );
  return out;
}

export async function fetchSingleQuote(symbol) {
  const list = await fetchQuotes([symbol], { chunk: 1 });
  if (!list.length) throw new Error(`No quote for ${symbol}`);
  return list[0];
}

// Daily OHLCV bars for a symbol.
export async function fetchChart(symbol, range = "1M") {
  const url = `${CHART_BASE}/${range}.json?symbol=${encodeURIComponent(symbol)}`;
  const json = await getJson(url);
  const bars = json?.barData?.priceBars || [];
  const points = [];
  for (const b of bars) {
    const c = num(b.close);
    if (c == null) continue;
    points.push({ t: Number(b.tradeTimeinMills) || null, c, v: Number(b.volume) || 0 });
  }
  return {
    symbol,
    name: json?.barData?.companyName || displayName(symbol),
    exchange: json?.barData?.exchange || "",
    points,
  };
}

// Compute chart-derived technicals for one symbol (RSI, SMAs, returns, spark).
export async function fetchEnrichment(symbol, range = "1M") {
  const { points } = await fetchChart(symbol, range);
  const closes = points.map((p) => p.c);
  if (closes.length < 20) return { symbol, spark: closes.slice(-44) };
  const m = macd(closes);
  return {
    symbol,
    rsi: rsi(closes, 14),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    macdHist: m?.hist ?? null,
    ret1m: returnPct(closes, 21),
    ret3m: returnPct(closes, 63),
    ret6m: returnPct(closes, 126),
    spark: closes.slice(-44),
  };
}

// Re-score a quote once chart enrichment is merged in.
export function rescoreWithEnrichment(quote) {
  quote.opportunity = opportunityScore({
    price: quote.price,
    sma20: quote.sma20,
    sma50: quote.sma50,
    rsi: quote.rsi,
    ret1m: quote.ret1m,
    ret3m: quote.ret3m,
    volRatio: quote.volRatio,
    changePct: quote.changePct,
    pctFrom52wHigh: quote.pctFrom52wHigh,
    rangePos: quote.rangePos,
  });
  return quote;
}

// Bounded-concurrency map so we stay gentle with the chart endpoint.
export async function mapPool(items, limit, worker, gapMs = 120) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const cur = idx++;
      try {
        results[cur] = { ok: true, value: await worker(items[cur]) };
      } catch (err) {
        results[cur] = { ok: false, error: err?.message || String(err), item: items[cur] };
      }
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    }
  });
  await Promise.all(runners);
  return results;
}
