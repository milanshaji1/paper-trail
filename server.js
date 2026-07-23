// Market Pulse — backend.
// Background refreshers keep an in-memory snapshot warm so the browser always
// gets an instant response and we stay gentle with the upstream APIs.
//
//   stocks  : CNBC batch quotes for the whole universe (cheap, ~every 60s)
//   enrich  : CNBC daily charts for the *displayed* subset -> RSI/SMA/spark (~5m)
//   crypto  : CoinGecko (~90s)
//   news    : Google News RSS (~5m)

import "./lib/config.js"; // loads optional .env keys before anything reads them
import express from "express";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasFinnhub, fetchAnalyst, fetchEarnings } from "./lib/finnhub.js";
import { hasFred, fetchMacroIndicators } from "./lib/fred.js";
import { PaperEngine, RISK_PROFILES } from "./lib/paper.js";
import { runBacktest } from "./lib/backtest.js";
import { MomentumEngine, formationReturn } from "./lib/momentum.js";

import { INDICES, EQUITIES, ALL_STOCK_SYMBOLS, normalizeSymbol, displayName, registerSymbols } from "./lib/universe.js";
import { fetchScanUniverse } from "./lib/sp500.js";
import {
  fetchQuotes, fetchSingleQuote, fetchChart, fetchEnrichment,
  rescoreWithEnrichment, mapPool,
} from "./lib/cnbc.js";
import { fetchTopCrypto, fetchTrendingCrypto, fetchGlobalCrypto } from "./lib/crypto.js";
import { fetchNews, fetchSymbolNews, fetchMacroNews } from "./lib/news.js";
import { themesForSymbol, newsSentiment, eventRisk } from "./lib/catalysts.js";
import { fetchProfile } from "./lib/profile.js";
import { computeOutlook } from "./lib/outlook.js";
import { computeConviction, computeEntry } from "./lib/conviction.js";
import { sma, rsi, macd, returnPct, cagrFromPoints } from "./lib/indicators.js";

