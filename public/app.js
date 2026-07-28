/* PaperTrail — frontend controller. Vanilla JS, no build step. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const state = {
  data: null,
  moverTab: "gainers",
  intervalMs: 30000,
  timer: null,
  countdown: 30,
  countdownTimer: null,
  watchlist: JSON.parse(localStorage.getItem("mp_watchlist") || "[]"),
};

/* ---------- formatting ---------- */
const fmtNum = (n, d = 2) =>
  n == null || Number.isNaN(n) ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

function fmtPrice(n) {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return fmtNum(n, 2);
  if (abs >= 1) return fmtNum(n, 2);
  if (abs >= 0.01) return fmtNum(n, 4);
  return fmtNum(n, 6);
}
const fmtPct = (n) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
function fmtCompact(n) {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
const cls = (n) => (n == null ? "" : n >= 0 ? "up" : "down");
const ago = (ts) => {
  if (!ts) return "—";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

/* ---------- sparkline (inline SVG) ---------- */
function sparkline(values, w = 64, h = 22, color) {
  if (!values || values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = w / (values.length - 1);
  const pts = values.map((v, i) => `${(i * stepX).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`);
  const stroke = color || (values[values.length - 1] >= values[0] ? "var(--up)" : "var(--down)");
  return `<span class="spark"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(" ")}"/></svg></span>`;
}

/* ---------- conviction / entry helpers ---------- */
function starRow(n, cls2 = "") {
  let h = "";
  for (let i = 1; i <= 5; i++) h += `<span class="star ${i <= n ? "on" : ""}">★</span>`;
  return `<span class="stars ${cls2}">${h}</span>`;
}
const ENTRY_TONE = { BUY_NOW: "good", WAIT_PULLBACK: "warn", WAIT_BREAKOUT: "warn", WAIT_CONFIRM: "warn", AVOID: "bad", DCA: "warn" };
function entryTag(entry) {
  if (!entry) return "";
  return `<span class="entry-tag ${ENTRY_TONE[entry.verdict] || ""}">${entry.action}</span>`;
}
function levelChips(entry) {
  if (!entry || !entry.levels) return "";
  const L = entry.levels, chips = [];
  const p = (x) => "$" + fmtPrice(x);
  if (L.buyZone) chips.push(["Buy zone", `${p(L.buyZone[0])}–${p(L.buyZone[1])}`, "good"]);
  if (L.addZone) chips.push(["Add on dip", `${p(L.addZone[0])}–${p(L.addZone[1])}`, "warn"]);
  if (L.breakoutTrigger) chips.push(["Breakout trigger", `> ${p(L.breakoutTrigger)}`, "warn"]);
  if (L.confirmAbove) chips.push(["Confirm above", `> ${p(L.confirmAbove)}`, "warn"]);
  if (L.invalidation) chips.push(["Invalidation", `< ${p(L.invalidation)}`, "bad"]);
  else if (L.support) chips.push(["Support", p(L.support), ""]);
  return chips.map(([k, v, t]) => `<span class="lvl ${t}"><span class="lvl-k">${k}</span><span class="lvl-v">${v}</span></span>`).join("");
}
function earningsBadge(e) {
  if (!e || e.daysAway == null || e.daysAway < 0 || e.daysAway > 14) return "";
  const when = e.daysAway === 0 ? "today" : e.daysAway === 1 ? "1d" : `${e.daysAway}d`;
  return `<span class="earn-badge" title="Earnings ${e.date} — expect volatility">📅 Earnings ${when}</span>`;
}

function subBars(sub) {
  if (!sub) return "";
  const rows = [["Trend", sub.trend], ["Momentum", sub.momentum], ["Quality", sub.quality], ["Value", sub.value], ["Risk", sub.risk], ["Analysts", sub.analyst]];
  return rows.filter(([, v]) => v != null).map(([k, v]) =>
    `<div class="cv-bar ${k === "Analysts" ? "cv-bar-analyst" : ""}"><span class="cv-bar-k">${k}</span><span class="cv-bar-track"><span class="cv-bar-fill" style="width:${v}%"></span></span><span class="cv-bar-v">${v}</span></div>`
  ).join("");
}

/* ---------- signal alerts (browser notifications) ----------
   Watches your watchlist each refresh and notifies when a stock:
   hits its buy zone, pulls back into its dip zone, crosses its breakout
   trigger, or reports earnings tomorrow. Once per condition per day.
   Requires the dashboard tab to be open (no server push). */
const alerts = {
  enabled: localStorage.getItem("mp_alerts") === "1",
  log: JSON.parse(localStorage.getItem("mp_alert_log") || "{}"),
};

function alertBellUI() {
  const btn = $("#alerts-toggle");
  if (!btn) return;
  btn.classList.toggle("active", alerts.enabled);
}

async function toggleAlerts() {
  if (!("Notification" in window)) {
    alert("This browser doesn't support notifications. On iPhone, add the dashboard to your Home Screen first, then enable alerts from there.");
    return;
  }
  if (alerts.enabled) {
    alerts.enabled = false;
  } else {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      alert("Notifications are blocked for this site. Allow them in your browser settings, then try again.");
      return;
    }
    alerts.enabled = true;
    new Notification("PaperTrail — alerts on", {
      body: "You'll be notified when a watchlist stock hits its buy zone, breakout trigger, or reports earnings tomorrow. Keep this tab open.",
      icon: "/icon-192.png",
    });
  }
  localStorage.setItem("mp_alerts", alerts.enabled ? "1" : "0");
  alertBellUI();
}

function fireAlert(key, title, body, symbol) {
  const today = new Date().toISOString().slice(0, 10);
  const fullKey = `${key}|${today}`;
  if (alerts.log[fullKey]) return; // once per condition per day
  alerts.log[fullKey] = Date.now();
  // prune entries older than 3 days so localStorage stays tiny
  const cutoff = Date.now() - 3 * 864e5;
  for (const k of Object.keys(alerts.log)) if (alerts.log[k] < cutoff) delete alerts.log[k];
  localStorage.setItem("mp_alert_log", JSON.stringify(alerts.log));
  const n = new Notification(title, { body, icon: "/icon-192.png", tag: fullKey });
  n.onclick = () => { window.focus(); openDetail(symbol); };
}

function checkAlerts(quotes) {
  if (!alerts.enabled || !("Notification" in window) || Notification.permission !== "granted") return;
  for (const q of quotes) {
    const en = q?.entry;
    if (!en || q.price == null) continue;
    const L = en.levels || {};
    if (en.verdict === "BUY_NOW" && L.buyZone) {
      fireAlert(`${q.symbol}|BUY`, `${q.symbol} is in its buy zone`,
        `${q.name} at $${fmtPrice(q.price)} — zone $${fmtPrice(L.buyZone[0])}–$${fmtPrice(L.buyZone[1])}. ${en.reason || ""}`, q.symbol);
    } else if (en.verdict === "WAIT_PULLBACK" && L.addZone && q.price <= L.addZone[1]) {
      fireAlert(`${q.symbol}|DIP`, `${q.symbol} pulled back into its dip zone`,
        `${q.name} at $${fmtPrice(q.price)} — dip zone $${fmtPrice(L.addZone[0])}–$${fmtPrice(L.addZone[1])}.`, q.symbol);
    } else if (en.verdict === "WAIT_BREAKOUT" && L.breakoutTrigger && q.price >= L.breakoutTrigger) {
      fireAlert(`${q.symbol}|BREAKOUT`, `${q.symbol} crossed its breakout trigger`,
        `${q.name} at $${fmtPrice(q.price)} — above trigger $${fmtPrice(L.breakoutTrigger)}. Watch for a daily close above it on volume.`, q.symbol);
    }
    if (q.earnings && q.earnings.daysAway === 1) {
      fireAlert(`${q.symbol}|EARNINGS`, `${q.symbol} reports earnings tomorrow`,
        `${q.name} reports ${q.earnings.date}. Expect volatility — results can gap the price.`, q.symbol);
    }
  }
}

/* ---------- data fetch ---------- */
async function loadDashboard() {
  try {
    const res = await fetch("/api/dashboard");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    render();
    setConn("live");
  } catch (err) {
    setConn("error");
    $("#last-updated").textContent = "connection error — retrying";
  }
}

function setConn(mode) {
  const dot = $("#conn-dot");
  dot.className = "dot " + (mode === "live" ? "live" : mode === "stale" ? "stale" : "error");
}

/* ---------- render ---------- */
function render() {
  const d = state.data;
  if (!d) return;

  // status line
  const stUpdated = d.stocks?.updatedAt;
  $("#last-updated").textContent = stUpdated ? `updated ${ago(stUpdated)}` : "warming up…";
  const anyMarketOpen = (d.stocks?.indices || []).some((i) => i.marketState === "REGULAR");
  $("#market-state").textContent = anyMarketOpen ? "Market Open" : "Market Closed";

  renderTape(d.stocks?.indices || [], d.stocks?.gainers || []);
  renderPulse(d.stocks?.indices || []);
  renderBreadth(d.stocks?.breadth);
  renderIndices(d.stocks?.indices || []);
  renderOpportunities(d.stocks?.opportunities || []);
  renderMovers();
  renderCrypto(d.crypto);
  renderWatchlist();
  renderEcon(d.econ);
  renderMacro(d.macro);
  renderNews(d.news);
  renderPaper(d.paper);
  renderMomentum(d.momentum);
}

/* H1 momentum book — the forward test */
function renderMomentum(p) {
  const stats = $("#momentum-stats");
  if (!stats || !p) return;
  const m = p.metrics || {};
  const next = p.nextRebalanceAt;
  const nextEl = $("#momentum-next");
  if (nextEl) {
    nextEl.textContent = next
      ? `— ${p.rebalances} rebalance${p.rebalances === 1 ? "" : "s"} so far · next ${new Date(next).toISOString().slice(0, 10)}`
      : "— first ranking pending";
  }

  stats.innerHTML = `
    <div class="m-stat"><div class="k">Equity (sim)</div><div class="v">$${fmtNum(p.equity, 0)}</div></div>
    <div class="m-stat"><div class="k">Total return</div><div class="v ${cls(m.totalReturnPct)}">${fmtPct(m.totalReturnPct)}</div></div>
    <div class="m-stat"><div class="k">Cash</div><div class="v">$${fmtNum(p.cash, 0)}</div></div>
    <div class="m-stat"><div class="k">Holdings</div><div class="v">${p.positions.length}/${p.topN}</div></div>
    <div class="m-stat"><div class="k">Closed trades</div><div class="v">${m.trades ?? 0}</div></div>
    <div class="m-stat"><div class="k">Win rate</div><div class="v">${m.winRate != null ? (m.winRate * 100).toFixed(0) + "%" : "—"}</div></div>
    <div class="m-stat"><div class="k">Max drawdown</div><div class="v down">${m.maxDrawdown ? "-" + (m.maxDrawdown * 100).toFixed(1) + "%" : "—"}</div></div>
    <div class="m-stat"><div class="k">Running since</div><div class="v" style="font-size:11px">${new Date(p.createdAt).toISOString().slice(0, 10)}</div></div>`;

  const wrap = $("#momentum-chart-wrap");
  if ((p.equityHistory || []).length > 1) {
    wrap.style.display = "";
    $("#momentum-chart").innerHTML = paperEquityChart(p.equityHistory, p.startingCash);
  } else wrap.style.display = "none";

  const t = $("#momentum-positions");
  const pos = p.positions || [];
  $("#momentum-empty").style.display = pos.length ? "none" : "block";
  t.innerHTML = pos.length ? `
    <thead><tr><th class="left">Symbol</th><th>Entry</th><th>Now</th><th>P&L</th><th>12-1 mom.</th></tr></thead>
    <tbody>${pos.map((x) => {
      const pnlPct = x.lastPrice != null ? ((x.qty * x.lastPrice * (1 - 0.001)) - x.cost) / x.cost * 100 : null;
      return `<tr data-sym="${x.symbol}">
        <td class="left"><div class="sym-cell"><span class="sym">${x.symbol}</span><span class="nm">${x.name}</span></div></td>
        <td class="num">$${fmtPrice(x.entryPrice)}</td>
        <td class="num">$${fmtPrice(x.lastPrice)}</td>
        <td class="num ${cls(pnlPct)}"><span class="pill ${cls(pnlPct)}">${fmtPct(pnlPct)}</span></td>
        <td class="num ${cls(x.momentumAtEntry)}">${x.momentumAtEntry != null ? fmtPct(x.momentumAtEntry) : "—"}</td>
      </tr>`;
    }).join("")}</tbody>` : "";
  t.querySelectorAll("tr[data-sym]").forEach((tr) => (tr.onclick = () => openDetail(tr.dataset.sym)));
}

/* equity-curve chart: time-scaled line vs the starting-cash baseline */
function paperEquityChart(history, startingCash) {
  if (!history || history.length < 2) return "";
  const W = 800, H = 150, padY = 14;
  const t0 = history[0].t, t1 = history[history.length - 1].t || t0 + 1;
  const vals = history.map((p) => p.equity);
  const min = Math.min(...vals, startingCash), max = Math.max(...vals, startingCash);
  const range = max - min || 1;
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * W;
  const y = (v) => H - padY - ((v - min) / range) * (H - padY * 2);
  const line = history.map((p) => `${x(p.t).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" L");
  const up = vals[vals.length - 1] >= startingCash;
  const stroke = up ? "var(--up)" : "var(--down)";
  const baseY = y(startingCash).toFixed(1);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Simulated equity curve">
    <line x1="0" y1="${baseY}" x2="${W}" y2="${baseY}" stroke="var(--line)" stroke-width="1" stroke-dasharray="5 5" vector-effect="non-scaling-stroke"/>
    <path d="M${line} L${W},${H} L0,${H} Z" fill="${stroke}" opacity="0.07"/>
    <path d="M${line}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/* paper-trading autopilot (simulated) */
function renderPaper(p) {
  const stats = $("#paper-stats");
  if (!stats || !p) return;
  const m = p.metrics || {};
  const riskSel = $("#paper-risk");
  if (riskSel && document.activeElement !== riskSel) riskSel.value = p.risk;

  const dc = p.dayChange;
  stats.innerHTML = `
    <div class="m-stat"><div class="k">Equity (sim)</div><div class="v">$${fmtNum(p.equity, 0)}</div></div>
    <div class="m-stat"><div class="k">Today</div><div class="v ${cls(dc?.abs)}">${dc ? `${dc.abs >= 0 ? "+" : "−"}$${fmtNum(Math.abs(dc.abs), 0)} (${fmtPct(dc.pct)})` : "—"}</div></div>
    <div class="m-stat"><div class="k">Total return</div><div class="v ${cls(m.totalReturnPct)}">${fmtPct(m.totalReturnPct)}</div></div>
    <div class="m-stat"><div class="k">Cash</div><div class="v">$${fmtNum(p.cash, 0)}</div></div>
    <div class="m-stat"><div class="k">Win rate</div><div class="v">${m.winRate != null ? (m.winRate * 100).toFixed(0) + "%" : "—"}</div></div>
    <div class="m-stat"><div class="k">Trades</div><div class="v">${m.trades ?? 0}</div></div>
    <div class="m-stat"><div class="k">Avg win / loss</div><div class="v" style="font-size:12px"><span class="up">${m.avgWinPct != null ? "+" + m.avgWinPct.toFixed(1) + "%" : "—"}</span> / <span class="down">${m.avgLossPct != null ? m.avgLossPct.toFixed(1) + "%" : "—"}</span></div></div>
    <div class="m-stat"><div class="k">Profit factor</div><div class="v">${m.profitFactor != null ? m.profitFactor.toFixed(2) : "—"}</div></div>
    <div class="m-stat"><div class="k">Max drawdown</div><div class="v down">${m.maxDrawdown ? "-" + (m.maxDrawdown * 100).toFixed(1) + "%" : "—"}</div></div>`;

  // equity curve
  const chart = $("#paper-chart");
  const hint = $("#paper-curve-hint");
  const histLen = (p.equityHistory || []).length;
  if (chart) {
    if (histLen >= 2) {
      chart.innerHTML = paperEquityChart(p.equityHistory, p.startingCash);
      chart.style.display = "";
      if (hint) {
        const spanMs = p.equityHistory[histLen - 1].t - p.equityHistory[0].t;
        const days = spanMs / 864e5;
        hint.textContent = days >= 1 ? `— last ${days.toFixed(days < 3 ? 1 : 0)} days` : "— since launch today";
      }
    } else {
      chart.style.display = "none";
      if (hint) hint.textContent = "— appears as history accumulates";
    }
  }

  // open positions
  const posT = $("#paper-positions");
  const positions = p.positions || [];
  $("#paper-pos-empty").style.display = positions.length ? "none" : "block";
  posT.innerHTML = positions.length ? `
    <thead><tr><th class="left">Symbol</th><th>Entry</th><th>Now</th><th>P&L</th><th>Stop</th><th class="left">Why</th></tr></thead>
    <tbody>${positions.map((x) => {
      const pnlPct = x.lastPrice != null ? ((x.qty * x.lastPrice * (1 - 0.001)) - x.cost) / x.cost * 100 : null;
      return `<tr data-sym="${x.symbol}">
        <td class="left"><div class="sym-cell"><span class="sym">${x.symbol}</span><span class="nm">${x.name}</span></div></td>
        <td class="num">$${fmtPrice(x.entryPrice)}</td>
        <td class="num">$${fmtPrice(x.lastPrice)}</td>
        <td class="num ${cls(pnlPct)}"><span class="pill ${cls(pnlPct)}">${fmtPct(pnlPct)}</span></td>
        <td class="num">$${fmtPrice(x.stop)}</td>
        <td class="left paper-why">${x.reason || x.kind}</td>
      </tr>`;
    }).join("")}</tbody>` : "";
  posT.querySelectorAll("tr[data-sym]").forEach((tr) => (tr.onclick = () => openDetail(tr.dataset.sym)));

  // trade history
  const trT = $("#paper-trades");
  const closed = p.closed || [];
  $("#paper-trades-empty").style.display = closed.length ? "none" : "block";
  trT.innerHTML = closed.length ? `
    <thead><tr><th class="left">Symbol</th><th>In</th><th>Out</th><th>P&L</th><th class="left">Exit reason</th><th>Closed</th></tr></thead>
    <tbody>${closed.slice(0, 25).map((t) => `<tr data-sym="${t.symbol}">
      <td class="left"><span class="sym">${t.symbol}</span></td>
      <td class="num">$${fmtPrice(t.entryPrice)}</td>
      <td class="num">$${fmtPrice(t.exitPrice)}</td>
      <td class="num ${cls(t.pnl)}"><span class="pill ${cls(t.pnl)}">${fmtPct(t.pnlPct)}</span></td>
      <td class="left paper-why">${t.reason}</td>
      <td class="num">${ago(t.closedAt)}</td>
    </tr>`).join("")}</tbody>` : "";
  trT.querySelectorAll("tr[data-sym]").forEach((tr) => (tr.onclick = () => openDetail(tr.dataset.sym)));
}

/* FRED economic indicators (only present when a FRED key is configured) */
function renderEcon(econ) {
  const strip = $("#econ-strip");
  if (!strip) return;
  const items = econ?.indicators || [];
  if (!items.length) { strip.innerHTML = ""; strip.style.display = "none"; return; }
  strip.style.display = "";
  strip.innerHTML = items.map((i) => {
    const delta = i.change != null && Math.abs(i.change) >= 0.005
      ? `<span class="econ-delta">${i.change > 0 ? "▲" : "▼"} ${Math.abs(i.change).toFixed(2)}</span>`
      : "";
    return `<div class="econ-card" title="FRED · as of ${i.date}">
      <div class="econ-k">${i.label}</div>
      <div class="econ-v num">${i.value.toFixed(2)}${i.unit}${delta}</div>
    </div>`;
  }).join("");
}

function renderMacro(macro) {
  const ul = $("#macro-list");
  if (!ul || !macro) return;
  ul.innerHTML = "";
  for (const n of (macro.items || []).slice(0, 12)) {
    const li = el("li");
    const sTone = n.sentiment === "pos" ? "good" : n.sentiment === "neg" ? "bad" : "";
    li.innerHTML = `<a href="${n.link}" target="_blank" rel="noopener">${n.title}</a>
      <div class="news-meta"><span class="news-topic">${n.themeLabel || n.topic}</span>${n.sentiment && n.sentiment !== "neutral" ? `<span class="sent ${sTone}">${n.sentiment === "pos" ? "▲ bullish" : "▼ bearish"}</span>` : ""}<span>${n.source}</span><span>·</span><span>${ago(n.published)}</span></div>`;
    ul.appendChild(li);
  }
}

/* running ticker tape — built once, values updated in place to keep the marquee smooth */
let tapeBuilt = false;
function tapeItemHTML(it) {
  const label = it.symbol.replace(/^[.@^]/, "");
  const val = it.unit === "%" ? fmtNum(it.price, 2) + "%" : fmtPrice(it.price);
  return `<span class="tape-item" data-key="${it.symbol}"><span class="t-sym">${label}</span><span class="t-px ${cls(it.changePct)}">${val} ${fmtPct(it.changePct)}</span></span>`;
}
function renderTape(indices, gainers) {
  const track = $("#tape-track");
  if (!track) return;
  const items = [...indices, ...gainers.slice(0, 10)].filter((x) => x && x.price != null);
  if (!items.length) return;
  if (!tapeBuilt) {
    const html = items.map(tapeItemHTML).join("");
    track.innerHTML = html + html; // duplicate for a seamless loop
    tapeBuilt = true;
  } else {
    for (const it of items) {
      const val = it.unit === "%" ? fmtNum(it.price, 2) + "%" : fmtPrice(it.price);
      track.querySelectorAll(`[data-key="${CSS.escape(it.symbol)}"] .t-px`).forEach((e) => {
        e.textContent = `${val} ${fmtPct(it.changePct)}`;
        e.className = "t-px " + cls(it.changePct);
      });
    }
  }
}

/* oscilloscope pulse hero — the signature element */
let pulseDrawn = false;
function renderPulse(indices) {
  const box = $("#pulse");
  if (!box) return;
  const spx = indices.find((q) => q.symbol === ".SPX") || indices[0];
  if (!spx) return;
  // readout
  const nameEl = $("#hero-name"), priceEl = $("#hero-price"), chgEl = $("#hero-change");
  if (nameEl) nameEl.textContent = spx.name;
  if (priceEl) priceEl.textContent = spx.unit === "%" ? fmtNum(spx.price, 2) + "%" : fmtNum(spx.price, 2);
  if (chgEl) { chgEl.textContent = fmtPct(spx.changePct); chgEl.className = "hero-change num " + cls(spx.changePct); }

  const v = spx.spark && spx.spark.length > 1 ? spx.spark : null;
  if (!v) return;
  const W = 1000, H = 210, padY = 22;
  const min = Math.min(...v), max = Math.max(...v), range = max - min || 1;
  const x = (i) => (i / (v.length - 1)) * W;
  const y = (val) => H - padY - ((val - min) / range) * (H - padY * 2);
  const line = v.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(" L");
  const area = `M0,${H} L${line} L${W},${H} Z`;
  const trace = `M${line}`;
  const up = spx.changePct >= 0;
  const stroke = up ? "var(--amber)" : "var(--down)";
  const grid = [0.25, 0.5, 0.75].map((g) => `<line x1="0" y1="${(H * g).toFixed(0)}" x2="${W}" y2="${(H * g).toFixed(0)}" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke" opacity="0.5"/>`).join("");

  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="pulseFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${stroke}" stop-opacity="0.20"/>
          <stop offset="1" stop-color="${stroke}" stop-opacity="0"/>
        </linearGradient>
        <filter id="pulseGlow" x="-5%" y="-40%" width="110%" height="180%">
          <feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      ${grid}
      <path d="${area}" fill="url(#pulseFill)"/>
      <path id="pulseTrace" d="${trace}" fill="none" stroke="${stroke}" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"
        filter="url(#pulseGlow)" pathLength="100"
        style="stroke-dasharray:100;stroke-dashoffset:${pulseDrawn ? 0 : 100};transition:stroke-dashoffset 1.3s ease-out"/>
    </svg>`;
  if (!pulseDrawn) {
    const t = box.querySelector("#pulseTrace");
    requestAnimationFrame(() => requestAnimationFrame(() => { if (t) t.style.strokeDashoffset = "0"; }));
    pulseDrawn = true;
  }
}

function renderBreadth(b) {
  const box = $("#breadth");
  if (!box || !b || !b.total) return;
  const advPct = ((b.adv || 0) / ((b.adv || 0) + (b.dec || 0) || 1)) * 100;
  box.innerHTML = `
    <span>Breadth <b class="up">${b.adv}▲</b> <b class="down">${b.dec}▼</b></span>
    <span class="breadth-bar"><span class="adv" style="width:${advPct}%"></span></span>
    <span>Avg <b class="${cls(b.avg)}">${fmtPct(b.avg)}</b></span>`;
}

function renderIndices(indices) {
  const strip = $("#indices-strip");
  if (!indices.length) return;
  strip.innerHTML = "";
  for (const q of indices) {
    const card = el("div", "idx-card");
    const priceStr = q.unit === "%" ? fmtNum(q.price, 2) + "%" : fmtPrice(q.price);
    card.innerHTML = `
      <div class="idx-name">${q.name}</div>
      <div class="idx-price num">${priceStr}</div>
      <div class="idx-change num ${cls(q.changePct)}">${fmtPct(q.changePct)}</div>
      ${sparkline(q.spark)}`;
    card.onclick = () => openDetail(q.symbol);
    strip.appendChild(card);
  }
}

function renderOpportunities(list) {
  const grid = $("#opportunity-grid");
  const cnt = $("#opp-count");
  const n = state.data?.universeSize;
  if (cnt) cnt.textContent = list.length ? `top ${Math.min(list.length, 12)} of ${n || "—"} scanned` : "";
  grid.innerHTML = "";
  if (!list.length) { grid.innerHTML = `<div class="hint">Scanning the universe…</div>`; return; }
  list.slice(0, 12).forEach((q, i) => {
    const o = q.opportunity || {};
    const card = el("div", "opp-card");
    card.innerHTML = `
      <span class="opp-rank">${String(i + 1).padStart(2, "0")}</span>
      <div class="opp-top">
        <div>
          <div class="opp-sym">${q.symbol}</div>
          <div class="opp-name">${q.name}</div>
        </div>
        <div class="score-badge ${o.tone || "neutral"}">${o.score ?? "—"}</div>
      </div>
      <div class="opp-mid">
        <span class="opp-price num">$${fmtPrice(q.price)}</span>
        <span class="num ${cls(q.changePct)}">${fmtPct(q.changePct)}</span>
      </div>
      ${q.conviction ? `<div class="opp-rating">${starRow(q.conviction.rating)}<span class="rating-label">${q.conviction.rating}/5 ${q.conviction.label}</span>${entryTag(q.entry)}</div>` : ""}
      ${earningsBadge(q.earnings)}
      ${q.entry ? `<div class="opp-entry"><span class="entry-zone">${q.entry.zone || ""}</span></div>
      <div class="opp-reason">${q.entry.reason || ""}</div>` : `<div class="opp-signals">${(o.signals || []).map((s) => `<span class="sig ${s.tone}">${s.label}</span>`).join("")}</div>`}`;
    card.onclick = () => openDetail(q.symbol);
    grid.appendChild(card);
  });
}

/* movers table */
function renderMovers() {
  const d = state.data;
  const tab = state.moverTab;
  const rows = d.stocks?.[tab] || [];
  const table = $("#movers-table");
  const showVol = tab === "mostActive";
  table.innerHTML = `
    <thead><tr>
      <th class="left">#</th>
      <th class="left">Symbol</th>
      <th>Price</th>
      <th>Chg%</th>
      <th>${showVol ? "Volume" : "RSI"}</th>
      <th>Trend</th>
    </tr></thead><tbody></tbody>`;
  const tb = table.querySelector("tbody");
  rows.forEach((q, i) => {
    const tr = el("tr");
    tr.innerHTML = `
      <td class="left t-rank">${i + 1}</td>
      <td class="left"><div class="sym-cell"><span class="sym">${q.symbol}</span><span class="nm">${q.name}</span></div></td>
      <td class="num">$${fmtPrice(q.price)}</td>
      <td class="num ${cls(q.changePct)}"><span class="pill ${cls(q.changePct)}">${fmtPct(q.changePct)}</span></td>
      <td class="num">${showVol ? fmtCompact(q.volume) : (q.rsi != null ? q.rsi.toFixed(0) : "—")}</td>
      <td>${sparkline(q.spark)}</td>`;
    tr.onclick = () => openDetail(q.symbol);
    tb.appendChild(tr);
  });
}

/* crypto */
function renderCrypto(crypto) {
  if (!crypto) return;
  const g = crypto.global;
  if (g) {
    $("#crypto-global").innerHTML =
      `Cap ${g.marketCap ? "$" + fmtCompact(g.marketCap) : "—"} ` +
      `<span class="${cls(g.marketCapChange24h)}">${fmtPct(g.marketCapChange24h)}</span> · ` +
      `BTC ${g.btcDominance ? g.btcDominance.toFixed(1) + "%" : "—"}`;
  }
  const trend = $("#crypto-trending");
  trend.innerHTML = "";
  for (const c of (crypto.trending || []).slice(0, 7)) {
    const chip = el("span", "chip");
    chip.innerHTML = `${c.thumb ? `<img class="coin-thumb" src="${c.thumb}" alt="">` : "🔥"}<b>${c.symbol}</b>${c.change24h != null ? `<span class="${cls(c.change24h)}">${fmtPct(c.change24h)}</span>` : ""}`;
    trend.appendChild(chip);
  }

  const table = $("#crypto-table");
  table.innerHTML = `
    <thead><tr>
      <th class="left">Coin</th>
      <th>Price</th>
      <th>24h</th>
      <th>7d</th>
      <th>Mkt Cap</th>
      <th>7d Trend</th>
    </tr></thead><tbody></tbody>`;
  const tb = table.querySelector("tbody");
  for (const c of (crypto.top || []).slice(0, 20)) {
    const tr = el("tr");
    tr.innerHTML = `
      <td class="left"><div class="sym-cell"><img class="coin-img" src="${c.image}" alt=""><span class="sym">${c.symbol}</span><span class="nm">${c.name}</span></div></td>
      <td class="num">$${fmtPrice(c.price)}</td>
      <td class="num ${cls(c.change24h)}">${fmtPct(c.change24h)}</td>
      <td class="num ${cls(c.change7d)}">${fmtPct(c.change7d)}</td>
      <td class="num">$${fmtCompact(c.marketCap)}</td>
      <td>${sparkline(c.spark)}</td>`;
    tb.appendChild(tr);
  }
}

/* watchlist */
async function renderWatchlist() {
  const table = $("#watchlist-table");
  const empty = $("#watchlist-empty");
  if (!state.watchlist.length) {
    table.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  // Pull fresh quotes for the watchlist symbols on demand.
  const quotes = await Promise.all(
    state.watchlist.map((s) =>
      fetch(`/api/quote/${encodeURIComponent(s)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    )
  );
  checkAlerts(quotes.filter(Boolean));
  table.innerHTML = `
    <thead><tr>
      <th class="left">Symbol</th>
      <th>Price</th>
      <th>Chg%</th>
      <th>RSI</th>
      <th>Score</th>
      <th>Trend</th>
      <th></th>
    </tr></thead><tbody></tbody>`;
  const tb = table.querySelector("tbody");
  state.watchlist.forEach((sym, i) => {
    const q = quotes[i];
    const tr = el("tr");
    if (!q) {
      tr.innerHTML = `<td class="left"><span class="sym">${sym}</span></td><td colspan="5" class="hint">not found</td><td><button class="remove-btn" data-sym="${sym}">✕</button></td>`;
    } else {
      const o = q.opportunity || {};
      tr.innerHTML = `
        <td class="left"><div class="sym-cell"><span class="sym">${q.symbol}</span><span class="nm">${q.name}</span>${earningsBadge(q.earnings)}</div></td>
        <td class="num">$${fmtPrice(q.price)}</td>
        <td class="num ${cls(q.changePct)}"><span class="pill ${cls(q.changePct)}">${fmtPct(q.changePct)}</span></td>
        <td class="num">${q.rsi != null ? q.rsi.toFixed(0) : "—"}</td>
        <td class="num"><span class="score-badge ${o.tone || "neutral"}">${o.score ?? "—"}</span></td>
        <td>${sparkline(q.spark)}</td>
        <td><button class="remove-btn" data-sym="${q.symbol}">✕</button></td>`;
      tr.querySelectorAll("td:not(:last-child)").forEach((td) => (td.onclick = () => openDetail(q.symbol)));
    }
    tb.appendChild(tr);
  });
  tb.querySelectorAll(".remove-btn").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); removeSymbol(b.dataset.sym); }));
}

