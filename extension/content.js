/* ═══════════════════════════════════════════════════════════════════════
   OCPS Repair Validator — Content Script (Standalone)
   Injected on Odoo repair pages. Reads the repair ID from the URL,
   validates directly via Odoo JSON-RPC (no dashboard needed), shows
   a floating validation panel, and hides the End Repair button when
   errors are present.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  // Guard against double-injection (e.g. programmatic re-inject after extension reload).
  // odoo-rpc.js and validator.js use top-level const — a second injection would throw.
  // This flag is checked by background.js before injecting into existing tabs.
  if (window.__ocpsInit) return;
  window.__ocpsInit = true;

  const PANEL_ID = "ocps-validator-panel";
  const DEBOUNCE_MS = 1200;
  const RPC_REVALIDATE_DEBOUNCE_MS = 2500;
  const DOM_REVALIDATE_DEBOUNCE_MS = 1500; // live revalidation after form DOM changes

  let currentRepairId = null;
  let debounceTimer = null;
  let rpcDebounceTimer = null;
  let domDebounceTimer = null;
  let bodyObserverTimer = null;  // handle debounce per MutationObserver del body
  let lastUiControlsApply = 0;  // timestamp throttle per applyUiControls() nell'observer del body
  let formObserver = null;

  /* ── Helper ──────────────────────────────────────────────────────── */

  function getRepairIdFromUrl() {
    const path = window.location.pathname;
    if (!path.includes("/repairs/")) return null;
    // Ritorna null a meno che il percorso non termini con un segmento numerico (un record form specifico)
    // E quel segmento appartenga a un record riparazione (non un sale.order, picking, ecc. annidato).
    // /odoo/repairs/2076                   → 2076  (parent repair form)
    // /odoo/repairs/2076/repair.order/5678 → 5678  (child/rework repair form)
    // /odoo/repairs/1097/sale.order/1      → null  (SO sub-view — not a repair form)
    const segments = path.split("/").filter(Boolean);
    const lastSeg = segments[segments.length - 1];
    if (!/^\d+$/.test(lastSeg)) return null;
    const parentSeg = segments[segments.length - 2] || "";
    if (parentSeg !== "repairs" && parentSeg !== "repair.order") return null;
    return parseInt(lastSeg, 10);
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

  function waitForElement(selector, timeout = 5000) {
    const el = document.querySelector(selector);
    if (el) return Promise.resolve(el);
    return new Promise(resolve => {
      const deadline = Date.now() + timeout;
      const iv = setInterval(() => {
        const found = document.querySelector(selector);
        if (found || Date.now() >= deadline) {
          clearInterval(iv);
          resolve(found || null);
        }
      }, 80);
    });
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    const sheet = document.querySelector(".o_form_sheet");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      // Posizione ideale: direttamente sopra il foglio form, sotto i pulsanti azione
      if (sheet && sheet.parentElement) {
        sheet.parentElement.insertBefore(panel, sheet);
      } else {
        const view = document.querySelector(".o_form_view") || document.body;
        view.prepend(panel);
      }
    } else if (sheet && sheet.parentElement && !sheet.parentElement.contains(panel)) {
      // Panel landed in a fallback position (e.g. body) before Odoo finished re-rendering.
      // Now that the form sheet is present, move the panel to the correct spot.
      sheet.parentElement.insertBefore(panel, sheet);
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

    // Info ticket
    const deliveries = data.delivery_history || [];
    const returns    = data.return_history   || [];
    // thisRepairDeliveries: consegne il cui picking è stato attivato da QUESTO ordine di riparazione
    // priorDeliveries: consegne da altri ordini di riparazione per lo stesso seriale
    const thisRepairDeliveries = deliveries.filter(d => d.repair_id === data.id);
    const priorDeliveries      = deliveries.filter(d => d.repair_id && d.repair_id !== data.id);

    function fmtHistDate(rawDate) {
      if (!rawDate) return "";
      try { return new Date(rawDate.replace(" ", "T")).toLocaleDateString(); } catch { return rawDate; }
    }

    let ticketHtml = "";
    if (data.ticket_name || data.ticket_stage) {
      ticketHtml = `<div class="ocps-ticket">`;
      if (data.ticket_name) ticketHtml += `<span>🎫 Ticket: <strong>${esc(data.ticket_name)}</strong></span>`;
      if (data.ticket_stage) ticketHtml += `<span>Stage: <strong>${esc(data.ticket_stage)}</strong></span>`;
      if (thisRepairDeliveries.length > 0) {
        const d = thisRepairDeliveries[0];
        ticketHtml += `<span class="ocps-last-delivery">📦 Delivered: <strong>${fmtHistDate(d.date)}</strong>${d.picking_name ? ` <span class="ocps-pick-ref">(${esc(d.picking_name)})</span>` : ""}</span>`;
      } else if (priorDeliveries.length > 0) {
        const d = priorDeliveries[0];
        ticketHtml += `<span class="ocps-last-delivery ocps-prev-repair">⚠️ Prev. repair: <strong>${esc(d.repair_name || "?")}</strong> &nbsp;·&nbsp; ${fmtHistDate(d.date)}</span>`;
      } else if (deliveries.length > 0) {
        const lastDelivery = deliveries[0];
        const pickRef = lastDelivery.picking_name || (lastDelivery.picking_id ? esc(Array.isArray(lastDelivery.picking_id) ? lastDelivery.picking_id[1] : lastDelivery.picking_id) : "");
        ticketHtml += `<span class="ocps-last-delivery">📦 Last delivered: <strong>${fmtHistDate(lastDelivery.date)}</strong>${pickRef ? ` <span class="ocps-pick-ref">(${pickRef})</span>` : ""}</span>`;
      }
      ticketHtml += `</div>`;
    }

    // Riepilogo parti
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

    // Lista problemi
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
    // Auto-espandi quando ci sono problemi
    if (errorCount > 0 || warnCount > 0) panel.classList.remove("ocps-collapsed");
    else panel.classList.add("ocps-collapsed");

    // Sezione Storico Dispositivo — mostra quando c'è qualsiasi move consegna/reso, o riparazione completata
    let historyHtml = "";
    if (deliveries.length > 0 || returns.length > 0 || data.state === "done") {
      const hasEnrichment = deliveries.some(d => d.repair_id != null);
      let histBody = "";
      if (thisRepairDeliveries.length > 0) {
        const d = thisRepairDeliveries[0];
        histBody += `<div class="ocps-history-item ocps-hist-ok">✅ This repair delivered — ${fmtHistDate(d.date)}${d.picking_name ? ` <span class="ocps-pick-ref">(${esc(d.picking_name)})</span>` : ""}</div>`;
      } else if (!hasEnrichment && deliveries.length > 0) {
        const last = deliveries[0];
        const pickRef = last.picking_name || (last.picking_id ? (Array.isArray(last.picking_id) ? last.picking_id[1] : last.picking_id) : "");
        histBody += `<div class="ocps-history-item ocps-hist-ok">✅ Delivered to customer ${deliveries.length}× — last: ${fmtHistDate(last.date)}${pickRef ? ` <span class="ocps-pick-ref">(${esc(pickRef)})</span>` : ""}</div>`;
      } else if (data.state === "done") {
        histBody += `<div class="ocps-history-item ocps-hist-pending">⏳ Not yet delivered to customer after this repair</div>`;
      }
      if (priorDeliveries.length > 0) {
        const last = priorDeliveries[0];
        histBody += `<div class="ocps-history-item ocps-hist-prior">🔁 Prior ${priorDeliveries.length > 1 ? `${priorDeliveries.length}× deliveries` : "delivery"} — last: ${last.repair_name ? `<strong>${esc(last.repair_name)}</strong> ` : ""}${fmtHistDate(last.date)}</div>`;
      }
      if (returns.length > 0) {
        const last = returns[0];
        const pickRef = last.picking_id ? (Array.isArray(last.picking_id) ? last.picking_id[1] : last.picking_id) : "";
        histBody += `<div class="ocps-history-item ocps-hist-return">↩️ Returned from customer ${returns.length}× — last: ${fmtHistDate(last.date)}${pickRef ? ` <span class="ocps-pick-ref">(${esc(pickRef)})</span>` : ""}</div>`;
      }
      historyHtml = `<div class="ocps-history-section ocps-hist-collapsed">
        <div class="ocps-history-header">📦 Device History <span class="ocps-hist-arrow">▸</span></div>
        <div class="ocps-history-body">${histBody}</div>
      </div>`;
    }

    const deliveredBadge = thisRepairDeliveries.length > 0
      ? ` &nbsp;|&nbsp; <span class="ocps-meta-delivered">📦 Delivered</span>`
      : "";
    panel.innerHTML = `
      <div class="ocps-summary">
        <span class="ocps-status-badge">${statusIcon} ${statusText}</span>
        <span class="ocps-summary-meta">${esc(data.name || "")} &nbsp;|&nbsp; ${esc(data.state || "")} &nbsp;|&nbsp; ${esc(data.lot_name || "—")} &nbsp;|&nbsp; ${esc(data.device_location || "—")}${deliveredBadge}</span>
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
        ${historyHtml}
      </div>`;

    panel.querySelector(".ocps-summary").onclick = (e) => {
      if (!e.target.closest(".ocps-summary-actions")) {
        panel.classList.toggle("ocps-collapsed");
        const btn = panel.querySelector(".ocps-toggle");
        if (btn) btn.textContent = panel.classList.contains("ocps-collapsed") ? "▸" : "▾";
      }
    };

    // Collega pulsanti
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

    // Collega toggle storico
    const histHeader = panel.querySelector(".ocps-history-header");
    if (histHeader) {
      histHeader.onclick = () => {
        const section = histHeader.closest(".ocps-history-section");
        if (!section) return;
        section.classList.toggle("ocps-hist-collapsed");
        const arrow = section.querySelector(".ocps-hist-arrow");
        if (arrow) arrow.textContent = section.classList.contains("ocps-hist-collapsed") ? "▸" : "▾";
      };
    }

    // Nascondi/mostra pulsante End Repair in base agli errori
    setEndRepairHidden(errorCount > 0, errorCount);

    // Hide Create Quotation if coverage is CHS (no quotation needed) or if this is a rework
    // (SO must be on the parent repair, not the rework itself)
    const isChs = (data.coverage_type || "").toLowerCase().includes("chs");
    const isRework = !!(data.parent_repair_id);
    setCreateQuotationHidden(isChs || isRework);

    // Applica override controlli UI admin (eseguito per ultimo per sovrapporsi alle decisioni del validatore)
    applyUiControls();

    // Controllo seriale bloccato
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

  /* ── Driver di validazione ──────────────────────────────────────── */

  /* ── Form MutationObserver — live revalidation on DOM changes ─── */

  function stopFormObserver() {
    if (formObserver) { formObserver.disconnect(); formObserver = null; }
    clearTimeout(domDebounceTimer);
    domDebounceTimer = null;
  }

  function isUserInteractingWithForm() {
    // Returns true when the user has a form field focused or an Odoo dropdown open,
    // meaning we should not interrupt them with a revalidation.
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return false;
    const tag = el.tagName;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return true;
    // Widget autocomplete / combobox Odoo
    if (el.getAttribute("role") === "combobox") return true;
    // Qualsiasi elemento focalizzato dentro un dropdown aperto o pannello autocomplete
    if (el.closest(".dropdown-menu, .o_autocomplete_dropdown, .o_field_many2one_dropdown")) return true;
    // Odoo marca il widget campo in modifica con .o_focused
    if (el.closest(".o_field_widget.o_focused")) return true;
    return false;
  }

  function startFormObserver(repairId) {
    stopFormObserver();
    const form = document.querySelector(".o_form_view");
    if (!form) return;

    function scheduleDomRevalidate() {
      clearTimeout(domDebounceTimer);
      domDebounceTimer = setTimeout(function tryRevalidate() {
        // Se l'utente ha ancora un campo/dropdown focalizzato, continua ad aspettare invece di interrompere.
        if (isUserInteractingWithForm()) {
          domDebounceTimer = setTimeout(tryRevalidate, DOM_REVALIDATE_DEBOUNCE_MS);
          return;
        }
        domDebounceTimer = null;
        if (currentRepairId === repairId) runValidation(repairId);
      }, DOM_REVALIDATE_DEBOUNCE_MS);
    }

    formObserver = new MutationObserver((mutations) => {
      // Ignora mutazioni che riguardano solo il nostro pannello di validazione (evita loop).
      const panel = document.getElementById(PANEL_ID);
      if (panel && mutations.every(m => m.target === panel || panel.contains(m.target))) return;
      scheduleDomRevalidate();
    });
    formObserver.observe(form, { childList: true, subtree: true, characterData: true });
  }

  /* ── Driver di validazione ──────────────────────────────────────── */

  async function runValidation(repairId) {
    stopFormObserver(); // pause live observer while validation runs
    // Aspetta che Odoo finisca il rendering del form prima di inserire il pannello.
    await waitForElement(".o_form_sheet", 6000);
    renderLoading(repairId);
    await loadBlockedSerials(); // always fetch fresh list before checking
    try {
      const result = await Validator.validateRepair(repairId);
      renderResult(result);
    } catch (err) {
      console.error("[OCPS] Validation failed:", err);
      renderError(repairId, err.message || "Validation failed — see console");
    } finally {
      startFormObserver(repairId); // resume live observer once panel is painted
    }
  }

  /* ── URL monitoring ───────────────────────────────────────────── */

  function checkForRepairPage() {
    const rid = getRepairIdFromUrl();
    const panelMissing = !document.getElementById(PANEL_ID);
    if (rid && (rid !== currentRepairId || (panelMissing && debounceTimer === null))) {
      currentRepairId = rid;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        runValidation(rid);
      }, DEBOUNCE_MS);
    } else if (!rid) {
      currentRepairId = null;
      stopFormObserver();
      const panel = document.getElementById(PANEL_ID);
      if (panel) panel.classList.add("ocps-hidden");
      setEndRepairHidden(false, 0);
      setCreateQuotationHidden(false);
    }
  }

  // Odoo is a SPA — watch for URL changes.
  // Use the native Navigation API (Chrome 102+) when available.
  // NOTE: use "navigatesuccess" not "navigate" — "navigate" fires BEFORE the URL
  // updates, so window.location still shows the old path when we read it.
  // "navigatesuccess" fires after the navigation commits and window.location is current.
  if (typeof navigation !== "undefined" && navigation.addEventListener) {
    // navigatesuccess — scatta dopo che le navigazioni SPA forward sono complete
    // currententrychange — scatta ad ogni cambio di entry nella history incluso avanti/indietro del browser
    navigation.addEventListener("navigatesuccess", checkForRepairPage);
    navigation.addEventListener("currententrychange", checkForRepairPage);
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

  // bfcache safety: Chrome may freeze this page in the back-forward cache.
  // On freeze, reset currentRepairId so that when the page is thawed and
  // pageshow fires, checkForRepairPage() treats it as a fresh visit and
  // re-validates instead of seeing rid === currentRepairId and skipping.
  window.addEventListener("pagehide", () => { currentRepairId = null; stopFormObserver(); });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) setTimeout(checkForRepairPage, 100);
  });

  /* ── Fetch interceptor — revalidate on Odoo RPC writes ──────────── */
  // Watches for JSON-RPC calls that mutate repair-relevant models and
  // schedules a silent re-validation ~2.5 s after the last write lands,
  // giving Odoo time to finish any downstream cascades (stock moves, etc.)
  if (!window.fetch.__ocpsPatched) {
    const _origFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const response = await _origFetch(input, init);
      try {
        if (currentRepairId) {
          const url = (typeof input === "string" ? input : (input && input.url)) || "";
          if (url.includes("/web/dataset/call_kw")) {
            let body = null;
            try { body = JSON.parse(init && init.body); } catch { /* ignora */ }
            const params  = (body && body.params) || {};
            const model   = params.model  || "";
            const method  = params.method || "";
            const WATCHED = ["repair.order", "stock.move", "repair.line",
                             "stock.quant", "sale.order", "sale.order.line"];
            const WRITE_METHODS = ["write", "create", "unlink"];
            const isWrite = WRITE_METHODS.includes(method) || method.startsWith("action_");
            if (WATCHED.includes(model) && isWrite) {
              clearTimeout(rpcDebounceTimer);
              rpcDebounceTimer = setTimeout(() => {
                if (currentRepairId) runValidation(currentRepairId);
              }, RPC_REVALIDATE_DEBOUNCE_MS);
            }
          }
        }
      } catch { /* non interrompere mai fetch */ }
      return response;
    };
    window.fetch.__ocpsPatched = true;
  }

  // MutationObserver to catch Odoo's internal navigation (e.g. SPA route changes, button
  // reinsertion after statusbar re-render). Debounced to 150ms to avoid running on every
  // individual DOM mutation — Odoo generates hundreds per second during renders.
  const observer = new MutationObserver((mutations) => {
    // Salta se tutte le mutazioni sono dentro il nostro pannello (evita loop di feedback).
    const panel = document.getElementById(PANEL_ID);
    if (panel && mutations.every(m => panel === m.target || panel.contains(m.target))) return;

    clearTimeout(bodyObserverTimer);
    bodyObserverTimer = setTimeout(() => {
      bodyObserverTimer = null;
      checkForRepairPage();
      if (currentRepairId) {
        // Ri-applica visibilità pulsante End Repair (Odoo ri-renderizza la statusbar su switch tab ecc.)
        const p = document.getElementById(PANEL_ID);
        if (p) {
          const errCount = p.querySelectorAll(".ocps-issue-err").length;
          setEndRepairHidden(errCount > 0, errCount);
        }
        // Ri-applica controlli UI admin — limitato a massimo una volta ogni 500ms
        if (Date.now() - lastUiControlsApply > 500) {
          lastUiControlsApply = Date.now();
          applyUiControls();
        }
      }
    }, 150);
  });

  /* ── Annunci e Seriali Bloccati ───────────────────────────────── */

  const ANNOUNCE_URL      = "http://10.56.65.139:3131/api/announcements";
  const BLOCKED_URL        = "http://10.56.65.139:3131/api/blocked";
  const UI_CONTROLS_URL    = "http://10.56.65.139:3131/api/ui-controls";
  const MESSAGES_URL       = "http://10.56.65.139:3131/api/messages";
  const ANNOUNCE_INTERVAL  = 10000;

  let cachedBlockedSerials = [];
  let cachedUiControls     = {};

  function fetchOfficeApi(url, options = {}) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({
          type: "ocps-api-fetch",
          url,
          method: options.method || "GET",
          headers: options.headers || {},
          json: options.json,
        }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response) {
            reject(new Error("No response from background fetch bridge"));
            return;
          }
          if (response.error) {
            reject(new Error(response.error));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  // ── Controlli UI ──────────────────────────────────────────────────────────

  // Finder elementi per ID controllo (deve corrispondere al catalogo in admin.html)
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
      const resp = await fetchOfficeApi(UI_CONTROLS_URL + "?_=" + Date.now());
      if (!resp.ok) return;
      const data = resp.data || {};
      cachedUiControls = data.controls || {};
      applyUiControls();
    } catch { /* silenzioso */ }
  }

  function applyUiControls() {
    if (!currentRepairId) return;
    // Ripristina elementi precedentemente controllati (approccio classi CSS — nessun conflitto con stili inline del validatore)
    document.querySelectorAll('.ocps-ui-hidden').forEach(el => el.classList.remove('ocps-ui-hidden'));
    document.querySelectorAll('.ocps-ui-disabled').forEach(el => el.classList.remove('ocps-ui-disabled'));
    // Applica controlli attivi
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
      const resp = await fetchOfficeApi(BLOCKED_URL + "?_=" + Date.now());
      if (!resp.ok) return;
      const data = resp.data || {};
      cachedBlockedSerials = (data.blocked || []).map(b => (b.serial || "").trim().toLowerCase());
    } catch { /* silenzioso */ }
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

      async function dismiss() {
        markSeen(announcement.id);
        const user = await getOdooUsername();
        if (user) ackAnnouncement(announcement.id, user);
        overlay.remove();
        resolve();
      }
      overlay.querySelector(".ocps-modal-close").onclick = dismiss;
      overlay.querySelector(".ocps-modal-ok").onclick = dismiss;
    });
  }

  async function checkAnnouncements() {
    try {
      const resp = await fetchOfficeApi(ANNOUNCE_URL + "?_=" + Date.now());
      if (!resp.ok) return;
      const data = resp.data || {};
      const list = (data.announcements || []).filter(a => a.active !== false);
      if (!list.length) return;

      const seen = await getSeenIds();
      const unseen = list.filter(a => !seen.includes(a.id));

      // Show urgent first, then normal
      const sorted = [...unseen.filter(a => a.priority === "urgent"), ...unseen.filter(a => a.priority !== "urgent")];

      for (const ann of sorted) {
        await showAnnouncementModal(ann);
      }
    } catch { /* silenzioso — gli annunci non sono critici */ }
  }
  /* ── Messaggi ─────────────────────────────────────────────────── */

  async function getOdooUsername() {
    // Prova sempre la sessione Odoo fresca; fallback al valore in cache se non disponibile.
    try {
      const resp = await fetch("/web/session/get_session_info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "call", params: {} }),
      });
      const json = await resp.json();
      const login = (json.result && (json.result.login || json.result.username)) || "";
      if (login) {
        try { chrome.storage.local.set({ ocps_odoo_username: login }); } catch {}
        return login;
      }
    } catch { /* prosegui */ }
    try {
      return await new Promise(resolve =>
        chrome.storage.local.get("ocps_odoo_username", d => resolve((d && d.ocps_odoo_username) || ""))
      );
    } catch { return ""; }
  }

  async function ackMessage(msgId, user) {
    try {
      await fetchOfficeApi(`${MESSAGES_URL}/${msgId}/ack`, {
        method: "POST",
        json: { user },
      });
    } catch { /* silenzioso */ }
  }

  async function ackAnnouncement(annId, user) {
    try {
      await fetchOfficeApi(`${ANNOUNCE_URL}/${annId}/ack`, {
        method: "POST",
        json: { user },
      });
    } catch { /* silenzioso */ }
  }

  function showMessageModal(msg) {
    return new Promise(resolve => {
      const existing = document.getElementById("ocps-message-modal");
      if (existing) existing.remove();
      const overlay = document.createElement("div");
      overlay.id = "ocps-message-modal";
      overlay.innerHTML = `
        <div class="ocps-modal-box">
          <div class="ocps-modal-titlebar">
            <span class="ocps-modal-titlebar-text">💬 Message from Admin</span>
          </div>
          <div class="ocps-modal-body">
            <span class="ocps-modal-icon">📩</span>
            <span>${esc(msg.text)}</span>
          </div>
          <div class="ocps-modal-footer">
            <button class="ocps-modal-ok">OK — Got it</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector(".ocps-modal-ok").onclick = () => {
        overlay.remove();
        resolve();
      };
    });
  }

  let checkMessagesBusy = false;

  async function checkMessages() {
    // Synchronous lock — set before first await so concurrent callers see it immediately.
    // Without this, multiple async callers (interval + background push + long-poll event)
    // all pass the DOM guard before any of them has appended the modal.
    if (checkMessagesBusy) return;
    if (document.getElementById("ocps-message-modal")) return;
    checkMessagesBusy = true;
    try {
      const user = await getOdooUsername();
      if (!user) return;
      const resp = await fetchOfficeApi(`${MESSAGES_URL}?user=${encodeURIComponent(user)}&_=${Date.now()}`);
      if (!resp.ok) return;
      const data = resp.data || {};
      const list = data.messages || [];
      for (const msg of list) {
        await showMessageModal(msg);
        await ackMessage(msg.id, user);
      }
    } catch { /* silenzioso */ } finally {
      checkMessagesBusy = false;
    }
  }
  /* ── Inizializzazione ─────────────────────────────────────────── */

  function init() {
    checkForRepairPage();
    observer.observe(document.body, { childList: true, subtree: true });
    // Nessun setInterval per checkForRepairPage — Navigation API + patch history + popstate coprono tutte le navigazioni SPA.
    // Annunci: controlla al caricamento e ogni minuto
    checkAnnouncements();
    setInterval(checkAnnouncements, ANNOUNCE_INTERVAL);
    // Seriali bloccati: carica all'avvio e aggiorna ogni minuto
    loadBlockedSerials();
    setInterval(loadBlockedSerials, ANNOUNCE_INTERVAL);
    // Controlli UI: carica all'avvio e aggiorna ogni minuto
    loadUiControls();
    setInterval(loadUiControls, ANNOUNCE_INTERVAL);
    // Messaggi: controlla al caricamento e ogni minuto
    checkMessages();
    setInterval(checkMessages, ANNOUNCE_INTERVAL);
  }

  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }

  // Background pushes this when a new message arrives, so the modal appears
  // immediately without waiting for the next 10 s poll interval.
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "ocps-check-messages") {
      checkMessages();
    }
  });
})();
