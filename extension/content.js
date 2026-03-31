/* ═══════════════════════════════════════════════════════════════════════
   OCPS Repair Validator — Content Script (Standalone)
   Injected on Odoo repair pages. Reads the repair ID from the URL,
   validates directly via Odoo JSON-RPC (no dashboard needed), shows
   a floating validation panel, and hides the End Repair button when
   errors are present.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  const PANEL_ID = "ocps-validator-panel";
  const POLL_INTERVAL = 8000;
  const DEBOUNCE_MS = 1200;

  let currentRepairId = null;
  let debounceTimer = null;

  /* ── Helpers ─────────────────────────────────────────────────────── */

  function getRepairIdFromUrl() {
    const matches = [...window.location.pathname.matchAll(/\/repairs\/(\d+)/g)];
    if (!matches.length) return null;
    return parseInt(matches[matches.length - 1][1], 10);
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  /* ── End Repair button management ─────────────────────────────── */

  function findEndRepairButtons() {
    const buttons = [];
    document.querySelectorAll("button").forEach((btn) => {
      const name = btn.getAttribute("name") || "";
      const text = (btn.textContent || "").trim().toLowerCase();
      if (
        name === "action_repair_end" ||
        text === "end repair" ||
        text === "end" ||
        name === "action_end_repair"
      ) {
        buttons.push(btn);
      }
    });
    document.querySelectorAll('.o_statusbar_buttons button, .oe_button_box button, .o_form_statusbar button').forEach((btn) => {
      const text = (btn.textContent || "").trim().toLowerCase();
      if (text === "end repair" || text === "end") {
        if (!buttons.includes(btn)) buttons.push(btn);
      }
    });
    return buttons;
  }

  function setEndRepairHidden(hide, errorCount) {
    const buttons = findEndRepairButtons();
    buttons.forEach((btn) => {
      if (hide) {
        btn.style.setProperty("display", "none", "important");
        btn.dataset.ocpsHidden = "1";
        if (!btn.parentElement.querySelector(".ocps-blocked-msg")) {
          const msg = document.createElement("span");
          msg.className = "ocps-blocked-msg";
          msg.textContent = `⛔ End Repair blocked (${errorCount} error${errorCount !== 1 ? "s" : ""})`;
          msg.style.cssText =
            "color:#ef4444;font-size:12px;font-weight:600;padding:4px 10px;display:inline-flex;align-items:center;gap:4px;";
          btn.parentElement.insertBefore(msg, btn.nextSibling);
        }
      } else {
        btn.style.removeProperty("display");
        delete btn.dataset.ocpsHidden;
        const msg = btn.parentElement.querySelector(".ocps-blocked-msg");
        if (msg) msg.remove();
      }
    });
  }

  /* ── Create Quotation button management ──────────────────────── */

  function findCreateQuotationButtons() {
    const buttons = [];
    document.querySelectorAll("button").forEach((btn) => {
      const name = btn.getAttribute("name") || "";
      const text = (btn.textContent || "").trim().toLowerCase();
      if (
        name === "action_create_sale_order" ||
        name === "action_quotation_create" ||
        text === "create quotation" ||
        text === "create quote"
      ) {
        buttons.push(btn);
      }
    });
    return buttons;
  }

  function setCreateQuotationHidden(hide) {
    const buttons = findCreateQuotationButtons();
    buttons.forEach((btn) => {
      if (hide) {
        btn.style.setProperty("display", "none", "important");
        btn.dataset.ocpsChsHidden = "1";
        if (!btn.parentElement.querySelector(".ocps-chs-msg")) {
          const msg = document.createElement("span");
          msg.className = "ocps-chs-msg";
          msg.textContent = "Quotation Disabled";
          msg.style.cssText =
            "color:#ef4444;font-size:12px;font-weight:600;padding:4px 10px;display:inline-flex;align-items:center;gap:4px;";
          btn.parentElement.insertBefore(msg, btn.nextSibling);
        }
      } else {
        btn.style.removeProperty("display");
        delete btn.dataset.ocpsChsHidden;
        const msg = btn.parentElement.querySelector(".ocps-chs-msg");
        if (msg) msg.remove();
      }
    });
  }

  /* ── Panel rendering ──────────────────────────────────────────── */

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      // Best position: directly above the form sheet, below the action buttons
      const sheet = document.querySelector(".o_form_sheet");
      if (sheet && sheet.parentElement) {
        sheet.parentElement.insertBefore(panel, sheet);
      } else {
        const view = document.querySelector(".o_form_view") || document.body;
        view.prepend(panel);
      }
    }
    return panel;
  }

  function renderLoading(repairId) {
    const panel = ensurePanel();
    panel.className = "ocps-loading";
    panel.classList.remove("ocps-hidden");
    panel.innerHTML = `
      <div class="ocps-summary">
        <span class="ocps-status-badge"><span class="ocps-spinner"></span> Validating…</span>
      </div>`;
  }

  function renderResult(data) {
    const panel = ensurePanel();
    panel.classList.remove("ocps-hidden");
    const errs = (data.errors || []).filter((e) => e.severity === "error");
    const warns = (data.errors || []).filter((e) => e.severity === "warning");
    const errorCount = errs.length;
    const warnCount = warns.length;
    const isClean = errorCount === 0 && warnCount === 0;

    const statusCls = errorCount > 0 ? "ocps-error" : warnCount > 0 ? "ocps-warn" : "ocps-clean";
    const statusIcon = errorCount > 0 ? "❌" : warnCount > 0 ? "⚠️" : "✅";
    const statusText = errorCount > 0
      ? `${errorCount} Error${errorCount !== 1 ? "s" : ""}${warnCount ? `, ${warnCount} Warning${warnCount !== 1 ? "s" : ""}` : ""}`
      : warnCount > 0
        ? `${warnCount} Warning${warnCount !== 1 ? "s" : ""}`
        : "All Checks Passed";

    // Ticket info
    let ticketHtml = "";
    if (data.ticket_name || data.ticket_stage) {
      ticketHtml = `<div class="ocps-ticket">`;
      if (data.ticket_name) ticketHtml += `<span>🎫 Ticket: <strong>${esc(data.ticket_name)}</strong></span>`;
      if (data.ticket_stage) ticketHtml += `<span>Stage: <strong>${esc(data.ticket_stage)}</strong></span>`;
      ticketHtml += `</div>`;
    }

    // Parts summary
    let partsHtml = "";
    if (data.parts && data.parts.length) {
      const iw = data.parts.filter(p => (p.warranty_type || "").toUpperCase() === "IW").length;
      const oow = data.parts.filter(p => (p.warranty_type || "").toUpperCase() === "OOW").length;
      const ber = data.parts.filter(p => (p.warranty_type || "").toUpperCase() === "BER").length;
      partsHtml = `<div class="ocps-parts-summary">
        <span>Parts: ${data.parts.length}</span>
        ${iw ? `<span class="ocps-badge ocps-iw">IW ${iw}</span>` : ""}
        ${oow ? `<span class="ocps-badge ocps-oow">OOW ${oow}</span>` : ""}
        ${ber ? `<span class="ocps-badge ocps-ber">BER ${ber}</span>` : ""}
      </div>`;
    }

    // Issue list
    let issuesHtml = "";
    if (!isClean) {
      issuesHtml = `<ul class="ocps-issues">`;
      errs.forEach((e) => {
        issuesHtml += `<li class="ocps-issue-err"><span class="ocps-cat">${esc(e.category)}</span> ${esc(e.message)}</li>`;
      });
      warns.forEach((e) => {
        issuesHtml += `<li class="ocps-issue-warn"><span class="ocps-cat">${esc(e.category)}</span> ${esc(e.message)}</li>`;
      });
      issuesHtml += `</ul>`;
    }

    // Unconsumed parts detail.
    // Reliable check: move state === 'done' means consumed (Odoo zeroes qty after completion).
    // For under_repair also show qty-based mismatches while the move is still in progress.
    let partsDetailHtml = "";
    if (data.parts && data.parts.length && ["under_repair", "done"].includes(data.state)) {
      const unconsumed = data.parts.filter(p => {
        const moveStateDone = (p.state || "").toLowerCase() === "done";
        if (moveStateDone) return false;
        if (data.state === "under_repair") return p.done < p.demand;
        return true; // done repair + move not in done state = truly unconsumed
      });
      if (unconsumed.length) {
        partsDetailHtml = `<div class="ocps-parts-detail">
          <strong>Unconsumed Parts:</strong>
          <ul>${unconsumed.map(p => `<li>${esc(p.product_name)} — demand: ${p.demand}, done: ${p.done}</li>`).join("")}</ul>
        </div>`;
      }
    }

    const pillCls = errorCount > 0 ? "ocps-error" : warnCount > 0 ? "ocps-warn" : "ocps-clean";
    panel.className = pillCls;
    // Auto-expand when there are issues
    if (errorCount > 0 || warnCount > 0) panel.classList.remove("ocps-collapsed");
    else panel.classList.add("ocps-collapsed");

    panel.innerHTML = `
      <div class="ocps-summary">
        <span class="ocps-status-badge">${statusIcon} ${statusText}</span>
        <span class="ocps-summary-meta">${esc(data.name || "")} &nbsp;|&nbsp; ${esc(data.state || "")} &nbsp;|&nbsp; ${esc(data.lot_name || "—")} &nbsp;|&nbsp; ${esc(data.device_location || "—")}</span>
        <div class="ocps-summary-actions">
          <button class="ocps-btn-icon ocps-refresh" title="Re-validate">🔄</button>
          <button class="ocps-btn-icon ocps-toggle" title="Toggle details">${panel.classList.contains("ocps-collapsed") ? "▸" : "▾"}</button>
        </div>
      </div>
      <div class="ocps-body">
        ${ticketHtml}
        ${partsHtml}
        ${issuesHtml}
        ${partsDetailHtml}
      </div>`;

    panel.querySelector(".ocps-summary").onclick = (e) => {
      if (!e.target.closest(".ocps-summary-actions")) {
        panel.classList.toggle("ocps-collapsed");
        const btn = panel.querySelector(".ocps-toggle");
        if (btn) btn.textContent = panel.classList.contains("ocps-collapsed") ? "▸" : "▾";
      }
    };

    // Wire buttons
    panel.querySelector(".ocps-toggle").onclick = (e) => {
      e.stopPropagation();
      panel.classList.toggle("ocps-collapsed");
      panel.querySelector(".ocps-toggle").textContent =
        panel.classList.contains("ocps-collapsed") ? "▸" : "▾";
    };
    panel.querySelector(".ocps-refresh").onclick = (e) => {
      e.stopPropagation();
      const rid = getRepairIdFromUrl();
      if (rid) runValidation(rid);
    };

    // Hide/show End Repair button based on errors
    setEndRepairHidden(errorCount > 0, errorCount);

    // Hide Create Quotation if coverage is CHS
    const isChs = (data.coverage_type || "").toLowerCase().includes("chs");
    setCreateQuotationHidden(isChs);

    // Apply admin UI control overrides (runs last so it layers on top of validator decisions)
    applyUiControls();

    // Blocked serial check
    if (data.lot_name && checkSerialBlocked(data.lot_name)) {
      showBlockedSerialModal(data.lot_name);
    }
  }

  function renderError(repairId, message) {
    const panel = ensurePanel();
    panel.classList.remove("ocps-hidden");
    panel.className = "ocps-error";
    panel.innerHTML = `
      <div class="ocps-summary">
        <span class="ocps-status-badge">⚡ Connection Error</span>
        <div class="ocps-summary-actions">
          <button class="ocps-btn-icon ocps-retry-inline" title="Retry">🔄</button>
        </div>
      </div>
      <div class="ocps-body">
        <p class="ocps-err-msg">${esc(message)}</p>
        <button class="ocps-retry-btn">Retry</button>
      </div>`;
    panel.querySelector(".ocps-retry-btn").onclick = () => { const rid = getRepairIdFromUrl(); if (rid) runValidation(rid); };
    panel.querySelector(".ocps-retry-inline").onclick = () => { const rid = getRepairIdFromUrl(); if (rid) runValidation(rid); };
    panel.querySelector(".ocps-summary").onclick = (e) => {
      if (!e.target.closest(".ocps-summary-actions")) panel.classList.toggle("ocps-collapsed");
    };
  }

  /* ── Validation driver ────────────────────────────────────────── */

  async function runValidation(repairId) {
    renderLoading(repairId);
    await loadBlockedSerials(); // always fetch fresh list before checking
    try {
      const result = await Validator.validateRepair(repairId);
      renderResult(result);
    } catch (err) {
      console.error("[OCPS] Validation failed:", err);
      renderError(repairId, err.message || "Validation failed — see console");
    }
  }

  /* ── URL monitoring ───────────────────────────────────────────── */

  function checkForRepairPage() {
    const rid = getRepairIdFromUrl();
    if (rid && rid !== currentRepairId) {
      currentRepairId = rid;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runValidation(rid), DEBOUNCE_MS);
    } else if (!rid) {
      currentRepairId = null;
      const panel = document.getElementById(PANEL_ID);
      if (panel) panel.classList.add("ocps-hidden");
      setEndRepairHidden(false, 0);
      setCreateQuotationHidden(false);
    }
  }

  // Odoo is a SPA — watch for URL changes.
  // Use the native Navigation API (Chrome 102+) when available — it fires once per
  // actual navigation and cannot be silently overwritten by Odoo's own router patches.
  // Fall back to monkey-patching history for older Chrome builds.
  if (typeof navigation !== "undefined" && navigation.addEventListener) {
    navigation.addEventListener("navigate", checkForRepairPage);
  } else {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      checkForRepairPage();
    };
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      checkForRepairPage();
    };
  }
  window.addEventListener("popstate", checkForRepairPage);
  window.addEventListener("hashchange", checkForRepairPage);

  // MutationObserver to catch Odoo's internal navigation
  const observer = new MutationObserver(() => {
    checkForRepairPage();
    // Re-enforce End Repair visibility after DOM mutations
    if (currentRepairId) {
      const panel = document.getElementById(PANEL_ID);
      if (panel && panel.classList.contains("ocps-error")) {
        const errCount = panel.querySelectorAll(".ocps-issue-err").length;
        if (errCount > 0) setEndRepairHidden(true, errCount);
      }
      // Re-apply admin UI controls after Odoo re-renders parts of the page
      applyUiControls();
    }
  });

  /* ── Announcements & Blocked Serials ────────────────────────── */

  const ANNOUNCE_URL      = "http://10.56.65.139:3131/api/announcements";
  const BLOCKED_URL        = "http://10.56.65.139:3131/api/blocked";
  const UI_CONTROLS_URL    = "http://10.56.65.139:3131/api/ui-controls";
  const ANNOUNCE_INTERVAL  = 60000;

  let cachedBlockedSerials = [];
  let cachedUiControls     = {};

  // ── UI Controls ──────────────────────────────────────────────────────────

  // Element finders keyed by control ID (must match catalog in admin.html)
  const CONTROL_DEFS = {
    btn_create_quotation: () => [...document.querySelectorAll(
      'button[name="action_create_sale_order"], button[name="action_quotation_create"]')],
    btn_quality_alert:    () => [...document.querySelectorAll('button[name="action_quality_alert"]')],
    btn_create_rework:    () => [...document.querySelectorAll(
      'button[name="action_create_repair_rework"], button[name="action_repair_rework"], button[name="action_rework"]')],
    stat_product_moves:   () => [...document.querySelectorAll('.o_stat_button[name="product_move"]')],
    stat_quality_checks:  () => [...document.querySelectorAll('.o_stat_button[name="quality_check_ids"]')],
    stat_sale_order:      () => [...document.querySelectorAll('.o_stat_button[name="sale_order"]')],
    tab_repair_notes:     () => [...document.querySelectorAll('.o_notebook .nav-link')]
      .filter(el => el.textContent.trim() === "Repair Notes")
      .map(el => el.closest('.nav-item') || el),
    tab_miscellaneous:    () => [...document.querySelectorAll('.o_notebook .nav-link')]
      .filter(el => el.textContent.trim() === "Miscellaneous")
      .map(el => el.closest('.nav-item') || el),
    tab_rework_info:      () => [...document.querySelectorAll('.o_notebook .nav-link')]
      .filter(el => el.textContent.trim() === "Rework Info")
      .map(el => el.closest('.nav-item') || el),
  };

  async function loadUiControls() {
    try {
      const resp = await fetch(UI_CONTROLS_URL + "?_=" + Date.now());
      if (!resp.ok) return;
      const data = await resp.json();
      cachedUiControls = data.controls || {};
      applyUiControls();
    } catch { /* silent */ }
  }

  function applyUiControls() {
    if (!currentRepairId) return;
    // Restore previously controlled elements (CSS class approach — no conflict with validator's inline styles)
    document.querySelectorAll('.ocps-ui-hidden').forEach(el => el.classList.remove('ocps-ui-hidden'));
    document.querySelectorAll('.ocps-ui-disabled').forEach(el => el.classList.remove('ocps-ui-disabled'));
    // Apply active controls
    Object.entries(cachedUiControls).forEach(([id, ctrl]) => {
      if (!ctrl.enabled) return;
      const finder = CONTROL_DEFS[id];
      if (!finder) return;
      finder().forEach(el => {
        el.classList.add(ctrl.action === "disable" ? "ocps-ui-disabled" : "ocps-ui-hidden");
      });
    });
  }

  async function loadBlockedSerials() {
    try {
      const resp = await fetch(BLOCKED_URL + "?_=" + Date.now());
      if (!resp.ok) return;
      const data = await resp.json();
      cachedBlockedSerials = (data.blocked || []).map(b => (b.serial || "").trim().toLowerCase());
    } catch { /* silent */ }
  }

  function checkSerialBlocked(serial) {
    if (!serial) return false;
    return cachedBlockedSerials.includes(serial.trim().toLowerCase());
  }

  function showBlockedSerialModal(serial) {
    const existing = document.getElementById("ocps-blocked-modal");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.id = "ocps-blocked-modal";
    overlay.innerHTML = `
      <div class="ocps-modal-box ocps-modal-urgent">
        <div class="ocps-modal-titlebar">
          <span class="ocps-modal-titlebar-text">&#9888;&#65039; Device Flagged</span>
        </div>
        <div class="ocps-modal-body">
          <span class="ocps-modal-icon">&#128721;</span>
          <span>Serial <strong>${esc(serial)}</strong> has been flagged.<br><br>Redirect this device to leadership immediately.</span>
        </div>
        <div class="ocps-modal-footer">
          <button class="ocps-modal-ok">I Understand</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector(".ocps-modal-ok").onclick = () => overlay.remove();
  }

  function getSeenIds() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get("ocps_seen_announcements", data => {
          resolve((data && data.ocps_seen_announcements) || []);
        });
      } catch { resolve([]); }
    });
  }

  function markSeen(id) {
    getSeenIds().then(seen => {
      if (!seen.includes(id)) {
        seen.push(id);
        if (seen.length > 300) seen = seen.slice(-300);
        try { chrome.storage.local.set({ ocps_seen_announcements: seen }); } catch {}
      }
    });
  }

  function showAnnouncementModal(announcement) {
    return new Promise(resolve => {
      const existing = document.getElementById("ocps-announce-modal");
      if (existing) existing.remove();

      const isUrgent = announcement.priority === "urgent";
      const title = announcement.title || (isUrgent ? "System Alert" : "Announcement");
      const icon = isUrgent ? "⚠️" : "📢";

      const overlay = document.createElement("div");
      overlay.id = "ocps-announce-modal";
      overlay.innerHTML = `
        <div class="ocps-modal-box${isUrgent ? " ocps-modal-urgent" : ""}">
          <div class="ocps-modal-titlebar">
            <span class="ocps-modal-titlebar-text">${icon} ${esc(title)}</span>
            <button class="ocps-modal-close" title="OK">✕</button>
          </div>
          <div class="ocps-modal-body">
            <span class="ocps-modal-icon">${isUrgent ? "🚨" : "💬"}</span>
            <span>${esc(announcement.message)}</span>
          </div>
          <div class="ocps-modal-footer">
            <button class="ocps-modal-ok">OK</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      overlay.querySelector(".ocps-modal-close").onclick = () => {
        markSeen(announcement.id);
        overlay.remove();
        resolve();
      };
      overlay.querySelector(".ocps-modal-ok").onclick = () => {
        markSeen(announcement.id);
        overlay.remove();
        resolve();
      };
    });
  }

  async function checkAnnouncements() {
    try {
      const resp = await fetch(ANNOUNCE_URL + "?_=" + Date.now());
      if (!resp.ok) return;
      const data = await resp.json();
      const list = (data.announcements || []).filter(a => a.active !== false);
      if (!list.length) return;

      const seen = await getSeenIds();
      const unseen = list.filter(a => !seen.includes(a.id));

      // Show urgent first, then normal
      const sorted = [...unseen.filter(a => a.priority === "urgent"), ...unseen.filter(a => a.priority !== "urgent")];

      for (const ann of sorted) {
        await showAnnouncementModal(ann);
      }
    } catch { /* silent — announcements are non-critical */ }
  }

  /* ── Initialization ───────────────────────────────────────────── */

  function init() {
    checkForRepairPage();
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(checkForRepairPage, POLL_INTERVAL);
    // Announcements: check on load and every minute
    checkAnnouncements();
    setInterval(checkAnnouncements, ANNOUNCE_INTERVAL);
    // Blocked serials: load on start and refresh every minute
    loadBlockedSerials();
    setInterval(loadBlockedSerials, ANNOUNCE_INTERVAL);
    // UI Controls: load on start and refresh every minute
    loadUiControls();
    setInterval(loadUiControls, ANNOUNCE_INTERVAL);
  }

  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }
})();