// Build the technical/fundamental context conviction + entry timing read from.
function convictionCtx(q, extra = {}) {
  return {
    price: q.price, sma20: q.sma20, sma50: q.sma50, sma200: q.sma200,
    rsi: q.rsi, macdHist: q.macdHist, ret1m: q.ret1m, ret3m: q.ret3m, ret6m: q.ret6m,
    volRatio: q.volRatio, pctFrom52wHigh: q.pctFrom52wHigh, rangePos: q.rangePos,
    fiftyTwoWeekHigh: q.fiftyTwoWeekHigh, fiftyTwoWeekLow: q.fiftyTwoWeekLow,
    fund: q.fund, ...extra,
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;

// Simulated paper-trading autopilot (fake money — validates the app's signals).
const paper = new PaperEngine({ file: path.join(__dirname, "data", "paper.json") });

// H1 traded forward: 12-1 momentum, top 15, monthly, no stops. Its own book, so
// it can be compared head-to-head with the breakout autopilot and with SPY.
// The backtest said H1 has an edge but was inflated by survivorship + hindsight.
// This is the honest test: picks made before the outcome is known.
const momentum = new MomentumEngine({
  file: path.join(__dirname, "data", "momentum.json"),
  topN: 15,
  rebalanceDays: 28,
});

// Universe rule, fixed and deliberately dumb: every stock the dashboard tracks.
// No screening, no cherry-picking — that's the whole point.
async function refreshMomentum() {
  if (!momentum.isDue()) return;
  try {
    log(`momentum[SIM] rebalance due — ranking ${EQUITIES.length} stocks by 12-1 momentum…`);
    // Live prices to trade at. The weekly bars are for RANKING only: their last
    // bar is a stale week-close and can sit >15% away from the current market,
    // which would book a fake gain/loss the moment we mark to market.
    const livePrice = new Map(store.stocks.quotes.filter((q) => q.price > 0).map((q) => [q.symbol, q.price]));
    const results = await mapPool(EQUITIES, 4, async (sym) => {
      const { points } = await fetchChart(sym, "5Y"); // ~10yr weekly
      const i = (points?.length ?? 0) - 1;
      const m = formationReturn(points, i);
      const price = livePrice.get(sym);
      if (m == null || !(price > 0)) return null;
      return { symbol: sym, name: displayName(sym), price, momentum: m };
    }, 100);
    const ranked = results
      .filter((r) => r.ok && r.value)
      .map((r) => r.value)
      .sort((a, b) => b.momentum - a.momentum);
    if (momentum.rebalance(ranked, Date.now())) {
      log(`momentum[SIM] rebalanced from ${ranked.length} ranked → top ${momentum.topN}: ` +
          momentum.state.positions.map((p) => p.symbol).join(", "));
    } else {
      log(`momentum[SIM] skipped — only ${ranked.length} ranked, need ${momentum.topN}`);
    }
  } catch (err) {
    log(`momentum refresh failed: ${err.message}`);
  }
}

function markMomentum() {
  const prices = {};
  for (const q of store.stocks.quotes) if (q.price > 0) prices[q.symbol] = q.price;
  if (Object.keys(prices).length) momentum.mark(prices, Date.now());
}

function runPaperCycle() {
  try {
    const actions = paper.evaluate({
      stocks: store.stocks.quotes,
      crypto: store.crypto.top || [],
      now: Date.now(),
    });
    for (const a of actions) {
      log(`paper[SIM] ${a.type === "open" ? "BUY " : "SELL"} ${a.symbol} @ $${a.price}${a.reason ? ` — ${a.reason}` : ""}${a.pnl != null ? ` (P&L $${a.pnl.toFixed(2)})` : ""}`);
    }
  } catch (err) {
    log(`paper cycle failed: ${err.message}`);
  }
}

const STOCK_INTERVAL = 60_000;
const ENRICH_INTERVAL = 180_000;
const CRYPTO_INTERVAL = 90_000;
const NEWS_INTERVAL = 300_000;

const indexSet = new Set(INDICES.map((i) => i.symbol));

// symbol -> { rsi, sma20, sma50, ret1m, ret3m, spark }
const enrichCache = new Map();
// symbol -> analyst consensus (only populated when a Finnhub key is set)
const analystCache = new Map();
// symbol -> { at, data } next-earnings info (12h TTL; dates rarely move)
const earningsCache = new Map();
const EARNINGS_TTL = 12 * 3600_000;

async function getEarnings(sym) {
  if (!hasFinnhub()) return null;
  const hit = earningsCache.get(sym);
  if (hit && Date.now() - hit.at < EARNINGS_TTL) return hit.data;
  const data = await fetchEarnings(sym).catch(() => null);
  earningsCache.set(sym, { at: Date.now(), data });
  return data;
}

const store = {
  startedAt: Date.now(),
  stocks: {
    updatedAt: null, indices: [], quotes: [],
    gainers: [], losers: [], mostActive: [], opportunities: [], errors: 0,
  },
  crypto: { updatedAt: null, global: null, top: [], trending: [] },
  news: { updatedAt: null, items: [] },
  macro: { updatedAt: null, items: [] },
  econ: { updatedAt: null, indicators: [] }, // FRED series (needs FRED_API_KEY)
  status: { stocks: "pending", crypto: "pending", news: "pending" },
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function applyEnrichment(quote) {
  const e = enrichCache.get(quote.symbol);
  if (!e) return quote;
  Object.assign(quote, {
    rsi: e.rsi ?? quote.rsi,
    sma20: e.sma20 ?? quote.sma20,
    sma50: e.sma50 ?? quote.sma50,
    sma200: e.sma200 ?? quote.sma200,
    macdHist: e.macdHist ?? quote.macdHist,
    ret1m: e.ret1m ?? quote.ret1m,
    ret3m: e.ret3m ?? quote.ret3m,
    ret6m: e.ret6m ?? quote.ret6m,
    spark: e.spark ?? quote.spark,
  });
  rescoreWithEnrichment(quote);
  // Full conviction + entry once we have real technicals (folds in analyst
  // consensus + upcoming earnings when cached for this symbol).
  if (quote.rsi != null && quote.sma50 != null) {
    const earnings = earningsCache.get(quote.symbol)?.data ?? null;
    const ctx = convictionCtx(quote, { analyst: analystCache.get(quote.symbol), earnings });
    quote.conviction = computeConviction(ctx);
    quote.entry = computeEntry(ctx);
    quote.earnings = earnings;
  }
  return quote;
}

// Rank equities into the gainers/losers/most-active/opportunity lists.
// With small caps in the universe, liquidity gates keep thin/penny names from
// polluting the lists: their delayed prints and easy multi-percent swings
// would otherwise dominate every board.
function rankEquities(equities) {
  const liquid = (q, minVol) => (q.price ?? 0) >= 3 && Math.max(q.volume ?? 0, q.avgVol10 ?? 0) >= minVol;
  const byChange = equities.filter((q) => q.changePct != null && liquid(q, 100_000))
    .sort((a, b) => b.changePct - a.changePct);
  const byVolume = [...equities].filter((q) => q.volume != null)
    .sort((a, b) => b.volume - a.volume);
  const byOpportunity = equities.filter((q) => liquid(q, 300_000))
    .sort((a, b) => (b.opportunity?.score || 0) - (a.opportunity?.score || 0));
  return {
    gainers: byChange.slice(0, 15),
    losers: byChange.slice(-15).reverse(),
    mostActive: byVolume.slice(0, 15),
    opportunities: byOpportunity.slice(0, 15),
  };
}

async function refreshStocks() {
  try {
    const quotes = (await fetchQuotes(ALL_STOCK_SYMBOLS)).map(applyEnrichment);
    const got = new Set(quotes.map((q) => q.symbol));
    const errors = ALL_STOCK_SYMBOLS.filter((s) => !got.has(s)).length;

    const indices = INDICES
      .map((i) => {
        const q = quotes.find((x) => x.symbol === i.symbol);
        if (q && i.unit) q.unit = i.unit;
        return q;
      })
      .filter(Boolean);
    const equities = quotes.filter((q) => !indexSet.has(q.symbol));

    store.stocks = {
      updatedAt: Date.now(),
      indices,
      quotes: equities,
      ...rankEquities(equities),
      errors,
    };
    store.status.stocks = equities.length < EQUITIES.length / 2 ? "degraded" : "ok";
    log(`stocks: ${equities.length} equities, ${indices.length} indices, ${errors} missing`);
    runPaperCycle();
    markMomentum();
  } catch (err) {
    store.status.stocks = "error";
    log(`stocks refresh failed: ${err.message}`);
  }
}

// Pull daily charts only for the symbols we actually surface, so RSI/SMA/spark
// stay fresh without hammering the chart endpoint with the whole universe.
async function refreshEnrichment() {
  try {
    const s = store.stocks;
    const wanted = new Set([
      ...INDICES.map((i) => i.symbol),
      ...[...s.gainers, ...s.losers, ...s.mostActive, ...s.opportunities].map((q) => q.symbol),
    ]);
    const symbols = [...wanted].slice(0, 60);
    if (!symbols.length) return;
    const results = await mapPool(symbols, 3, (sym) => fetchEnrichment(sym), 120);
    let ok = 0;
    for (const r of results) {
      if (r.ok && r.value) { enrichCache.set(r.value.symbol, r.value); ok++; }
    }
    // Merge into the live snapshot immediately so sparklines/RSI show up now,
    // rather than waiting for the next stock cycle.
    store.stocks.indices.forEach(applyEnrichment);
    store.stocks.quotes.forEach(applyEnrichment);
    Object.assign(store.stocks, rankEquities(store.stocks.quotes));
    log(`enrichment: ${ok}/${symbols.length} charts merged`);
  } catch (err) {
    log(`enrichment failed: ${err.message}`);
  }
}

// Pull real analyst consensus for the names we surface on cards, so their 1–5
// rating reflects Wall Street too. Only runs when a Finnhub key is configured.
async function refreshAnalyst() {
  if (!hasFinnhub()) return;
  try {
    const s = store.stocks;
    const wanted = [...new Set([...s.opportunities, ...s.gainers, ...s.losers].map((q) => q.symbol))].slice(0, 24);
    if (!wanted.length) return;
    const results = await mapPool(wanted, 3, (sym) => fetchAnalyst(sym), 300);
    let ok = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.ok && r.value) { analystCache.set(wanted[i], r.value); ok++; }
    }
    // Recompute conviction with the analyst overlay and re-rank.
    store.stocks.quotes.forEach(applyEnrichment);
    Object.assign(store.stocks, rankEquities(store.stocks.quotes));
    log(`analyst: ${ok}/${wanted.length} consensus merged`);
  } catch (err) {
    log(`analyst refresh failed: ${err.message}`);
  }
}

// Warm the earnings cache for the surfaced names (runs on its own cadence,
// offset from the analyst job, to stay inside Finnhub's 60 calls/min).
async function refreshEarnings() {
  if (!hasFinnhub()) return;
  try {
    const s = store.stocks;
    const wanted = [...new Set([...s.opportunities, ...s.gainers, ...s.mostActive].map((q) => q.symbol))]
      .filter((sym) => {
        const hit = earningsCache.get(sym);
        return !hit || Date.now() - hit.at >= EARNINGS_TTL;
      })
      .slice(0, 20);
    if (!wanted.length) return;
    const results = await mapPool(wanted, 2, (sym) => getEarnings(sym), 500);
    const ok = results.filter((r) => r.ok && r.value).length;
    // Re-apply so cards pick up earnings badges + entry warnings now.
    store.stocks.quotes.forEach(applyEnrichment);
    Object.assign(store.stocks, rankEquities(store.stocks.quotes));
    log(`earnings: ${ok}/${wanted.length} upcoming dates cached`);
  } catch (err) {
    log(`earnings refresh failed: ${err.message}`);
  }
}

// Real US macro series via FRED (only when FRED_API_KEY is set). Daily data —
// hourly refresh is plenty.
async function refreshEcon() {
  if (!hasFred()) return;
  try {
    const indicators = await fetchMacroIndicators();
    if (indicators.length) store.econ = { updatedAt: Date.now(), indicators };
    log(`econ: ${indicators.length} FRED indicators`);
  } catch (err) {
    log(`econ refresh failed: ${err.message}`);
  }
}

async function refreshCrypto() {
  try {
    const [global, topRaw, trending] = await Promise.all([
      fetchGlobalCrypto().catch(() => null),
      fetchTopCrypto(50).catch(() => []),
      fetchTrendingCrypto().catch(() => []),
    ]);
    const top = topRaw.map((c) => {
      const ctx = { isCrypto: true, price: c.price, change24h: c.change24h, change7d: c.change7d };
      c.conviction = computeConviction(ctx);
      c.entry = computeEntry(ctx);
      return c;
    });
    store.crypto = { updatedAt: Date.now(), global, top, trending };
    store.status.crypto = top.length ? "ok" : "degraded";
    log(`crypto: ${top.length} coins, ${trending.length} trending`);
    runPaperCycle();
  } catch (err) {
    store.status.crypto = "error";
    log(`crypto refresh failed: ${err.message}`);
  }
}

async function refreshNews() {
  try {
    const [items, macro] = await Promise.all([
      fetchNews(),
      fetchMacroNews().catch(() => []),
    ]);
    store.news = { updatedAt: Date.now(), items };
    store.macro = { updatedAt: Date.now(), items: macro };
    store.status.news = items.length ? "ok" : "degraded";
    log(`news: ${items.length} headlines, ${macro.length} macro`);
  } catch (err) {
    store.status.news = "error";
    log(`news refresh failed: ${err.message}`);
  }
}

function schedule(fn, interval, delay = 0) {
  setTimeout(() => { fn(); setInterval(fn, interval); }, delay);
}

// --- HTTP ---
const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/dashboard", (_req, res) => {
  // Ship rankings + a breadth summary, not all ~500 raw quotes (payload size).
  const { quotes, ...stocksLite } = store.stocks;
  const adv = quotes.filter((q) => (q.changePct ?? 0) > 0).length;
  const dec = quotes.filter((q) => (q.changePct ?? 0) < 0).length;
  const avg = quotes.length ? quotes.reduce((a, q) => a + (q.changePct ?? 0), 0) / quotes.length : null;
  res.json({
    serverTime: Date.now(),
    status: store.status,
    universeSize: EQUITIES.length,
    stocks: { ...stocksLite, breadth: { adv, dec, avg, total: quotes.length } },
    crypto: store.crypto,
    news: store.news,
    macro: store.macro,
    econ: store.econ,
    paper: paper.summary(),
    momentum: momentum.summary(),
  });
});

