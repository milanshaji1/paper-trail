// Forward paper-trading book for the memecoin radar.
//
// Why this exists: a screener that surfaces candidates and never grades itself
// is a tip sheet. PaperTrail's whole posture is that a signal has to earn trust
// by accumulating a visible record first (see PRODUCT.md — "show the work"),
// and that applies hardest here, where the base rate is brutal.
//
// Every alert opens a SIMULATED position. Nothing here touches real money, and
// the numbers are deliberately pessimistic:
//   - a slippage + fee haircut is charged on both sides, because a $30k-liquidity
//     memecoin does not fill at the quoted mid
//   - the peak price is tracked separately from the exit, so the summary can
//     distinguish "the signal was wrong" from "the signal was right and the exit
//     rule was wrong". Those need different fixes.
//
// Marking to market is free in the common case: positions are priced from the
// new/trending pools the watcher already pulls each cycle. Only positions that
// have dropped out of those lists need a lookup, and if that fails the position
// simply goes unmarked until next cycle.

export const RULES = {
  stopPct: Number(process.env.MEME_STOP_PCT || -40),
  targetPct: Number(process.env.MEME_TARGET_PCT || 150),
  maxHoldHours: Number(process.env.MEME_MAX_HOLD_H || 48),
  // 1% swap fee + 2% assumed slippage, charged entering AND exiting.
  costPctPerSide: Number(process.env.MEME_COST_PCT || 3),
};

export const emptyBook = () => ({ version: 1, open: [], closed: [], startedAt: Date.now() });

const pct = (from, to) => (from > 0 ? ((to - from) / from) * 100 : 0);

/** Open a simulated position for an alerted candidate. */
export function openPosition(book, { token, scored, safety }, now = Date.now()) {
  const key = `${token.network}:${token.mint}`;
  if (book.open.some((p) => p.key === key)) return null; // already holding

  const price = Number(token.priceUsd) || 0;
  if (price <= 0) return null; // cannot simulate an entry without a price

  const pos = {
    key,
    mint: token.mint,
    network: token.network,
    symbol: token.symbol,
    poolAddress: token.poolAddress,
    url: token.url,
    openedAt: now,
    entryPrice: price,
    peakPrice: price,
    lastPrice: price,
    lastMarkedAt: now,
    score: scored.score,
    band: scored.band,
    safetyProvider: safety?.details?.provider || null,
  };
  book.open.push(pos);
  return pos;
}

function closePosition(book, pos, reason, exitPrice, now) {
  // Charge the haircut on both legs — entry fill worse than quoted, exit too.
  const c = RULES.costPctPerSide / 100;
  const grossPct = pct(pos.entryPrice, exitPrice);
  const netPct = ((1 + grossPct / 100) * (1 - c) * (1 - c) - 1) * 100;

  book.closed.unshift({
    ...pos,
    closedAt: now,
    exitPrice,
    reason,
    holdHours: Number(((now - pos.openedAt) / 3.6e6).toFixed(2)),
    grossPct: Number(grossPct.toFixed(1)),
    netPct: Number(netPct.toFixed(1)),
    // Max favourable excursion: the best it ever offered. If MFE is strongly
    // positive on losers, the signal worked and the exit rule is what failed.
    mfePct: Number(pct(pos.entryPrice, pos.peakPrice).toFixed(1)),
    win: netPct > 0,
  });
  book.closed = book.closed.slice(0, 500);
  book.open = book.open.filter((p) => p.key !== pos.key);
}

/**
 * Mark open positions and close any that hit a rule.
 * @param {Map<string, number>} pricesByKey  "network:mint" → current USD price
 */
export function markToMarket(book, pricesByKey, now = Date.now()) {
  const events = [];

  for (const pos of [...book.open]) {
    const price = pricesByKey.get(pos.key);
    const ageH = (now - pos.openedAt) / 3.6e6;

    if (Number.isFinite(price) && price > 0) {
      pos.lastPrice = price;
      pos.lastMarkedAt = now;
      if (price > pos.peakPrice) pos.peakPrice = price;

      const move = pct(pos.entryPrice, price);
      if (move <= RULES.stopPct) { closePosition(book, pos, "stop", price, now); events.push({ pos, reason: "stop" }); continue; }
      if (move >= RULES.targetPct) { closePosition(book, pos, "target", price, now); events.push({ pos, reason: "target" }); continue; }
    }

    // Time-stop uses the last known price. A position we can no longer price is
    // usually one whose pool died — closing it at its last mark is the honest
    // outcome, not dropping it from the record.
    if (ageH >= RULES.maxHoldHours) {
      closePosition(book, pos, Number.isFinite(price) ? "time" : "unpriceable", pos.lastPrice, now);
      events.push({ pos, reason: "time" });
    }
  }
  return events;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Number((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(1));
};

/** Honest scorecard. Reports "not enough data" rather than a flattering number. */
export function summary(book) {
  const closed = book.closed || [];
  const rets = closed.map((c) => c.netPct);
  const wins = closed.filter((c) => c.win);

  const byBand = {};
  for (const band of ["high", "medium"]) {
    const sub = closed.filter((c) => c.band === band);
    byBand[band] = sub.length
      ? { n: sub.length, winRate: Number(((sub.filter((c) => c.win).length / sub.length) * 100).toFixed(0)), median: median(sub.map((c) => c.netPct)) }
      : { n: 0, winRate: null, median: null };
  }

  return {
    simulated: true,
    rules: RULES,
    startedAt: book.startedAt,
    openCount: (book.open || []).length,
    closedCount: closed.length,
    // Below ~20 closed trades none of this means anything, and the UI should
    // say so rather than render a win rate off three samples.
    significant: closed.length >= 20,
    winRate: closed.length ? Number(((wins.length / closed.length) * 100).toFixed(0)) : null,
    medianReturnPct: median(rets),
    meanReturnPct: rets.length ? Number((rets.reduce((a, b) => a + b, 0) / rets.length).toFixed(1)) : null,
    bestPct: rets.length ? Math.max(...rets) : null,
    worstPct: rets.length ? Math.min(...rets) : null,
    // If this is high while medianReturn is negative, the entries were fine and
    // the exit rule is throwing the gains away.
    medianMfePct: median(closed.map((c) => c.mfePct)),
    exitReasons: closed.reduce((a, c) => ({ ...a, [c.reason]: (a[c.reason] || 0) + 1 }), {}),
    byBand,
    open: (book.open || []).map((p) => ({
      symbol: p.symbol, network: p.network, band: p.band, score: p.score, url: p.url,
      entryPrice: p.entryPrice, lastPrice: p.lastPrice,
      unrealisedPct: Number(pct(p.entryPrice, p.lastPrice).toFixed(1)),
      ageHours: Number(((Date.now() - p.openedAt) / 3.6e6).toFixed(1)),
    })),
    recent: closed.slice(0, 20).map((c) => ({
      symbol: c.symbol, network: c.network, band: c.band, score: c.score,
      netPct: c.netPct, mfePct: c.mfePct, reason: c.reason, holdHours: c.holdHours, closedAt: c.closedAt,
    })),
  };
}
