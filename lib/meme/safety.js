// The hard safety gate.
//
// This runs BEFORE momentum scoring and rejects outright. That ordering is the
// whole point: "find memecoins early" selects, by construction, for tokens that
// have not rugged *yet*, so a radar without a gate is a rug feed with extra
// steps. Nothing gets alerted on unless it clears every check here.
//
// Two providers, both free and keyless: RugCheck for Solana, GoPlus for the EVM
// chains. Every rejection keeps its reason so the dashboard can show why
// something was filtered rather than silently disappearing it.
//
// The distinction between `reasons` (disqualifying) and `warnings` (worth
// seeing, not worth blocking) is load-bearing and was set empirically. See the
// note on insider networks in evaluate() — getting that wrong rejected BONK.

const RUGCHECK = "https://api.rugcheck.xyz/v1/tokens";
const GOPLUS = "https://api.gopluslabs.io/api/v1/token_security";

// GoPlus covers the EVM chains; RugCheck covers Solana. Between them we can
// verify everywhere we look, so nothing has to be alerted on blind.
const EVM_CHAIN_IDS = {
  base: 8453, ethereum: 1, eth: 1, bsc: 56, arbitrum: 42161,
  polygon: 137, avalanche: 43114, optimism: 10,
};

export const LIMITS = {
  minLiquidityUsd: Number(process.env.MEME_MIN_LIQ || 15000),
  maxTop10Pct: Number(process.env.MEME_MAX_TOP10 || 60),
  minHolders: Number(process.env.MEME_MIN_HOLDERS || 50),
  maxRugcheckScore: Number(process.env.MEME_MAX_RISK || 40),
  maxTaxPct: Number(process.env.MEME_MAX_TAX || 10),
};

export const canVerify = (network) => network === "solana" || network in EVM_CHAIN_IDS;

export async function fetchReport(mint) {
  const res = await fetch(`${RUGCHECK}/${mint}/report`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404) throw new Error("not indexed by RugCheck");
  if (res.status === 429) throw new Error("RugCheck rate limited");
  if (!res.ok) throw new Error(`RugCheck HTTP ${res.status}`);
  return res.json();
}

/**
 * @returns {{pass:boolean, reasons:string[], details:object}}
 *   `reasons` is non-empty exactly when `pass` is false.
 */
export function evaluate(report, token) {
  const reasons = [];
  const warnings = [];

  const topHolders = report.topHolders || [];
  const top10Pct = topHolders.slice(0, 10).reduce((a, h) => a + (h.pct || 0), 0);
  const lpLocked = (report.markets || []).reduce((m, mk) => Math.max(m, mk.lp?.lpLockedPct || 0), 0);
  const insiders = (report.insiderNetworks || []).length;

  if (report.rugged === true) reasons.push("flagged as already rugged");
  if (report.mintAuthority) reasons.push("mint authority still live — supply can be inflated");
  if (report.freezeAuthority) reasons.push("freeze authority still live — balances can be frozen");

  // Insider networks are a WARNING, not a rejection. Verified against positive
  // controls: BONK (2.0M holders, risk 7) and WIF (770k holders, risk 1) both
  // carry insider-network flags. Rejecting on this filtered out every token
  // that has ever actually worked — RugCheck's own risk score already prices it.
  if (insiders > 0 || report.graphInsidersDetected > 0) {
    warnings.push(`insider network detected (${insiders || report.graphInsidersDetected})`);
  }

  if (top10Pct > LIMITS.maxTop10Pct) reasons.push(`top-10 hold ${top10Pct.toFixed(0)}% (max ${LIMITS.maxTop10Pct}%)`);
  if (lpLocked < 50) warnings.push(`only ${lpLocked.toFixed(0)}% of LP locked`);
  if ((report.totalHolders ?? 0) < LIMITS.minHolders) reasons.push(`only ${report.totalHolders ?? 0} holders (min ${LIMITS.minHolders})`);
  if ((report.score_normalised ?? 100) > LIMITS.maxRugcheckScore) reasons.push(`RugCheck risk ${report.score_normalised} (max ${LIMITS.maxRugcheckScore})`);
  if ((token?.liquidityUsd ?? 0) < LIMITS.minLiquidityUsd) reasons.push(`liquidity $${Math.round(token?.liquidityUsd ?? 0).toLocaleString()} (min $${LIMITS.minLiquidityUsd.toLocaleString()})`);

  for (const r of report.risks || []) {
    if (r.level === "danger") reasons.push(`RugCheck: ${r.name}`);
    else if (r.level === "warn") warnings.push(`RugCheck: ${r.name}`);
  }

  return {
    pass: reasons.length === 0,
    reasons,
    warnings,
    details: {
      provider: "rugcheck",
      riskScore: report.score_normalised ?? null,
      top10Pct: Number(top10Pct.toFixed(1)),
      holders: report.totalHolders ?? null,
      lpLockedPct: Number(lpLocked.toFixed(1)),
      mintAuthority: Boolean(report.mintAuthority),
      freezeAuthority: Boolean(report.freezeAuthority),
      insiderNetworks: insiders,
      creator: report.creator || null,
      launchpad: report.launchpad || report.deployPlatform || null,
      risks: (report.risks || []).map((r) => `${r.name} (${r.level})`),
    },
  };
}