// H1 forward book (simulated).
app.get("/api/momentum", (_req, res) => res.json(momentum.summary()));
app.post("/api/momentum/reset", express.json(), (_req, res) => {
  momentum.reset();
  log("momentum[SIM] book reset");
  res.json(momentum.summary());
});

// Historical backtest — replays the same rules over ~2 years of real daily bars.
// Bounded universe + cached, since it costs one chart fetch per symbol.
let backtestCache = { at: 0, risk: null, data: null };
const BACKTEST_TTL = 30 * 60_000;

app.post("/api/backtest", express.json(), async (req, res) => {
  const risk = RISK_PROFILES[req.body?.risk] ? req.body.risk : paper.state.risk;
  if (backtestCache.data && backtestCache.risk === risk && Date.now() - backtestCache.at < BACKTEST_TTL) {
    return res.json({ ...backtestCache.data, cached: true });
  }
  try {
    // Scan the names the dashboard actually surfaces (bounded for cost).
    const s = store.stocks;
    const universe = [...new Set([...s.opportunities, ...s.gainers, ...s.mostActive].map((q) => q.symbol))].slice(0, 30);
    if (!universe.length) return res.status(503).json({ error: "Universe not warmed up yet — try again in a minute." });

    // "3M" is CNBC's ~2yr daily-bar range (their range names are non-obvious).
    const fetched = await mapPool([...universe, "SPY"], 4, async (sym) => {
      const { points } = await fetchChart(sym, "3M");
      return { symbol: sym, name: displayName(sym), bars: points };
    }, 120);

    const ok = fetched.filter((r) => r.ok && r.value.bars?.length).map((r) => r.value);
    const benchmark = ok.find((x) => x.symbol === "SPY");
    const symbols = ok.filter((x) => x.symbol !== "SPY");
    if (!symbols.length) return res.status(503).json({ error: "Could not fetch enough history to backtest." });

    const t0 = Date.now();
    const result = runBacktest({ symbols, benchmarkBars: benchmark?.bars || [], risk });
    result.tookMs = Date.now() - t0;
    result.benchmarkSymbol = "SPY";
    backtestCache = { at: Date.now(), risk, data: result };
    log(`backtest[SIM] ${result.days} days, ${result.universe} symbols, ${result.metrics.trades} trades, ` +
        `return ${result.metrics.totalReturnPct.toFixed(1)}% vs SPY ${result.benchmark.returnPct.toFixed(1)}%`);
    res.json(result);
  } catch (err) {
    log(`backtest failed: ${err.message}`);
    res.status(500).json({ error: `Backtest failed: ${err.message}` });
  }
});

