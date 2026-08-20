// ==UserScript==
// @name         Cursor Spend Pace
// @namespace    https://github.com/xjoker/CursorSpendPace
// @version      20260820.8
// @description  Linear-burn pace, high-precision usage, and inferred caps on the Cursor Spending dashboard
// @author       chou
// @license      MIT
// @match        https://cursor.com/dashboard/*
// @run-at       document-idle
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
  let cachedPlanInfo = null;
  let cachedAgg = null;
  let cachedGrokAgg = null;
  let cachedGrok = null;
  let cachedTeamId = -1;
  let fetchTimer = 0;
  let renderTimer = 0;
  let applying = false;
  let observer = null;
  const OBSERVE_OPTS = { childList: true, subtree: true };

  function onSpendingPage() {
    return location.pathname.startsWith("/dashboard/spending");
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

  function visiblePace(used, pace) {
    const remaining = Math.max(100 - used, 0);
    if (Math.round(remaining) <= 0) return null;
    return pace;
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
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
    style.textContent = `
      .${WRAP_CLASS} { position: relative; }
      .${WRAP_CLASS} .${MARKER_CLASS} {
        position: absolute;
        top: -5px;
        height: calc(100% + 10px);
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
        top: calc(100% + 3px);
        z-index: 3;
        pointer-events: none;
        font: 11px/1.2 ui-sans-serif, system-ui, sans-serif;
        font-weight: 650;
        color: ${C_CYAN};
        white-space: nowrap;
        letter-spacing: .01em;
      }
      .${META_CLASS} {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-top: 16px;
        font: 11px/1.35 ui-sans-serif, system-ui, sans-serif;
        color: ${DIM};
      }
      .${META_CLASS} > span:first-child { min-width: 0; }
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

  async function loadPlanInfo() {
    return postJson("/api/dashboard/get-plan-info", {});
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

  function sectionRoot(sectionId) {
    const header = document.getElementById(sectionId);
    if (!header) return null;
    return header.closest(".dashboard-section") || header.closest("section") || header.parentElement;
  }

  function sectionTracks(sectionId) {
    const section = sectionRoot(sectionId);
    if (!section) return [];
    const primary = [...section.querySelectorAll(".relative.w-full.overflow-hidden.rounded-full")];
    if (primary.length) return primary;
    return [...section.querySelectorAll('[class*="rounded-full"]')].filter((el) => findFill(el));
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

  function topSpender(agg, predicate) {
    let best = null;
    for (const row of agg?.aggregations || []) {
      const name = rowName(row);
      if (!predicate(name)) continue;
      const cents = rowCents(row);
      if (!best || cents > best.cents) best = { name, cents };
    }
    return best;
  }

  function withTopModel(line, top) {
    if (!top || !(top.cents > 0)) return line;
    return `${line} · top ${shortModelName(top.name)} ${formatUsdFromCents(top.cents)}`;
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

  function inferredCapLine(usedCents, pct, label) {
    if (!(Number.isFinite(pct) && pct > 0 && usedCents > 0)) return null;
    const cap = inferRoundCapCents(usedCents / (pct / 100));
    if (cap == null) return null;
    return `${formatUsdFromCents(usedCents)} / ${formatUsdFromCents(cap)} inferred ${label}`;
  }

  function cursorModelsQuotaLine(period, agg) {
    const autoSet = autoModelSet(period);
    const top = topSpender(agg, (name) => isCursorPoolModel(name, autoSet));
    const usage = period?.planUsage || {};
    const pct = pickNumber(usage, ["autoPercentUsed", "auto_percent_used"]);
    const protoLimit = pickNumber(usage, ["autoLimit", "auto_limit"], true);
    const protoSpend = pickNumber(usage, ["autoSpend", "auto_spend"]);
    let line = "Cursor Models cap omitted by API";
    if (protoLimit != null) {
      const used = pct != null ? (protoLimit * pct) / 100 : protoSpend;
      line = `${formatUsdFromCents(used)} / ${formatUsdFromCents(protoLimit)} Cursor Models`;
    } else {
      const usedCents = sumMatchingCents(agg, (name) => isCursorPoolModel(name, autoSet));
      line = inferredCapLine(usedCents, pct, "Cursor Models cap") || line;
    }
    return withTopModel(line, top);
  }

  function otherModelsCapCents(period, summary, planInfo) {
    const usage = period?.planUsage || {};
    const plan = summary?.individualUsage?.plan;
    const info = planInfo?.planInfo || planInfo;
    return (
      pickNumber(usage, ["apiLimit", "api_limit"], true) ??
      pickNumber(info, ["includedAmountCents", "included_amount_cents"], true) ??
      pickNumber(plan, ["limit"], true)
    );
  }

  function otherModelsQuotaLine(period, summary, planInfo, agg) {
    const autoSet = autoModelSet(period);
    const top = topSpender(agg, (name) => isOtherPoolModel(name, autoSet));
    const cap = otherModelsCapCents(period, summary, planInfo);
    const pct =
      pickNumber(period?.planUsage, ["apiPercentUsed", "api_percent_used"]) ??
      pickNumber(summary?.individualUsage?.plan, ["apiPercentUsed", "api_percent_used"]);
    let line = "Other Models cap omitted by API";
    if (cap != null && pct != null) {
      line = `${formatUsdFromCents((cap * pct) / 100)} / ${formatUsdFromCents(cap)} Other Models included`;
    } else if (cap != null) {
      line = `${formatUsdFromCents(cap)} Other Models included`;
    }
    return withTopModel(line, top);
  }

  function grokQuotaLine(grok, grokAgg) {
    const top = topSpender(grokAgg, isSandModel);
    const pct = pickNumber(grok, ["usagePercent", "usage_percent"]);
    const usedCents = sumMatchingCents(grokAgg, isSandModel);
    let line =
      grok?.hasNonZeroIncludedLimit || grok?.has_non_zero_included_limit
        ? "Grok included limit exists, cap omitted by API"
        : "Grok weekly cap omitted by API";
    line = inferredCapLine(usedCents, pct, "Grok weekly cap") || line;
    return withTopModel(line, top);
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

  function placeHoriz(el, percent) {
    el.style.left = `${percent}%`;
    if (percent < 10) el.style.transform = "translateX(0)";
    else if (percent > 90) el.style.transform = "translateX(-100%)";
    else el.style.transform = "translateX(-50%)";
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

  function applyTrack(track, used, pace, windowMs, quotaLine) {
    const fill = findFill(track);
    if (!fill) return;
    const shownPace = visiblePace(used, pace);
    const over = isOver(used, shownPace);
    const color = usedColor(used, over);
    const wrap = wrapTrack(track);

    fill.style.background = color;
    fill.style.transition = "width .4s ease, background-color .2s ease";

    const usedSpan = findUsedSpan(track);
    if (usedSpan) usedSpan.textContent = `${formatPct(used)} used`;

    const sig = [
      used.toFixed(6),
      shownPace == null ? "" : shownPace.toFixed(4),
      over ? "1" : "0",
      quotaLine || "",
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
      placeHoriz(marker, shownPace);
      marker.style.transform = "none";
      marker.style.marginLeft = "-1px";

      label = upsertChild(wrap, LABEL_CLASS);
      label.textContent = `↑ pace ${formatPct(shownPace, 2)}`;
      placeHoriz(label, shownPace);
    }

    const meta = upsertAfter(wrap, META_CLASS);
    const quota = quotaLine || "cap not in API";
    if (shownPace == null) {
      meta.innerHTML = `<span>${quota}</span><span>quota exhausted, hiding pace</span>`;
      return;
    }
    if (over) {
      const wait = formatRest(restMs(used, shownPace, windowMs));
      meta.innerHTML =
        `<span>${quota}</span>` +
        `<span class="cs-pace-rest" style="color:${color}">rest ${wait} to even pace</span>`;
    } else {
      const slack = Math.max(shownPace - used, 0);
      meta.innerHTML =
        `<span>${quota}</span>` +
        `<span style="color:${C_GREEN}">under pace · ${formatPct(slack, 2)} left</span>`;
    }
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
    if (applying) return;
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(render, 50);
  }

  function render() {
    if (!onSpendingPage() || applying) return;
    applying = true;
    observer?.disconnect();
    try {
      ensureStyle();
      const now = Date.now();

      if (cachedSummary || cachedPeriod) {
        const { startMs, endMs, windowMs } = cycleWindow(cachedSummary, cachedPeriod);
        const pace = pacePercent(startMs, endMs, now);
        const cursorLine = cursorModelsQuotaLine(cachedPeriod, cachedAgg);
        const otherLine = otherModelsQuotaLine(
          cachedPeriod,
          cachedSummary,
          cachedPlanInfo,
          cachedAgg,
        );
        sectionTracks("included-in-ultra").forEach((track, index) => {
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
      observer?.takeRecords();
      observer?.observe(document.documentElement, OBSERVE_OPTS);
      applying = false;
    }
  }

  function swallow(label, err) {
    console.warn("[cursor-included-pace]", label, err?.message || err);
  }

  async function refresh() {
    if (!onSpendingPage()) return;
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
      loadPlanInfo()
        .then((data) => {
          cachedPlanInfo = data;
        })
        .catch((err) => swallow("plan-info", err)),
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

  observer = new MutationObserver((mutations) => {
    if (!onSpendingPage() || applying) return;
    if (onlyOverlayMutations(mutations)) return;
    if (cachedSummary || cachedGrok || cachedPeriod) requestRender();
    else schedule();
  });

  observer.observe(document.documentElement, OBSERVE_OPTS);
  window.addEventListener("popstate", schedule);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  window.setInterval(() => {
    if (onSpendingPage() && document.visibilityState === "visible") refresh();
  }, 60_000);

  refresh();
})();
