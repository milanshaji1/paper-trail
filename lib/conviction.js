// Conviction rating (1–5) + entry-timing engine.
//
// A transparent, rules-based screen. It blends trend, momentum, quality,
// valuation and risk into a 1–5 rating, then derives a concrete entry plan
// (buy now / wait for pullback / wait for breakout / wait for confirmation /
// avoid) with real price levels computed from the data.
//
// This is decision SUPPORT, not advice or prediction. Every output ships with
// its inputs so a human can judge it. Markets are risky.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- sub-scores, each normalized 0..1 ----
function trendScore(c) {
  const { price, sma20, sma50, sma200, rangePos } = c;
  if (sma50 == null && rangePos != null) return clamp(rangePos, 0, 1); // fallback
  if (price == null || sma50 == null) return 0.5;
  let s = 0.45;
  if (price > sma20) s += 0.18;
  if (sma20 != null && sma20 > sma50) s += 0.15;
  if (sma200 != null && sma50 > sma200) s += 0.15;
  if (sma200 != null && price > sma200) s += 0.07;
  else if (sma200 != null && price < sma200) s -= 0.28;
  return clamp(s, 0, 1);
}

function momentumScore(c) {
  if (c.isCrypto) {
    let s = 0.5;
    if (c.change7d != null) s += clamp(c.change7d / 30, -0.3, 0.3);
    if (c.change24h != null) s += clamp(c.change24h / 20, -0.15, 0.15);
    return clamp(s, 0, 1);
  }
  let s = 0.5;
  if (c.ret1m != null) s += clamp(c.ret1m / 20, -0.18, 0.18) * 0.9;
  if (c.ret3m != null) s += clamp(c.ret3m / 40, -0.12, 0.12);
  if (c.ret6m != null) s += clamp(c.ret6m / 60, -0.12, 0.12);
  if (c.rsi != null) {
    if (c.rsi >= 78) s -= 0.14;
    else if (c.rsi >= 55) s += 0.1;
    else if (c.rsi >= 45) s += 0.04;
    else if (c.rsi < 35) s -= 0.08;
  }
  if (c.macdHist != null) s += c.macdHist > 0 ? 0.05 : -0.05;
  return clamp(s, 0, 1);
}

function qualityScore(c) {
  const f = c.fund || {};
  if (f.roe == null && f.grossMargin == null && f.epsGrowth == null) return null;
  let s = 0.42;
  if (f.roe != null) s += f.roe >= 25 ? 0.16 : f.roe >= 12 ? 0.09 : f.roe < 0 ? -0.14 : 0.03;
  if (f.netMargin != null) s += f.netMargin >= 18 ? 0.1 : f.netMargin >= 8 ? 0.05 : f.netMargin < 0 ? -0.12 : 0;
  if (f.grossMargin != null) s += f.grossMargin >= 50 ? 0.08 : 0.02;
  if (f.epsGrowth != null) s += clamp(f.epsGrowth / 40, -0.12, 0.14);
  if (f.revGrowth != null) s += clamp(f.revGrowth / 40, -0.08, 0.1);
  if (f.debtEquity != null && f.debtEquity > 200) s -= 0.08;
  return clamp(s, 0, 1);
}

function valueScore(c) {
  const f = c.fund || {};
  if (f.fpe == null || f.fpe <= 0) return null;
  let s = 0.5;
  const g = f.epsGrowth;
  if (g != null && g > 0) {
    const peg = f.fpe / g; // PEG-style
    if (peg <= 1) s += 0.28;
    else if (peg <= 1.6) s += 0.16;
    else if (peg <= 2.5) s += 0.02;
    else s -= 0.14;
  } else {
    if (f.fpe <= 15) s += 0.2;
    else if (f.fpe <= 25) s += 0.06;
    else if (f.fpe > 45) s -= 0.16;
  }
  return clamp(s, 0, 1);
}