// Paper-trading autopilot (simulated). Full state, and reset with a risk level.
app.get("/api/paper", (_req, res) => res.json(paper.summary()));
app.post("/api/paper/reset", express.json(), (req, res) => {
  const risk = req.body?.risk;
  if (risk != null && !RISK_PROFILES[risk]) {
    return res.status(400).json({ error: `Unknown risk level: ${risk}` });
  }
  paper.reset(risk);
  log(`paper[SIM] book reset (risk=${paper.state.risk})`);
  res.json(paper.summary());
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, uptimeMs: Date.now() - store.startedAt, status: store.status, providers: { finnhub: hasFinnhub(), fred: hasFred() } });
});

// On-demand single quote (watchlist "add symbol"), enriched if we can.
app.get("/api/quote/:symbol", async (req, res) => {
  try {
    const sym = normalizeSymbol(req.params.symbol);
    const q = await fetchSingleQuote(sym);
    try {
      const e = await fetchEnrichment(sym);
      enrichCache.set(sym, e);
    } catch { /* enrichment is best-effort */ }
    // Warm earnings too so watchlist rows can badge + alert on report dates.
    if (hasFinnhub() && !sym.startsWith(".") && !sym.startsWith("@")) await getEarnings(sym);
    res.json(applyEnrichment(q));
  } catch (err) {
    res.status(404).json({ error: `Could not fetch ${req.params.symbol}`, detail: err.message });
  }
});