// ---------------------------------------------------------------------------
// EVM (GoPlus). Free, keyless. The failure modes differ from Solana's: instead
// of mint authority you get honeypots, confiscatory sell taxes and pausable
// transfers — all of which mean you can buy and then cannot sell.
// ---------------------------------------------------------------------------
export async function fetchGoPlus(chainId, address) {
  const res = await fetch(`${GOPLUS}/${chainId}?contract_addresses=${address}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GoPlus HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 1) throw new Error(`GoPlus: ${json.message || "error"}`);
  const key = Object.keys(json.result || {})[0];
  if (!key) throw new Error("not indexed by GoPlus");
  return json.result[key];
}

const on = (v) => v === 1 || v === "1";
const pctOf = (v) => (Number(v) || 0) * 100; // GoPlus taxes are fractions

export function evaluateEvm(r, token) {
  const reasons = [];
  const warnings = [];
  const buyTax = pctOf(r.buy_tax);
  const sellTax = pctOf(r.sell_tax);
  const ownerPct = Math.max(pctOf(r.owner_percent), pctOf(r.creator_percent));

  if (on(r.is_honeypot)) reasons.push("honeypot — cannot sell");
  if (on(r.cannot_sell_all)) reasons.push("cannot sell entire balance");
  if (on(r.transfer_pausable)) reasons.push("transfers can be paused");
  if (on(r.is_mintable)) reasons.push("mintable — supply can be inflated");
  if (on(r.can_take_back_ownership)) reasons.push("ownership can be reclaimed");
  if (on(r.hidden_owner)) reasons.push("hidden owner");
  if (on(r.selfdestruct)) reasons.push("contract can self-destruct");
  if (on(r.is_blacklisted)) reasons.push("addresses can be blacklisted");
  if (on(r.honeypot_with_same_creator)) reasons.push("creator has shipped a honeypot before");
  if (!on(r.is_open_source)) reasons.push("contract source not verified");
  if (buyTax > LIMITS.maxTaxPct) reasons.push(`buy tax ${buyTax.toFixed(1)}%`);
  if (sellTax > LIMITS.maxTaxPct) reasons.push(`sell tax ${sellTax.toFixed(1)}%`);
  if (ownerPct > LIMITS.maxTop10Pct) reasons.push(`owner holds ${ownerPct.toFixed(0)}%`);
  if (Number(r.holder_count || 0) < LIMITS.minHolders) reasons.push(`only ${r.holder_count || 0} holders (min ${LIMITS.minHolders})`);
  if ((token?.liquidityUsd ?? 0) < LIMITS.minLiquidityUsd) reasons.push(`liquidity $${Math.round(token?.liquidityUsd ?? 0).toLocaleString()} (min $${LIMITS.minLiquidityUsd.toLocaleString()})`);

  // Non-fatal, but you should see them before sizing a position.
  if (buyTax > 0 || sellTax > 0) warnings.push(`tax ${buyTax.toFixed(1)}% buy / ${sellTax.toFixed(1)}% sell`);
  if (on(r.is_proxy)) warnings.push("proxy contract — logic is upgradeable");
  if (on(r.slippage_modifiable)) warnings.push("slippage is modifiable by owner");
  if (on(r.anti_whale_modifiable)) warnings.push("max-tx limit is modifiable");
  if (Number(r.lp_holder_count || 0) < 3) warnings.push(`only ${r.lp_holder_count || 0} LP holders`);

  return {
    pass: reasons.length === 0,
    reasons,
    warnings,
    details: {
      provider: "goplus",
      holders: Number(r.holder_count || 0),
      top10Pct: Number(ownerPct.toFixed(1)),
      buyTaxPct: Number(buyTax.toFixed(1)),
      sellTaxPct: Number(sellTax.toFixed(1)),
      mintAuthority: on(r.is_mintable),
      freezeAuthority: on(r.transfer_pausable),
      openSource: on(r.is_open_source),
      lpHolders: Number(r.lp_holder_count || 0),
      creator: r.creator_address || null,
    },
  };
}

// Bidi overrides and zero-width characters in a token name are not decorative —
// they disguise the symbol so it renders as something else in a wallet. Caught
// live on a pool named "‮WW" during testing.
const DECEPTIVE_CHARS = /[‪-‮⁦-⁩​-‏﻿]/;

export function nameRisk(token) {
  const reasons = [];
  const blob = `${token.name || ""} ${token.symbol || ""}`;
  if (DECEPTIVE_CHARS.test(blob)) reasons.push("name uses bidi/zero-width characters to disguise the symbol");
  return reasons;
}

/** Fetch + evaluate, routed by chain. A failed lookup is a rejection, never a pass. */
export async function checkToken(token) {
  if (!canVerify(token.network)) {
    return { pass: false, reasons: [`safety unverifiable on ${token.network}`], warnings: [], details: {}, unverifiable: true };
  }
  try {
    const result = token.network === "solana"
      ? evaluate(await fetchReport(token.mint), token)
      : evaluateEvm(await fetchGoPlus(EVM_CHAIN_IDS[token.network], token.mint), token);

    const nameReasons = nameRisk(token);
    if (nameReasons.length) {
      return { ...result, pass: false, reasons: [...nameReasons, ...result.reasons] };
    }
    return result;
  } catch (err) {
    return { pass: false, reasons: [`safety check failed: ${err.message}`], warnings: [], details: {}, errored: true };
  }
}

/** Sequential with a gap — RugCheck is free and we are a guest on it. */
export async function checkAll(tokens, { gapMs = 350, max = 12 } = {}) {
  const out = [];
  for (const t of tokens.slice(0, max)) {
    out.push({ token: t, safety: await checkToken(t) });
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
  return out;
}