// risk sub-score, 1 = lower risk / cleaner setup
function riskScore(c) {
  let s = 0.62;
  if (c.rsi != null && c.rsi >= 78) s -= 0.2;
  if (c.price != null && c.sma20 != null && c.price / c.sma20 - 1 > 0.12) s -= 0.16; // extended
  const beta = c.fund?.beta;
  if (beta != null && beta > 1.8) s -= 0.14;
  if (c.isCrypto) s -= 0.14; // structurally higher volatility
  if (c.sma200 != null && c.price != null && c.price < c.sma200) s -= 0.14;
  if (c.pctFrom52wHigh != null && c.pctFrom52wHigh <= -35) s -= 0.08;
  return clamp(s, 0, 1);
}

// Real analyst consensus → 0..1 (weighted recommendation mix + target upside).
function analystScore(a) {
  if (!a || !a.reco) return null;
  const r = a.reco;
  const total = (r.strongBuy || 0) + (r.buy || 0) + (r.hold || 0) + (r.sell || 0) + (r.strongSell || 0);
  if (!total) return null;
  let s = ((r.strongBuy || 0) * 1.0 + (r.buy || 0) * 0.8 + (r.hold || 0) * 0.5 + (r.sell || 0) * 0.2 + (r.strongSell || 0) * 0.0) / total;
  if (a.upsidePct != null) s += clamp(a.upsidePct / 100, -0.15, 0.15); // target upside nudges
  return clamp(s, 0, 1);
}

export function computeConviction(c) {
  const sub = {
    trend: trendScore(c),
    momentum: momentumScore(c),
    quality: qualityScore(c),
    value: valueScore(c),
    risk: riskScore(c),
  };

  // Weight; redistribute quality/value when fundamentals are absent (ETF/index/crypto).
  const w = { trend: 0.28, momentum: 0.28, quality: 0.2, value: 0.12, risk: 0.12 };
  if (sub.quality == null && sub.value == null) { w.trend = 0.42; w.momentum = 0.4; w.risk = 0.18; w.quality = 0; w.value = 0; }
  else if (sub.value == null) { w.trend = 0.3; w.momentum = 0.3; w.quality = 0.26; w.value = 0; w.risk = 0.14; }

  let score = 0, wsum = 0;
  for (const k of Object.keys(w)) {
    if (w[k] === 0 || sub[k] == null) continue;
    score += w[k] * sub[k];
    wsum += w[k];
  }
  score = wsum ? (score / wsum) * 100 : 50;

  // Blend in real analyst consensus when available (a "Buy" from many analysts
  // lifts the score; a "Sell" drags it down).
  const aScore = analystScore(c.analyst);
  let analystIncluded = false;
  if (aScore != null) {
    const wA = 0.2;
    score = score * (1 - wA) + aScore * 100 * wA;
    sub.analyst = aScore;
    analystIncluded = true;
  }

  let rating, label;
  if (score >= 78) { rating = 5; label = "Strong setup"; }
  else if (score >= 62) { rating = 4; label = "Favorable"; }
  else if (score >= 46) { rating = 3; label = "Mixed"; }
  else if (score >= 32) { rating = 2; label = "Weak"; }
  else { rating = 1; label = "Avoid"; }

  return {
    rating, label, score: Math.round(score), analystIncluded,
    sub: Object.fromEntries(Object.entries(sub).map(([k, v]) => [k, v == null ? null : Math.round(v * 100)])),
    confidence: analystIncluded ? "Medium-High" : c.isCrypto ? "Low" : sub.quality == null ? "Low-Med" : "Medium",
  };
}

