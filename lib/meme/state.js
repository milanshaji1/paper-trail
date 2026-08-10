// Radar state: alert cooldowns, the current candidate board, and a log of what
// the safety gate rejected and why.
//
// The rejection log is not incidental — it's how you audit that the gate is
// doing its job instead of silently swallowing everything.

import fs from "node:fs";
import path from "node:path";

const DIR = process.env.DJT_STATE_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DIR, "meme-state.json");

const EMPTY = { version: 1, alerted: {}, candidates: [], rejected: [], lastRun: null, stats: {} };

// Re-alerting the same token every cycle is how a radar becomes an unfollowed
// channel. Only a genuine escalation breaks the cooldown.
const COOLDOWN_MS = Number(process.env.MEME_COOLDOWN_H || 12) * 3.6e6;
const RANK = { low: 0, medium: 1, high: 2 };

export function load() {
  try {
    return { ...EMPTY, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    return structuredClone(EMPTY);
  }
}

export function save(state) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  return FILE;
}

export const statePath = () => FILE;

export function shouldAlert(state, mint, band) {
  // Callers pass a network-qualified key; the same address can exist on two
  // chains and must not share a cooldown.
  const prev = state.alerted[mint];
  if (!prev) return true;
  if (Date.now() - prev.ts > COOLDOWN_MS) return true;
  return RANK[band] > RANK[prev.band]; // escalation only
}

export function recordAlert(state, mint, band, score) {
  state.alerted[mint] = { ts: Date.now(), band, score };
}

export function setBoard(state, candidates, rejected) {
  state.candidates = candidates.slice(0, 60);
  state.rejected = rejected.slice(0, 60);
}

export function prune(state, days = 7) {
  const cutoff = Date.now() - days * 864e5;
  for (const [mint, a] of Object.entries(state.alerted)) {
    if (a.ts < cutoff) delete state.alerted[mint];
  }
  return state;
}