// Full analysis: quote + company summary + recent news + multi-horizon outlook.
const analysisCache = new Map(); // symbol -> { at, data }
app.get("/api/analysis/:symbol", async (req, res) => {
  const sym = normalizeSymbol(req.params.symbol);
  try {
    const hit = analysisCache.get(sym);
    if (hit && Date.now() - hit.at < 5 * 60_000) return res.json(hit.data);

    const name = displayName(sym);
    const [quote, daily, weekly, profile, news] = await Promise.all([
      fetchSingleQuote(sym),
      fetchChart(sym, "1M").catch(() => ({ points: [] })),   // ~1yr daily
      fetchChart(sym, "5Y").catch(() => ({ points: [] })),   // ~10yr weekly
      fetchProfile(sym, name).catch(() => null),
      fetchSymbolNews(sym, name).catch(() => []),
    ]);

    const closes = daily.points.map((p) => p.c);
    const m = macd(closes);
    const f = quote.fund || {};
    const epsGrowth = f.eps && f.eps > 0 && f.feps != null ? ((f.feps - f.eps) / f.eps) * 100 : null;
    const revGrowth = f.revenue && f.revenue > 0 && f.fsales != null ? ((f.fsales - f.revenue) / f.revenue) * 100 : null;

    const technicals = {
      price: quote.price,
      sma20: sma(closes, 20),
      sma50: sma(closes, 50),
      sma200: sma(closes, 200),
      rsi: rsi(closes, 14),
      macdHist: m?.hist ?? null,
      ret5d: returnPct(closes, 5),
      ret1m: returnPct(closes, 21),
      ret3m: returnPct(closes, 63),
      ret6m: returnPct(closes, 126),
      volRatio: quote.volRatio,
      pctFrom52wHigh: quote.pctFrom52wHigh,
      rangePos: quote.rangePos,
    };
    const cagr = {
      y1: cagrFromPoints(weekly.points, 1),
      y5: cagrFromPoints(weekly.points, 5),
      y10: cagrFromPoints(weekly.points, 10),
    };

    const outlook = computeOutlook({
      ...technicals,
      fpe: f.fpe, epsGrowth, revGrowth, roe: f.roe, netMargin: f.netMargin,
      grossMargin: f.grossMargin, debtEquity: f.debtEquity, dividendYield: f.dividendYield,
      cagr5y: cagr.y5, cagr10y: cagr.y10,
    });

    const isIdx = sym.startsWith(".") || sym.startsWith("@") || sym.startsWith("US");

    // Optional: real analyst consensus + next earnings (Finnhub key required).
    const [analyst, earnings] = !isIdx && hasFinnhub()
      ? await Promise.all([
          fetchAnalyst(sym, quote.price).catch(() => null),
          getEarnings(sym),
        ])
      : [null, null];

    const cvCtx = convictionCtx(quote, {
      ...technicals,
      fund: { ...f, epsGrowth, revGrowth },
      analyst,  // folds real analyst consensus into the 1–5 rating
      earnings, // adds the earnings event-risk warning to the entry plan
    });
    const conviction = computeConviction(cvCtx);
    const entry = computeEntry(cvCtx);

    const catalysts = {
      themes: isIdx ? [] : themesForSymbol(sym),
      sentiment: newsSentiment(news),
      eventRisk: eventRisk(quote),
    };

    const data = {
      symbol: sym, name, quote, profile, news, technicals,
      fundamentals: { ...f, epsGrowth, revGrowth },
      cagr, outlook, conviction, entry, catalysts, analyst, earnings,
      tradingViewSymbol: toTradingView(sym, quote.exchange),
      generatedAt: Date.now(),
    };
    analysisCache.set(sym, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: `Could not analyze ${req.params.symbol}`, detail: err.message });
  }
});

