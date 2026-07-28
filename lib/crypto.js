// Crypto provider backed by the free CoinGecko public API (no key required).

const BASE = "https://api.coingecko.com/api/v3";
const UA = "PaperTrailDashboard/1.0";

async function cg(path) {
  const res = await fetch(BASE + path, {
    headers: { Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  return res.json();
}

export async function fetchTopCrypto(perPage = 50) {
  const data = await cg(
    `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}` +
      `&page=1&price_change_percentage=1h,24h,7d&sparkline=true`
  );
  return data.map((c) => ({
    id: c.id,
    symbol: (c.symbol || "").toUpperCase(),
    name: c.name,
    image: c.image,
    rank: c.market_cap_rank,
    price: c.current_price,
    marketCap: c.market_cap,
    volume: c.total_volume,
    change1h: c.price_change_percentage_1h_in_currency,
    change24h: c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h,
    change7d: c.price_change_percentage_7d_in_currency,
    high24h: c.high_24h,
    low24h: c.low_24h,
    ath: c.ath,
    athChangePct: c.ath_change_percentage,
    spark: c.sparkline_in_7d?.price?.filter((_, i) => i % 4 === 0) || [],
  }));
}

export async function fetchTrendingCrypto() {
  const data = await cg(`/search/trending`);
  return (data.coins || []).map((w) => ({
    id: w.item.id,
    symbol: (w.item.symbol || "").toUpperCase(),
    name: w.item.name,
    rank: w.item.market_cap_rank,
    thumb: w.item.thumb,
    priceBtc: w.item.price_btc,
    score: w.item.score,
    priceUsd: w.item.data?.price,
    change24h: w.item.data?.price_change_percentage_24h?.usd,
    spark: w.item.data?.sparkline || null,
  }));
}

export async function fetchGlobalCrypto() {
  const data = await cg(`/global`);
  const d = data.data || {};
  return {
    marketCap: d.total_market_cap?.usd ?? null,
    volume: d.total_volume?.usd ?? null,
    marketCapChange24h: d.market_cap_change_percentage_24h_usd ?? null,
    btcDominance: d.market_cap_percentage?.btc ?? null,
    ethDominance: d.market_cap_percentage?.eth ?? null,
    activeCryptos: d.active_cryptocurrencies ?? null,
  };
}
