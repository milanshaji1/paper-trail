// Alert rendering for memecoin candidates.
//
// Deliberately heavier on caveats than the DJT alert. A political headline is
// information; a 40-minute-old token is a lottery ticket with a counterparty,
// and the message should read that way.

import { send, esc, configured } from "../telegram.js";

export { configured };

const fmtUsd = (n) => {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
};

const fmtAge = (h) => (h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(0)}h` : `${(h / 24).toFixed(0)}d`);

export function formatAlert({ token, scored, safety }) {
  const icon = scored.band === "high" ? "🚀" : "📡";
  const m = scored.metrics;
  const d = safety.details || {};
  const lines = [];

  lines.push(`${icon} <b>${esc(token.symbol || token.name)}</b> · ${scored.score} · ${esc(token.network)}`);
  lines.push(`<i>${esc(token.name)} · ${esc(token.dex)} · ${fmtAge(m.ageHours)} old</i>`);
  lines.push("");

  lines.push(
    `<b>Liquidity</b> ${fmtUsd(token.liquidityUsd)} · <b>FDV</b> ${fmtUsd(token.fdvUsd)}\n` +
    `<b>Vol 1h</b> ${fmtUsd(token.volume.h1)} · <b>15m accel</b> ${m.accel15m}×\n` +
    `<b>Buyers</b> ${m.buyerAccel5m}× · <b>Buy ratio</b> ${Math.round(m.buyRatio5m * 100)}%\n` +
    `<b>Price</b> 15m ${token.priceChange.m15 > 0 ? "+" : ""}${token.priceChange.m15}% · 1h ${token.priceChange.h1 > 0 ? "+" : ""}${token.priceChange.h1}%`
  );
  lines.push("");

  lines.push(
    `✅ <b>Safety</b> risk ${d.riskScore ?? "?"}/100 · top10 ${d.top10Pct ?? "?"}% · ` +
    `${d.holders ?? "?"} holders · mint ${d.mintAuthority ? "LIVE ⚠️" : "renounced"} · ` +
    `freeze ${d.freezeAuthority ? "LIVE ⚠️" : "renounced"}`
  );

  if (scored.why.length) {
    lines.push("");
    lines.push(`<i>${esc(scored.why.slice(0, 3).join(" · "))}</i>`);
  }
  const cautions = [...(scored.flags || []), ...(safety.warnings || [])];
  if (cautions.length) lines.push(`⚠️ <i>${esc(cautions.join(" · "))}</i>`);

  lines.push("");
  lines.push(`<a href="${esc(token.url)}">chart</a> · <code>${esc(token.mint)}</code>`);
  lines.push(`<i>Screening signal, not advice. Most new tokens go to zero.</i>`);

  return lines.join("\n");
}

export const sendAlert = (alert) =>
  send(formatAlert(alert), { silent: alert.scored.band !== "high" });
