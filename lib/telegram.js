// Telegram transport, shared by the watchers.
//
// HTML parse mode rather than MarkdownV2: MarkdownV2 requires escaping 18
// characters and these messages are wall-to-wall punctuation. HTML needs three.
//
// With no token configured every send is a no-op that reports itself, so the
// watchers stay runnable and testable on a machine with no secrets.

const API = "https://api.telegram.org";

export const configured = () =>
  Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

export const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const truncate = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/**
 * @returns {{sent:boolean, reason?:string, retryable?:boolean}}
 *   `retryable` distinguishes "Telegram blipped, try again next cycle" from
 *   "there is no bot configured, stop asking". Callers use it to decide whether
 *   to leave the item unseen so it gets another chance.
 */
export async function send(text, { silent = false } = {}) {
  // Not an error: the watchers are meant to run headless without secrets.
  if (!configured()) return { sent: false, reason: "no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID", retryable: false };

  const res = await fetch(`${API}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      // Only high-band alerts make a sound; medium arrives silently.
      disable_notification: silent,
      link_preview_options: { is_disabled: true },
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 4xx means the request itself is wrong (bad chat id, malformed HTML) and
    // will fail identically next time. 429/5xx are worth another attempt.
    const retryable = res.status === 429 || res.status >= 500;
    return { sent: false, reason: `Telegram HTTP ${res.status}: ${truncate(body, 200)}`, retryable };
  }
  return { sent: true };
}
