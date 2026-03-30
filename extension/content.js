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
    const m = window.location.pathname.match(/\/repairs\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
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
      document.body.appendChild(panel);
    }
    return panel;
  }

  function renderLoading(repairId) {
    const panel = ensurePanel();
    panel.className = "ocps-panel ocps-loading";
    panel.classList.remove("ocps-hidden");
    panel.innerHTML = `
      <div class="ocps-header">
        <span class="ocps-title">🔍 Validating Repair #${repairId}…</span>
        <button class="ocps-close" title="Close">&times;</button>
      </div>
      <div class="ocps-body"><div class="ocps-spinner"></div></div>`;
    panel.querySelector(".ocps-close").onclick = () => panel.classList.add("ocps-collapsed");
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

    // Unconsumed parts detail
    let partsDetailHtml = "";
    if (data.parts && data.parts.length) {
      const unconsumed = data.parts.filter(p => p.done < p.demand);
      if (unconsumed.length) {
        partsDetailHtml = `<div class="ocps-parts-detail">
          <strong>Unconsumed Parts:</strong>
          <ul>${unconsumed.map(p => `<li>${esc(p.product_name)} — demand: ${p.demand}, done: ${p.done}</li>`).join("")}</ul>
        </div>`;
      }
    }

    panel.className = `ocps-panel ${statusCls}`;
    panel.innerHTML = `
      <div class="ocps-header">
        <span class="ocps-title">${statusIcon} ${esc(data.name || "Repair")} — ${statusText}</span>
        <div class="ocps-header-actions">
          <button class="ocps-refresh" title="Re-validate">🔄</button>
          <button class="ocps-toggle" title="Collapse">▾</button>
          <button class="ocps-close" title="Close">&times;</button>
        </div>
      </div>
      <div class="ocps-body">
        <div class="ocps-meta">
          <span>State: <strong>${esc(data.state || "—")}</strong></span>
          <span>Serial: <strong>${esc(data.lot_name || "—")}</strong></span>
          <span>Location: <strong>${esc(data.device_location || "—")}</strong></span>
          <span>Coverage: <strong>${esc(data.coverage_type || "—")}</strong></span>
        </div>
        ${ticketHtml}
        ${partsHtml}
        ${issuesHtml}
        ${partsDetailHtml}
      </div>`;

    // Wire buttons
    panel.querySelector(".ocps-close").onclick = () => panel.classList.add("ocps-hidden");
    panel.querySelector(".ocps-toggle").onclick = () => {
      panel.classList.toggle("ocps-collapsed");
      const btn = panel.querySelector(".ocps-toggle");
      btn.textContent = panel.classList.contains("ocps-collapsed") ? "▸" : "▾";
    };
    panel.querySelector(".ocps-refresh").onclick = () => {
      const rid = getRepairIdFromUrl();
      if (rid) runValidation(rid);
    };

    // Hide/show End Repair button based on errors
    setEndRepairHidden(errorCount > 0, errorCount);

    // Hide Create Quotation if coverage is CHS
    const isChs = (data.coverage_type || "").toLowerCase().includes("chs");
    setCreateQuotationHidden(isChs);
  }

  function renderError(repairId, message) {
    const panel = ensurePanel();
    panel.classList.remove("ocps-hidden");
    panel.className = "ocps-panel ocps-disconnected";
    panel.innerHTML = `
      <div class="ocps-header">
        <span class="ocps-title">⚡ Validator — Repair #${repairId || "?"}</span>
        <button class="ocps-close" title="Close">&times;</button>
      </div>
      <div class="ocps-body">
        <p class="ocps-err-msg">${esc(message)}</p>
        <button class="ocps-retry-btn">Retry</button>
      </div>`;
    panel.querySelector(".ocps-close").onclick = () => panel.classList.add("ocps-hidden");
    panel.querySelector(".ocps-retry-btn").onclick = () => {
      const rid = getRepairIdFromUrl();
      if (rid) runValidation(rid);
    };
  }

  /* ── Validation driver ────────────────────────────────────────── */

  async function runValidation(repairId) {
    renderLoading(repairId);
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

  // Odoo is a SPA — watch for URL changes via History API
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
  window.addEventListener("popstate", checkForRepairPage);

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
    }
  });

  /* ── Initialization ───────────────────────────────────────────── */

  function init() {
    checkForRepairPage();
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(checkForRepairPage, POLL_INTERVAL);
  }

  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }
})();