function addSymbol(sym) {
  sym = sym.trim().toUpperCase();
  if (!sym || state.watchlist.includes(sym)) return;
  state.watchlist.push(sym);
  localStorage.setItem("mp_watchlist", JSON.stringify(state.watchlist));
  renderWatchlist();
}
function removeSymbol(sym) {
  state.watchlist = state.watchlist.filter((s) => s !== sym);
  localStorage.setItem("mp_watchlist", JSON.stringify(state.watchlist));
  renderWatchlist();
}

/* news */
function renderNews(news) {
  if (!news) return;
  $("#news-updated").textContent = news.updatedAt ? `updated ${ago(news.updatedAt)}` : "";
  const ul = $("#news-list");
  ul.innerHTML = "";
  for (const n of (news.items || []).slice(0, 18)) {
    const li = el("li");
    li.innerHTML = `
      <a href="${n.link}" target="_blank" rel="noopener">${n.title}</a>
      <div class="news-meta"><span class="news-topic">${n.topic}</span><span>${n.source}</span><span>·</span><span>${ago(n.published)}</span></div>`;
    ul.appendChild(li);
  }
}

/* ---------- analysis modal ---------- */
const HORIZONS = ["1W", "1M", "1Y", "5Y", "10Y"];
const verdictClass = (tone) => (tone === "good" ? "up" : tone === "bad" ? "down" : "warn-txt");

