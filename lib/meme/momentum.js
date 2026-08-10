// Acceleration scoring.
//
// The premise: a token already trending is, by definition, late. So we score
// the *derivative* — is the last 5 minutes running hotter than the trailing
// hour, is the buyer count growing, is price confirming — rather than the level.
//
// Every window comparison is normalised to a common rate so the numbers are
// comparable: volume in the m5 bucket is multiplied by 12 to put it on an
// hourly footing before being divided by the actual h1 figure. A ratio above 1
// means "the recent window is outpacing its own baseline".

const rate = (short, long, factor) => (long > 0 ? (short * factor) / long : 0);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Map a ratio onto 0..max points, where `flat` (1.0) scores zero and `hot`
// scores full marks.
function ramp(ratio, max, hot = 3) {
  if (!Number.isFinite(ratio) || ratio <= 1) return 0;
  return Math.round(clamp((ratio - 1) / (hot - 1), 0, 1) * max);
}

export const BANDS = {
  high: Number(process.env.MEME_BAND_HIGH || 70),
  medium: Number(process.env.MEME_BAND_MEDIUM || 50),
};

/**
 * @param {object} t         normalised token from lib/meme/sources.js
 * @param {object} ctx       { chatter: Map<symbol,count>, chatterOk: boolean, boosted: Set<mint> }
 */
export function scoreToken(t, ctx = {}) {
  const why = [];
  const flags = [];
  const v = t.volume, x = t.txns;

  // --- Volume acceleration (0-30) -----------------------------------------
  const a5 = rate(v.m5, v.h1, 12);
  const a15 = rate(v.m15, v.h1, 4);
  const a1 = rate(v.h1, v.h6, 6);
  const volumeAccel = clamp(ramp(a5, 14) + ramp(a15, 10) + ramp(a1, 6), 0, 30);
  if (a15 > 1.3) why.push(`volume ${a15.toFixed(1)}× its hourly baseline`);

  // --- Buyer acceleration (0-25) ------------------------------------------
  const buyers5 = x.m5.buyers ?? 0, buyers1h = x.h1.buyers ?? 0;
  const b5 = rate(buyers5, buyers1h, 12);
  const buys1h = x.h1.buys ?? 0, sells1h = x.h1.sells ?? 0;
  const buys5 = x.m5.buys ?? 0, sells5 = x.m5.sells ?? 0;
  const skew1h = buys1h + sells1h > 0 ? buys1h / (buys1h + sells1h) : 0.5;
  const skew5 = buys5 + sells5 > 0 ? buys5 / (buys5 + sells5) : 0.5;

  let buyerAccel = ramp(b5, 15);
  if (skew5 > 0.55) buyerAccel += Math.round(clamp((skew5 - 0.55) / 0.25, 0, 1) * 10);
  buyerAccel = clamp(buyerAccel, 0, 25);
  if (b5 > 1.3) why.push(`new buyers arriving ${b5.toFixed(1)}× faster than the last hour`);
  if (skew5 > 0.6) why.push(`${Math.round(skew5 * 100)}% of recent trades are buys`);

  // Distribution: more sellers than buyers while price climbs is someone
  // exiting into strength. That's the pattern to avoid, not to chase.
  if (skew5 < 0.42) { flags.push("sell-dominant right now"); }

  // --- Price confirmation (0-15) ------------------------------------------
  // Volume without price is churn; price without volume is a thin mark-up.
  let priceConfirm = 0;
  if (t.priceChange.m15 > 0 && a15 > 1.2) priceConfirm += 9;
  if (t.priceChange.h1 > 0) priceConfirm += 6;
  if (t.priceChange.m15 < -12) { priceConfirm = 0; flags.push("price falling on the move"); }
  priceConfirm = clamp(priceConfirm, 0, 15);

  // --- Earliness (0-20) ---------------------------------------------------
  // The whole ask: catch it before it is loud. Age, size and how much it is
  // already being talked about.
  const ageH = t.createdAt ? (Date.now() - t.createdAt) / 3.6e6 : 999;
  let earliness = 0;
  if (ageH >= 0.5 && ageH <= 6) earliness += 10;
  else if (ageH <= 24) earliness += 8;
  else if (ageH <= 72) earliness += 4;
  if (t.fdvUsd > 0 && t.fdvUsd < 1e6) earliness += 6;
  else if (t.fdvUsd < 5e6) earliness += 4;
  else if (t.fdvUsd < 2e7) earliness += 1;

  // Only credit "nobody is talking about this yet" when we actually looked.
  // A failed fetch also yields zero mentions, and treating that as evidence of
  // obscurity handed every token a free +4 whenever 4chan was unreachable.
  const chatterOk = ctx.chatterOk !== false;
  const chatter = ctx.chatter?.get?.((t.symbol || "").toUpperCase()) || 0;
  if (!chatterOk) flags.push("social check unavailable — earliness unverified");
  else if (chatter === 0) earliness += 4;
  else if (chatter > 4) flags.push(`already discussed on /biz/ (${chatter} threads)`);
  earliness = clamp(earliness, 0, 20);
  if (ageH < 72) why.push(`pool is ${ageH < 1 ? `${Math.round(ageH * 60)}m` : `${ageH.toFixed(0)}h`} old`);

  // --- Liquidity quality (0-10) -------------------------------------------
  const turnover = t.liquidityUsd > 0 ? v.h1 / t.liquidityUsd : 0;
  let liquidityQuality = 0;
  if (turnover > 0.3 && turnover < 12) liquidityQuality += 7;
  else if (turnover >= 12) flags.push(`turnover ${turnover.toFixed(0)}× liquidity in 1h — possible wash trading`);
  if (t.liquidityUsd > 40000) liquidityQuality += 3;
  liquidityQuality = clamp(liquidityQuality, 0, 10);

  // --- Penalties ----------------------------------------------------------
  let score = volumeAccel + buyerAccel + priceConfirm + earliness + liquidityQuality;

  if (ctx.boosted?.has?.(t.mint)) {
    // Someone is paying for attention. That is what an organised pump looks
    // like from outside, so it reduces confidence rather than raising it.
    score -= 12;
    flags.push("paid DexScreener promotion active");
  }
  if (flags.some((f) => f.startsWith("sell-dominant"))) score -= 15;
  if (flags.some((f) => f.includes("wash trading"))) score -= 12;
  if (flags.some((f) => f.startsWith("price falling"))) score -= 10;

  score = clamp(Math.round(score), 0, 100);

  return {
    score,
    band: score >= BANDS.high ? "high" : score >= BANDS.medium ? "medium" : "low",
    components: { volumeAccel, buyerAccel, priceConfirm, earliness, liquidityQuality },
    metrics: {
      ageHours: Number(ageH.toFixed(1)),
      accel5m: Number(a5.toFixed(2)),
      accel15m: Number(a15.toFixed(2)),
      accel1h: Number(a1.toFixed(2)),
      buyerAccel5m: Number(b5.toFixed(2)),
      buyRatio5m: Number(skew5.toFixed(2)),
      buyRatio1h: Number(skew1h.toFixed(2)),
      turnover1h: Number(turnover.toFixed(2)),
      chatter,
    },
    flags,
    why,
  };
}