// Best-effort mapping to a TradingView symbol for the embedded live chart.
const TV_INDEX = {
  ".SPX": "SP:SPX", ".IXIC": "NASDAQ:IXIC", ".DJI": "DJ:DJI", ".RUT": "TVC:RUT",
  ".VIX": "TVC:VIX", ".DXY": "TVC:DXY", "US10Y": "TVC:US10Y",
  "@GC.1": "COMEX:GC1!", "@CL.1": "NYMEX:CL1!",
};
function toTradingView(sym, exchange) {
  if (TV_INDEX[sym]) return TV_INDEX[sym];
  if (sym.startsWith(".") || sym.startsWith("@") || sym.startsWith("US")) return null;
  const e = (exchange || "").toUpperCase();
  let prefix = "NASDAQ";
  if (e.includes("NYSE") || e.includes("NEW YORK")) prefix = "NYSE";
  else if (e.includes("NASDAQ")) prefix = "NASDAQ";
  else if (e.includes("ARCA") || e.includes("BATS") || e.includes("AMEX")) prefix = "AMEX";
  return `${prefix}:${sym}`;
}

// Historical series for the detail chart.
app.get("/api/history/:symbol", async (req, res) => {
  try {
    const sym = normalizeSymbol(req.params.symbol);
    const range = req.query.range || "6M";
    res.json(await fetchChart(sym, range));
  } catch (err) {
    res.status(404).json({ error: `No history for ${req.params.symbol}`, detail: err.message });
  }
});

