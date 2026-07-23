// Loads optional API keys from a `.env` file (if present) into process.env.
// The dashboard works fully without any keys; adding them unlocks extra,
// higher-accuracy data (see .env.example). No key is ever required.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");

try {
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      const k = m[1];
      const v = m[2].replace(/^['"]|['"]$/g, "");
      if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
    }
  }
} catch { /* ignore — keys are optional */ }

export const config = {
  finnhubKey: process.env.FINNHUB_API_KEY || "",
  fredKey: process.env.FRED_API_KEY || "",
  coingeckoKey: process.env.COINGECKO_DEMO_KEY || "",
};