function cagrStr(c) {
  if (!c || c.value == null) return "—";
  return `${c.value >= 0 ? "+" : ""}${c.value.toFixed(1)}%${c.sinceInception ? "*" : ""}`;
}

function outlookGauge(bias) {
  const pos = ((bias + 100) / 200) * 100; // 0..100
  return `<div class="gauge"><div class="gauge-track"></div><div class="gauge-mark" style="left:${pos}%"></div>
    <span class="gauge-lo">Bearish</span><span class="gauge-hi">Bullish</span></div>`;
}

function renderHorizonDetail(o) {
  return `
    <div class="hz-verdict ${verdictClass(o.tone)}">${o.verdict}
      <span class="hz-conf">${o.confidence} confidence</span></div>
    ${outlookGauge(o.bias)}
    <div class="opp-signals" style="margin:12px 0">${(o.signals || []).map((s) => `<span class="sig ${s.tone}">${s.label}</span>`).join("")}</div>
    <p class="hz-rationale">${o.rationale}</p>`;
}

let tvLoader = null;
function loadTradingView() {
  if (window.TradingView) return Promise.resolve(true);
  if (tvLoader) return tvLoader;
  tvLoader = new Promise((resolve) => {
    const sc = document.createElement("script");
    sc.src = "https://s3.tradingview.com/tv.js";
    sc.onload = () => resolve(true);
    sc.onerror = () => resolve(false);
    document.head.appendChild(sc);
    setTimeout(() => resolve(!!window.TradingView), 4000);
  });
  return tvLoader;
}