// This machine's LAN IPv4 addresses — the URLs a phone on the same Wi-Fi uses.
function lanUrls(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(`http://${ni.address}:${port}`);
    }
  }
  return out;
}

// Bind to 0.0.0.0 so other devices on the network (your phone) can reach it.
const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log("\n  \x1b[33m▁▂▃▅▂▇\x1b[0m  MARKET PULSE is live\n");
  console.log(`  On this Mac:   http://localhost:${PORT}`);
  const lan = lanUrls(PORT);
  if (lan.length) {
    console.log(`  On your phone: ${lan[0]}   \x1b[2m(same Wi-Fi network)\x1b[0m`);
    lan.slice(1).forEach((u) => console.log(`                 ${u}`));
  }

  // Expand the scan universe to the live S&P 1500 (large + mid + small caps)
  // before the first refresh, so the Opportunity Radar screens the whole
  // investable US market plus the curated momentum/ADR names.
  try {
    const { list, breakdown } = await fetchScanUniverse();
    registerSymbols(list);
    console.log(`  Scan universe: \x1b[32m${EQUITIES.length} stocks\x1b[0m (${breakdown.join(" · ")} + curated extras/ADRs)`);
  } catch (err) {
    console.log(`  Scan universe: ${EQUITIES.length} stocks \x1b[2m(built-in list — index fetch failed: ${err.message})\x1b[0m`);
  }
  console.log(`  Analyst data:  ${hasFinnhub() ? "\x1b[32mFinnhub key active ✓ (analyst consensus + earnings dates)\x1b[0m" : "\x1b[2mno key (add FINNHUB_API_KEY to .env for analyst consensus)\x1b[0m"}`);
  console.log(`  Macro data:    ${hasFred() ? "\x1b[32mFRED key active ✓ (rates, CPI, yield curve)\x1b[0m" : "\x1b[2mno key (add FRED_API_KEY to .env for real macro series)\x1b[0m"}`);
  console.log("");
  schedule(refreshStocks, STOCK_INTERVAL, 0);
  schedule(refreshEnrichment, ENRICH_INTERVAL, 4000);
  schedule(refreshCrypto, CRYPTO_INTERVAL, 500);
  schedule(refreshNews, NEWS_INTERVAL, 1000);
  if (hasFinnhub()) {
    schedule(refreshAnalyst, 5 * 60_000, 12_000);
    schedule(refreshEarnings, 30 * 60_000, 90_000); // offset from analyst job (rate limit)
  }
  if (hasFred()) schedule(refreshEcon, 60 * 60_000, 2_000);
  // Self-gates on isDue(); the actual rebalance only fires every 28 days.
  schedule(refreshMomentum, 6 * 60 * 60_000, 60_000);
});

// Friendly message instead of a stack trace if the port is taken.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Market Pulse may already be running — port ${PORT} is in use.`);
    console.error(`  • Just open http://localhost:${PORT} in your browser, or`);
    console.error(`  • Free the port and relaunch:  lsof -ti tcp:${PORT} | xargs kill\n`);
    process.exit(1);
  }
  throw err;
});
