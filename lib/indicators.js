// Small, dependency-free technical-indicator toolkit + the "opportunity" score.
// Everything here is a heuristic for surfacing momentum — NOT financial advice.

export function sma(values, period) {
  if (!values || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

// Wilder's RSI.
export function rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Percentage return over the last `days` closes.
export function returnPct(closes, days) {
  if (!closes || closes.length <= days) return null;
  const past = closes[closes.length - 1 - days];
  const now = closes[closes.length - 1];
  if (!past) return null;
  return ((now - past) / past) * 100;
}

// Exponential moving average series.
export function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = new Array(period - 1).fill(null);
  out.push(e);
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

// MACD (12/26/9). Returns the latest macd, signal and histogram.
export function macd(closes, fast = 12, slow = 26, signalP = 9) {
  if (!closes || closes.length < slow + signalP) return null;
  const eFast = ema(closes, fast);
  const eSlow = ema(closes, slow);
  const line = closes.map((_, i) =>
    eFast[i] != null && eSlow[i] != null ? eFast[i] - eSlow[i] : null
  );
  const clean = line.filter((v) => v != null);
  const sig = ema(clean, signalP);
  const macdVal = clean[clean.length - 1];
  const signalVal = sig ? sig[sig.length - 1] : null;
  const prevMacd = clean[clean.length - 2];
  const prevSignal = sig ? sig[sig.length - 2] : null;
  return {
    macd: macdVal,
    signal: signalVal,
    hist: signalVal != null ? macdVal - signalVal : null,
    // crossed up this bar?
    crossUp: prevMacd != null && prevSignal != null && prevMacd <= prevSignal && macdVal > signalVal,
    crossDown: prevMacd != null && prevSignal != null && prevMacd >= prevSignal && macdVal < signalVal,
  };
}

// Compound annual growth rate from a time series, targeting `years` back.
// Falls back to since-inception when history is shorter than requested.
export function cagrFromPoints(points, years) {
  if (!points || points.length < 2) return null;
  const now = points[points.length - 1];
  const targetT = now.t - years * 365.25 * 864e5;
  let past = points[0];
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].t <= targetT) { past = points[i]; break; }
  }
  if (!past || !past.c || past.c <= 0) return null;
  const actualYears = Math.max((now.t - past.t) / (365.25 * 864e5), 0.05);
  const value = (Math.pow(now.c / past.c, 1 / actualYears) - 1) * 100;
  return { value, actualYears, sinceInception: actualYears < years - 0.5 };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Composite 0–100 "upturn potential" score built from trend, momentum,
// RSI posture, volume surge and breakout proximity. Returns the score plus
// the individual signals so the UI can explain *why* something ranks high.
export function opportunityScore(m) {
  const signals = [];
  let score = 0;

  // --- Trend structure (0–22): price above rising moving averages ---
  if (m.price != null && m.sma20 != null && m.sma50 != null) {
    if (m.price > m.sma20) score += 8;
    if (m.sma20 > m.sma50) score += 8;
    if (m.price > m.sma50) score += 6;
    if (m.price > m.sma20 && m.sma20 > m.sma50) {
      signals.push({ label: "Uptrend", tone: "good" });
    } else if (m.price < m.sma50) {
      signals.push({ label: "Below trend", tone: "bad" });
    }
  }

  // --- 52-week range position (0–14): momentum proxy that works even before
  //     chart history (RSI/SMA) is available. High in the range = strength. ---
  if (m.rangePos != null) {
    if (m.rangePos >= 0.9) score += 14;
    else if (m.rangePos >= 0.75) score += 11;
    else if (m.rangePos >= 0.5) score += 7;
    else if (m.rangePos >= 0.3) score += 3;
    if (m.rangePos <= 0.15) signals.push({ label: "Near 52w low", tone: "bad" });
  }

  // --- Momentum (0–26): blend of 1M and 3M returns ---
  const mom = [];
  if (m.ret1m != null) mom.push(clamp(m.ret1m, -20, 20) / 20 * 16);
  if (m.ret3m != null) mom.push(clamp(m.ret3m, -40, 40) / 40 * 10);
  const momScore = mom.reduce((a, b) => a + b, 0);
  score += clamp(momScore, -10, 26);
  if (m.ret1m != null && m.ret1m > 8) signals.push({ label: `+${m.ret1m.toFixed(0)}% 1M`, tone: "good" });
  else if (m.ret1m != null && m.ret1m < -8) signals.push({ label: `${m.ret1m.toFixed(0)}% 1M`, tone: "bad" });

  // --- RSI posture (0–18): reward strong-but-not-euphoric momentum ---
  if (m.rsi != null) {
    if (m.rsi >= 78) { score += 2; signals.push({ label: `Overbought RSI ${m.rsi.toFixed(0)}`, tone: "warn" }); }
    else if (m.rsi >= 55) { score += 18; signals.push({ label: `Strong RSI ${m.rsi.toFixed(0)}`, tone: "good" }); }
    else if (m.rsi >= 45) score += 11;
    else if (m.rsi >= 32) score += 6;
    else { score += 8; signals.push({ label: `Oversold RSI ${m.rsi.toFixed(0)}`, tone: "warn" }); }
  }

  // --- Volume surge (0–18): today's volume vs 20-day average ---
  if (m.volRatio != null) {
    if (m.volRatio >= 2.5) { score += 18; signals.push({ label: `${m.volRatio.toFixed(1)}× volume`, tone: "good" }); }
    else if (m.volRatio >= 1.5) { score += 12; signals.push({ label: `${m.volRatio.toFixed(1)}× volume`, tone: "good" }); }
    else if (m.volRatio >= 1.1) score += 6;
  }

  // --- Breakout proximity (0–16): distance to 52-week high ---
  if (m.pctFrom52wHigh != null) {
    const d = m.pctFrom52wHigh; // negative = below high
    if (d >= -2) { score += 16; signals.push({ label: "At 52w high", tone: "good" }); }
    else if (d >= -8) { score += 12; signals.push({ label: "Near 52w high", tone: "good" }); }
    else if (d >= -20) score += 6;
  }

  // --- Intraday spark (0–?): today's move nudges the score a touch ---
  if (m.changePct != null) score += clamp(m.changePct, -6, 6);

  score = clamp(Math.round(score), 0, 100);

  let bucket, tone;
  if (score >= 72) { bucket = "High"; tone = "hot"; }
  else if (score >= 55) { bucket = "Elevated"; tone = "warm"; }
  else if (score >= 38) { bucket = "Neutral"; tone = "neutral"; }
  else { bucket = "Weak"; tone = "cool"; }

  return { score, bucket, tone, signals: signals.slice(0, 4) };
}
