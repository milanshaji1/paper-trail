// Watcher state: what we've already seen, what we alerted on, and the caching
// metadata the conditional GET needs.
//
// In GitHub Actions this file lives on the `djt-data` branch, which is also
// what the dashboard reads. One artifact, so the panel can never disagree with
// what actually reached the phone.

import fs from "node:fs";
import path from "node:path";

const DIR = process.env.DJT_STATE_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DIR, "djt-state.json");

const EMPTY = { version: 1, meta: {}, seen: {}, alerts: [], lastRun: null, stats: {} };

export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { ...EMPTY, ...raw };
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

/** First run has no history — treat everything as seen so we don't alert on a backlog. */
export const isBootstrap = (state) => Object.keys(state.seen).length === 0;

export function markSeen(state, posts) {
  for (const p of posts) state.seen[p.id] = p.ts;
}

export const isNew = (state, post) => !(post.id in state.seen);

export function recordAlert(state, entry) {
  state.alerts.unshift(entry);
  state.alerts = state.alerts.slice(0, 300);
}

/** Keep the file bounded: 90 days of ids, 300 alerts. */
export function prune(state, days = 90) {
  const cutoff = Date.now() - days * 864e5;
  for (const [id, ts] of Object.entries(state.seen)) {
    if (ts < cutoff) delete state.seen[id];
  }
  state.alerts = state.alerts.filter((a) => a.ts >= cutoff);
  return state;
}
