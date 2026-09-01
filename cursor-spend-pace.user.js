// ==UserScript==
// @name         Cursor Spend Pace
// @namespace    https://github.com/xjoker/CursorSpendPace
// @version      20260901.5
// @description  Linear-burn pace, high-precision usage, and inferred caps on the Cursor Spending dashboard
// @author       chou
// @license      MIT
// @match        https://cursor.com/*
// @match        https://www.cursor.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const C_RED = "#ff5a5a";
  const C_GREEN = "#16a34a";
  const C_YELLOW = "#ca8a04";
  const C_CYAN = "#0284c7";
  const C_MARK = "#0f172a";
  const DIM = "#64748b";
  const WRAP_CLASS = "cs-pace-wrap";
  const MARKER_CLASS = "cs-pace-marker";
  const LABEL_CLASS = "cs-pace-label";
  const META_CLASS = "cs-pace-meta";
  const STYLE_ID = "cs-pace-style";
  const JSON_HEADERS = { "content-type": "application/json" };
  const SNAP_KEY = "cs-pace-meter-snaps-v1";
  const SNAP_MAX = 120;
  const SNAP_MIN_GAP_MS = 5 * 60 * 1000;

  let cachedSummary = null;
  let cachedPeriod = null;
  let cachedAgg = null;
  let cachedGrokAgg = null;
  let cachedGrok = null;
  let cachedTeamId = -1;
  let fetchTimer = 0;
  let renderTimer = 0;
  let waitTimer = 0;
  let waitUntil = 0;
  let applying = false;
  let pendingRender = false;
  let refreshing = false;
  let refreshQueued = false;
  let expectOverlay = false;
  let observer = null;
  let lastHref = "";
  let pageActive = false;
  let observing = false;
  let hrefPollTimer = 0;
  let historyHookTimer = 0;
  let moDebounceTimer = 0;
  const OBSERVE_OPTS = { childList: true, subtree: true };
  const HREF_POLL_IDLE_MS = 2500;
  const HREF_POLL_ACTIVE_MS = 1500;
  const MO_DEBOUNCE_MS = 200;

  function dashboardPath() {
    return (location.pathname.replace(/\/+$/, "") || "/").replace(
      /^\/[a-z]{2}(?:-[A-Za-z]{2})?(?=\/|$)/,
      "",
    );
  }

  function isOverlayPath() {
    const path = dashboardPath();
    if (
      path === "/dashboard/spending" ||
      path === "/dashboard/usage" ||
      path.startsWith("/dashboard/spending/") ||
      path.startsWith("/dashboard/usage/")
    ) {
      return true;
    }
    const tab = new URLSearchParams(location.search).get("tab");
    return path === "/dashboard" && /^(spending|usage)$/i.test(tab || "");
  }

  // URL-first. Avoid scanning the whole document on every poll/mutation.
  function onOverlayPage() {
    if (isOverlayPath()) return true;
    const path = dashboardPath();
    if (!path.startsWith("/dashboard")) return false;
    return Boolean(
      document.getElementById("grok-bot") || document.querySelector("[id^='included-in-']"),
    );
  }

  function overlayHasTracks() {
    return poolTracks().length > 0 || sectionTracks("grok-bot").length > 0;
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function pickNumber(obj, keys, requirePositive = false) {
    if (!obj) return null;
    for (const key of keys) {
      const n = Number(obj[key]);
      if (!Number.isFinite(n)) continue;
      if (requirePositive && n <= 0) continue;
      return n;
    }
    return null;
  }

  function parseTime(value) {
    if (value == null || value === "") return NaN;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
    const asNum = Number(value);
    if (Number.isFinite(asNum) && /^\d+(\.\d+)?$/.test(String(value).trim())) {
      return asNum < 1e12 ? asNum * 1000 : asNum;
    }
    return Date.parse(value);
  }

  function pacePercent(startMs, endMs, nowMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return null;
    }
    const windowMs = endMs - startMs;
    const remainingMs = Math.max(endMs - nowMs, 0);
    const elapsedMs = clamp(windowMs - remainingMs, 0, windowMs);
    return clamp((elapsedMs / windowMs) * 100, 0, 100);
  }

  function quotaGone(used) {
    return Math.round(Math.max(100 - used, 0)) <= 0;
  }

  function isOver(used, pace) {
    return used >= 10 && pace != null && used > pace;
  }

  function usedColor(used, over) {
    if (used >= 90) return C_RED;
    if (over || used >= 70) return C_YELLOW;
    return C_GREEN;
  }

  function formatRest(ms) {
    const secs = Math.max(0, Math.round(ms / 1000));
    if (secs === 0) return "~0m";
    if (secs < 3600) return `~${Math.ceil(secs / 60)}m`;
    if (secs < 86400) {
      const h = Math.floor(secs / 3600);
      const m = Math.round((secs % 3600) / 60);
      return m > 0 ? `~${h}h${m}m` : `~${h}h`;
    }
    const d = Math.floor(secs / 86400);
    const h = Math.round((secs % 86400) / 3600);
    return h > 0 ? `~${d}d${h}h` : `~${d}d`;
  }

  function restMs(used, pace, windowMs) {
    if (pace == null || used <= pace || windowMs <= 0) return 0;
    return (windowMs * (used - pace)) / 100;
  }

  function formatPct(n, digits = 6) {
    if (!Number.isFinite(n)) return "n/a";
    return `${n.toFixed(digits).replace(/\.?0+$/, "")}%`;
  }

  function formatUsdFromCents(cents) {
    if (!Number.isFinite(cents)) return "n/a";
    return `$${(cents / 100).toFixed(2)}`;
  }

  function ensureStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = `
      .${WRAP_CLASS} { position: relative; overflow: visible; }
      .${WRAP_CLASS} .${MARKER_CLASS} {
        position: absolute;
        top: -4px;
        height: calc(100% + 4px);
        width: 2px;
        margin-left: -1px;
        background: ${C_MARK};
        box-shadow: 0 0 0 1px #fff, 0 0 0 2px ${C_CYAN};
        border-radius: 1px;
        z-index: 3;
        pointer-events: none;
      }
      .${WRAP_CLASS} .${LABEL_CLASS} {
        position: absolute;
        top: calc(100% + 8px);
        z-index: 3;
        pointer-events: none;
        font: 11px/1.2 ui-sans-serif, system-ui, sans-serif;
        font-weight: 650;
        color: ${C_CYAN};
        white-space: nowrap;
        letter-spacing: .01em;
      }
      .${WRAP_CLASS} .${LABEL_CLASS} .cs-pace-arrow {
        position: absolute;
        left: 0;
        top: 0;
        width: 12px;
        margin-left: -6px;
        text-align: center;
        line-height: 1;
      }
      .${WRAP_CLASS} .${LABEL_CLASS} .cs-pace-copy { display: inline-block; }
      .${WRAP_CLASS} .${LABEL_CLASS}[data-side="right"] .cs-pace-copy { margin-left: 10px; }
      .${WRAP_CLASS} .${LABEL_CLASS}[data-side="left"] .cs-pace-copy {
        transform: translateX(calc(-100% - 10px));
      }
      .${META_CLASS} {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 26px;
        font: 11px/1.35 ui-sans-serif, system-ui, sans-serif;
        color: ${DIM};
      }
      .${META_CLASS} .cs-pace-meta-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
      }
      .${META_CLASS} .cs-pace-meta-row > span:first-child { min-width: 0; }
      .${META_CLASS} .cs-pace-note {
        font-size: 10px;
        line-height: 1.35;
        color: #94a3b8;
      }
      .${META_CLASS} .cs-pace-tops {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .${META_CLASS} .cs-pace-top {
        display: inline-flex;
        align-items: baseline;
        gap: 5px;
        max-width: 100%;
        padding: 2px 8px;
        border-radius: 999px;
        background: #f1f5f9;
        color: #334155;
        font-variant-numeric: tabular-nums;
      }
      .${META_CLASS} .cs-pace-top b {
        font-weight: 700;
        color: #64748b;
        font-size: 10px;
      }
      .${META_CLASS} .cs-pace-top i {
        font-style: normal;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cs-pace-rest { font-weight: 700; }
    `;
  }

  async function loadJson(url, init) {
    const res = await fetch(url, { credentials: "include", ...init });
    if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
    return res.json();
  }

  function postJson(url, body) {
    return loadJson(url, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body ?? {}),
    });
  }

  async function loadSummary() {
    return loadJson("/api/usage-summary");
  }

  async function loadGrok() {
    return postJson("/api/dashboard/get-sand-usage-status", {});
  }

  async function loadPeriod() {
    return postJson("/api/dashboard/get-current-period-usage", {});
  }

  function walkTeamId(value, depth = 0) {
    if (value == null || depth > 4) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") {
          const direct = item.teamId ?? item.team_id ?? item.id;
          if (direct != null && direct !== "") return direct;
        }
        const found = walkTeamId(item, depth + 1);
        if (found != null) return found;
      }
      return null;
    }
    if (typeof value !== "object") return null;
    for (const key of ["teamId", "team_id"]) {
      if (value[key] != null && value[key] !== "") return value[key];
    }
    for (const key of ["teams", "organizations", "items", "data"]) {
      if (value[key] != null) {
        const found = walkTeamId(value[key], depth + 1);
        if (found != null) return found;
      }
    }
    return null;
  }

  async function resolveTeamId() {
    for (const url of ["/api/dashboard/get-user-organizations", "/api/dashboard/teams"]) {
      try {
        const data = await postJson(url, {});
        const id = walkTeamId(data);
        if (id != null) return id;
      } catch {
        // Individual accounts use teamId -1, matching the dashboard client.
      }
    }
    return -1;
  }

  async function loadAgg(startMs, endMs) {
    const bodies = [
      { teamId: cachedTeamId, startDate: startMs, endDate: endMs },
      { startDate: startMs, endDate: endMs },
      { startMs, endMs },
    ];
    let lastErr = null;
    for (const body of bodies) {
      try {
        return await postJson("/api/dashboard/get-aggregated-usage-events", body);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("aggregated usage unavailable");
  }

  function sectionRoot(el) {
    if (!el) return null;
    return el.closest(".dashboard-section") || el.closest("section") || el.parentElement;
  }

  function tracksIn(section) {
    if (!section) return [];
    const primary = [...section.querySelectorAll(".relative.w-full.overflow-hidden.rounded-full")];
    if (primary.length) return primary;
    return [...section.querySelectorAll('[class*="rounded-full"]')].filter((el) => findFill(el));
  }

  function sectionTracks(sectionId) {
    return tracksIn(sectionRoot(document.getElementById(sectionId)));
  }

  function uniqueNodes(nodes) {
    const seen = new Set();
    return nodes.filter((el) => {
      if (!el || seen.has(el)) return false;
      seen.add(el);
      return true;
    });
  }

  function includedSectionRoots() {
    const roots = [];
    const seen = new Set();
    const add = (el) => {
      const root = sectionRoot(el);
      if (!root || seen.has(root)) return;
      seen.add(root);
      roots.push(root);
    };
    document.querySelectorAll("[id]").forEach((el) => {
      if (/^included-in-/i.test(el.id)) add(el);
    });
    document.querySelectorAll("h1,h2,h3,h4,button").forEach((el) => {
      const text = (el.textContent || "").trim();
      if (/^included in /i.test(text) || /^included usage\b/i.test(text)) add(el);
    });
    return roots;
  }

  function poolTracks() {
    const fromRoots = uniqueNodes(includedSectionRoots().flatMap(tracksIn));
    if (fromRoots.length) return fromRoots;
    return uniqueNodes([
      ...document.querySelectorAll(".relative.w-full.overflow-hidden.rounded-full"),
    ]).filter((track) => {
      const kind = trackKind(track);
      return kind === "cursor" || kind === "other";
    });
  }

  function findFill(track) {
    return (
      track.querySelector(".absolute.inset-y-0.left-0") ||
      track.querySelector('[style*="width"]')
    );
  }

  function cardText(track) {
    let el = track;
    for (let i = 0; i < 8 && el; i++) {
      const text = el.textContent || "";
      if (/Cursor Models|Other Models|Grok Bot|Weekly usage/i.test(text)) return text;
      el = el.parentElement;
    }
    const card = track.closest(".px-4.py-3") || track.parentElement;
    return card?.textContent || "";
  }

  function trackKind(track, fallbackIndex) {
    const text = cardText(track);
    if (/Cursor Models/i.test(text)) return "cursor";
    if (/Other Models/i.test(text)) return "other";
    if (/Weekly usage/i.test(text) || /Grok Bot/i.test(text)) return "grok";
    if (fallbackIndex === 0) return "cursor";
    if (fallbackIndex === 1) return "other";
    return null;
  }

  function rowName(row) {
    return row?.modelIntent || row?.model_intent || "";
  }

  function rowCents(row) {
    return Number(row?.totalCents ?? row?.total_cents ?? 0);
  }

  function isGrokBotModel(name) {
    const n = name || "";
    return /^sand(?:[-_]|$)/i.test(n) || /^grok-bot(?:[-_]|$)/i.test(n);
  }

  function modelStem(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/-fast/g, "")
      .replace(/-(low|medium|high|xhigh)/g, "")
      .replace(/\d+(?:\.\d+)*/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function sameModelFamily(name, bucketName) {
    if (!name || !bucketName) return false;
    if (name === bucketName) return true;
    const a = modelStem(name);
    const b = modelStem(bucketName);
    return Boolean(a) && a === b;
  }

  function isCursorPoolModel(name, autoSet) {
    if (!name || isGrokBotModel(name)) return false;
    if (autoSet.has(name)) return true;
    for (const bucket of autoSet) {
      if (sameModelFamily(name, bucket)) return true;
    }
    return false;
  }

  function isOtherPoolModel(name, autoSet) {
    if (!name || isGrokBotModel(name)) return false;
    return !isCursorPoolModel(name, autoSet);
  }

  function autoModelSet(period) {
    const list = period?.autoBucketModels || period?.auto_bucket_models || [];
    return new Set(list);
  }

  function shortModelName(name) {
    return String(name || "").replace(/^cursor-/, "");
  }

  function topSpenders(agg, predicate, limit = 3) {
    const byName = new Map();
    for (const row of agg?.aggregations || []) {
      const name = rowName(row);
      if (!predicate(name)) continue;
      const cents = rowCents(row);
      if (!(cents > 0)) continue;
      byName.set(name, (byName.get(name) || 0) + cents);
    }
    return [...byName.entries()]
      .map(([name, cents]) => ({ name, cents }))
      .sort((a, b) => b.cents - a.cents)
      .slice(0, limit);
  }

  function escapeText(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function topsMarkup(tops) {
    if (!tops?.length) return "";
    const chips = tops
      .map(
        (top, i) =>
          `<span class="cs-pace-top"><b>#${i + 1}</b><i>${escapeText(shortModelName(top.name))}</i>${formatUsdFromCents(top.cents)}</span>`,
      )
      .join("");
    return `<div class="cs-pace-tops">${chips}</div>`;
  }

  function quotaInfo(line, tops, note) {
    return { line, tops: tops || [], note: note || "" };
  }

  function sumMatchingCents(agg, predicate) {
    let cents = 0;
    for (const row of agg?.aggregations || []) {
      if (predicate(rowName(row))) cents += rowCents(row);
    }
    return cents;
  }

  function inferRoundCapCents(rawCents) {
    if (!Number.isFinite(rawCents) || rawCents <= 0) return null;
    const usd = rawCents / 100;
    for (const step of [1, 10, 50, 100, 500, 1000]) {
      const rounded = Math.round(usd / step) * step;
      if (rounded > 0 && Math.abs(usd - rounded) / usd < 0.015) return rounded * 100;
    }
    return Math.round(rawCents);
  }

  function readMeterSnaps() {
    try {
      const raw = localStorage.getItem(SNAP_KEY);
      if (!raw) return [];
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function writeMeterSnaps(list) {
    try {
      const pruned = list
        .filter((s) => s && Number.isFinite(s.t) && s.pool && s.w)
        .sort((a, b) => a.t - b.t);
      while (pruned.length > SNAP_MAX) pruned.shift();
      localStorage.setItem(SNAP_KEY, JSON.stringify(pruned));
    } catch {
      // QuotaExceeded or private mode — inference still works without history.
    }
  }

  function pushMeterSnap(pool, windowKey, spendCents, pct) {
    if (!pool || !windowKey) return;
    if (!(Number.isFinite(spendCents) && spendCents > 0 && Number.isFinite(pct) && pct > 0)) return;
    const now = Date.now();
    const list = readMeterSnaps();
    const last = [...list].reverse().find((s) => s.pool === pool && s.w === windowKey);
    if (
      last &&
      now - last.t < SNAP_MIN_GAP_MS &&
      Math.abs(last.c - spendCents) < 1 &&
      Math.abs(last.p - pct) < 0.01
    ) {
      return;
    }
    list.push({
      t: now,
      pool,
      w: windowKey,
      c: Math.round(spendCents * 1000) / 1000,
      p: Math.round(pct * 1e6) / 1e6,
    });
    writeMeterSnaps(list);
  }

  function formatSnapTime(ms) {
    if (!Number.isFinite(ms)) return "n/a";
    try {
      return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
    } catch {
      return "n/a";
    }
  }

  function inferCapFromHistory(pool, windowKey, usedCents, label) {
    if (!pool || !windowKey || !(usedCents > 0)) return null;
    const snaps = readMeterSnaps()
      .filter(
        (s) =>
          s.pool === pool &&
          s.w === windowKey &&
          Number.isFinite(s.c) &&
          s.c > 0 &&
          Number.isFinite(s.p) &&
          s.p > 0 &&
          s.p < 99.5,
      )
      .sort((a, b) => b.t - a.t);
    if (!snaps.length) return null;
    // Prefer the freshest usable bar reading in this billing/week window.
    const hit = snaps[0];
    const raw = hit.c / (hit.p / 100);
    const cap = inferRoundCapCents(raw);
    if (cap == null) return null;
    return {
      line: `${formatUsdFromCents(usedCents)} / ${formatUsdFromCents(cap)} from history ${label}`,
      note: `history ${formatSnapTime(hit.t)} list ${formatUsdFromCents(hit.c)} ÷ ${formatPct(hit.p, 3)} = ${formatUsdFromCents(raw)}; bar now ~100%`,
    };
  }

  function inferCap(usedCents, pct, label, opts = {}) {
    if (!(Number.isFinite(pct) && pct > 0 && usedCents > 0)) return null;
    const pool = opts.pool || "";
    const windowKey = opts.windowKey || "";
    // At ~100% the quotient collapses to spend; use an earlier same-window snapshot.
    if (pct >= 99.5) {
      return (
        inferCapFromHistory(pool, windowKey, usedCents, label) || {
          line: `${formatUsdFromCents(usedCents)} used · bar ${formatPct(pct, 2)} (${label} ≥ this)`,
          note: `bar is ~100%, no earlier snapshot in localStorage for this window yet`,
        }
      );
    }
    const raw = usedCents / (pct / 100);
    const cap = inferRoundCapCents(raw);
    if (cap == null) return null;
    return {
      line: `${formatUsdFromCents(usedCents)} / ${formatUsdFromCents(cap)} inferred ${label}`,
      note: `list ${formatUsdFromCents(usedCents)} ÷ ${formatPct(pct, 3)} = ${formatUsdFromCents(raw)} this snapshot`,
    };
  }

  function captureMeterSnaps(summary, period, agg, grok, grokAgg) {
    const monthKey = monthWindowKey(summary, period);
    if (monthKey && (summary || period) && agg) {
      const autoSet = autoModelSet(period);
      const usage = period?.planUsage || {};
      const autoPct = pickNumber(usage, ["autoPercentUsed", "auto_percent_used"]);
      const apiPct =
        pickNumber(usage, ["apiPercentUsed", "api_percent_used"]) ??
        pickNumber(summary?.individualUsage?.plan, ["apiPercentUsed", "api_percent_used"]);
      const cursorCents = sumMatchingCents(agg, (name) => isCursorPoolModel(name, autoSet));
      const otherCents = sumMatchingCents(agg, (name) => isOtherPoolModel(name, autoSet));
      if (autoPct != null) pushMeterSnap("cursor", monthKey, cursorCents, autoPct);
      if (apiPct != null) pushMeterSnap("other", monthKey, otherCents, apiPct);
    }
    if (grok && grokAgg) {
      const gKey = grokWindowKey(grok);
      const gPct = pickNumber(grok, ["usagePercent", "usage_percent"]);
      const gCents = sumMatchingCents(grokAgg, isGrokBotModel);
      if (gKey && gPct != null) pushMeterSnap("grok", gKey, gCents, gPct);
    }
  }

  function monthWindowKey(summary, period) {
    const start =
      parseTime(summary?.billingCycleStart) || parseTime(period?.billingCycleStart);
    return Number.isFinite(start) ? `m:${start}` : "";
  }

  function grokWindowKey(grok) {
    const start = parseTime(grok?.currentPeriodStart || grok?.current_period_start);
    return Number.isFinite(start) ? `g:${start}` : "";
  }

  function cursorModelsQuotaLine(period, agg, summary) {
    const autoSet = autoModelSet(period);
    const tops = topSpenders(agg, (name) => isCursorPoolModel(name, autoSet));
    const usage = period?.planUsage || {};
    const pct = pickNumber(usage, ["autoPercentUsed", "auto_percent_used"]);
    const protoLimit = pickNumber(usage, ["autoLimit", "auto_limit"], true);
    const protoSpend = pickNumber(usage, ["autoSpend", "auto_spend"]);
    const windowKey = monthWindowKey(summary, period);
    let line = "Cursor Models cap omitted by API";
    let note = "";
    if (protoLimit != null) {
      const used = pct != null ? (protoLimit * pct) / 100 : protoSpend;
      line = `${formatUsdFromCents(used)} / ${formatUsdFromCents(protoLimit)} Cursor Models`;
    } else {
      const usedCents = sumMatchingCents(agg, (name) => isCursorPoolModel(name, autoSet));
      const inferred = inferCap(usedCents, pct, "Cursor Models cap", {
        pool: "cursor",
        windowKey,
      });
      if (inferred) {
        line = inferred.line;
        note = inferred.note;
      }
    }
    return quotaInfo(line, tops, note);
  }

  function otherModelsQuotaLine(period, summary, agg) {
    const autoSet = autoModelSet(period);
    const tops = topSpenders(agg, (name) => isOtherPoolModel(name, autoSet));
    const usage = period?.planUsage || {};
    const pct =
      pickNumber(usage, ["apiPercentUsed", "api_percent_used"]) ??
      pickNumber(summary?.individualUsage?.plan, ["apiPercentUsed", "api_percent_used"]);
    const protoLimit = pickNumber(usage, ["apiLimit", "api_limit"], true);
    const protoSpend = pickNumber(usage, ["apiSpend", "api_spend"]);
    const windowKey = monthWindowKey(summary, period);
    let line = "Other Models cap omitted by API";
    let note = "";
    if (protoLimit != null) {
      const used = pct != null ? (protoLimit * pct) / 100 : protoSpend;
      line = `${formatUsdFromCents(used)} / ${formatUsdFromCents(protoLimit)} Other Models`;
    } else {
      const usedCents = sumMatchingCents(agg, (name) => isOtherPoolModel(name, autoSet));
      const inferred = inferCap(usedCents, pct, "Other Models cap", {
        pool: "other",
        windowKey,
      });
      if (inferred) {
        line = inferred.line;
        note = inferred.note;
      }
    }
    return quotaInfo(line, tops, note);
  }

  function grokQuotaLine(grok, grokAgg) {
    const tops = topSpenders(grokAgg, isGrokBotModel);
    const pct = pickNumber(grok, ["usagePercent", "usage_percent"]);
    const usedCents = sumMatchingCents(grokAgg, isGrokBotModel);
    let line =
      grok?.hasNonZeroIncludedLimit || grok?.has_non_zero_included_limit
        ? "Grok included limit exists, cap omitted by API"
        : "Grok weekly cap omitted by API";
    let note = "";
    const inferred = inferCap(usedCents, pct, "Grok weekly cap", {
      pool: "grok",
      windowKey: grokWindowKey(grok),
    });
    if (inferred) {
      line = inferred.line;
      note = inferred.note;
    }
    return quotaInfo(line, tops, note);
  }

  function parseUsedFromFill(fill) {
    const style = fill?.getAttribute?.("style") || "";
    const m = style.match(/width:\s*([\d.]+)%/);
    if (m) return Number(m[1]);
    return null;
  }

  function poolUsed(kind, summary, period, fill) {
    const usage = period?.planUsage;
    const plan = summary?.individualUsage?.plan;
    if (kind === "cursor") {
      return (
        pickNumber(plan, ["autoPercentUsed", "auto_percent_used"]) ??
        pickNumber(usage, ["autoPercentUsed", "auto_percent_used"]) ??
        parseUsedFromFill(fill) ??
        0
      );
    }
    if (kind === "other") {
      return (
        pickNumber(plan, ["apiPercentUsed", "api_percent_used"]) ??
        pickNumber(usage, ["apiPercentUsed", "api_percent_used"]) ??
        parseUsedFromFill(fill) ??
        0
      );
    }
    if (kind === "grok") {
      return pickNumber(cachedGrok, ["usagePercent", "usage_percent"]) ?? parseUsedFromFill(fill) ?? 0;
    }
    return parseUsedFromFill(fill) ?? 0;
  }

  function wrapTrack(track) {
    const parent = track.parentElement;
    if (parent?.classList.contains(WRAP_CLASS)) return parent;
    const wrap = document.createElement("div");
    wrap.className = WRAP_CLASS;
    track.before(wrap);
    wrap.appendChild(track);
    parent?.querySelectorAll(`:scope > .cs-pace-hint`).forEach((el) => el.remove());
    return wrap;
  }

  function placeMarker(marker, percent) {
    marker.style.left = `${percent}%`;
    marker.style.transform = "none";
    marker.style.marginLeft = "-1px";
  }

  function layoutPaceLabel(label, percent) {
    let arrow = label.querySelector(".cs-pace-arrow");
    let copy = label.querySelector(".cs-pace-copy");
    if (!arrow || !copy) {
      label.textContent = "";
      arrow = document.createElement("span");
      arrow.className = "cs-pace-arrow";
      arrow.textContent = "↑";
      copy = document.createElement("span");
      copy.className = "cs-pace-copy";
      label.append(arrow, copy);
    }
    copy.textContent = `pace ${formatPct(percent, 2)}`;
    label.style.left = `${percent}%`;
    label.dataset.side = "right";
    const wrap = label.parentElement;
    if (!wrap) return;
    const wrapW = wrap.getBoundingClientRect().width;
    const copyW = copy.getBoundingClientRect().width;
    if (!(wrapW > 0 && copyW > 0)) return;
    const x = (percent / 100) * wrapW;
    if (x + 10 + copyW > wrapW - 2) label.dataset.side = "left";
  }

  function watchWrap(wrap) {
    if (wrap.dataset.csRo) return;
    wrap.dataset.csRo = "1";
    const ro = new ResizeObserver(() => {
      const label = wrap.querySelector(`:scope > .${LABEL_CLASS}`);
      const pct = Number(wrap.dataset.csPace);
      if (label && Number.isFinite(pct)) layoutPaceLabel(label, pct);
    });
    ro.observe(wrap);
  }

  function findUsedSpan(track) {
    const card = track.closest(".px-4.py-3") || track.parentElement;
    if (!card) return null;
    return [...card.querySelectorAll("span")].find((span) =>
      /[\d.]+%\s*used/i.test(span.textContent || ""),
    );
  }

  function upsertChild(parent, className, tag = "div") {
    let el = parent.querySelector(`:scope > .${className}`);
    if (!el) {
      el = document.createElement(tag);
      el.className = className;
      parent.appendChild(el);
    }
    return el;
  }

  function upsertAfter(wrap, className) {
    const next = wrap.nextElementSibling;
    if (next?.classList.contains(className)) return next;
    const el = document.createElement("div");
    el.className = className;
    wrap.after(el);
    return el;
  }

  function applyTrack(track, used, pace, windowMs, quota) {
    const fill = findFill(track);
    if (!fill) return;
    const exhausted = quotaGone(used);
    const windowOk = pace != null && Number.isFinite(windowMs) && windowMs > 0;
    const shownPace = exhausted || !windowOk ? null : pace;
    const over = isOver(used, shownPace);
    const color = usedColor(used, over);
    const wrap = wrapTrack(track);

    fill.style.background = color;
    fill.style.transition = "width .4s ease, background-color .2s ease";

    const usedSpan = findUsedSpan(track);
    if (usedSpan) usedSpan.textContent = `${formatPct(used)} used`;

    const quotaLine = quota?.line || "cap not in API";
    const tops = quota?.tops || [];
    const note = quota?.note || "";
    const sig = [
      used.toFixed(6),
      shownPace == null ? "" : shownPace.toFixed(4),
      over ? "1" : "0",
      exhausted ? "ex" : windowOk ? "ok" : "nowin",
      quotaLine,
      note,
      tops.map((t) => `${t.name}:${t.cents}`).join(","),
    ].join("|");
    if (wrap.dataset.csSig === sig) return;
    wrap.dataset.csSig = sig;

    wrap.querySelector(":scope > .cs-pace-overshoot")?.remove();
    track.querySelector(".cs-pace-overshoot")?.remove();
    track.querySelector(`.${MARKER_CLASS}`)?.remove();

    let marker = wrap.querySelector(`:scope > .${MARKER_CLASS}`);
    let label = wrap.querySelector(`:scope > .${LABEL_CLASS}`);
    if (shownPace == null) {
      marker?.remove();
      label?.remove();
    } else {
      marker = upsertChild(wrap, MARKER_CLASS);
      marker.title = "Linear burn: usage should be here by now";
      placeMarker(marker, shownPace);

      label = upsertChild(wrap, LABEL_CLASS);
      wrap.dataset.csPace = String(shownPace);
      watchWrap(wrap);
      layoutPaceLabel(label, shownPace);
    }

    const meta = upsertAfter(wrap, META_CLASS);
    const status = exhausted
      ? "<span>quota exhausted, hiding pace</span>"
      : !windowOk
        ? "<span>billing window missing, hiding pace</span>"
        : over
          ? `<span class="cs-pace-rest" style="color:${color}">rest ${formatRest(restMs(used, shownPace, windowMs))} to even pace</span>`
          : `<span style="color:${C_GREEN}">under pace · ${formatPct(Math.max(shownPace - used, 0), 2)} left</span>`;
    meta.innerHTML =
      `<div class="cs-pace-meta-row"><span>${escapeText(quotaLine)}</span>${status}</div>` +
      (note ? `<div class="cs-pace-note">${escapeText(note)}</div>` : "") +
      topsMarkup(tops);
  }

  function cycleWindow(summary, period) {
    const startMs =
      parseTime(summary?.billingCycleStart) || parseTime(period?.billingCycleStart);
    const endMs = parseTime(summary?.billingCycleEnd) || parseTime(period?.billingCycleEnd);
    return { startMs, endMs, windowMs: endMs - startMs };
  }

  function requestRender() {
    if (applying) {
      pendingRender = true;
      return;
    }
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(render, 50);
  }

  function render() {
    if (!onOverlayPage() || applying) {
      if (onOverlayPage() && applying) pendingRender = true;
      return;
    }
    applying = true;
    try {
      ensureStyle();
      const now = Date.now();

      if (cachedSummary || cachedPeriod) {
        const { startMs, endMs, windowMs } = cycleWindow(cachedSummary, cachedPeriod);
        const pace = pacePercent(startMs, endMs, now);
        const cursorLine = cursorModelsQuotaLine(cachedPeriod, cachedAgg, cachedSummary);
        const otherLine = otherModelsQuotaLine(cachedPeriod, cachedSummary, cachedAgg);
        poolTracks().forEach((track, index) => {
          const kind = trackKind(track, index);
          const used = poolUsed(kind, cachedSummary, cachedPeriod, findFill(track));
          const quota = kind === "other" ? otherLine : cursorLine;
          applyTrack(track, used, pace, windowMs, quota);
        });
      }

      if (cachedGrok) {
        const startMs = parseTime(cachedGrok.currentPeriodStart || cachedGrok.current_period_start);
        const endMs = parseTime(
          cachedGrok.nextResetTimestampUtc || cachedGrok.next_reset_timestamp_utc,
        );
        const pace = pacePercent(startMs, endMs, now);
        const windowMs = endMs - startMs;
        const grokLine = grokQuotaLine(cachedGrok, cachedGrokAgg);
        sectionTracks("grok-bot").forEach((track) => {
          const used = poolUsed("grok", cachedSummary, cachedPeriod, findFill(track));
          applyTrack(track, used, pace, windowMs, grokLine);
        });
      }
    } finally {
      applying = false;
      if (pendingRender) {
        pendingRender = false;
        requestRender();
      } else if (onOverlayPage() && !overlayHasTracks()) {
        startWaitForBars();
      }
    }
  }

  function swallow(label, err) {
    console.warn("[cursor-included-pace]", label, err?.message || err);
  }

  async function refresh() {
    if (refreshing) {
      refreshQueued = true;
      return;
    }
    if (!onOverlayPage() && !expectOverlay) return;
    refreshing = true;
    try {
      const tasks = [
        loadSummary()
          .then((data) => {
            cachedSummary = data;
          })
          .catch((err) => swallow("usage-summary", err)),
        loadPeriod()
          .then((data) => {
            cachedPeriod = data;
          })
          .catch((err) => swallow("period-usage", err)),
        loadGrok()
          .then((data) => {
            cachedGrok = data;
          })
          .catch((err) => swallow("sand-usage", err)),
        resolveTeamId()
          .then((id) => {
            cachedTeamId = id;
          })
          .catch(() => {
            cachedTeamId = -1;
          }),
      ];
      await Promise.all(tasks);

      const month = cycleWindow(cachedSummary, cachedPeriod);
      if (Number.isFinite(month.startMs) && Number.isFinite(month.endMs)) {
        try {
          cachedAgg = await loadAgg(month.startMs, month.endMs);
        } catch (err) {
          swallow("month-agg", err);
        }
      }
      if (cachedGrok) {
        const grokStart = parseTime(cachedGrok.currentPeriodStart || cachedGrok.current_period_start);
        const grokEnd = parseTime(
          cachedGrok.nextResetTimestampUtc || cachedGrok.next_reset_timestamp_utc,
        );
        if (Number.isFinite(grokStart) && Number.isFinite(grokEnd)) {
          try {
            cachedGrokAgg = await loadAgg(grokStart, grokEnd);
          } catch (err) {
            swallow("grok-agg", err);
          }
        }
      }
      if (onOverlayPage()) expectOverlay = false;
      captureMeterSnaps(cachedSummary, cachedPeriod, cachedAgg, cachedGrok, cachedGrokAgg);
      render();
      if (onOverlayPage() && !overlayHasTracks()) startWaitForBars(true);
      syncPageMode();
    } finally {
      refreshing = false;
      if (refreshQueued) {
        refreshQueued = false;
        scheduleFetch(true);
      }
    }
  }

  // Do not reset an already-pending fetch timer. Continuous SPA mutations used to
  // keep pushing the 80ms debounce out until waitForBars expired, so nothing rendered.
  function scheduleFetch(force = false) {
    if (fetchTimer && !force) return;
    window.clearTimeout(fetchTimer);
    fetchTimer = window.setTimeout(() => {
      fetchTimer = 0;
      refresh();
    }, force ? 50 : 120);
  }

  function schedule() {
    scheduleFetch(false);
  }

  function stopWaitForBars() {
    window.clearTimeout(waitTimer);
    waitTimer = 0;
    waitUntil = 0;
  }

  function startWaitForBars(reset = false) {
    const now = Date.now();
    if (reset || !waitUntil || now >= waitUntil) waitUntil = now + 20_000;
    if (waitTimer) return;
    tickWait();
  }

  function tickWait() {
    waitTimer = 0;
    if (!onOverlayPage() && !expectOverlay) {
      stopWaitForBars();
      syncPageMode();
      return;
    }
    if (overlayHasTracks()) {
      if (cachedSummary || cachedPeriod || cachedGrok) requestRender();
      else scheduleFetch(false);
      // One short follow-up in case SPA swaps the bars once; do not poll for 20s.
      if (Date.now() < waitUntil) {
        waitUntil = 0;
        waitTimer = window.setTimeout(() => {
          waitTimer = 0;
          if (onOverlayPage() && overlayHasTracks()) {
            if (cachedSummary || cachedPeriod || cachedGrok) requestRender();
          } else if (onOverlayPage() || expectOverlay) {
            startWaitForBars(true);
          }
        }, 800);
      }
      return;
    }
    if (Date.now() >= waitUntil) {
      waitUntil = 0;
      syncPageMode();
      return;
    }
    if (!(cachedSummary || cachedPeriod || cachedGrok) && !refreshing) scheduleFetch(false);
    else if (cachedSummary || cachedPeriod || cachedGrok) requestRender();
    waitTimer = window.setTimeout(tickWait, 300);
  }

  function startObserving() {
    if (observing || !observer) return;
    const root = document.documentElement;
    if (!root) return;
    observer.observe(root, OBSERVE_OPTS);
    observing = true;
  }

  function stopObserving() {
    if (!observing || !observer) return;
    observer.disconnect();
    observing = false;
    window.clearTimeout(moDebounceTimer);
    moDebounceTimer = 0;
  }

  function setHrefPoll(ms) {
    window.clearInterval(hrefPollTimer);
    hrefPollTimer = window.setInterval(() => onUrlChange(), ms);
  }

  function syncPageMode() {
    const want = onOverlayPage() || expectOverlay;
    if (want === pageActive) {
      if (want) startObserving();
      return;
    }
    pageActive = want;
    if (want) {
      startObserving();
      setHrefPoll(HREF_POLL_ACTIVE_MS);
    } else {
      stopObserving();
      stopWaitForBars();
      window.clearTimeout(renderTimer);
      renderTimer = 0;
      setHrefPoll(HREF_POLL_IDLE_MS);
    }
  }

  function markExpectOverlay() {
    expectOverlay = true;
    syncPageMode();
    startWaitForBars(true);
    scheduleFetch(true);
  }

  function onUrlChange(force = false) {
    if (!force && location.href === lastHref) {
      syncPageMode();
      return;
    }
    lastHref = location.href;
    if (onOverlayPage()) {
      expectOverlay = false;
      syncPageMode();
      scheduleFetch(true);
      startWaitForBars(true);
      return;
    }
    if (!expectOverlay) syncPageMode();
  }

  function hookHistoryMethod(method) {
    const orig = history[method];
    if (typeof orig !== "function" || orig.__csPace) return;
    const wrapped = function (...args) {
      const ret = orig.apply(this, args);
      onUrlChange();
      return ret;
    };
    wrapped.__csPace = true;
    history[method] = wrapped;
  }

  function hookSpaNavigation() {
    hookHistoryMethod("pushState");
    hookHistoryMethod("replaceState");
    window.addEventListener("popstate", () => onUrlChange());
    window.addEventListener("hashchange", () => onUrlChange());
    if (window.navigation?.addEventListener) {
      window.navigation.addEventListener("navigate", () => {
        queueMicrotask(() => onUrlChange());
      });
    }
    document.addEventListener(
      "click",
      (ev) => {
        const el = ev.target?.closest?.("a,button,[role='tab'],[role='link'],[role='menuitem']");
        if (!el) return;
        const href = el.getAttribute("href") || "";
        const blob = `${href} ${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`;
        const toOverlay =
          /\/(?:[a-z]{2}(?:-[A-Za-z]+)?\/)?dashboard\/(spending|usage)\b/i.test(href) ||
          /(?:\?|&)tab=(spending|usage)\b/i.test(href) ||
          /\b(spending|usage|支出|用量|花费)\b/i.test(blob);
        if (!toOverlay) return;
        markExpectOverlay();
        window.setTimeout(() => onUrlChange(true), 0);
        window.setTimeout(() => onUrlChange(true), 400);
        window.setTimeout(() => onUrlChange(true), 1200);
      },
      true,
    );
    // Next.js may replace history methods; re-hook rarely, not every second.
    historyHookTimer = window.setInterval(() => {
      hookHistoryMethod("pushState");
      hookHistoryMethod("replaceState");
    }, 10_000);
  }

  function onDomActivity() {
    if (!pageActive && !expectOverlay && !isOverlayPath()) return;
    onUrlChange();
    if (!onOverlayPage() && !expectOverlay) {
      syncPageMode();
      return;
    }
    if (applying) {
      pendingRender = true;
      return;
    }
    if (cachedSummary || cachedGrok || cachedPeriod) requestRender();
    else scheduleFetch(false);
    if (!overlayHasTracks()) startWaitForBars();
  }

  observer = new MutationObserver(() => {
    // Debounce: ignore mutation lists; we only need "DOM changed" while active.
    window.clearTimeout(moDebounceTimer);
    moDebounceTimer = window.setTimeout(() => {
      moDebounceTimer = 0;
      onDomActivity();
    }, MO_DEBOUNCE_MS);
  });

  hookSpaNavigation();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (onOverlayPage() || expectOverlay)) {
      scheduleFetch(true);
    }
  });
  // Data refresh only while the overlay page is open and visible.
  window.setInterval(() => {
    if (!pageActive || document.visibilityState !== "visible") return;
    if (onOverlayPage() || expectOverlay) scheduleFetch(true);
  }, 60_000);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => onUrlChange(true));
  }
  onUrlChange(true);
  syncPageMode();
})();
