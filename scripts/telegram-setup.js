#!/usr/bin/env node
// Interactive-ish setup helper for Telegram delivery.
//
//   node scripts/telegram-setup.js
//
// Reads TELEGRAM_BOT_TOKEN from .env, verifies it, discovers your chat id from
// the message you sent the bot, writes that id back to .env, and sends a test
// alert.
//
// The token is read from the environment and never printed — only a masked
// fingerprint appears in output, so this is safe to run with someone watching
// or to paste the output into a chat.

import "../lib/config.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENV_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");

// Hand-copied tokens routinely arrive with stray spaces or a dropped character.
// Strip whitespace, then check the shape locally — a precise "your paste is 45
// chars, needs 46" beats Telegram's opaque "Not Found".
const RAW_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TOKEN = RAW_TOKEN.replace(/\s+/g, "");
// Deliberately loose. Telegram is the authority on whether a token is valid;
// this only catches pastes that are obviously broken (whitespace, no colon,
// wrong charset) so we fail in a second with a clear reason instead of on a
// round-trip. An exact length check here once rejected a token that only LOOKED
// a character short — let the API adjudicate anything borderline.
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,45}$/;

const ok = (m) => process.stdout.write(`  ✔ ${m}\n`);
const bad = (m) => process.stdout.write(`  ✘ ${m}\n`);
const info = (m) => process.stdout.write(`    ${m}\n`);

// Never print a credential. Enough to confirm which token is loaded, useless
// to anyone who sees it.
const mask = (t) => (t.length < 12 ? "(too short)" : `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} chars)`);

async function api(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    throw new Error(json.description || `HTTP ${res.status}`);
  }
  return json.result;
}

function writeEnv(key, value) {
  let text = fs.readFileSync(ENV_PATH, "utf8");
  const line = `${key}=${value}`;
  text = new RegExp(`^${key}=.*$`, "m").test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${text.trimEnd()}\n${line}\n`;
  fs.writeFileSync(ENV_PATH, text);
}

// --- 0. optional: take the token straight from the clipboard ----------------
// Two manual pastes in a row arrived corrupted (embedded spaces, then a dropped
// character). Reading the clipboard directly removes the human step that keeps
// breaking it. The value goes from clipboard to .env without being displayed.
process.stdout.write("\nTelegram setup\n──────────────\n");

if (process.argv.includes("--from-clipboard")) {
  const { execSync } = await import("node:child_process");
  let clip = "";
  try {
    clip = execSync("pbpaste", { encoding: "utf8" });
  } catch {
    bad("could not read the clipboard (pbpaste failed)");
    process.exit(1);
  }
  const candidate = clip.replace(/\s+/g, "");
  if (!TOKEN_RE.test(candidate)) {
    bad("the clipboard does not contain a Telegram token");
    info(`clipboard holds ${candidate.length} non-whitespace characters; a token is ~46`);
    info("Copy the token from BotFather (tap the code block), then re-run.");
    process.exit(1);
  }
  writeEnv("TELEGRAM_BOT_TOKEN", candidate);
  ok(`token written to .env from clipboard: ${mask(candidate)}`);
  info("re-running with the new value…\n");
  // Re-exec so the new value is read fresh. The child prints its own diagnosis,
  // so surface its exit code rather than letting execFileSync throw a stack
  // trace over the top of a perfectly clear message.
  const { spawnSync } = await import("node:child_process");
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { stdio: "inherit" });
  process.exit(child.status ?? 1);
}

if (!TOKEN) {
  bad("TELEGRAM_BOT_TOKEN is empty in .env");
  info("Message @BotFather on Telegram → /newbot → paste the token into .env, then re-run.");
  process.exit(1);
}
if (!TOKEN_RE.test(TOKEN)) {
  bad("the token in .env is not a valid Telegram token");
  const suffix = TOKEN.split(":")[1] ?? "";
  info(`length ${TOKEN.length} after removing whitespace — a typical token is 46`);
  if (RAW_TOKEN !== TOKEN) info(`${RAW_TOKEN.length - TOKEN.length} whitespace character(s) were embedded in the value`);
  if (!TOKEN.includes(":")) info("missing the ':' separator entirely");
  else if (!/^\d+$/.test(TOKEN.split(":")[0])) info("the part before ':' should be all digits");
  else if (suffix.length < 30) info(`the part after ':' is only ${suffix.length} characters — looks truncated`);
  else info("the part after ':' contains characters outside A-Z a-z 0-9 _ -");
  process.stdout.write("\n");
  info("Re-copy it: in Telegram open BotFather, send /mybots → your bot → API Token,");
  info("then TAP the token (it is a code block, tapping copies it exactly).");
  info("Selecting it by hand is what introduces spaces and drops characters.");
  process.exit(1);
}
ok(`token loaded: ${mask(TOKEN)}`);
if (RAW_TOKEN !== TOKEN) ok("stripped stray whitespace from the pasted value");

// --- 2. token valid? --------------------------------------------------------
let me;
try {
  me = await api("getMe");
  ok(`bot verified: @${me.username} ("${me.first_name}")`);
} catch (err) {
  bad(`token rejected by Telegram: ${err.message}`);
  info("Check for a stray space or a truncated paste in .env, then re-run.");
  process.exit(1);
}

// --- 3. find the chat id ----------------------------------------------------
let chatId = process.env.TELEGRAM_CHAT_ID || "";
if (chatId) {
  ok(`chat id already set: ${chatId}`);
} else {
  const updates = await api("getUpdates").catch(() => []);
  const chats = new Map();
  for (const u of updates) {
    const c = u.message?.chat || u.channel_post?.chat;
    if (c?.id) chats.set(String(c.id), c);
  }

  if (!chats.size) {
    bad("no messages found — Telegram bots cannot message you first");
    info(`Open Telegram, search @${me.username}, press Start and send it any message.`);
    info("Then re-run this script.");
    process.exit(1);
  }

  if (chats.size > 1) {
    bad(`found ${chats.size} chats — set TELEGRAM_CHAT_ID in .env manually:`);
    for (const [id, c] of chats) info(`  ${id}  ${c.title || c.first_name || c.type}`);
    process.exit(1);
  }

  const [id, chat] = [...chats][0];
  chatId = id;
  writeEnv("TELEGRAM_CHAT_ID", chatId);
  process.env.TELEGRAM_CHAT_ID = chatId;
  ok(`chat id discovered and saved: ${chatId} (${chat.first_name || chat.title || chat.type})`);
}

// --- 4. send a real alert through the real code path ------------------------
const { send, configured } = await import("../lib/telegram.js");
if (!configured()) {
  bad("still not configured after setup — unexpected");
  process.exit(1);
}

const r = await send(
  "✅ <b>PaperTrail is connected</b>\n\n" +
    "This is a test from <code>scripts/telegram-setup.js</code>.\n\n" +
    "You'll get:\n" +
    "🔴 <b>HIGH</b> — market-moving posts (with sound)\n" +
    "🟠 <b>MEDIUM</b> — worth knowing (silent)\n" +
    "🚨 <b>LAUNCH</b> — a contract address in a Trump post\n" +
    "📡 <b>RADAR</b> — a memecoin that cleared the safety gate\n\n" +
    "<i>Roughly one alert a day. Screening signals, not advice.</i>"
);

if (r.sent) {
  ok("test message sent — check your phone");
  process.stdout.write("\nDone. Both watchers will now deliver alerts.\n\n");
} else {
  bad(`send failed: ${r.reason}`);
  process.exit(1);
}
