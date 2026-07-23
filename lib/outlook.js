// Multi-horizon outlook engine.
//
// Produces a transparent, rules-based directional lean for 1W / 1M / 1Y / 5Y /
// 10Y from real technical + fundamental inputs. Short horizons lean on price
// technicals (trend, RSI, MACD, momentum); long horizons lean on fundamentals
// (earnings/revenue growth, profitability, valuation, leverage) plus long-run
// price trend. This is a HEURISTIC that explains its reasoning — it is NOT a
// forecast, prediction, or investment advice. Nobody can reliably predict
// prices, and 5–10 year outputs especially reflect business quality, not fate.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function verdictFromBias(bias) {
  if (bias >= 40) return "Bullish";
  if (bias >= 15) return "Lean Bullish";
  if (bias > -15) return "Neutral";
  if (bias > -40) return "Lean Bearish";
  return "Bearish";
}
function toneFromBias(bias) {
  if (bias >= 15) return "good";
  if (bias <= -15) return "bad";
  return "warn";
}

function pkg(label, bias, confidence, signals, rationale) {
  bias = Math.round(clamp(bias, -100, 100));
  return { label, bias, verdict: verdictFromBias(bias), tone: toneFromBias(bias), confidence, signals, rationale };
}

const pct = (n, d = 0) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`);

// ---- 1 WEEK: short-term technicals, mean-reversion aware ----
function horizon1W(c) {
  let bias = 0;
  const sig = [];
  if (c.price != null && c.sma20 != null) {
    if (c.price > c.sma20) { bias += 18; sig.push({ label: "Above 20-day avg", tone: "good" }); }
    else { bias -= 16; sig.push({ label: "Below 20-day avg", tone: "bad" }); }
  }
  if (c.macdHist != null) {
    if (c.macdHist > 0) { bias += 14; sig.push({ label: "MACD positive", tone: "good" }); }
    else { bias -= 12; sig.push({ label: "MACD negative", tone: "bad" }); }
  }
  if (c.rsi != null) {
    if (c.rsi >= 70) { bias -= 18; sig.push({ label: `Overbought RSI ${c.rsi.toFixed(0)} — pullback risk`, tone: "warn" }); }
    else if (c.rsi <= 30) { bias += 16; sig.push({ label: `Oversold RSI ${c.rsi.toFixed(0)} — bounce setup`, tone: "warn" }); }
    else if (c.rsi >= 55) bias += 8;
    else if (c.rsi < 45) bias -= 4;
  }
  if (c.ret5d != null) bias += clamp(c.ret5d * 1.6, -12, 12);
  if (c.volRatio != null && c.volRatio >= 1.5 && (c.ret5d ?? 0) > 0) { bias += 6; sig.push({ label: `${c.volRatio.toFixed(1)}× volume`, tone: "good" }); }

  const v = verdictFromBias(clamp(bias, -100, 100));
  const rationale =
    `Next ~5 trading days are dominated by short-term price action. ` +
    `Read: ${v.toLowerCase()} — driven by ${c.price > c.sma20 ? "price holding above" : "price under"} the 20-day average` +
    (c.rsi != null ? `, RSI ${c.rsi.toFixed(0)}` : "") +
    (c.macdHist != null ? `, MACD ${c.macdHist > 0 ? "positive" : "negative"}` : "") +
    `. Short-horizon signals are noisy — treat as low confidence.`;
  return pkg("1 Week", bias, "Low", sig, rationale);
}

// ---- 1 MONTH: swing trend ----
function horizon1M(c) {
  let bias = 0;
  const sig = [];
  if (c.sma20 != null && c.sma50 != null) {
    if (c.sma20 > c.sma50) { bias += 18; sig.push({ label: "Uptrend (20>50 DMA)", tone: "good" }); }
    else { bias -= 16; sig.push({ label: "Downtrend (20<50 DMA)", tone: "bad" }); }
  }
  if (c.ret1m != null) { bias += clamp(c.ret1m, -18, 18); if (Math.abs(c.ret1m) >= 6) sig.push({ label: `${pct(c.ret1m)} past month`, tone: c.ret1m >= 0 ? "good" : "bad" }); }
  if (c.rsi != null) {
    if (c.rsi >= 75) { bias -= 8; sig.push({ label: "Overbought", tone: "warn" }); }
    else if (c.rsi >= 45 && c.rsi <= 68) bias += 8;
    else if (c.rsi < 35) bias -= 6;
  }
  if (c.pctFrom52wHigh != null) {
    if (c.pctFrom52wHigh >= -3) { bias += 10; sig.push({ label: "At 52w highs", tone: "good" }); }
    else if (c.pctFrom52wHigh <= -25) { bias -= 8; sig.push({ label: "Well off highs", tone: "bad" }); }
  }
  const v = verdictFromBias(clamp(bias, -100, 100));
  const rationale =
    `Over ~1 month the swing trend matters most. Read: ${v.toLowerCase()} — ` +
    `${c.sma20 > c.sma50 ? "20-day above 50-day (constructive)" : "20-day below 50-day (weak)"}` +
    (c.ret1m != null ? `, ${pct(c.ret1m)} last month` : "") + `.`;
  return pkg("1 Month", bias, "Low", sig, rationale);
}

// ---- 1 YEAR: primary trend + momentum + valuation sanity ----
function horizon1Y(c) {
  let bias = 0;
  const sig = [];
  if (c.sma50 != null && c.sma200 != null) {
    if (c.sma50 > c.sma200) { bias += 22; sig.push({ label: "Golden cross (50>200 DMA)", tone: "good" }); }
    else { bias -= 20; sig.push({ label: "Death cross (50<200 DMA)", tone: "bad" }); }
  }
  const mom = (c.ret6m ?? 0) * 0.4 + (c.ret3m ?? 0) * 0.3;
  bias += clamp(mom, -20, 20);
  if (c.ret6m != null && Math.abs(c.ret6m) >= 10) sig.push({ label: `${pct(c.ret6m)} 6-month`, tone: c.ret6m >= 0 ? "good" : "bad" });
  if (c.rangePos != null) {
    if (c.rangePos >= 0.8) { bias += 8; }
    else if (c.rangePos <= 0.2) { bias -= 8; sig.push({ label: "Bottom of 52w range", tone: "bad" }); }
  }
  if (c.fpe != null) {
    if (c.fpe > 60) { bias -= 8; sig.push({ label: `Rich valuation (fwd P/E ${c.fpe.toFixed(0)})`, tone: "warn" }); }
    else if (c.fpe > 0 && c.fpe < 18 && (c.epsGrowth ?? 0) > 0) { bias += 6; sig.push({ label: `Reasonable valuation (fwd P/E ${c.fpe.toFixed(0)})`, tone: "good" }); }
  }
  const v = verdictFromBias(clamp(bias, -100, 100));
  const rationale =
    `Across ~1 year the primary trend leads. Read: ${v.toLowerCase()} — ` +
    `${c.sma50 > c.sma200 ? "50-day above 200-day (bull structure)" : "50-day below 200-day (bear structure)"}` +
    (c.ret6m != null ? `, ${pct(c.ret6m)} over 6 months` : "") +
    (c.fpe != null ? `, forward P/E ${c.fpe.toFixed(0)}` : "") + `.`;
  return pkg("1 Year", bias, "Medium", sig, rationale);
}

// ---- 5 YEAR: fundamentals-led ----
function horizon5Y(c) {
  const sig = [];
  let bias = 0;
  let haveFundamentals = false;

  if (c.epsGrowth != null) {
    haveFundamentals = true;
    bias += clamp(c.epsGrowth * 0.5, -12, 24);
    sig.push({ label: `Fwd EPS growth ${pct(c.epsGrowth)}`, tone: c.epsGrowth >= 5 ? "good" : c.epsGrowth <= -5 ? "bad" : "warn" });
  }
  if (c.revGrowth != null) {
    haveFundamentals = true;
    bias += clamp(c.revGrowth * 0.35, -8, 14);
    if (Math.abs(c.revGrowth) >= 8) sig.push({ label: `Rev growth ${pct(c.revGrowth)}`, tone: c.revGrowth >= 0 ? "good" : "bad" });
  }
  if (c.roe != null && c.roe >= 20) { bias += 8; sig.push({ label: `High ROE ${c.roe.toFixed(0)}%`, tone: "good" }); }
  if (c.netMargin != null && c.netMargin >= 15) bias += 6;
  if (c.fpe != null) {
    if (c.fpe > 0 && c.fpe <= 20 && (c.epsGrowth ?? 0) > 0) { bias += 8; sig.push({ label: "Attractive fwd P/E", tone: "good" }); }
    else if (c.fpe > 50) { bias -= 8; sig.push({ label: "Expensive vs earnings", tone: "warn" }); }
  }
  if (c.debtEquity != null && c.debtEquity > 200) { bias -= 6; sig.push({ label: "High leverage", tone: "warn" }); }
  if (c.cagr5y?.value != null) bias += clamp(c.cagr5y.value * 0.25, -8, 10);

  let confidence = haveFundamentals ? "Low-Med" : "Low";
  let rationale;
  const v = verdictFromBias(clamp(bias, -100, 100));
  if (haveFundamentals) {
    rationale =
      `Over 5 years fundamentals dominate price. Read: ${v.toLowerCase()} — ` +
      `${c.epsGrowth != null ? `earnings expected to ${c.epsGrowth >= 0 ? "grow" : "shrink"} (${pct(c.epsGrowth)} fwd EPS)` : "growth unclear"}` +
      `${c.roe != null ? `, ROE ${c.roe.toFixed(0)}%` : ""}` +
      `${c.cagr5y?.value != null ? `, 5-yr price CAGR ${pct(c.cagr5y.value)}${c.cagr5y.sinceInception ? " (since listing)" : ""}` : ""}` +
      `. Multi-year outlooks are inherently uncertain — this reflects business quality and valuation, not a price target.`;
  } else {
    bias = c.cagr5y?.value != null ? clamp(c.cagr5y.value * 1.2, -35, 40) : 0;
    rationale =
      `No company fundamentals available (index/ETF/fund). Read is based only on long-term price trend` +
      `${c.cagr5y?.value != null ? ` — 5-yr CAGR ${pct(c.cagr5y.value)}${c.cagr5y.sinceInception ? " (since listing)" : ""}` : ""}. Low confidence.`;
    sig.push({ label: "Trend-only (no fundamentals)", tone: "warn" });
  }
  return pkg("5 Year", bias, confidence, sig, rationale);
}

// ---- 10 YEAR: business quality + secular trend, valuation de-emphasized ----
function horizon10Y(c) {
  const sig = [];
  let bias = 0;
  let haveFundamentals = false;

  if (c.epsGrowth != null) { haveFundamentals = true; bias += clamp(c.epsGrowth * 0.35, -8, 18); }
  if (c.revGrowth != null) { haveFundamentals = true; bias += clamp(c.revGrowth * 0.3, -8, 14); if (c.revGrowth >= 8) sig.push({ label: `Growing revenue ${pct(c.revGrowth)}`, tone: "good" }); }
  if (c.roe != null && c.roe >= 20) { bias += 10; sig.push({ label: `Durable returns (ROE ${c.roe.toFixed(0)}%)`, tone: "good" }); }
  else if (c.roe != null && c.roe < 8) { bias -= 6; sig.push({ label: "Low returns on equity", tone: "warn" }); }
  if (c.grossMargin != null && c.grossMargin >= 50) { bias += 8; sig.push({ label: `Wide margins (${c.grossMargin.toFixed(0)}% gross)`, tone: "good" }); }
  if (c.debtEquity != null && c.debtEquity > 250) { bias -= 8; sig.push({ label: "Heavy debt load", tone: "warn" }); }
  if (c.dividendYield != null && c.dividendYield > 0) bias += clamp(c.dividendYield, 0, 6);
  if (c.cagr10y?.value != null) bias += clamp(c.cagr10y.value * 0.25, -8, 12);
  if (c.fpe != null && c.fpe > 80) { bias -= 5; sig.push({ label: "Very rich valuation", tone: "warn" }); }

  let rationale;
  const v = verdictFromBias(clamp(bias, -100, 100));
  if (haveFundamentals) {
    rationale =
      `A decade out, only business quality and secular trends are meaningful — technicals are irrelevant. Read: ${v.toLowerCase()} — ` +
      `${c.roe != null && c.roe >= 20 ? "high returns on capital" : "average returns"}` +
      `${c.grossMargin != null ? `, ${c.grossMargin.toFixed(0)}% gross margin` : ""}` +
      `${c.cagr10y?.value != null ? `, historical 10-yr CAGR ${pct(c.cagr10y.value)}${c.cagr10y.sinceInception ? " (since listing)" : ""}` : ""}` +
      `. This is a quality read, NOT a prediction — a decade of prices cannot be forecast.`;
  } else {
    bias = c.cagr10y?.value != null ? clamp(c.cagr10y.value * 1.1, -30, 40) : 0;
    rationale =
      `No fundamentals (index/ETF). Based only on very-long-term price trend` +
      `${c.cagr10y?.value != null ? ` — 10-yr CAGR ${pct(c.cagr10y.value)}${c.cagr10y.sinceInception ? " (since listing)" : ""}` : ""}. Low confidence.`;
    sig.push({ label: "Trend-only (no fundamentals)", tone: "warn" });
  }
  return pkg("10 Year", bias, "Low", sig, rationale);
}

export function computeOutlook(c) {
  return {
    "1W": horizon1W(c),
    "1M": horizon1M(c),
    "1Y": horizon1Y(c),
    "5Y": horizon5Y(c),
    "10Y": horizon10Y(c),
  };
}
