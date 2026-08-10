// Calibration harness for the impact scorer.
//
// Runs the scorer over the full Truth Social archive and reports what it would
// have alerted on. This is the honest test of selectivity: if the top of the
// list isn't obviously market news, or the alert rate is 15/day, the thresholds
// are wrong and no amount of live testing will hide it.
//
//   node scripts/djt-calibrate.js            # summary + top 40
//   node scripts/djt-calibrate.js --band=medium --sample=30
//   node scripts/djt-calibrate.js --worst     # highest-scoring posts that look like noise

import fs from "node:fs";
import { scorePost, marketSession } from "../lib/djt/impact.js";

const ARCHIVE_URL = "https://ix.cnn.io/data/truth-social/truth_archive.json";
const CACHE = "/tmp/tsa.json";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

async function loadArchive() {
  if (fs.existsSync(CACHE) && fs.statSync(CACHE).size > 1e6) {
    return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  }
  process.stderr.write("fetching archive (~19MB)...\n");
  const res = await fetch(ARCHIVE_URL, { signal: AbortSignal.timeout(60000) });
  const json = await res.json();
  fs.writeFileSync(CACHE, JSON.stringify(json));
  return json;
}

const posts = await loadArchive();
process.stdout.write(`archive: ${posts.length} posts\n\n`);

// Score newest-first, feeding each post the 40 that preceded it (which, in a
// newest-first array, are the ones *after* it) so novelty is measured against
// what he had actually already said at that moment.
const scored = [];
for (let i = 0; i < posts.length; i++) {
  const p = posts[i];
  const recentTexts = posts.slice(i + 1, i + 41).map((x) => x.content || "");
  const r = scorePost({ text: p.content, ts: p.created_at }, { recentTexts });
  scored.push({ ...r, ts: p.created_at, text: p.content || "", url: p.url });
}

// --- Distribution -----------------------------------------------------------
const withText = scored.filter((s) => !s.skipped);
const high = scored.filter((s) => s.band === "high");
const medium = scored.filter((s) => s.band === "medium");

const days = (new Date(posts[0].created_at) - new Date(posts[posts.length - 1].created_at)) / 864e5;

const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`;
process.stdout.write(
  `span                : ${days.toFixed(0)} days\n` +
  `empty / retruth     : ${scored.length - withText.length} (${pct(scored.length - withText.length, scored.length)})\n` +
  `scorable posts      : ${withText.length}\n` +
  `HIGH   (>=70)       : ${high.length}  → ${(high.length / days).toFixed(2)}/day\n` +
  `MEDIUM (40-69)      : ${medium.length}  → ${(medium.length / days).toFixed(2)}/day\n` +
  `ALERTS (medium+)    : ${high.length + medium.length}  → ${((high.length + medium.length) / days).toFixed(2)}/day\n\n`
);

// --- Mechanism breakdown ----------------------------------------------------
const byMech = {};
for (const s of [...high, ...medium]) {
  for (const m of s.mechanisms) byMech[m.label] = (byMech[m.label] || 0) + 1;
}
process.stdout.write("alerts by mechanism:\n");
for (const [k, v] of Object.entries(byMech).sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`  ${k.padEnd(24)} ${String(v).padStart(5)}\n`);
}
process.stdout.write("\n");

// --- Sample -----------------------------------------------------------------
const band = args.band || "high";
const n = Number(args.sample || 40);
let sample = scored.filter((s) => s.band === band).sort((a, b) => b.score - a.score);

// --worst: top-scoring posts with NO named ticker — the likeliest false positives.
if (args.worst) {
  sample = scored.filter((s) => s.score >= 40 && !s.named.length).sort((a, b) => b.score - a.score);
  process.stdout.write("── highest-scoring posts with no explicitly named company (false-positive risk) ──\n\n");
} else {
  process.stdout.write(`── top ${n} in band "${band}" ──\n\n`);
}

for (const s of sample.slice(0, n)) {
  const c = s.components;
  process.stdout.write(
    `[${String(s.score).padStart(3)}] ${s.ts.slice(0, 16)} ${marketSession(s.ts).padEnd(12)} ${s.direction}\n` +
    `      mech=${c.mechanism} ent=${c.entities} mod=${c.modality} spec=${c.specificity} nov=${c.novelty}\n` +
    `      hits: ${s.tickers.slice(0, 10).join(" ") || "—"}\n` +
    `      ${s.text.replace(/\s+/g, " ").slice(0, 190)}\n\n`
  );
}
