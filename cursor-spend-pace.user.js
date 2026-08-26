// ==UserScript==
// @name         Cursor Spend Pace
// @namespace    https://github.com/xjoker/CursorSpendPace
// @version      20260826.8
// @description  Linear-burn pace, high-precision usage, and inferred caps on the Cursor Spending dashboard
// @author       chou
// @license      MIT
// @match        https://cursor.com/dashboard
// @match        https://cursor.com/dashboard/*
// @match        https://www.cursor.com/dashboard
// @match        https://www.cursor.com/dashboard/*
// @match        https://cursor.com/*/dashboard
// @match        https://cursor.com/*/dashboard/*
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
  let observer = null;
  let lastHref = "";
  const OBSERVE_OPTS = { childList: true, subtree: true };

  function dashboardPath() {
    return (location.pathname.replace(/\/+$/, "") || "/").replace(
      /^\/[a-z]{2}(?:-[A-Za-z]{2})?(?=\/|$)/,
      "",
    );
  }

  function onOverlayPage() {
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
    if (path === "/dashboard" && /^(spending|usage)$/i.test(tab || "")) return true;
    return Boolean(
      document.querySelector("[id^='included-in-']") ||
        document.getElementById("grok-bot") ||
        includedSectionRoots().length > 0,
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
      if (/^included in /i.test((el.textContent || "").trim())) add(el);
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
    const card = track.closest(".px-4.py-3") || track.parentElement;
    return card?.innerText || "";
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

  function isSandModel(name) {
    return /^sand(?:[-_]|$)/i.test(name || "");
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
    if (!name || isSandModel(name)) return false;
    if (autoSet.has(name)) return true;
    for (const bucket of autoSet) {
      if (sameModelFamily(name, bucket)) return true;
    }
    return false;
  }

  function isOtherPoolModel(name, autoSet) {
    if (!name || isSandModel(name)) return false;
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
    const rows = [];
    for (const row of agg?.aggregations || []) {
      const name = rowName(row);
      if (!predicate(name)) continue;
      const cents = rowCents(row);
      if (!(cents > 0)) continue;
      rows.push({ name, cents });
    }
    rows.sort((a, b) => b.cents - a.cents);
    return rows.slice(0, limit);
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

  function inferCap(usedCents, pct, label) {
    if (!(Number.isFinite(pct) && pct > 0 && usedCents > 0)) return null;
    const raw = usedCents / (pct / 100);
    const cap = inferRoundCapCents(raw);
    if (cap == null) return null;
    return {
      line: `${formatUsdFromCents(usedCents)} / ${formatUsdFromCents(cap)} inferred ${label}`,
      note: `list ${formatUsdFromCents(usedCents)} ÷ ${formatPct(pct, 3)} = ${formatUsdFromCents(raw)} this snapshot`,
    };
  }

  function cursorModelsQuotaLine(period, agg) {
    const autoSet = autoModelSet(period);
    const tops = topSpenders(agg, (name) => isCursorPoolModel(name, autoSet));
    const usage = period?.planUsage || {};
    const pct = pickNumber(usage, ["autoPercentUsed", "auto_percent_used"]);
    const protoLimit = pickNumber(usage, ["autoLimit", "auto_limit"], true);
    const protoSpend = pickNumber(usage, ["autoSpend", "auto_spend"]);
    let line = "Cursor Models cap omitted by API";
    let note = "";
    if (protoLimit != null) {
      const used = pct != null ? (protoLimit * pct) / 100 : protoSpend;
      line = `${formatUsdFromCents(used)} / ${formatUsdFromCents(protoLimit)} Cursor Models`;
    } else {
      const usedCents = sumMatchingCents(agg, (name) => isCursorPoolModel(name, autoSet));
      const inferred = inferCap(usedCents, pct, "Cursor Models cap");
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
    let line = "Other Models cap omitted by API";
    let note = "";
    if (protoLimit != null) {
      const used = pct != null ? (protoLimit * pct) / 100 : protoSpend;
      line = `${formatUsdFromCents(used)} / ${formatUsdFromCents(protoLimit)} Other Models`;
    } else {
      const usedCents = sumMatchingCents(agg, (name) => isOtherPoolModel(name, autoSet));
      const inferred = inferCap(usedCents, pct, "Other Models cap");
      if (inferred) {
        line = inferred.line;
        note = inferred.note;
      }
    }
    return quotaInfo(line, tops, note);
  }

  function grokQuotaLine(grok, grokAgg) {
    const tops = topSpenders(grokAgg, isSandModel);
    const pct = pickNumber(grok, ["usagePercent", "usage_percent"]);
    const usedCents = sumMatchingCents(grokAgg, isSandModel);
    let line =
      grok?.hasNonZeroIncludedLimit || grok?.has_non_zero_included_limit
        ? "Grok included limit exists, cap omitted by API"
        : "Grok weekly cap omitted by API";
    let note = "";
    const inferred = inferCap(usedCents, pct, "Grok weekly cap");
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

  function overlayNode(node) {
    if (!node) return false;
    if (node.nodeType === 3) return overlayNode(node.parentElement);
    if (node.nodeType !== 1) return false;
    return Boolean(node.id === STYLE_ID || node.closest?.(`.${WRAP_CLASS}, .${META_CLASS}`));
  }

  function onlyOverlayMutations(mutations) {
    return mutations.every((m) => {
      if (!overlayNode(m.target)) return false;
      for (const node of m.addedNodes) {
        if (node.nodeType === 1 && !overlayNode(node)) return false;
      }
      for (const node of m.removedNodes) {
        if (node.nodeType === 1 && !overlayNode(node)) return false;
      }
      return true;
    });
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
        const cursorLine = cursorModelsQuotaLine(cachedPeriod, cachedAgg);
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
    if (!onOverlayPage()) return;
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
    render();
  }

  function schedule() {
    window.clearTimeout(fetchTimer);
    fetchTimer = window.setTimeout(() => {
      refresh();
    }, 80);
  }

  function startWaitForBars() {
    const now = Date.now();
    if (!waitUntil || now >= waitUntil) waitUntil = now + 12_000;
    if (waitTimer) return;
    tickWait();
  }

  function tickWait() {
    waitTimer = 0;
    if (!onOverlayPage()) {
      if (Date.now() < waitUntil) waitTimer = window.setTimeout(tickWait, 250);
      return;
    }
    if (overlayHasTracks()) {
      if (cachedSummary || cachedPeriod || cachedGrok) requestRender();
      else schedule();
      return;
    }
    if (Date.now() >= waitUntil) return;
    if (cachedSummary || cachedPeriod || cachedGrok) requestRender();
    else schedule();
    waitTimer = window.setTimeout(tickWait, 250);
  }

  function onUrlChange(force = false) {
    if (!force && location.href === lastHref) return;
    lastHref = location.href;
    if (onOverlayPage()) {
      schedule();
      startWaitForBars();
    }
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
        const el = ev.target?.closest?.("a,button,[role='tab'],[role='link']");
        if (!el) return;
        const blob = `${el.getAttribute("href") || ""} ${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`;
        if (!/spending|usage/i.test(blob)) return;
        window.setTimeout(() => onUrlChange(true), 0);
        window.setTimeout(() => onUrlChange(true), 300);
      },
      true,
    );
    window.setInterval(() => {
      hookHistoryMethod("pushState");
      hookHistoryMethod("replaceState");
    }, 1000);
  }

  observer = new MutationObserver((mutations) => {
    onUrlChange();
    if (!onOverlayPage()) return;
    if (onlyOverlayMutations(mutations)) return;
    if (applying) {
      pendingRender = true;
      startWaitForBars();
      return;
    }
    if (cachedSummary || cachedGrok || cachedPeriod) requestRender();
    else schedule();
    if (!overlayHasTracks()) startWaitForBars();
  });

  hookSpaNavigation();
  if (document.documentElement) {
    observer.observe(document.documentElement, OBSERVE_OPTS);
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      observer.observe(document.documentElement, OBSERVE_OPTS);
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && onOverlayPage()) refresh();
  });
  window.setInterval(() => {
    onUrlChange();
    if (onOverlayPage() && document.visibilityState === "visible") refresh();
  }, 60_000);
  window.setInterval(() => onUrlChange(), 400);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => onUrlChange(true));
  }
  onUrlChange(true);
})();
