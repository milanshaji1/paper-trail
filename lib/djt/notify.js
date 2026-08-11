// Alert rendering for Trump posts and presidential actions.
// Transport lives in lib/telegram.js.

import { send, esc, truncate, configured } from "../telegram.js";
import { explain, explainLaunch } from "./explain.js";

export { configured };

const BAND = {
  high: { icon: "🔴", label: "HIGH IMPACT" },
  medium: { icon: "🟠", label: "MEDIUM" },
  low: { icon: "⚪", label: "LOW" },
};

/**
 * Front-loads the verdict: on a lock screen you should see band, score and
 * market session before the notification is truncated.
 */
export function formatAlert({ post, scored, session }) {
  const b = BAND[scored.band] || BAND.low;
  const lines = [];

  lines.push(`${b.icon} <b>${b.label}</b> · ${scored.score} · ${esc(session)}`);
  lines.push("");
  lines.push(`<i>${esc(post.sourceLabel)}</i>`);
  lines.push(`<blockquote>${esc(truncate(post.text.replace(/\s+/g, " "), 420))}</blockquote>`);

  // The "so what", before the ticker soup — this is the line that has to survive
  // being read on a lock screen.
  lines.push(`<b>What it means:</b> ${esc(explain(post, scored))}`);
  lines.push("");

  if (scored.named.length) lines.push(`<b>Named:</b> ${scored.named.join(" ")}`);
  if (scored.bullish.length) lines.push(`📈 <b>Helps:</b> ${scored.bullish.join(" ")}`);
  if (scored.bearish.length) lines.push(`📉 <b>Hurts:</b> ${scored.bearish.join(" ")}`);
  if (scored.mixed?.length) lines.push(`⚖️ <b>Mixed:</b> ${scored.mixed.join(" ")}`);

  const mech = scored.mechanisms.map((m) => m.label).join(" + ");
  if (mech) lines.push(`<b>Mechanism:</b> ${esc(mech)} · ${esc(scored.direction)}`);

  lines.push("");
  lines.push(`<i>${esc(scored.why.slice(0, 4).join(" · "))}</i>`);
  if (post.url) lines.push(`<a href="${esc(post.url)}">source</a>`);

  return lines.join("\n");
}

/**
 * Token-launch alert. Deliberately distinct from the policy alerts: it leads
 * with the contract address, and it states the latency reality up front so the
 * message can never be mistaken for a tradeable edge.
 */
export function formatLaunchAlert({ post, launch, session, market }) {
  const lines = [];
  const conf = launch.confidence === "high" ? "CONTRACT ADDRESS POSTED" : "POSSIBLE TOKEN LAUNCH";

  lines.push(`🚨 <b>${conf}</b> · ${esc(session)}`);
  lines.push(`<i>${esc(post.sourceLabel)}</i>`);
  lines.push(`<blockquote>${esc(truncate(post.text.replace(/\s+/g, " "), 400))}</blockquote>`);
  lines.push(`<b>What it means:</b> ${esc(explainLaunch(post, launch))}`);
  lines.push("");

  for (const a of launch.addresses.slice(0, 3)) {
    lines.push(`<b>${esc(a.chain)}:</b> <code>${esc(a.address)}</code>`);
  }
  if (launch.cashtags.length) lines.push(`<b>Ticker:</b> ${launch.cashtags.map((c) => `$${esc(c)}`).join(" ")}`);
  if (launch.platforms.length) lines.push(`<b>Platform:</b> ${esc(launch.platforms.join(", "))}`);

  if (market?.live) {
    lines.push(
      `<b>Market:</b> live on ${esc(market.network)} · ` +
      `$${market.priceUsd ?? "?"} · liq $${Math.round(market.liquidityUsd || 0).toLocaleString()}`
    );
  } else if (launch.addresses.length) {
    lines.push(`<b>Market:</b> no pool found yet`);
  }

  lines.push("");
  lines.push(`<i>${esc(launch.reasons.join(" · "))}</i>`);
  lines.push(
    `<i>⚠️ Detection latency is 5–20 min. $TRUMP repriced in minutes and ` +
    `~989k wallets are down $3.8B on it. This is an awareness alert, not an edge, and not advice.</i>`
  );
  if (post.url) lines.push(`<a href="${esc(post.url)}">source</a>`);

  return lines.join("\n");
}

// Launches always make a sound — that is the one category where a delay of one
// polling cycle genuinely matters.
export const sendLaunchAlert = (alert) => send(formatLaunchAlert(alert), { silent: false });

export const sendAlert = (alert) =>
  send(formatAlert(alert), { silent: alert.scored.band !== "high" });