// ---- entry timing ----
export function computeEntry(c) {
  const p = c.price;
  const round = (x) => (x == null ? null : Math.round(x * 100) / 100);
  const $ = (x) => (x == null ? "?" : "$" + (Math.abs(x) >= 1 ? round(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : x.toPrecision(3)));

  if (c.isCrypto) {
    const up7 = (c.change7d ?? 0) > 0, hot = (c.change24h ?? 0) > 12;
    let verdict, headline, detail, zone, reason;
    const dip = round(p * 0.9), dip2 = round(p * 0.85);
    if (up7 && hot) {
      verdict = "WAIT_PULLBACK"; headline = "Extended — let it cool";
      zone = `Wait for a dip toward ${$(dip)}–${$(dip2)}`;
      reason = `Up ${c.change24h?.toFixed(0)}% in 24h — chasing a vertical move is poor risk/reward.`;
      detail = `${reason} A pullback of ~10–15% toward ${$(dip)}–${$(dip2)} offers a better entry.`;
    } else if (up7) {
      verdict = "BUY_NOW"; headline = "Constructive — accumulate";
      zone = `Accumulate near ${$(p)} (add on dips to ${$(dip)})`;
      reason = `Positive 7-day trend (${(c.change7d ?? 0).toFixed(0)}%) without a blow-off top.`;
      detail = `${reason} Reasonable zone to start; add on dips toward ${$(dip)}.`;
    } else if ((c.change7d ?? 0) < -8) {
      verdict = "WAIT_CONFIRM"; headline = "Falling — wait for a base";
      zone = `Wait for it to stop falling and hold above ${$(p)}`;
      reason = `Down ${(c.change7d ?? 0).toFixed(0)}% over the week — no support confirmed yet.`;
      detail = `${reason} Let it stabilize before entering.`;
    } else {
      verdict = "WAIT_CONFIRM"; headline = "Range-bound";
      zone = `Wait for a decisive break from the range`;
      reason = `No clear 7-day trend (${(c.change7d ?? 0).toFixed(1)}%).`;
      detail = reason;
    }
    return {
      verdict, headline, detail, zone, reason,
      timing: "Crypto is highly volatile — averaging in over 3–5 tranches reduces timing risk.",
      levels: { current: round(p) },
      action: entryAction(verdict),
    };
  }

  const { sma20, sma50, sma200, rsi, pctFrom52wHigh, fiftyTwoWeekHigh } = c;
  const downtrend = sma200 != null && p != null && p < sma200 && (sma50 == null || sma50 < sma200);
  const uptrend = sma50 != null && p != null && p > sma50 && (sma200 == null || sma50 > sma200);
  const overbought = rsi != null && rsi >= 72;
  const pctAbove20 = sma20 != null && p != null ? (p / sma20 - 1) * 100 : null;
  const extended = pctAbove20 != null && pctAbove20 > 10;
  const nearHigh = pctFrom52wHigh != null && pctFrom52wHigh >= -3;
  const beta = c.fund?.beta;

  const supports = [sma20, sma50, sma200].filter((s) => s != null && p != null && s < p).sort((a, b) => b - a);
  const support = supports[0] ?? sma50 ?? sma20 ?? null;
  const resistance = !nearHigh && fiftyTwoWeekHigh != null && p != null && fiftyTwoWeekHigh > p ? fiftyTwoWeekHigh : null;

  let verdict, headline, detail, timing = null, zone = null, reason = null;
  const levels = { current: round(p), support: round(support), sma20: round(sma20), sma50: round(sma50), sma200: round(sma200), breakout: round(resistance) };

  if (downtrend && (rsi == null || rsi < 55)) {
    verdict = "AVOID";
    headline = "Not a buy setup yet";
    reason = `Downtrend — price ${$(p)} is below its 200-day average (${$(sma200)})${rsi != null ? `, RSI ${rsi.toFixed(0)}` : ""}.`;
    zone = `No buy zone. Re-evaluate only if it reclaims ${$(sma200)}`;
    detail = `${reason} Wait for a reclaim of ${$(sma200)} that holds, then reassess.`;
    timing = "Could take weeks to months — revisit on a trend change, not on a calendar.";
  } else if (uptrend && (overbought || extended)) {
    verdict = "WAIT_PULLBACK";
    headline = "Strong, but stretched — wait for a dip";
    const lo = round(sma50 ?? support), hi = round(sma20 ?? p);
    reason = `Uptrend is healthy${rsi != null ? `, but RSI ${rsi.toFixed(0)}` : ""}${extended ? ` and price is ${pctAbove20.toFixed(0)}% above its 20-day average` : ""} — overbought/stretched.`;
    zone = `Buy the dip: ${$(lo)}–${$(hi)}`;
    detail = `${reason} Better risk/reward on a pullback into ${$(lo)}–${$(hi)} (the 50- to 20-day zone).`;
    timing = "Typically days to a few weeks — set a price alert at the zone rather than buying up here.";
    levels.addZone = [lo, hi];
  } else if (resistance && !overbought) {
    verdict = "WAIT_BREAKOUT";
    headline = "Coiled below resistance";
    reason = `Trading ${pctFrom52wHigh != null ? `${Math.abs(pctFrom52wHigh).toFixed(0)}% ` : ""}below resistance at its recent high ${$(resistance)}.`;
    zone = `Buy on a daily close above ${$(resistance)}`;
    detail = `${reason} A daily close above ${$(resistance)} on strong volume confirms the breakout. Some take a partial position now (near ${$(p)}) and add on the break.`;
    timing = "Event-driven — the trigger is the breakout, whenever it comes.";
    levels.breakoutTrigger = round(resistance);
  } else if (uptrend && rsi != null && rsi >= 40 && rsi <= 68) {
    verdict = "BUY_NOW";
    headline = "Constructive entry zone";
    const inval = round(sma50 ?? sma200 ?? support);
    reason = `Uptrend intact, RSI ${rsi.toFixed(0)} (not overbought), holding above support ${$(support)}.`;
    zone = `Buy zone: ${$(support)}–${$(p)}`;
    detail = `${reason} This is a reasonable area to start a position. Exit the thesis if it closes below ${$(inval)}.`;
    timing = "No need to wait — though scaling in beats going all-in at once.";
    levels.buyZone = [round(support), round(p)];
    levels.invalidation = inval;
  } else {
    verdict = "WAIT_CONFIRM";
    headline = "Trend unclear — wait for confirmation";
    reason = `Mixed signals${rsi != null ? ` (RSI ${rsi.toFixed(0)})` : ""} — no clean trend.`;
    zone = `Buy on a reclaim of the 50-day at ${$(sma50)}`;
    detail = `${reason} Wait for a reclaim of the 50-day average (${$(sma50)}) on rising volume before committing.`;
    timing = "Revisit on a trend change, not after a fixed period.";
    levels.confirmAbove = round(sma50);
  }

  if (beta != null && beta > 1.8 && verdict !== "AVOID") {
    timing = (timing ? timing + " " : "") + `High volatility (beta ${beta.toFixed(1)}) — averaging in over several tranches cuts timing risk.`;
  }

  // Upcoming earnings = binary event risk: results can gap price straight
  // through any technical level, so flag it prominently near the report date.
  let event = null;
  const e = c.earnings;
  if (e && e.daysAway != null && e.daysAway >= 0 && e.daysAway <= 14) {
    const when = e.daysAway === 0 ? "today" : e.daysAway === 1 ? "tomorrow" : `in ${e.daysAway} days`;
    event = {
      type: "earnings",
      date: e.date,
      daysAway: e.daysAway,
      label: `Earnings ${when}`,
      warning:
        `Earnings ${when} (${e.date}). Results can gap the price straight through any support or trigger level — ` +
        `if you don't want that event risk, wait for the report before entering${verdict === "BUY_NOW" ? ", or size the position smaller" : ""}.`,
    };
  }

  return { verdict, headline, detail, zone, reason, timing, levels, event, action: entryAction(verdict) };
}

function entryAction(verdict) {
  return {
    BUY_NOW: "Buy zone",
    WAIT_PULLBACK: "Wait · dip",
    WAIT_BREAKOUT: "Wait · breakout",
    WAIT_CONFIRM: "Wait · confirm",
    AVOID: "Avoid",
  }[verdict] || "—";
}