async function mountChart(tvSymbol, fallbackCloses) {
  const container = $("#an-chart");
  if (!container) return;
  if (tvSymbol && (await loadTradingView()) && window.TradingView) {
    container.innerHTML = `<div id="tv_widget" style="height:360px"></div>`;
    try {
      new window.TradingView.widget({
        autosize: true, symbol: tvSymbol, interval: "D", timezone: "Etc/UTC",
        theme: "dark", style: "1", locale: "en", hide_side_toolbar: true,
        allow_symbol_change: false, container_id: "tv_widget",
      });
      return;
    } catch { /* fall through to svg */ }
  }
  container.innerHTML = `<div class="fallback-chart">${sparkline(fallbackCloses, 820, 220)}<div class="hint" style="margin-top:6px">Static chart (live TradingView chart unavailable here).</div></div>`;
}

async function openDetail(symbol) {
  const modal = $("#modal");
  const body = $("#modal-body");
  body.innerHTML = `<div class="hint" style="padding:30px 0">Analyzing ${symbol}…</div>`;
  modal.hidden = false;
  modal.scrollTop = 0;
  try {
    const d = await fetch(`/api/analysis/${encodeURIComponent(symbol)}`).then((r) => r.json());
    if (d.error) throw new Error(d.error);
    const q = d.quote, o = q.opportunity || {}, f = d.fundamentals || {}, t = d.technicals || {};
    const cv = d.conviction, en = d.entry;

    body.innerHTML = `
      <div class="an-head">
        <div>
          <h3>${d.symbol} <span class="num ${cls(q.changePct)}" style="font-size:15px">${fmtPct(q.changePct)}</span></h3>
          <div class="m-sub">${d.name} · ${q.exchange || ""}</div>
        </div>
        <div class="an-price">
          <div class="p num">${q.unit === "%" ? fmtNum(q.price, 2) + "%" : "$" + fmtPrice(q.price)}</div>
          <div class="score-line">Opportunity <span class="score-badge ${o.tone || "neutral"}">${o.score ?? "—"}</span></div>
        </div>
      </div>

      ${cv ? `<div class="an-section-label">Conviction &amp; entry plan <span class="hint">— rules-based screen, not advice</span></div>
      <div class="conviction-block">
        <div class="cv-head">
          <div>
            ${starRow(cv.rating, "big")}
            <div class="cv-label">${cv.rating}/5 · ${cv.label}<span class="cv-conf">${cv.confidence} confidence · score ${cv.score}/100${cv.analystIncluded ? " · incl. Wall St consensus" : ""}</span></div>
          </div>
          ${entryTag(en)}
        </div>
        <div class="cv-bars">${subBars(cv.sub)}</div>
        <div class="entry-plan">
          <div class="entry-headline">${en.headline}</div>
          ${en.zone ? `<div class="entry-zone-big">🎯 ${en.zone}</div>` : ""}
          <p class="entry-detail">${en.detail}</p>
          <div class="entry-levels">${levelChips(en)}</div>
          ${en.event ? `<div class="event-risk">📅 ${en.event.warning}</div>` : ""}
          ${en.timing ? `<p class="entry-timing">⏱ ${en.timing}</p>` : ""}
        </div>
      </div>` : ""}

      ${d.analyst ? `<div class="an-section-label">Analyst consensus <span class="hint">— real Wall Street data (Finnhub)</span></div>
      <div class="analyst-block">
        ${d.analyst.consensus ? `<div class="analyst-consensus"><span class="ac-label ${d.analyst.consensus.includes("Buy") ? "good" : d.analyst.consensus === "Sell" ? "bad" : "warn"}">${d.analyst.consensus}</span> <span class="hint">${d.analyst.total} analysts</span></div>` : ""}
        ${d.analyst.reco ? `<div class="reco-bar">
          ${[["Strong Buy", d.analyst.reco.strongBuy, "good"], ["Buy", d.analyst.reco.buy, "good"], ["Hold", d.analyst.reco.hold, "warn"], ["Sell", d.analyst.reco.sell, "bad"], ["Strong Sell", d.analyst.reco.strongSell, "bad"]].filter(([, n]) => n > 0).map(([k, n, t]) => `<span class="reco-seg ${t}" style="flex:${n}" title="${k}: ${n}">${n}</span>`).join("")}
        </div><div class="reco-legend"><span class="good">▮ Buy</span> <span class="warn">▮ Hold</span> <span class="bad">▮ Sell</span></div>` : ""}
        ${d.analyst.target ? `<div class="m-stats" style="margin-top:12px">
          <div class="m-stat"><div class="k">Avg target</div><div class="v">$${fmtPrice(d.analyst.target.mean)}</div></div>
          <div class="m-stat"><div class="k">Implied upside</div><div class="v ${cls(d.analyst.upsidePct)}">${d.analyst.upsidePct != null ? fmtPct(d.analyst.upsidePct) : "—"}</div></div>
          <div class="m-stat"><div class="k">Target range</div><div class="v" style="font-size:12px">$${fmtPrice(d.analyst.target.low)}–$${fmtPrice(d.analyst.target.high)}</div></div>
        </div>` : ""}
      </div>` : ""}

      <div class="an-section-label">Directional outlook by horizon <span class="hint">— rules-based signal, not a prediction</span></div>
      <div class="horizon-strip" id="horizon-strip">
        ${HORIZONS.map((h, i) => {
          const ho = d.outlook[h];
          return `<button class="hz-pill ${i === 2 ? "active" : ""}" data-h="${h}">
            <span class="hz-k">${ho.label}</span>
            <span class="hz-v ${verdictClass(ho.tone)}">${ho.verdict}</span></button>`;
        }).join("")}
      </div>
      <div class="hz-detail" id="hz-detail">${renderHorizonDetail(d.outlook["1Y"])}</div>

      <div class="an-section-label">Live chart</div>
      <div class="an-chart" id="an-chart"><div class="hint">Loading chart…</div></div>

      ${d.profile ? `<div class="an-section-label">About</div>
        <p class="an-summary">${d.profile.extract} ${d.profile.url ? `<a href="${d.profile.url}" target="_blank" rel="noopener">Wikipedia →</a>` : ""}</p>` : ""}

      <div class="an-section-label">Key data</div>
      <div class="m-stats">
        <div class="m-stat"><div class="k">RSI (14)</div><div class="v">${t.rsi != null ? t.rsi.toFixed(0) : "—"}</div></div>
        <div class="m-stat"><div class="k">50 / 200 DMA</div><div class="v" style="font-size:12px">${fmtPrice(t.sma50)} / ${fmtPrice(t.sma200)}</div></div>
        <div class="m-stat"><div class="k">6-mo return</div><div class="v ${cls(t.ret6m)}">${t.ret6m != null ? fmtPct(t.ret6m) : "—"}</div></div>
        <div class="m-stat"><div class="k">52w range</div><div class="v" style="font-size:12px">$${fmtPrice(q.fiftyTwoWeekLow)} – $${fmtPrice(q.fiftyTwoWeekHigh)}</div></div>
        <div class="m-stat"><div class="k">Fwd P/E</div><div class="v">${f.fpe != null ? f.fpe.toFixed(1) : "—"}</div></div>
        <div class="m-stat"><div class="k">EPS growth (fwd)</div><div class="v ${cls(f.epsGrowth)}">${f.epsGrowth != null ? fmtPct(f.epsGrowth) : "—"}</div></div>
        <div class="m-stat"><div class="k">Revenue growth</div><div class="v ${cls(f.revGrowth)}">${f.revGrowth != null ? fmtPct(f.revGrowth) : "—"}</div></div>
        <div class="m-stat"><div class="k">ROE</div><div class="v">${f.roe != null ? f.roe.toFixed(0) + "%" : "—"}</div></div>
        <div class="m-stat"><div class="k">Price CAGR 1y</div><div class="v ${cls(d.cagr.y1?.value)}">${cagrStr(d.cagr.y1)}</div></div>
        <div class="m-stat"><div class="k">CAGR 5y</div><div class="v ${cls(d.cagr.y5?.value)}">${cagrStr(d.cagr.y5)}</div></div>
        <div class="m-stat"><div class="k">CAGR 10y</div><div class="v ${cls(d.cagr.y10?.value)}">${cagrStr(d.cagr.y10)}</div></div>
        <div class="m-stat"><div class="k">Market cap</div><div class="v">${q.marketCap || "—"}</div></div>
        ${d.earnings ? `<div class="m-stat"><div class="k">Next earnings</div><div class="v" style="font-size:12px">${d.earnings.date}${d.earnings.daysAway != null ? ` <span class="hint">(${d.earnings.daysAway}d)</span>` : ""}</div></div>` : ""}
      </div>

      ${d.catalysts ? `<div class="an-section-label">Catalysts &amp; macro exposure <span class="hint">— context, not a prediction</span></div>
        ${d.catalysts.eventRisk?.flag ? `<div class="event-risk ${d.catalysts.eventRisk.tone}">⚡ ${d.catalysts.eventRisk.label}</div>` : ""}
        <div class="cat-row">
          <div class="cat-block">
            <div class="cat-k">Recent news tone</div>
            <div class="cat-v"><span class="sent ${d.catalysts.sentiment.tone}">${d.catalysts.sentiment.label}</span> <span class="hint">${d.catalysts.sentiment.pos}▲ ${d.catalysts.sentiment.neg}▼ headlines</span></div>
          </div>
          ${d.catalysts.themes?.length ? `<div class="cat-block">
            <div class="cat-k">Sensitive to macro / policy</div>
            <div class="theme-chips">${d.catalysts.themes.map((th) => `<span class="theme-chip">${th.label}</span>`).join("")}</div>
          </div>` : ""}
        </div>
        <p class="cat-note">Policy &amp; macro headlines (tariffs, the Fed, chip curbs) drive short-term volatility in exposed names — this flags exposure and tone; it can't predict the reaction.</p>` : ""}

      ${d.news?.length ? `<div class="an-section-label">Recent news &amp; catalysts</div>
        <ul class="news-list an-news">${d.news.map((n) => `<li><a href="${n.link}" target="_blank" rel="noopener">${n.title}</a>
          <div class="news-meta">${n.type ? `<span class="news-type ${n.sentiment === "pos" ? "good" : n.sentiment === "neg" ? "bad" : ""}">${n.type}</span>` : ""}<span>${n.source}</span><span>·</span><span>${ago(n.published)}</span></div></li>`).join("")}</ul>` : ""}

      <p class="an-disclaimer">⚠️ The horizon outlook is an automated, rules-based reading of momentum, trend and (for 5–10y) fundamentals — <strong>not a forecast or investment advice</strong>. Long-horizon reads reflect business quality, not a price prediction. * = since listing (shorter history). Do your own research.</p>
    `;

    // horizon toggles
    $("#horizon-strip").addEventListener("click", (e) => {
      const btn = e.target.closest(".hz-pill");
      if (!btn) return;
      $("#horizon-strip").querySelectorAll(".hz-pill").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $("#hz-detail").innerHTML = renderHorizonDetail(d.outlook[btn.dataset.h]);
    });

    // chart (TradingView live, SVG fallback)
    const closes = (t && q.spark) || [];
    fetch(`/api/history/${encodeURIComponent(d.symbol)}?range=1M`)
      .then((r) => r.json())
      .then((h) => mountChart(d.tradingViewSymbol, (h.points || []).map((p) => p.c)))
      .catch(() => mountChart(d.tradingViewSymbol, q.spark || []));
  } catch (err) {
    body.innerHTML = `<div class="hint" style="padding:30px 0">Could not analyze ${symbol}. ${err.message || ""}</div>`;
  }
}

/* ---------- auto-refresh ---------- */
function startRefresh() {
  clearInterval(state.timer);
  clearInterval(state.countdownTimer);
  state.countdown = state.intervalMs / 1000;
  state.timer = setInterval(() => { loadDashboard(); state.countdown = state.intervalMs / 1000; }, state.intervalMs);
  state.countdownTimer = setInterval(() => {
    state.countdown = Math.max(0, state.countdown - 1);
    $("#countdown").textContent = Math.round(state.countdown);
  }, 1000);
}

/* ---------- wiring ---------- */
$("#mover-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  document.querySelectorAll("#mover-tabs .tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  state.moverTab = btn.dataset.tab;
  renderMovers();
});
$("#refresh-interval").addEventListener("change", (e) => {
  state.intervalMs = Number(e.target.value);
  startRefresh();
});
$("#refresh-now").addEventListener("click", () => { loadDashboard(); state.countdown = state.intervalMs / 1000; });
$("#add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#add-input");
  addSymbol(input.value);
  input.value = "";
});
$("#modal-close").addEventListener("click", () => ($("#modal").hidden = true));
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#modal").hidden = true; });

/* global ticker search */
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#search-input");
  const v = input.value.trim();
  if (v) openDetail(v);
  input.value = "";
  input.blur();
});
// "/" focuses search
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement.tagName !== "INPUT" && $("#modal").hidden) {
    e.preventDefault();
    $("#search-input").focus();
  }
});

/* sidebar nav: smooth-scroll + close mobile drawer */
const sidebar = $("#sidebar");
const scrim = $("#scrim");
function closeSidebar() { sidebar.classList.remove("open"); scrim.classList.remove("show"); }
$("#nav").addEventListener("click", (e) => {
  const link = e.target.closest(".nav-item");
  if (!link) return;
  closeSidebar();
});
$("#menu-toggle").addEventListener("click", () => {
  sidebar.classList.toggle("open");
  scrim.classList.toggle("show", sidebar.classList.contains("open"));
});
scrim.addEventListener("click", closeSidebar);

/* scroll-spy: highlight the nav item for the section in view */
const navItems = [...document.querySelectorAll(".nav-item")];
const spy = new IntersectionObserver(
  (entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      const id = en.target.id;
      navItems.forEach((n) => n.classList.toggle("active", n.dataset.section === id));
    });
  },
  { rootMargin: "-45% 0px -50% 0px" }
);
document.querySelectorAll(".view-block").forEach((s) => spy.observe(s));

$("#alerts-toggle").addEventListener("click", toggleAlerts);

/* paper autopilot controls — risk change or reset both start a fresh book,
   so the track record stays clean for one strategy at a time */
async function paperReset(risk) {
  const res = await fetch("/api/paper/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(risk ? { risk } : {}),
  }).catch(() => null);
  if (res?.ok) loadDashboard();
}
$("#paper-reset").addEventListener("click", () => {
  if (confirm("Reset the simulated book? All paper positions and history are wiped.")) {
    paperReset($("#paper-risk").value);
  }
});
/* historical backtest */
function renderBacktest(r) {
  const out = $("#backtest-out");
  if (r.error) { out.innerHTML = `<p class="bt-warn">${r.error}</p>`; return; }
  if (r.warning) { out.innerHTML = `<p class="bt-warn">${r.warning}</p>`; return; }
  const m = r.metrics;
  const beat = r.vsBenchmarkPct >= 0;
  const span = r.from && r.to ? `${new Date(r.from).toISOString().slice(0, 10)} → ${new Date(r.to).toISOString().slice(0, 10)}` : "";
  out.innerHTML = `
    <div class="bt-verdict ${beat ? "good" : "bad"}">
      ${beat ? "Beat" : "Lost to"} buy-and-hold by <strong>${Math.abs(r.vsBenchmarkPct).toFixed(1)}%</strong>
      <span class="hint">over ${r.days} trading days · ${r.universe} symbols · ${r.risk} risk${r.cached ? " · cached" : ""}</span>
    </div>
    <div class="m-stats" style="margin-top:12px">
      <div class="m-stat"><div class="k">Strategy return</div><div class="v ${cls(m.totalReturnPct)}">${fmtPct(m.totalReturnPct)}</div></div>
      <div class="m-stat"><div class="k">SPY buy &amp; hold</div><div class="v ${cls(r.benchmark.returnPct)}">${fmtPct(r.benchmark.returnPct)}</div></div>
      <div class="m-stat"><div class="k">Trades</div><div class="v">${m.trades}</div></div>
      <div class="m-stat"><div class="k">Win rate</div><div class="v">${m.winRate != null ? (m.winRate * 100).toFixed(0) + "%" : "—"}</div></div>
      <div class="m-stat"><div class="k">Avg win / loss</div><div class="v" style="font-size:12px"><span class="up">${m.avgWinPct != null ? "+" + m.avgWinPct.toFixed(1) + "%" : "—"}</span> / <span class="down">${m.avgLossPct != null ? m.avgLossPct.toFixed(1) + "%" : "—"}</span></div></div>
      <div class="m-stat"><div class="k">Profit factor</div><div class="v">${m.profitFactor != null ? m.profitFactor.toFixed(2) : "—"}</div></div>
      <div class="m-stat"><div class="k">Max drawdown</div><div class="v down">${m.maxDrawdown ? "-" + (m.maxDrawdown * 100).toFixed(1) + "%" : "—"}</div></div>
      <div class="m-stat"><div class="k">Period</div><div class="v" style="font-size:11px">${span}</div></div>
    </div>
    ${r.equityHistory?.length > 1 ? `<div class="paper-chart" style="margin-top:12px">${paperEquityChart(r.equityHistory, r.startingCash)}</div>` : ""}
    <p class="cat-note">Survivorship bias applies: the universe is today's index members, so companies that failed and were delisted aren't in this history. Real results skew worse than any backtest.</p>`;
}

async function runBacktest() {
  const btn = $("#backtest-run");
  const out = $("#backtest-out");
  btn.disabled = true;
  btn.textContent = "Running…";
  out.innerHTML = `<p class="hint">Fetching ~2 years of daily bars and replaying the rules. Takes a few seconds…</p>`;
  try {
    const r = await fetch("/api/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ risk: $("#paper-risk").value }),
    }).then((x) => x.json());
    renderBacktest(r);
  } catch (err) {
    out.innerHTML = `<p class="bt-warn">Backtest failed: ${err.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Run backtest";
  }
}
$("#backtest-run").addEventListener("click", runBacktest);

$("#momentum-reset").addEventListener("click", async () => {
  if (!confirm("Reset the momentum book? Its track record is wiped and the 28-day clock restarts.")) return;
  const res = await fetch("/api/momentum/reset", { method: "POST" }).catch(() => null);
  if (res?.ok) loadDashboard();
});

$("#paper-risk").addEventListener("change", (e) => {
  if (confirm(`Switch autopilot to ${e.target.value} risk? This resets the simulated book so the track record stays clean.`)) {
    paperReset(e.target.value);
  } else {
    loadDashboard(); // snap the selector back
  }
});

/* ---------- boot ---------- */
alertBellUI();
loadDashboard();
renderWatchlist();
startRefresh();
