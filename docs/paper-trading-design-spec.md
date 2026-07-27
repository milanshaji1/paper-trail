# Paper trading autopilot: design spec

**Date:** 2026-07-03 · **Status:** Approved by user (high-risk default, stocks + crypto, $100k)

## Purpose

Validate Market Pulse's own signals by running a **fully simulated** portfolio that
auto-follows the app's conviction ratings and entry plans. Produces a real track
record (win rate, P&L, drawdown) before any real money is considered.
**No brokerage connection exists or will exist. Fake money only.**

## Architecture (chosen: server-side engine)

- `lib/paper.js` — pure decision logic (`decideEntry`, `decideExit`, sizing, metrics)
  plus a `PaperEngine` class that owns state and persistence.
- State persists to `data/paper.json` (atomic write: tmp + rename). Survives restarts.
- Engine hook: after each stock ranking pass and each crypto refresh, the server calls
  `engine.evaluate({ stocks, crypto, now })`.
- Rejected: browser-side (only trades with a tab open; Mac/phone diverge) and
  signal-log-only (no P&L/sizing, so weaker validation).

## Portfolio rules

- Starting cash: **$100,000** (fake). Fees: **0.1% per side** so results are understated.
- Positions are fractional-quantity. Equity = cash + Σ(qty × lastPrice).

### Risk profiles

| | Low | Medium | **High (default)** |
|---|---|---|---|
| Min conviction | 5/5 | 4/5 | 4/5 |
| Entry kinds | Buy zone only | Buy zone only | Buy zone **+ breakout cross** |
| Position size | 5% | 8% | **12% of equity** |
| Max positions | 8 | 10 | **12** |
| Max crypto positions | 2 | 3 | **4** |
| Earnings ≤N days | skip ≤7d | skip ≤3d | **take (tagged)** |

### Entries

- Equity: `conviction.rating ≥ min` AND (`entry.verdict === "BUY_NOW"` or, high risk
  only, `entry.verdict === "WAIT_BREAKOUT"` with `price ≥ levels.breakoutTrigger`).
- Crypto: `rating ≥ min` AND `verdict === "BUY_NOW"`; capped per risk profile.
- Skip if already held, closed earlier in the same cycle (no stop-out→instant-rebuy churn),
  or insufficient cash. Every entry logs price, time, kind, reason.
- Note (found via TDD): with 12% sizing, cash — not the 12-position ceiling — is the
  binding constraint: high risk tops out ~8 concurrent positions ≈ 96% deployed. No leverage.

### Exits (first trigger wins)

- **Stop:** price ≤ stop. Equity stop starts at `entry.levels.invalidation`
  (fallback: sma50, else entry −8%); **trails up** to sma50 each cycle, never down.
  Crypto stop is fixed entry −15%, ratcheting to breakeven once price ≥ entry +10%.
- **Avoid flip:** entry verdict becomes `AVOID`.
- **Conviction collapse:** rating ≤ 2.
- Exits log price, time, reason, realized P&L (after fees).

### Metrics

Total return %, win rate, avg win %, avg loss %, profit factor, max drawdown
(from throttled equity history, capped at 2,000 points), open/closed counts.

## API & UI

- `GET /api/paper` → full state + metrics. Summary embedded in `/api/dashboard`.
- `POST /api/paper/reset` `{risk}` → fresh book (risk change requires reset so the
  track record stays clean).
- New sidebar section **Autopilot (Paper)**: SIMULATED banner, stat tiles, open
  positions (entry/now/P&L/stop/reason), trade history, risk selector + reset.
- Disclosed limitation: evaluates only while the app is running.

## Testing (TDD)

`node --test` suite written before implementation: entry qualification per risk
level, breakout cross, sizing/caps, fees, stop + trailing behavior, crypto
breakeven ratchet, avoid-flip and collapse exits, metrics math, persistence
round-trip, reset. `npm test` runs it.

## Implementation plan

1. `test/paper.test.js` (red) → 2. `lib/paper.js` (green) → 3. server wiring +
endpoints → 4. UI section + styles → 5. live boot verification on temp port →
6. sync to `~/Desktop/Stocks`.
