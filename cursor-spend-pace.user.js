// ==UserScript==
// @name         Cursor Spend Pace
// @namespace    https://github.com/xjoker/CursorSpendPace
// @version      20260917.12
// @description  Linear-burn pace, included-dollar ledger, token mix, Usage list-price, and local Grok reset
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
  const USAGE_EVENTS_RE = /get-filtered-usage-events/i;
  const USAGE_LOCAL_CLASS = "cs-pace-local";
  const USAGE_FILL_CLASS = "cs-pace-fillcol";
  const BOARD_CLASS = "cs-pace-board";
  const DATE_UTC_RE = /Date\s*[(（]\s*UTC\s*[)）]/i;
  const USAGE_LOCAL_PX = 180;
  const USAGE_FILL_PX = 96;
  const USAGE_MODEL_MAX_PX = 220;
  const USAGE_EXTRA_COLS = [
    ["maxMode", "Max"],
    ["inputNoCacheWrite", "In"],
    ["inputCacheWrite", "CW"],
    ["cacheRead", "CR"],
    ["output", "Out"],
    ["listCost", "List"],
  ];

  let cachedSummary = null;
  let cachedPeriod = null;
  let cachedAgg = null;
  let cachedAggWindow = "";
  let cachedViewAgg = null;
  let cachedViewAggWindow = "";
  let cachedUsageEventsWindow = "";
  let cachedGrokAgg = null;
  let cachedGrokAggWindow = "";
  let cachedGrok = null;
  let cachedPlanInfo = null;
  let cachedHardLimit = null;
  let cachedPricing = null;
  let cachedTeamId = -1;
  let cachedUsageEvents = [];
  let cachedUsageEventCount = null;
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

  function isUsagePath() {
    const path = dashboardPath();
    if (path === "/dashboard/usage" || path.startsWith("/dashboard/usage/")) return true;
    const tab = new URLSearchParams(location.search).get("tab");
    return path === "/dashboard" && /^usage$/i.test(tab || "");
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
    if (poolTracks().length > 0 || sectionTracks("grok-bot").length > 0) return true;
    if (isUsagePath()) {
      return Boolean(findDateUtcHeader() || findExactLabel("Total tokens"));
    }
    return false;
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

  function fetchUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input?.url || "";
  }

  function extractUsageEvents(data) {
    if (!data || typeof data !== "object") return [];
    const n = pickNumber(data, ["totalUsageEventsCount", "total_usage_events_count"]);
    if (n != null) cachedUsageEventCount = n;
    const list = data.usageEventsDisplay || data.usageEvents || data.usage_events || data.events;
    if (Array.isArray(list)) return list;
    return Array.isArray(data.data) ? data.data : [];
  }

  function hookUsageFetch() {
    const orig = window.fetch;
    if (typeof orig !== "function" || orig.__csPaceUsage) return;
    const wrapped = function (...args) {
      const pending = orig.apply(this, args);
      try {
        if (USAGE_EVENTS_RE.test(fetchUrl(args[0]))) {
          Promise.resolve(pending)
            .then((res) => res.clone().json())
            .then((data) => {
              cachedUsageEvents = extractUsageEvents(data);
              if (isUsagePath()) requestRender();
            })
            .catch(() => {});
        }
      } catch {
        // Keep the page fetch working even if our probe fails.
      }
      return pending;
    };
    wrapped.__csPaceUsage = true;
    window.fetch = wrapped;
  }

  function tzLabel() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
    try {
      const name = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        timeZoneName: "shortOffset",
      })
        .formatToParts(new Date())
        .find((part) => part.type === "timeZoneName")?.value;
      return name ? `${tz} (${name})` : tz;
    } catch {
      return tz;
    }
  }

  function formatLocalDate(ms, hasClock) {
    if (!Number.isFinite(ms)) return "";
    const opts = {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour12: false,
      hourCycle: "h23",
    };
    if (hasClock) {
      opts.hour = "2-digit";
      opts.minute = "2-digit";
      opts.second = "2-digit";
    }
    const parts = new Intl.DateTimeFormat("en-CA", opts).formatToParts(new Date(ms));
    const get = (type) => parts.find((part) => part.type === type)?.value || "";
    const date = `${get("year")}-${get("month")}-${get("day")}`;
    if (!hasClock) return date;
    return `${date} ${get("hour")}:${get("minute")}:${get("second")}`;
  }

  function parseUtcCell(text) {
    const raw = String(text || "").replace(/\s+/g, " ").trim();
    if (!raw) return { ms: NaN, hasClock: false };
    if (/^\d{10,13}$/.test(raw)) {
      const n = Number(raw);
      return { ms: n < 1e12 ? n * 1000 : n, hasClock: true };
    }
    const hasClock = /\d:\d{2}/.test(raw) || /\b(?:AM|PM)\b/i.test(raw) || /T\d{2}/.test(raw);
    let withZone = /Z$|UTC|GMT|[+-]\d{2}/i.test(raw)
      ? raw
      : `${raw.replace(/\s*[(（]\s*UTC\s*[)）]\s*$/i, "")} UTC`;
    if (!/\b\d{4}\b/.test(raw)) {
      withZone = withZone.replace(/\s*UTC$/i, ` ${new Date().getUTCFullYear()} UTC`);
    }
    let ms = Date.parse(withZone);
    if (!Number.isFinite(ms)) ms = Date.parse(raw);
    if (Number.isFinite(ms) && !/\b\d{4}\b/.test(raw) && ms - Date.now() > 31 * 86400000) {
      const shifted = new Date(ms);
      shifted.setUTCFullYear(shifted.getUTCFullYear() - 1);
      ms = shifted.getTime();
    }
    return { ms, hasClock };
  }

  function formatCount(n) {
    if (!Number.isFinite(n)) return "";
    return n.toLocaleString("en-US");
  }

  function kindLabel(kind) {
    const raw = String(kind || "").trim();
    if (!raw) return "";
    if (/included/i.test(raw)) return "Included";
    if (/usage.?based/i.test(raw)) return "Usage-based";
    if (/error/i.test(raw)) return raw.replace(/^USAGE_EVENT_KIND_/, "").replace(/_/g, " ");
    return raw.replace(/^USAGE_EVENT_KIND_/, "").replace(/_/g, " ");
  }

  function eventCost(ev) {
    const labeled = ev.usageBasedCosts ?? ev.usage_based_costs;
    if (typeof labeled === "string" && labeled.trim() && labeled.trim() !== "-") {
      return labeled.trim();
    }
    const charged = pickNumber(ev, ["chargedCents", "charged_cents"]);
    if (charged != null) return formatUsdFromCents(charged);
    const tu = ev.tokenUsage || ev.token_usage;
    const cents = pickNumber(tu, ["totalCents", "total_cents"]);
    if (cents != null && cents > 0) return formatUsdFromCents(cents);
    const kind = String(ev.kind || ev.kindLabel || "");
    if (ev.isChargeable === false || /included/i.test(kind)) return "Included";
    return "";
  }

  function eventValue(ev, key) {
    if (!ev) return "";
    const tu = ev.tokenUsage || ev.token_usage;
    const token = (names) => {
      if (!tu) return "";
      const n = pickNumber(tu, names);
      return n == null ? "" : formatCount(n);
    };
    if (key === "kind") return kindLabel(ev.kind || ev.kindLabel || ev.kind_label);
    if (key === "model") return String(ev.model || "");
    if (key === "maxMode") {
      const v = ev.maxMode ?? ev.max_mode;
      if (v === true) return "Yes";
      if (v === false) return "No";
      return "";
    }
    if (key === "inputCacheWrite") return token(["cacheWriteTokens", "cache_write_tokens"]);
    if (key === "inputNoCacheWrite") return token(["inputTokens", "input_tokens"]);
    if (key === "cacheRead") return token(["cacheReadTokens", "cache_read_tokens"]);
    if (key === "output") return token(["outputTokens", "output_tokens"]);
    if (key === "tokens") {
      if (!tu) return "";
      const total =
        (pickNumber(tu, ["inputTokens", "input_tokens"]) || 0) +
        (pickNumber(tu, ["outputTokens", "output_tokens"]) || 0) +
        (pickNumber(tu, ["cacheWriteTokens", "cache_write_tokens"]) || 0) +
        (pickNumber(tu, ["cacheReadTokens", "cache_read_tokens"]) || 0);
      return formatCount(total);
    }
    if (key === "requests") {
      const n = pickNumber(ev, ["requestsCosts", "requests_costs"]);
      return n == null ? "" : String(n);
    }
    if (key === "cost") return eventCost(ev);
    if (key === "listCost") {
      const cents =
        pickNumber(tu, ["totalCents", "total_cents"]) ??
        pickNumber(ev, ["chargedCents", "charged_cents"]);
      return cents == null ? "" : formatUsdFromCents(cents);
    }
    return "";
  }

  function headerKey(text) {
    const t = headerText(text);
    const lower = t.toLowerCase();
    if (DATE_UTC_RE.test(t)) return "dateUtc";
    if (/^date\s*[(（].*local/i.test(t) || /^date \(local\)$/i.test(t)) return "dateLocal";
    if (/^(type|kind)$/i.test(t)) return "kind";
    if (/^in$/i.test(t)) return "inputNoCacheWrite";
    if (/^cw$/i.test(t)) return "inputCacheWrite";
    if (/^cr$/i.test(t)) return "cacheRead";
    if (/^out$/i.test(t) || /^output$/i.test(t)) return "output";
    if (/^max$/i.test(t)) return "maxMode";
    if (/^req$/i.test(t)) return "requests";
    if (/max\s*mode/i.test(t)) return "maxMode";
    if (/cache write/i.test(lower) && /input/i.test(lower)) return "inputCacheWrite";
    if (/w\/o cache|without cache/i.test(lower)) return "inputNoCacheWrite";
    if (/cache read/i.test(lower)) return "cacheRead";
    if (/output/i.test(lower)) return "output";
    if (/total tokens/i.test(lower)) return "tokens";
    if (/^model$/i.test(t)) return "model";
    if (/^tokens$/i.test(t)) return "tokens";
    if (/^requests$/i.test(t)) return "requests";
    if (/^cost/i.test(t)) return "cost";
    if (/^list$/i.test(t)) return "listCost";
    return "";
  }

  function originalText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone
      .querySelectorAll(".cs-pace-local-line, .cs-pace-fields-line, .cs-pace-local-h")
      .forEach((node) => node.remove());
    return headerText(clone);
  }

  function headerText(elOrText) {
    const t = typeof elOrText === "string" ? elOrText : elOrText?.textContent || "";
    return t.replace(/\s+/g, " ").trim();
  }

  function cellLooksEmpty(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    return !t || /^[-–—]$/.test(t) || /^n\/a$/i.test(t);
  }

  function cellsOf(row) {
    if (!row) return [];
    const tagged = [...row.children].filter(
      (el) =>
        /^(TH|TD)$/.test(el.tagName) ||
        /^(columnheader|cell|gridcell)$/i.test(el.getAttribute("role") || ""),
    );
    return tagged.length ? tagged : [...row.children];
  }

  function nativeCells(row) {
    return cellsOf(row).filter(
      (el) => !el.classList.contains(USAGE_LOCAL_CLASS) && !el.classList.contains(USAGE_FILL_CLASS),
    );
  }

  function findDateUtcHeader() {
    const nodes = document.querySelectorAll("th, [role='columnheader']");
    for (const el of nodes) {
      if (el.classList.contains(USAGE_LOCAL_CLASS) || el.classList.contains(USAGE_FILL_CLASS)) continue;
      if (DATE_UTC_RE.test(originalText(el) || headerText(el))) return el;
    }
    return null;
  }

  function usageBodyRows(headRow) {
    const table = headRow.closest("table, [role='table'], [role='grid']");
    const group =
      table?.querySelector("[role='rowgroup'], .dashboard-table-rows") ||
      headRow.parentElement?.querySelector("[role='rowgroup'], .dashboard-table-rows");
    if (group) {
      const rows = [...group.querySelectorAll(":scope > [role='row'], :scope > .dashboard-table-row")];
      if (rows.length) return rows;
    }
    if (table?.tBodies?.length) {
      return [...table.tBodies].flatMap((body) => [...body.rows]);
    }
    const fallback = [...document.querySelectorAll(".dashboard-table-row")];
    if (fallback.length) return fallback;
    const parent = headRow.parentElement;
    if (!parent) return [];
    return [...parent.children].filter(
      (el) => el !== headRow && (el.matches?.("tr, [role='row']") || el.tagName === "TR"),
    );
  }

  function takeEvent(index, dateMs, modelText, used, rowCount) {
    const events = cachedUsageEvents;
    if (!events.length) return null;
    const model = (modelText || "").trim();
    for (let i = 0; i < events.length; i++) {
      if (used.has(i)) continue;
      const ev = events[i];
      const evMs = parseTime(ev.timestamp);
      const evModel = String(ev.model || "");
      const modelOk =
        !model || !evModel || evModel === model || evModel.includes(model) || model.includes(evModel);
      const timeOk =
        Number.isFinite(dateMs) && Number.isFinite(evMs) && Math.abs(evMs - dateMs) <= 2000;
      if (modelOk && timeOk) {
        used.add(i);
        return ev;
      }
    }
    if (events.length === rowCount && events[index] && !used.has(index)) {
      used.add(index);
      return events[index];
    }
    if (events[index] && !used.has(index)) {
      used.add(index);
      return events[index];
    }
    return null;
  }

  function dateCellTime(dateCell) {
    const titled = dateCell.querySelector("[title]");
    const fromTitle = parseUtcCell(titled?.getAttribute("title") || "");
    if (Number.isFinite(fromTitle.ms)) return fromTitle;
    return parseUtcCell(originalText(dateCell));
  }

  function makeUsageCell(kind, key, label) {
    const isHeader = kind === "header";
    const el = document.createElement("div");
    el.className = isHeader
      ? `${key === "local" ? USAGE_LOCAL_CLASS : USAGE_FILL_CLASS} dashboard-table-header${key === "local" ? "" : " dashboard-table-header-align-right"}`
      : `${key === "local" ? USAGE_LOCAL_CLASS : USAGE_FILL_CLASS} dashboard-table-cell dashboard-table-cell-align-${key === "local" ? "left" : "right"}`;
    el.setAttribute("role", isHeader ? "columnheader" : "cell");
    if (key !== "local") el.dataset.csCol = key;
    if (label) el.textContent = label;
    return el;
  }

  function ensureLocalCell(row, dateCell, isHeader) {
    const next = dateCell.nextElementSibling;
    if (next?.classList.contains(USAGE_LOCAL_CLASS)) return next;
    const el = makeUsageCell(isHeader ? "header" : "body", "local", isHeader ? "Date (local)" : "");
    dateCell.after(el);
    return el;
  }

  function ensureExtraCell(row, key, label, isHeader) {
    const found = [...row.children].find((el) => el.dataset.csCol === key);
    if (found) return found;
    const el = makeUsageCell(isHeader ? "header" : "body", key, isHeader ? label : "");
    row.appendChild(el);
    return el;
  }

  function setCellText(el, text) {
    if (!el || text == null || text === "") return;
    if ((el.textContent || "").trim() === text) return;
    el.textContent = text;
  }

  function stripLegacyInnerLines() {
    document
      .querySelectorAll(".cs-pace-local-line, .cs-pace-fields-line, .cs-pace-local-h")
      .forEach((el) => el.remove());
  }

  function usageColWidth(el) {
    if (!el || el.classList.contains("dashboard-table-row-divider")) return 0;
    if (el.classList.contains("cs-pace-model")) return USAGE_MODEL_MAX_PX;
    if (el.classList.contains(USAGE_LOCAL_CLASS)) return USAGE_LOCAL_PX;
    if (el.classList.contains(USAGE_FILL_CLASS)) {
      return el.dataset.csCol === "maxMode" ? 64 : USAGE_FILL_PX;
    }
    return Math.max(Math.ceil(el.getBoundingClientRect().width), 64);
  }

  function pinModelCell(el) {
    if (!el) return;
    el.classList.add("cs-pace-model");
    el.style.setProperty("flex", `0 0 ${USAGE_MODEL_MAX_PX}px`, "important");
    el.style.setProperty("flex-grow", "0", "important");
    el.style.setProperty("flex-shrink", "0", "important");
    el.style.setProperty("width", `${USAGE_MODEL_MAX_PX}px`, "important");
    el.style.setProperty("max-width", `${USAGE_MODEL_MAX_PX}px`, "important");
    el.style.setProperty("min-width", `${USAGE_MODEL_MAX_PX}px`, "important");
  }

  function markModelColumn(headRow, bodyRows, modelIdx) {
    if (modelIdx < 0) return;
    pinModelCell(nativeCells(headRow)[modelIdx]);
    for (const row of bodyRows) pinModelCell(nativeCells(row)[modelIdx]);
  }

  function syncUsageShell() {
    const shell = document.querySelector(".container.mx-auto");
    if (!shell) return;
    if (isUsagePath()) shell.classList.add("cs-pace-shell");
    else shell.classList.remove("cs-pace-shell");
  }

  function widenUsageTable(headRow) {
    const needed = [...headRow.children].reduce((n, el) => n + usageColWidth(el), 0);
    const minWidth = `${Math.max(needed, 1)}px`;
    const cont =
      headRow.closest(".dashboard-table-container") || headRow.parentElement;
    if (!cont) return;
    syncUsageShell();
    cont.classList.add("cs-pace-wide");
    cont.style.setProperty("--cs-pace-min-width", minWidth);
    cont.style.setProperty("min-width", minWidth, "important");
    const card = headRow.closest(".dashboard-table-card");
    const scroll = headRow.closest(".dashboard-table-scroll-container");
    if (scroll) {
      scroll.classList.add("cs-pace-wide-scroll");
      scroll.style.setProperty("overflow-x", "auto", "important");
    }
    if (card) {
      card.classList.add("cs-pace-wide-card");
      card.style.setProperty("overflow-x", "auto", "important");
      card.style.setProperty("overflow-y", "visible", "important");
    }
  }

  function teamBody(extra) {
    const body = { ...(extra || {}) };
    if (cachedTeamId != null && cachedTeamId !== "" && Number(cachedTeamId) !== -1) {
      body.teamId = cachedTeamId;
    }
    return body;
  }

  function usageRangeBody() {
    const view = usageViewWindow();
    const body = teamBody({ page: 1, pageSize: 100 });
    if (Number.isFinite(view.startMs)) body.startDate = String(view.startMs);
    if (Number.isFinite(view.endMs)) body.endDate = String(view.endMs);
    return body;
  }

  function viewWindowKey(view) {
    if (!view || !Number.isFinite(view.startMs) || !Number.isFinite(view.endMs)) return "";
    return `${view.startMs}:${view.endMs}`;
  }

  function enhanceUsageTable() {
    syncUsageShell();
    if (!isUsagePath()) return;
    stripLegacyInnerLines();
    const dateHeader = findDateUtcHeader();
    if (!dateHeader) return;
    const headRow = dateHeader.closest("tr, [role='row']") || dateHeader.parentElement;
    if (!headRow) return;
    const nativeHead = nativeCells(headRow);
    const dateIdx = headCellsIndex(nativeHead, dateHeader);
    if (dateIdx < 0) return;
    const keys = nativeHead.map((cell) => headerKey(cell));
    const present = new Set(keys.filter(Boolean));
    const modelIdx = keys.indexOf("model");
    const localHeader = ensureLocalCell(headRow, dateHeader, true);
    localHeader.title = tzLabel();
    const extraKeys = USAGE_EXTRA_COLS.filter(([key]) => !present.has(key));
    for (const [key, label] of extraKeys) {
      ensureExtraCell(headRow, key, label, true);
    }
    document.querySelectorAll('[data-cs-col="requests"]').forEach((el) => el.remove());
    const bodyRows = usageBodyRows(headRow);
    markModelColumn(headRow, bodyRows, modelIdx);
    widenUsageTable(headRow);
    const used = new Set();
    bodyRows.forEach((row, index) => {
      const cells = nativeCells(row);
      const dateCell = cells[dateIdx];
      if (!dateCell || DATE_UTC_RE.test(originalText(dateCell))) return;
      const parsed = dateCellTime(dateCell);
      const modelText = modelIdx >= 0 ? originalText(cells[modelIdx]) : "";
      const ev = takeEvent(index, parsed.ms, modelText, used, bodyRows.length);
      const evMs = ev ? parseTime(ev.timestamp) : NaN;
      const ms = Number.isFinite(evMs) ? evMs : parsed.ms;
      const hasClock = Number.isFinite(evMs) || parsed.hasClock;
      const localCell = ensureLocalCell(row, dateCell, false);
      setCellText(localCell, formatLocalDate(ms, hasClock));
      localCell.title = tzLabel();
      cells.forEach((cell, cellIdx) => {
        const key = keys[cellIdx];
        if (!key || key === "dateUtc" || key === "model") return;
        const value = eventValue(ev, key);
        if (!value || !cellLooksEmpty(originalText(cell))) return;
        setCellText(cell, value);
      });
      for (const [key, label] of extraKeys) {
        const td = ensureExtraCell(row, key, label, false);
        setCellText(td, eventValue(ev, key));
      }
    });
  }

  function headCellsIndex(cells, header) {
    const idx = cells.indexOf(header);
    if (idx >= 0) return idx;
    return cells.findIndex((cell) => cell.contains(header));
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

  function formatUsdComputed(cents) {
    if (!Number.isFinite(cents)) return "n/a";
    const usd = cents / 100;
    const text = usd.toFixed(4).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
    return `$${text}`;
  }

  function formatCompactTokens(n) {
    const x = Number(n);
    if (!Number.isFinite(x) || x < 0) return "n/a";
    if (x >= 1e9) return `${(x / 1e9).toFixed(2).replace(/\.?0+$/, "")}B`;
    if (x >= 1e6) return `${(x / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
    if (x >= 1e3) return `${(x / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
    return formatCount(x);
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
        gap: 12px 16px;
        flex-wrap: wrap;
      }
      .${META_CLASS} .cs-pace-meta-row > span:first-child {
        min-width: 0;
        flex: 1 1 12rem;
      }
      .${META_CLASS} .cs-pace-meta-row > span:last-child { white-space: nowrap; }
      .${META_CLASS} .cs-pace-note {
        font-size: 10px;
        line-height: 1.35;
        color: #64748b;
        font-variant-numeric: tabular-nums;
      }
      .cs-pace-tops {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .cs-pace-top {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 5px;
        max-width: 100%;
        padding: 4px 8px;
        border-radius: 10px;
        background: #f1f5f9;
        color: #334155;
        font-size: 11px;
        line-height: 1.35;
        font-variant-numeric: tabular-nums;
      }
      .cs-pace-top b {
        font-weight: 700;
        color: #64748b;
        font-size: 10px;
      }
      .cs-pace-top i {
        font-style: normal;
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cs-pace-top em {
        flex: 1 1 100%;
        font-style: normal;
        color: #64748b;
        font-size: 10px;
      }
      .cs-pace-rest { font-weight: 700; }
      .${USAGE_LOCAL_CLASS}, .${USAGE_FILL_CLASS} {
        flex: 0 0 ${USAGE_FILL_PX}px;
        width: ${USAGE_FILL_PX}px;
        display: flex;
        align-items: center;
        overflow: hidden;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
        padding: 12px 8px;
        color: var(--text-secondary);
        box-sizing: border-box;
        min-width: ${USAGE_FILL_PX}px;
        flex-shrink: 0;
      }
      .${USAGE_LOCAL_CLASS} {
        flex: 0 0 ${USAGE_LOCAL_PX}px;
        width: ${USAGE_LOCAL_PX}px;
        min-width: ${USAGE_LOCAL_PX}px;
      }
      .${USAGE_FILL_CLASS} { justify-content: flex-end; }
      .${USAGE_FILL_CLASS}[data-cs-col="maxMode"] {
        flex-basis: 64px;
        width: 64px;
        min-width: 64px;
      }
      .cs-pace-wide .dashboard-table-header.cs-pace-model,
      .cs-pace-wide .dashboard-table-cell.cs-pace-model {
        flex: 0 0 ${USAGE_MODEL_MAX_PX}px !important;
        flex-grow: 0 !important;
        flex-shrink: 0 !important;
        width: ${USAGE_MODEL_MAX_PX}px !important;
        max-width: ${USAGE_MODEL_MAX_PX}px !important;
        min-width: ${USAGE_MODEL_MAX_PX}px !important;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dashboard-table-header-row > .${USAGE_LOCAL_CLASS},
      .dashboard-table-header-row > .${USAGE_FILL_CLASS} { height: 40px; }
      .dashboard-table-row > .${USAGE_LOCAL_CLASS},
      .dashboard-table-row > .${USAGE_FILL_CLASS} { height: 44px; }
      .container.cs-pace-shell {
        max-width: none !important;
      }
      .dashboard-table-container.cs-pace-wide {
        min-width: var(--cs-pace-min-width, max-content) !important;
        width: max-content;
      }
      .cs-pace-wide-card,
      .dashboard-table-card:has(.cs-pace-wide) {
        overflow-x: auto;
        overflow-y: visible;
        max-width: none;
        min-width: 100%;
      }
      .cs-pace-wide-scroll,
      .dashboard-table-scroll-container:has(.cs-pace-wide) {
        overflow-x: auto;
        min-width: 0;
      }
      .cs-pace-wide .dashboard-table-header-row,
      .cs-pace-wide .dashboard-table-row {
        min-width: var(--cs-pace-min-width, max-content);
        width: max-content;
      }
      .${BOARD_CLASS} {
        margin: 0 0 16px;
        padding: 14px 16px;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        background: #fff;
        color: #334155;
        font: 12px/1.4 ui-sans-serif, system-ui, sans-serif;
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
        grid-column: 1 / -1;
      }
      .${BOARD_CLASS} .cs-pace-board-head {
        display: flex;
        justify-content: space-between;
        gap: 8px 16px;
        flex-wrap: wrap;
        align-items: baseline;
      }
      .${BOARD_CLASS} .cs-pace-board-head span { color: ${DIM}; }
      .${BOARD_CLASS} .cs-pace-kpis {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        margin: 10px 0;
      }
      @media (min-width: 860px) {
        .${BOARD_CLASS} .cs-pace-kpis {
          grid-template-columns: repeat(4, minmax(0, 1fr));
        }
      }
      .${BOARD_CLASS} .cs-pace-kpi {
        padding: 8px 10px;
        border-radius: 8px;
        background: #f8fafc;
        min-width: 0;
      }
      .${BOARD_CLASS} .cs-pace-kpi b {
        display: block;
        font-size: 16px;
        line-height: 1.25;
        color: #0f172a;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .${BOARD_CLASS} .cs-pace-kpi span { color: ${DIM}; font-size: 11px; }
      .${BOARD_CLASS} .cs-pace-kpis + .cs-pace-kpis {
        margin-top: 0;
      }
      .${BOARD_CLASS} .cs-pace-board-rows {
        display: flex;
        flex-direction: column;
        gap: 5px;
        color: ${DIM};
        font-size: 11px;
        line-height: 1.45;
        margin-top: 10px;
      }
      .${BOARD_CLASS} .cs-pace-tops { margin-top: 10px; }
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
    const data = await postJson("/api/dashboard/get-plan-info", {});
    return data?.planInfo || data;
  }

  async function loadHardLimit() {
    return postJson("/api/dashboard/get-hard-limit", {});
  }

  async function loadPricing() {
    return postJson("/api/dashboard/is-on-new-pricing", {});
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
    const team = cachedTeamId != null && cachedTeamId !== "" && Number(cachedTeamId) !== -1;
    const bodies = team
      ? [{ teamId: cachedTeamId, startDate: startMs, endDate: endMs }]
      : [{ startDate: startMs, endDate: endMs }, { startMs, endMs }];
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
      .replace(/\./g, "")
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
    if (!name || isGrokBotModel(name) || !autoSet.size) return false;
    if (autoSet.has(name)) return true;
    for (const bucket of autoSet) {
      if (sameModelFamily(name, bucket)) return true;
    }
    return false;
  }

  function isOtherPoolModel(name, autoSet) {
    if (!name || isGrokBotModel(name) || !autoSet.size) return false;
    return !isCursorPoolModel(name, autoSet);
  }

  function poolPct(kind, summary, period) {
    const usage = period?.planUsage;
    const plan = summary?.individualUsage?.plan;
    if (kind === "cursor") {
      return (
        pickNumber(usage, ["autoPercentUsed", "auto_percent_used"]) ??
        pickNumber(plan, ["autoPercentUsed", "auto_percent_used"])
      );
    }
    if (kind === "other") {
      return (
        pickNumber(usage, ["apiPercentUsed", "api_percent_used"]) ??
        pickNumber(plan, ["apiPercentUsed", "api_percent_used"])
      );
    }
    if (kind === "grok") {
      return pickNumber(cachedGrok, ["usagePercent", "usage_percent"]);
    }
    return null;
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
      const input = Number(row.inputTokens ?? row.input_tokens) || 0;
      const output = Number(row.outputTokens ?? row.output_tokens) || 0;
      const cacheRead = Number(row.cacheReadTokens ?? row.cache_read_tokens) || 0;
      const cacheWrite = Number(row.cacheWriteTokens ?? row.cache_write_tokens) || 0;
      if (!(cents > 0 || input || output || cacheRead || cacheWrite)) continue;
      const cur = byName.get(name) || {
        cents: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      cur.cents += cents;
      cur.input += input;
      cur.output += output;
      cur.cacheRead += cacheRead;
      cur.cacheWrite += cacheWrite;
      byName.set(name, cur);
    }
    return [...byName.entries()]
      .map(([name, tok]) => ({ name, ...tok }))
      .sort((a, b) => b.cents - a.cents || b.input + b.cacheRead - (a.input + a.cacheRead))
      .slice(0, limit);
  }

  function escapeText(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatTokBits(top) {
    if (!top) return "";
    const bits = [];
    if (top.input) bits.push(`in ${formatCompactTokens(top.input)}`);
    if (top.output) bits.push(`out ${formatCompactTokens(top.output)}`);
    if (top.cacheRead) bits.push(`cr ${formatCompactTokens(top.cacheRead)}`);
    if (top.cacheWrite) bits.push(`cw ${formatCompactTokens(top.cacheWrite)}`);
    return bits.join(" · ");
  }

  function topsMarkup(tops) {
    if (!tops?.length) return "";
    const chips = tops
      .map((top, i) => {
        const bits = formatTokBits(top);
        const money = top.cents > 0 ? formatUsdFromCents(top.cents) : "";
        const em = bits ? `<em>${escapeText(bits)}</em>` : "";
        return `<span class="cs-pace-top"><b>#${i + 1}</b><i>${escapeText(shortModelName(top.name))}</i>${escapeText(money)}${em}</span>`;
      })
      .join("");
    return `<div class="cs-pace-tops">${chips}</div>`;
  }

  function quotaInfo(line, tops, note, amounts) {
    return {
      line,
      tops: tops || [],
      note: note || "",
      usedCents: amounts?.usedCents,
      capCents: amounts?.capCents,
    };
  }

  function capSub(q) {
    if (q?.capCents != null) return `cap ~$${Math.round(q.capCents / 100)}`;
    return "cap n/a";
  }

  function sumMatchingCents(agg, predicate) {
    let cents = 0;
    for (const row of agg?.aggregations || []) {
      if (predicate(rowName(row))) cents += rowCents(row);
    }
    return cents;
  }

  function computedCap(usedCents, pct) {
    if (!(Number.isFinite(pct) && pct > 0 && Number.isFinite(usedCents) && usedCents > 0)) {
      return null;
    }
    return usedCents / (pct / 100);
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
    const raw = computedCap(hit.c, hit.p);
    if (raw == null) return null;
    return {
      line: `${formatUsdFromCents(usedCents)} / ${formatUsdComputed(raw)}`,
      note: `history ${formatSnapTime(hit.t)} ${formatUsdFromCents(hit.c)} ÷ ${formatPct(hit.p, 3)} = ${formatUsdComputed(raw)}; bar now ~100%`,
      usedCents,
      capCents: raw,
    };
  }

  function inferCap(usedCents, pct, label, opts = {}) {
    if (!(Number.isFinite(pct) && pct > 0 && usedCents > 0)) return null;
    const pool = opts.pool || "";
    const windowKey = opts.windowKey || "";
    if (pct >= 99.5) {
      return (
        inferCapFromHistory(pool, windowKey, usedCents, label) || {
          line: `${formatUsdFromCents(usedCents)} used · bar ${formatPct(pct, 2)}`,
          note: `bar is ~100%, spend÷percent collapses, no earlier snapshot in this window`,
          usedCents,
          capCents: null,
        }
      );
    }
    const raw = computedCap(usedCents, pct);
    if (raw == null) return null;
    const drift = snapCapDrift(pool, windowKey);
    return {
      line: `${formatUsdFromCents(usedCents)} / ${formatUsdComputed(raw)}`,
      note: [
        `${formatUsdFromCents(usedCents)} ÷ ${formatPct(pct, 3)} = ${formatUsdComputed(raw)}`,
        drift,
      ]
        .filter(Boolean)
        .join(" · "),
      usedCents,
      capCents: raw,
    };
  }

  function snapCapDrift(pool, windowKey) {
    if (!pool || !windowKey) return "";
    const caps = readMeterSnaps()
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
      .sort((a, b) => b.t - a.t)
      .slice(0, 6)
      .map((s) => computedCap(s.c, s.p))
      .filter((c) => Number.isFinite(c) && c > 0);
    if (caps.length < 2) return "";
    const ranked = [...caps].sort((a, b) => a - b);
    const median = ranked[Math.floor(ranked.length / 2)];
    const maxDev = Math.max(...caps.map((c) => Math.abs(c - median) / median));
    if (!(maxDev > 0.05)) return "";
    return `snapshot cap drift ${formatPct(maxDev * 100, 1)}`;
  }

  function spendAttribution(agg, period) {
    if (!agg) return "";
    const autoSet = autoModelSet(period);
    if (!autoSet.size) return "model buckets unknown";
    const cursor = sumMatchingCents(agg, (name) => isCursorPoolModel(name, autoSet));
    const other = sumMatchingCents(agg, (name) => isOtherPoolModel(name, autoSet));
    const grok = sumMatchingCents(agg, isGrokBotModel);
    const named = cursor + other + grok;
    const total = Number(agg.totalCostCents) || 0;
    if (!(total > 0) || Math.abs(total - named) < 1) return "";
    return `agg ${formatUsdFromCents(total)} vs pools ${formatUsdFromCents(named)}`;
  }

  function captureMeterSnaps(summary, period, agg, grok, grokAgg) {
    const monthKey = monthWindowKey(summary, period);
    const autoSet = autoModelSet(period);
    if (monthKey && agg && cachedAggWindow === monthKey && autoSet.size) {
      const autoPct = poolPct("cursor", summary, period);
      const apiPct = poolPct("other", summary, period);
      const cursorCents = sumMatchingCents(agg, (name) => isCursorPoolModel(name, autoSet));
      const otherCents = sumMatchingCents(agg, (name) => isOtherPoolModel(name, autoSet));
      if (autoPct != null) pushMeterSnap("cursor", monthKey, cursorCents, autoPct);
      if (apiPct != null) pushMeterSnap("other", monthKey, otherCents, apiPct);
    }
    const gKey = grokWindowKey(grok);
    if (grok && grokAgg && gKey && cachedGrokAggWindow === gKey) {
      const gPct = poolPct("grok", summary, period);
      const gCents = sumMatchingCents(grokAgg, isGrokBotModel);
      if (gPct != null) pushMeterSnap("grok", gKey, gCents, gPct);
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
    if (!autoSet.size) {
      return quotaInfo("model buckets unknown", [], "autoBucketModels missing");
    }
    const tops = topSpenders(agg, (name) => isCursorPoolModel(name, autoSet));
    const pct = poolPct("cursor", summary, period);
    const usedCents = sumMatchingCents(agg, (name) => isCursorPoolModel(name, autoSet));
    const inferred = inferCap(usedCents, pct, "Cursor Models cap", {
      pool: "cursor",
      windowKey: monthWindowKey(summary, period),
    });
    if (inferred) return quotaInfo(inferred.line, tops, inferred.note, inferred);
    return quotaInfo("Cursor Models cap omitted by API", tops, "", { usedCents });
  }

  function otherModelsQuotaLine(period, summary, agg) {
    const autoSet = autoModelSet(period);
    if (!autoSet.size) {
      return quotaInfo("model buckets unknown", [], "autoBucketModels missing");
    }
    const tops = topSpenders(agg, (name) => isOtherPoolModel(name, autoSet));
    const pct = poolPct("other", summary, period);
    const usedCents = sumMatchingCents(agg, (name) => isOtherPoolModel(name, autoSet));
    const inferred = inferCap(usedCents, pct, "Other Models cap", {
      pool: "other",
      windowKey: monthWindowKey(summary, period),
    });
    if (inferred) return quotaInfo(inferred.line, tops, inferred.note, inferred);
    return quotaInfo("Other Models cap omitted by API", tops, "", { usedCents });
  }

  function grokQuotaLine(grok, grokAgg) {
    const tops = topSpenders(grokAgg, isGrokBotModel);
    const pct = poolPct("grok", cachedSummary, cachedPeriod);
    const usedCents = sumMatchingCents(grokAgg, isGrokBotModel);
    const inferred = inferCap(usedCents, pct, "Grok weekly cap", {
      pool: "grok",
      windowKey: grokWindowKey(grok),
    });
    let line =
      grok?.hasNonZeroIncludedLimit || grok?.has_non_zero_included_limit
        ? "Grok included limit exists, cap omitted by API"
        : "Grok weekly cap omitted by API";
    let note = "";
    if (inferred) {
      line = inferred.line;
      note = inferred.note;
    }
    return quotaInfo(line, tops, note, inferred || { usedCents });
  }

  function parseUsedFromFill(fill) {
    const style = fill?.getAttribute?.("style") || "";
    const m = style.match(/width:\s*([\d.]+)%/);
    if (m) return Number(m[1]);
    return null;
  }

  function poolUsed(kind, summary, period, fill) {
    return poolPct(kind, summary, period) ?? parseUsedFromFill(fill) ?? 0;
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

  function tokenMix(agg) {
    if (!agg) return null;
    return {
      input: Number(agg.totalInputTokens) || 0,
      output: Number(agg.totalOutputTokens) || 0,
      cacheRead: Number(agg.totalCacheReadTokens) || 0,
      cacheWrite: Number(agg.totalCacheWriteTokens) || 0,
      listCents: Number(agg.totalCostCents) || 0,
    };
  }

  function mixStats(agg) {
    const mix = tokenMix(agg);
    if (!mix) return null;
    const total = mix.input + mix.output + mix.cacheRead + mix.cacheWrite;
    const prompt = mix.input + mix.cacheRead;
    return {
      ...mix,
      total,
      prompt,
      promptCache: prompt > 0 ? mix.cacheRead / prompt : null,
      outPerIn: mix.input > 0 ? mix.output / mix.input : null,
    };
  }

  function formatShare(part, total) {
    if (!(total > 0) || !Number.isFinite(part)) return "";
    const pct = (part / total) * 100;
    if (pct > 0 && pct < 0.1) return "<0.1%";
    return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
  }

  function mixKpiBlock(stats) {
    if (!stats) return "";
    const sub = (n) => {
      const share = formatShare(n, stats.total);
      return share ? `${share} of tokens` : "";
    };
    return (
      kpiMarkup("Input", formatCompactTokens(stats.input), sub(stats.input)) +
      kpiMarkup("Output", formatCompactTokens(stats.output), sub(stats.output)) +
      kpiMarkup("Cache read", formatCompactTokens(stats.cacheRead), sub(stats.cacheRead)) +
      kpiMarkup("Cache write", formatCompactTokens(stats.cacheWrite), sub(stats.cacheWrite))
    );
  }

  function mixInsightLine(stats, eventCount, listCents) {
    if (!stats) return "";
    const bits = [];
    if (stats.total) bits.push(`${formatCompactTokens(stats.total)} tokens`);
    if (stats.promptCache != null) {
      bits.push(`prompt cache ${formatShare(stats.cacheRead, stats.prompt)}`);
    }
    if (stats.outPerIn != null) bits.push(`out/in ${stats.outPerIn.toFixed(2)}`);
    if (eventCount != null) bits.push(`${formatCount(eventCount)} events`);
    if (eventCount > 0 && listCents != null) {
      bits.push(`${formatUsdComputed(listCents / eventCount)}/event`);
    }
    return bits.join(" · ");
  }

  function kpiMoney(cents) {
    return cents == null ? "n/a" : formatUsdFromCents(cents);
  }

  function rangeSpend(agg, period) {
    if (!agg) {
      return { listCents: null, cursorCents: null, otherCents: null, grokCents: null };
    }
    const autoSet = autoModelSet(period);
    const list = Number(agg.totalCostCents);
    return {
      listCents: Number.isFinite(list) ? list : null,
      cursorCents: autoSet.size
        ? sumMatchingCents(agg, (name) => isCursorPoolModel(name, autoSet))
        : null,
      otherCents: autoSet.size
        ? sumMatchingCents(agg, (name) => isOtherPoolModel(name, autoSet))
        : null,
      grokCents: sumMatchingCents(agg, isGrokBotModel),
    };
  }

  function findExactLabel(text) {
    const nodes = document.querySelectorAll("div,p,span,h2,h3");
    for (const el of nodes) {
      if (el.childElementCount > 0) continue;
      if (el.closest(`.${BOARD_CLASS}, [role='cell'], [role='row'], [role='columnheader']`)) {
        continue;
      }
      if ((el.textContent || "").replace(/\s+/g, " ").trim() === text) return el;
    }
    return null;
  }

  function usageViewWindow() {
    const params = new URLSearchParams(location.search);
    const from = params.get("from");
    const to = params.get("to");
    if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return {
        startMs: Date.parse(`${from}T00:00:00.000Z`),
        endMs: Date.parse(`${to}T23:59:59.999Z`),
        label: `${from} → ${to} UTC`,
      };
    }
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /[A-Za-z]{3}\s+\d{1,2}\s*[-–]\s*[A-Za-z]{3}\s+\d{1,2}/.test((b.textContent || "").trim()),
    );
    if (btn) {
      const m = (btn.textContent || "").match(
        /([A-Za-z]{3})\s+(\d{1,2})\s*[-–]\s*([A-Za-z]{3})\s+(\d{1,2})/,
      );
      if (m) {
        const year = new Date().getUTCFullYear();
        const startMs = Date.parse(`${m[1]} ${m[2]}, ${year} UTC`);
        const endMs = Date.parse(`${m[3]} ${m[4]}, ${year} 23:59:59 UTC`);
        if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
          return { startMs, endMs, label: `${m[1]} ${m[2]} – ${m[3]} ${m[4]} UTC` };
        }
      }
    }
    const now = new Date();
    const today0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return {
      startMs: today0 - 6 * 86400000,
      endMs: today0 + 86400000 - 1,
      label: "last 7 days UTC",
    };
  }

  function sameUtcDay(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) < 86400000;
  }

  function buildBoardModel(nowMs) {
    const usage = cachedPeriod?.planUsage || {};
    const plan = cachedSummary?.individualUsage?.plan || {};
    const onDemand = cachedSummary?.individualUsage?.onDemand || {};
    const planInfo = cachedPlanInfo || {};
    const { startMs, endMs } = cycleWindow(cachedSummary, cachedPeriod);
    const usedCents =
      pickNumber(usage, ["includedSpend"]) ?? pickNumber(plan, ["includedSpend"]);
    const apiPct =
      pickNumber(usage, ["totalPercentUsed", "total_percent_used"]) ??
      pickNumber(plan, ["totalPercentUsed", "total_percent_used"]);
    const grokResetMs = parseTime(
      cachedGrok?.nextResetTimestampUtc || cachedGrok?.next_reset_timestamp_utc,
    );
    const noUsageBased = cachedHardLimit?.noUsageBasedAllowed === true;
    const viewWin = isUsagePath() ? usageViewWindow() : null;
    const spend = viewWin ? rangeSpend(cachedViewAgg, cachedPeriod) : null;
    return {
      planName: planInfo.planName || cachedGrok?.cursorPlanName || "",
      planPrice: planInfo.price || "",
      newPricing: cachedPricing?.isOnNewPricing ?? null,
      autoSpillover: cachedPricing?.hasAutoSpillover ?? null,
      usageBasedAllowed: noUsageBased ? false : cachedHardLimit ? true : null,
      included: {
        usedCents,
        apiPct,
      },
      cursorPct: poolPct("cursor", cachedSummary, cachedPeriod),
      otherPct: poolPct("other", cachedSummary, cachedPeriod),
      grokPct: poolPct("grok", cachedSummary, cachedPeriod),
      grokResetMs,
      cycle: {
        startMs,
        endMs,
        pacePct: pacePercent(startMs, endMs, nowMs),
      },
      cycleTokens: mixStats(cachedAgg),
      view: viewWin
        ? {
            label: viewWin.label,
            mix: mixStats(cachedViewAgg),
            eventCount: cachedUsageEventCount,
            alignsWithCycle:
              sameUtcDay(viewWin.startMs, startMs) && sameUtcDay(viewWin.endMs, endMs),
            listCents: spend.listCents,
            cursorCents: spend.cursorCents,
            otherCents: spend.otherCents,
            grokCents: spend.grokCents,
          }
        : null,
      tops: topSpenders(viewWin ? cachedViewAgg : cachedAgg, () => true, 5),
      onDemandEnabled: onDemand.enabled === true,
      onDemandUsedCents: pickNumber(onDemand, ["used"]) ?? 0,
    };
  }

  function boardSignature(model) {
    return JSON.stringify(model);
  }

  function metricRowHost() {
    const a = findExactLabel("Total tokens");
    if (!a) return null;
    const b = findExactLabel("On-demand") || findExactLabel("Included");
    if (!b) return a.parentElement || a;
    let el = a;
    for (let i = 0; i < 8 && el.parentElement; i += 1) {
      el = el.parentElement;
      if (el.contains(b)) return el;
    }
    return a.parentElement || a;
  }

  function findBoardAnchor() {
    const included = document.getElementById("included-in-ultra");
    if (included) return included;
    const row = metricRowHost();
    if (row) return row;
    return document.querySelector(".dashboard-table-card");
  }

  function kpiMarkup(label, big, sub) {
    const subHtml = sub ? `<i>${escapeText(sub)}</i>` : "";
    return `<div class="cs-pace-kpi"><span>${escapeText(label)}</span><b>${escapeText(big)}</b>${subHtml}</div>`;
  }

  function renderBoard(nowMs) {
    const host = findBoardAnchor();
    if (!host) return;
    const model = buildBoardModel(nowMs);
    const sig = boardSignature(model);
    let board = document.querySelector(`.${BOARD_CLASS}`);
    if (!board) {
      board = document.createElement("div");
      board.className = BOARD_CLASS;
      host.before(board);
    } else if (board.nextElementSibling !== host) {
      host.before(board);
    }
    if (board.dataset.csSig === sig) return;
    board.dataset.csSig = sig;

    const inc = model.included;
    let includedSub = "";
    if (inc.apiPct != null && inc.apiPct > 0 && inc.apiPct < 99.5) {
      includedSub = `${formatPct(inc.apiPct, 2)} used`;
    } else if (inc.apiPct != null && inc.apiPct >= 99.5 && inc.usedCents != null) {
      includedSub = `bar ${formatPct(inc.apiPct, 2)}`;
    }
    const headBits = [
      model.planName,
      model.planPrice,
      model.autoSpillover === true ? "spillover on" : model.autoSpillover === false ? "spillover off" : "",
      model.newPricing === true ? "new pricing" : "",
      tzLabel(),
    ].filter(Boolean);
    const grokSub = Number.isFinite(model.grokResetMs)
      ? `resets ${formatLocalDate(model.grokResetMs, true).slice(5, 16)}`
      : "";
    const onDemandLine = model.usageBasedAllowed === false
      ? `on-demand blocked · ${formatUsdFromCents(model.onDemandUsedCents)}`
      : `on-demand ${model.onDemandEnabled ? "on" : "off"} · ${formatUsdFromCents(model.onDemandUsedCents)}`;
    const cycleLeft =
      Number.isFinite(model.cycle.endMs) ? ` · ${formatRest(model.cycle.endMs - nowMs)} left` : "";
    const cycleLine =
      Number.isFinite(model.cycle.startMs) && Number.isFinite(model.cycle.endMs)
        ? `cycle ${formatLocalDate(model.cycle.startMs, true).slice(5, 16)} → ${formatLocalDate(model.cycle.endMs, true).slice(5, 16)}${model.cycle.pacePct != null ? ` · pace ${formatPct(model.cycle.pacePct, 2)}` : ""}${cycleLeft}`
        : "";
    const rangeMode = Boolean(model.view);
    const stats = rangeMode ? model.view.mix : model.cycleTokens;
    const insight = mixInsightLine(
      stats,
      rangeMode ? model.view.eventCount : null,
      rangeMode ? model.view.listCents : stats?.listCents,
    );
    const rows = rangeMode
      ? [
          `range ${model.view.label}`,
          insight,
          cycleLine,
          spendAttribution(cachedViewAgg, cachedPeriod),
          onDemandLine,
        ]
      : [
          cycleLine,
          insight,
          spendAttribution(cachedAgg, cachedPeriod),
          onDemandLine,
        ];
    const moneyKpis = rangeMode
      ? kpiMarkup("List", kpiMoney(model.view.listCents), model.view.label) +
        kpiMarkup("Cursor Models", kpiMoney(model.view.cursorCents), "list in range") +
        kpiMarkup("Other Models", kpiMoney(model.view.otherCents), "list in range") +
        kpiMarkup("Grok Bot", kpiMoney(model.view.grokCents), "list in range")
      : kpiMarkup(
          "Included usage",
          inc.usedCents != null ? formatUsdFromCents(inc.usedCents) : "n/a",
          includedSub,
        ) +
        kpiMarkup(
          "Cursor Models",
          model.cursorPct != null ? formatPct(model.cursorPct, 2) : "n/a",
          capSub(cursorModelsQuotaLine(cachedPeriod, cachedAgg, cachedSummary)),
        ) +
        kpiMarkup(
          "Other Models",
          model.otherPct != null ? formatPct(model.otherPct, 2) : "n/a",
          capSub(otherModelsQuotaLine(cachedPeriod, cachedSummary, cachedAgg)),
        ) +
        kpiMarkup(
          "Grok week",
          model.grokPct != null ? formatPct(model.grokPct, 2) : "n/a",
          grokSub,
        );
    const mixKpis = mixKpiBlock(stats);
    board.innerHTML =
      `<div class="cs-pace-board-head"><b>Spend Pace</b><span>${escapeText(headBits.join(" · "))}</span></div>` +
      `<div class="cs-pace-kpis">${moneyKpis}</div>` +
      (mixKpis ? `<div class="cs-pace-kpis">${mixKpis}</div>` : "") +
      `<div class="cs-pace-board-rows">${rows.filter(Boolean).map((row) => `<div>${escapeText(row)}</div>`).join("")}</div>` +
      topsMarkup(model.tops);
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
      enhanceUsageTable();
      renderBoard(now);
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
        loadPlanInfo()
          .then((data) => {
            cachedPlanInfo = data;
          })
          .catch((err) => swallow("plan-info", err)),
        loadHardLimit()
          .then((data) => {
            cachedHardLimit = data;
          })
          .catch((err) => swallow("hard-limit", err)),
        loadPricing()
          .then((data) => {
            cachedPricing = data;
          })
          .catch((err) => swallow("new-pricing", err)),
      ];
      await Promise.all(tasks);

      if (isUsagePath()) {
        const view = usageViewWindow();
        const viewKey = viewWindowKey(view);
        if (cachedUsageEventsWindow !== viewKey) {
          cachedUsageEvents = [];
          cachedUsageEventCount = null;
          cachedUsageEventsWindow = viewKey;
        }
        try {
          const data = await postJson(
            "/api/dashboard/get-filtered-usage-events",
            usageRangeBody(),
          );
          cachedUsageEvents = extractUsageEvents(data);
        } catch (err) {
          swallow("filtered-usage", err);
        }
      }

      const month = cycleWindow(cachedSummary, cachedPeriod);
      const monthKey = monthWindowKey(cachedSummary, cachedPeriod);
      if (Number.isFinite(month.startMs) && Number.isFinite(month.endMs)) {
        try {
          cachedAgg = await loadAgg(month.startMs, month.endMs);
          cachedAggWindow = monthKey;
        } catch (err) {
          cachedAgg = null;
          cachedAggWindow = "";
          swallow("month-agg", err);
        }
      } else {
        cachedAgg = null;
        cachedAggWindow = "";
      }
      if (isUsagePath()) {
        const view = usageViewWindow();
        const viewKey = viewWindowKey(view);
        if (Number.isFinite(view.startMs) && Number.isFinite(view.endMs)) {
          try {
            cachedViewAgg = await loadAgg(view.startMs, view.endMs);
            cachedViewAggWindow = viewKey;
          } catch (err) {
            cachedViewAgg = null;
            cachedViewAggWindow = "";
            swallow("view-agg", err);
          }
        } else {
          cachedViewAgg = null;
          cachedViewAggWindow = "";
        }
      } else {
        cachedViewAgg = null;
        cachedViewAggWindow = "";
      }
      if (cachedGrok) {
        const grokStart = parseTime(cachedGrok.currentPeriodStart || cachedGrok.current_period_start);
        const grokEnd = parseTime(
          cachedGrok.nextResetTimestampUtc || cachedGrok.next_reset_timestamp_utc,
        );
        const gKey = grokWindowKey(cachedGrok);
        if (Number.isFinite(grokStart) && Number.isFinite(grokEnd)) {
          try {
            cachedGrokAgg = await loadAgg(grokStart, grokEnd);
            cachedGrokAggWindow = gKey;
          } catch (err) {
            cachedGrokAgg = null;
            cachedGrokAggWindow = "";
            swallow("grok-agg", err);
          }
        } else {
          cachedGrokAgg = null;
          cachedGrokAggWindow = "";
        }
      } else {
        cachedGrokAgg = null;
        cachedGrokAggWindow = "";
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
      hookUsageFetch();
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
    if (cachedSummary || cachedGrok || cachedPeriod || cachedUsageEvents.length || isUsagePath()) {
      requestRender();
    } else {
      scheduleFetch(false);
    }
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

  hookUsageFetch();
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
