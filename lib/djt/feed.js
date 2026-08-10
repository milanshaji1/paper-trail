// Reads the watchers' published state for the dashboard.
//
// Prefers the local file (present when you run the watchers on this machine),
// otherwise the `djt-data` branch on GitHub — which is what the 24/7 Actions
// run publishes. Same artifact either way, so the panel can never show
// something different from what was actually sent to your phone.

import fs from "node:fs";
import path from "node:path";

const REPO = process.env.DJT_FEED_REPO || "milanshaji1/paper-trail";
const BRANCH = process.env.DJT_FEED_BRANCH || "djt-data";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const LOCAL_DIR = process.env.DJT_STATE_DIR || path.join(process.cwd(), "data");

async function readOne(file) {
  const local = path.join(LOCAL_DIR, file);
  try {
    if (fs.existsSync(local)) {
      return { data: JSON.parse(fs.readFileSync(local, "utf8")), origin: "local" };
    }
  } catch { /* fall through to remote */ }

  const res = await fetch(`${RAW}/${file}`, {
    headers: { "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return { data: null, origin: "absent" };
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  return { data: await res.json(), origin: "github" };
}

export async function fetchDjtFeed() {
  const { data, origin } = await readOne("djt-state.json");
  return {
    updatedAt: data?.lastRun ?? null,
    origin,
    alerts: data?.alerts ?? [],
    stats: data?.stats ?? {},
  };
}

export async function fetchMemeFeed() {
  const { data, origin } = await readOne("meme-state.json");
  return {
    updatedAt: data?.lastRun ?? null,
    origin,
    candidates: data?.candidates ?? [],
    rejected: data?.rejected ?? [],
    stats: data?.stats ?? {},
    book: data?.bookSummary ?? null,
  };
}
