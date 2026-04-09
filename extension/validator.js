/* ═══════════════════════════════════════════════════════════════════════
   validator.js — Motore di validazione riparazioni standalone.
   Recupera tutti i dati necessari da Odoo tramite JSON-RPC ed esegue
   tutte le regole di validazione previste da sync_engine.py.
   ═══════════════════════════════════════════════════════════════════════ */

// eslint-disable-next-line no-unused-vars
const Validator = (() => {
  "use strict";

  /* ────────────────────────────────────────────────────────────────── *
   *  COSTANTI TAG (specchia sync_engine.py)
   * ────────────────────────────────────────────────────────────────── */

  const HOLD_REQUIRED_TAGS = {
    "pending order parts":             "Tag 'Pending Order Parts' → Put on Hold (awaiting parts order)",
    "pending order part(s)":           "Tag 'Pending Order Part(s)' → Put on Hold (awaiting parts order)",
    "pending to order part":           "Tag 'Pending to Order Parts' → Put on Hold (awaiting parts order)",
    "pending to order part(s)":        "Tag 'Pending to Order Part(s)' → Put on Hold (awaiting parts order)",
    "pending customer quote approval": "Tag 'Pending Customer Quote Approval' → Put on Hold (awaiting customer)",
    "ber-threshold met":               "Tag 'BER-Threshold Met' → Put on Hold (awaiting BER approval)",
    "ber-pending approval":            "Tag 'BER-Pending Approval' → Put on Hold (awaiting customer BER decision)",
    "ber-parts requested":             "Tag 'BER-Parts Requested' → Put on Hold (awaiting BER part)",
    "ber-part(s) requested":           "Tag 'BER- Part(s) Requested' → Put on Hold (awaiting BER part)",
    "doa part":                        "Tag 'DOA Part' → Put on Hold (defective part, log note required)",
    "part doa":                        "Tag 'Part DOA' → Put on Hold (defective part, log note required)",
    "device box requested":            "Tag 'Device Box Requested' → Put on Hold (Apple IW, awaiting box)",
    "waiting on replacement device":   "Tag 'Waiting on Replacement Device' → Put on Hold (Apple, awaiting device)",
    "shipped to oem":                  "Tag 'Shipped to OEM' → Put on Hold (awaiting OEM return)",
  };

  const HOLD_REASON_TAGS = new Set([
    "pending to order part", "pending to order part(s)",
    "pending order parts", "pending order part(s)",
    "pending customer quote approval",
    "parts ordered", "part(s) ordered",
    "ber-threshold met", "ber-pending approval",
    "ber-parts requested", "ber-part(s) requested",
    "doa part", "part doa",
    "device box requested", "waiting on replacement device", "shipped to oem",
  ]);

  const PROCESS_TAGS = new Set([
    "pending to order part", "pending to order part(s)",
    "pending order parts", "pending order part(s)", "parts ordered",
    "part(s) ordered", "part(s) received", "parts received",
    "pending customer quote approval", "customer quote approved",
    "return to customer", "ber-threshold met",
    "ber-pending approval",
    "ber-approved for dismantle",
    "ber-approved for repair",
    "ber-parts requested", "ber-part(s) requested",
    "doa part", "part doa",
    "device box requested", "waiting on replacement device",
    "shipped to oem",
  ]);

  const DONE_STALE_TAGS = new Set([
    "pending to order part", "pending to order part(s)",
    "pending order parts", "pending order part(s)",
    "parts ordered", "part(s) ordered",
    "pending customer quote approval",
    "ber-threshold met", "ber-pending approval",
    "ber-parts requested", "ber-part(s) requested",
    "doa part", "part doa",
    "device box requested", "waiting on replacement device",
    "shipped to oem",
  ]);

  const BER_RELATED_TAGS = new Set([
    "ber-threshold met", "ber-pending approval",
    "ber-approved for dismantle", "ber-approved for repair",
    "ber-parts requested", "ber-part(s) requested",
    "ber-parts requested", "ber-part(s) requested",
  ]);

  /** Costo OOW (a livello famiglia, USD) che attiva il flusso BER — specchia config Odoo. */
  const BER_THRESHOLD = 250;

  /* ────────────────────────────────────────────────────────────────── *
   *  CLASSIFICAZIONE GARANZIA
   * ────────────────────────────────────────────────────────────────── */

  function classifyWarranty(productName, productCode, repairLineType, categName) {
    // Passo 1: repair_line_type
    if (repairLineType) {
      const rlt = String(repairLineType).toLowerCase();
      if (rlt.includes("oow") || rlt.includes("out")) return "OOW";
      if (rlt.includes("ber") || rlt.includes("beyond")) return "BER";
      if (rlt.includes("iw") || rlt.includes("in_warranty") || rlt.includes("in warranty")) return "IW";
    }
    // Passo 2: codice/nome prodotto per OOW/BER
    for (const text of [productCode || "", productName || ""]) {
      const up = text.toUpperCase();
      if (up.includes("-OOW") || up.includes(" OOW")) return "OOW";
      if (up.includes("-BER") || up.includes(" BER")) return "BER";
    }
    // Passo 3: suffisso IW
    for (const text of [productCode || "", productName || ""]) {
      const up = text.trim().toUpperCase();
      if (up.endsWith(" IW") || up.endsWith("-IW")) return "IW";
    }
    // Passo 4: categ_name
    if (categName) {
      const cat = String(categName).toUpperCase();
      if (cat.includes("-OOW") || cat.includes(" OOW")) return "OOW";
      if (cat.includes("-BER") || cat.includes(" BER")) return "BER";
      if (cat.includes("-IW") || cat.endsWith("/ IW")) return "IW";
    }
    return "Unknown";
  }

  /* ────────────────────────────────────────────────────────────────── *
   *  SCOPERTA SCHEMA (eseguito una volta, poi in cache)
   * ────────────────────────────────────────────────────────────────── */

  let _schemaCache = null;

  async function discoverSchema() {
    if (_schemaCache) return _schemaCache;
    const repairInfo = await OdooRPC.fieldsGet("repair.order");

    // campo ops / modello riga
    const opsField = repairInfo["move_ids"] ? "move_ids" : null;
    const lineModel = opsField ? (repairInfo[opsField].relation || "stock.move") : "stock.move";

    // campo tag
    let tagField = null;
    for (const [fname, fmeta] of Object.entries(repairInfo)) {
      if ((fmeta.string || "").toLowerCase().includes("tag") &&
          ["many2many", "one2many"].includes(fmeta.type)) {
        tagField = fname;
        break;
      }
    }

    // campo risoluzione
    let resolutionField = null;
    for (const [fname, fmeta] of Object.entries(repairInfo)) {
      if ((fmeta.string || "").toLowerCase().includes("resolution") &&
          ["many2many", "one2many"].includes(fmeta.type)) {
        resolutionField = fname;
        break;
      }
    }

    // campo ticket
    let ticketField = null;
    for (const [fname, fmeta] of Object.entries(repairInfo)) {
      if (fmeta.type === "many2one" && (fmeta.relation || "").includes("helpdesk.ticket")) {
        ticketField = fname;
        break;
      }
    }

    // schema modello riga
    const moveInfo = await OdooRPC.fieldsGet(lineModel);

    // campo BER sale.order
    let soBerField = null;
    try {
      const soInfo = await OdooRPC.fieldsGet("sale.order");
      for (const [fname, fmeta] of Object.entries(soInfo)) {
        if (fmeta.type === "boolean" && fname.toLowerCase().includes("ber")) {
          soBerField = fname;
          break;
        }
      }
    } catch (_) { /* sale.order may not exist */ }

    _schemaCache = { repairInfo, opsField, lineModel, moveInfo, tagField, resolutionField, ticketField, soBerField };
    return _schemaCache;
  }

  /* ────────────────────────────────────────────────────────────────── *
   *  LETTORI DOM
   *  Il content script gira sulla pagina Odoo — legge i valori
   *  renderizzati direttamente dal DOM quando possibile (evita errori
   *  di permesso su modelli ausiliari come udt.repair.coverage.type).
   * ────────────────────────────────────────────────────────────────── */

  function readDomTags(fieldName) {
    // Odoo renderizza i campi tag many2many come .o_tag_badge_text dentro [name="fieldname"]
    const els = document.querySelectorAll(`[name="${fieldName}"] .o_tag_badge_text`);
    if (els.length) return Array.from(els).map(el => el.textContent.trim()).filter(Boolean);
    // Fallback: badge/pillole
    const badges = document.querySelectorAll(`[name="${fieldName}"] .badge`);
    if (badges.length) return Array.from(badges).map(el => el.textContent.trim()).filter(Boolean);
    return null;
  }

  function readDomField(fieldName) {
    // Legge il contenuto testuale di un campo renderizzato
    const el = document.querySelector(`[name="${fieldName}"] .o_field_widget, [name="${fieldName}"]`);
    return el ? el.textContent.trim() || null : null;
  }

  function readDomPartsDone() {
    // Legge la quantità Done per ogni riga della lista parti, nell'ordine del DOM.
    // Questa è l'unica fonte affidabile per le riparazioni completate: Odoo cancella/azzera la
    // quantità stock.move dopo il completamento, ma l'interfaccia mostra sempre il
    // valore corretto (0.00 = non consumata dal tecnico, 1.00 = correttamente consumata).
    // Prova prima il nome campo Odoo 17 ('quantity') poi Odoo 16 ('qty_done').
    const rows = document.querySelectorAll('[name="move_ids"] .o_data_row');
    if (!rows.length) return null;
    return Array.from(rows).map(row => {
      const el = row.querySelector('[name="quantity"]') || row.querySelector('[name="qty_done"]');
      if (!el) return null;
      const val = parseFloat(el.textContent.trim().replace(/[^\d.]/g, ""));
      return isNaN(val) ? null : val;
    });
  }

  const REPAIR_BASE_FIELDS = [
    "id", "name", "state", "partner_id", "product_id", "lot_id",
    "user_id", "assessment_responsible_id", "coverage_type_id",
    "schedule_date", "write_date", "create_date",
    "move_ids", "internal_notes", "sale_order_id", "is_rework", "parent_repair_id",
  ];

  const MOVE_BASE_FIELDS = [
    "id", "product_id", "product_uom_qty", "quantity", "state",
    "name", "repair_line_type", "write_date", "price_unit",
  ];

  // Campi opzionali che potrebbero esistere
  const MOVE_OPT_FIELDS = [
    "problem_statement_id", "x_studio_problem_statement", "coverage_type_id",
    "qty_done",   // Odoo 16 name for done quantity (renamed to 'quantity' in Odoo 17)
    "picked",     // Odoo 17 boolean — the 'Used' checkbox; stays True after repair completion
    "is_done",    // Some Odoo versions / custom modules use this name instead
  ];

  async function fetchRepair(repairId) {
    const schema = await discoverSchema();

    // Costruisci lista campi riparazione
    const rFields = [...REPAIR_BASE_FIELDS];
    if (schema.tagField && !rFields.includes(schema.tagField)) rFields.push(schema.tagField);
    if (schema.resolutionField && !rFields.includes(schema.resolutionField)) rFields.push(schema.resolutionField);
    if (schema.ticketField && !rFields.includes(schema.ticketField)) rFields.push(schema.ticketField);
    // Filtra solo campi esistenti
    const validRFields = rFields.filter(f => f in schema.repairInfo);

    const repairs = await OdooRPC.searchRead("repair.order", [["id", "=", repairId]], validRFields);
    if (!repairs.length) return null;
    const repair = repairs[0];

    // Risolvi nomi visualizzazione many2one
    repair._name = repair.name;
    repair._state = repair.state;
    repair._lot_name = OdooRPC.m2oName(repair.lot_id);
    repair._partner_name = OdooRPC.m2oName(repair.partner_id);
    repair._product_name = OdooRPC.m2oName(repair.product_id);
    repair._product_id = OdooRPC.m2oId(repair.product_id);
    repair._user_name = OdooRPC.m2oName(repair.user_id);
    repair._assessment_name = OdooRPC.m2oName(repair.assessment_responsible_id);
    // Risoluzione — campo Many2many. Legge prima dal DOM (stesso approccio dei tag —
    // evita di aver bisogno di accesso RPC al comodel). Fallback all'API usando il comodel dello schema.
    repair._resolution = "";
    if (schema.resolutionField) {
      const domResolutions = readDomTags(schema.resolutionField);
      if (domResolutions && domResolutions.length) {
        repair._resolution = domResolutions.join(", ");
      } else {
        const resolutionIds = Array.isArray(repair[schema.resolutionField]) ? repair[schema.resolutionField] : [];
        if (resolutionIds.length) {
          try {
            const resModel = (schema.repairInfo[schema.resolutionField] || {}).relation || null;
            if (resModel) {
              const resRecs = await OdooRPC.searchRead(resModel, [["id", "in", resolutionIds]], ["id", "name"]);
              repair._resolution = resRecs.map(r => r.name).join(", ");
            }
          } catch (_) { /* skip */ }
        }
      }
    }
    repair._so_id = OdooRPC.m2oId(repair.sale_order_id);
    repair._is_rework = repair.is_rework || false;
    repair._parent_id = OdooRPC.m2oId(repair.parent_repair_id);

    // Posizione dispositivo — interroga stock.quant per lot_id per trovare dove si trova l'unità ora
    repair._device_location = "";
    const lotId = OdooRPC.m2oId(repair.lot_id);
    if (lotId) {
      try {
        const quants = await OdooRPC.searchRead(
          "stock.quant",
          [["lot_id", "=", lotId], ["quantity", ">", 0]],
          ["location_id", "quantity"],
          { order: "quantity desc", limit: 5 }
        );
        if (quants.length) {
          repair._device_location = quants
            .map(q => OdooRPC.m2oName(q.location_id))
            .filter(Boolean)
            .join(" / ");
        }
      } catch (_) { /* leave empty */ }
    }

    // Storico consegne e resi — interroga stock.move.line per lot_id per trovare tutte le consegne al cliente.
    // location_dest_id.usage = "customer" → dispositivo andato AL cliente (consegna / ritiro)
    // location_id.usage = "customer"      → dispositivo tornato DAL cliente (reso / ricezione)
    // Entrambe le query girano in parallelo e hanno default [] su qualsiasi errore.
    repair._delivery_history = [];
    repair._return_history   = [];
    if (lotId) {
      try {
        const [deliveries, returns] = await Promise.all([
          OdooRPC.searchRead(
            "stock.move.line",
            [["lot_id", "=", lotId], ["state", "=", "done"],
             ["location_dest_id.usage", "=", "customer"]],
            ["id", "date", "picking_id"],
            { order: "date desc", limit: 10 }
          ),
          OdooRPC.searchRead(
            "stock.move.line",
            [["lot_id", "=", lotId], ["state", "=", "done"],
             ["location_id.usage", "=", "customer"]],
            ["id", "date", "picking_id"],
            { order: "date desc", limit: 10 }
          ),
        ]);
        repair._delivery_history = deliveries || [];
        repair._return_history   = returns   || [];
      } catch (_) { /* leave empty — history is informational only */ }
    }

    // Arricchisci le voci di consegna con dati dell'ordine di riparazione.
    // Fetch massivo di stock.picking per tutte le consegne per ottenere nome picking + ordine di riparazione collegato (WH/RO).
    // Saltato con grazia se il campo repair_id è assente (versioni Odoo più vecchie).
    if (repair._delivery_history.length) {
      try {
        const pickingIds = [...new Set(
          repair._delivery_history
            .map(d => Array.isArray(d.picking_id) ? d.picking_id[0] : d.picking_id)
            .filter(Boolean)
        )];
        if (pickingIds.length) {
          const pickings = await OdooRPC.searchRead(
            "stock.picking",
            [["id", "in", pickingIds]],
            ["id", "name", "date_done", "repair_id", "origin"]
          );
          const pickingById = {};
          pickings.forEach(p => { pickingById[p.id] = p; });
          repair._delivery_history = repair._delivery_history.map(d => {
            const pid = Array.isArray(d.picking_id) ? d.picking_id[0] : d.picking_id;
            const pk  = pid ? pickingById[pid] : null;
            // Preferisce campo repair_id; fallback su stringa origin (Odoo imposta origin = nome riparazione)
            let rid   = pk && pk.repair_id ? OdooRPC.m2oId(pk.repair_id)   : null;
            let rname = pk && pk.repair_id ? OdooRPC.m2oName(pk.repair_id) : null;
            if (!rid && pk && pk.origin && pk.origin === repair._name) {
              rid   = repair.id;
              rname = repair._name;
            }
            return {
              ...d,
              picking_name: pk ? pk.name : (Array.isArray(d.picking_id) ? d.picking_id[1] : ""),
              repair_id:    rid,
              repair_name:  rname,
            };
          });
        }
      } catch (_) { /* repair_id absent in this Odoo version — skip enrichment */ }
    }

    // Tipo copertura — legge prima dal DOM (già renderizzato, evita problemi di permesso su modelli ausiliari)
    repair._coverage_type = "";
    const covDom = readDomTags("coverage_type_id");
    if (covDom && covDom.length) {
      repair._coverage_type = covDom.join(", ");
    } else {
      const covRaw = repair.coverage_type_id || [];
      if (covRaw.length) {
        if (typeof covRaw[0] === "object" && covRaw[0] !== null) {
          repair._coverage_type = covRaw.map(r => r.display_name || r.name || "").filter(Boolean).join(", ");
        } else {
          const ids = covRaw.map(v => (typeof v === "number" ? v : (Array.isArray(v) ? v[0] : null))).filter(Boolean);
          if (ids.length) {
            const covModel = (schema.repairInfo["coverage_type_id"] || {}).relation || "udt.repair.coverage.type";
            try {
              const recs = await OdooRPC.searchRead(covModel, [["id", "in", ids]], ["id", "name"]);
              repair._coverage_type = recs.map(r => r.name).join(", ");
            } catch (_) { /* leave empty */ }
          }
        }
      }
    }

    repair._is_esdp = repair._coverage_type.toLowerCase().includes("esdp");

    // Tag — legge prima dal DOM
    repair._tags = [];
    const tagDom = schema.tagField ? readDomTags(schema.tagField) : null;
    if (tagDom && tagDom.length) {
      repair._tags = tagDom;
    } else if (schema.tagField && repair[schema.tagField]) {
      const tagRaw = repair[schema.tagField] || [];
      if (tagRaw.length) {
        if (typeof tagRaw[0] === "object" && tagRaw[0] !== null) {
          repair._tags = tagRaw.map(r => r.display_name || r.name || "").filter(Boolean);
        } else {
          const tagIds = tagRaw.map(v => (typeof v === "number" ? v : (Array.isArray(v) ? v[0] : null))).filter(Boolean);
          if (tagIds.length) {
            const tagModel = (schema.repairInfo[schema.tagField] || {}).relation || "repair.tag";
            try {
              const tagRecs = await OdooRPC.searchRead(tagModel, [["id", "in", tagIds]], ["id", "name"]);
              repair._tags = tagRecs.map(r => r.name);
            } catch (_) { /* leave empty */ }
          }
        }
      }
    }
    repair._tags_lower = repair._tags.map(t => t.toLowerCase().replace(/\s*-\s*/g, "-").trim());

    // Ticket
    repair._ticket_name = "";
    repair._ticket_stage = "";
    if (schema.ticketField && repair[schema.ticketField]) {
      const tid = OdooRPC.m2oId(repair[schema.ticketField]);
      if (tid) {
        try {
          const tRecs = await OdooRPC.read("helpdesk.ticket", [tid], ["name", "stage_id"]);
          if (tRecs.length) {
            repair._ticket_name = tRecs[0].name || "";
            repair._ticket_stage = OdooRPC.m2oName(tRecs[0].stage_id);
          }
        } catch (_) { /* skip */ }
      }
    }

    // Parti (stock.move)
    const moveIds = repair[schema.opsField] || repair.move_ids || [];
    repair._parts = [];
    if (moveIds.length) {
      const mFields = [...MOVE_BASE_FIELDS];
      for (const opt of MOVE_OPT_FIELDS) {
        if (opt in schema.moveInfo) mFields.push(opt);
      }
      const moves = await OdooRPC.read(schema.lineModel, moveIds, mFields);
      repair._parts = moves.map((mv, idx) => {
        const pName = OdooRPC.m2oName(mv.product_id);
        const pId = OdooRPC.m2oId(mv.product_id);
        const rlt = mv.repair_line_type || "";
        const wt = classifyWarranty(pName, "", rlt, "");
        const ps = OdooRPC.m2oName(mv.problem_statement_id || "") ||
                   mv.x_studio_problem_statement || "";
        const covName = OdooRPC.m2oName(mv.coverage_type_id || "");
        return {
          idx: idx + 1,
          move_id: mv.id,
          product_id: pId,
          product_name: pName,
          warranty_type: wt,
          repair_line_type: rlt,
          demand: parseFloat(mv.product_uom_qty) || 0,
          // qty_done (Odoo 16) o quantity (Odoo 17) — azzerato da Odoo dopo il completamento
          done: parseFloat(mv.qty_done !== undefined ? mv.qty_done : mv.quantity) || 0,
          // 'picked' (Odoo 17) / 'is_done' — il checkbox Used; rimane True dopo il completamento
          // Questo è l'indicatore di consumo più affidabile quando disponibile
          picked: mv.picked === true || mv.is_done === true,
          state: mv.state || "",
          price_unit: parseFloat(mv.price_unit) || 0,
          problem_statement: ps,
          coverage_type_name: covName,
        };
      });
    }

    // Per le riparazioni completate, Odoo cancella/azzera tutte le stock move dopo il completamento,
    // rendendo la qty RPC inaffidabile. La colonna DOM 'Done' mostra sempre il valore reale:
    // 0.00 = il tecnico ha lasciato la parte non consumata, 1.00 = correttamente consumata.
    // Nota: 'picked' è impostato da Odoo durante il flusso di completamento indipendentemente dal
    // consumo effettivo — non può essere usato come indicatore di consumo qui.
    if (repair._state === "done" && repair._parts.length) {
      const domDone = readDomPartsDone();
      if (domDone && domDone.length === repair._parts.length) {
        repair._parts.forEach((p, i) => {
          if (domDone[i] !== null) p.done = domDone[i];
        });
      }
    }

    // Recupera nomi categorie prodotto per corrispondenza riferimenti nelle note.
    // I tecnici spesso scrivono l'abbreviazione della categoria (es. "MB", "TP", "SPK", "KBB")
    // invece del nome completo della parte. Un singolo batch read copre tutti i prodotti unici.
    if (repair._parts.length) {
      const uniqueProdIds = [...new Set(repair._parts.map(p => p.product_id).filter(Boolean))];
      if (uniqueProdIds.length) {
        try {
          const prods = await OdooRPC.read("product.product", uniqueProdIds, ["id", "categ_id"]);
          const categByProdId = {};
          prods.forEach(pr => { categByProdId[pr.id] = OdooRPC.m2oName(pr.categ_id) || ""; });
          repair._parts.forEach(p => { p.categ_name = categByProdId[p.product_id] || ""; });
        } catch (_) { repair._parts.forEach(p => { p.categ_name = ""; }); }
      }
    }

    // Note di log (mail.message)
    repair._notes = [];
    try {
      const notes = await OdooRPC.searchRead("mail.message", [
        ["res_id", "=", repairId],
        ["model", "=", "repair.order"],
        ["message_type", "in", ["comment", "email", "notification"]],
      ], ["body", "date", "author_id", "subtype_id"], { limit: 50, order: "date desc" });
      repair._notes = notes;
    } catch (_) { /* skip */ }

    // Dati ordine di vendita
    repair._so = null;
    if (repair._so_id) {
      try {
        const soFields = ["id", "name", "amount_total", "amount_untaxed", "state", "order_line"];
        if (schema.soBerField) soFields.push(schema.soBerField);
        const sos = await OdooRPC.read("sale.order", [repair._so_id], soFields);
        if (sos.length) {
          const so = sos[0];
          so._is_ber = schema.soBerField ? !!so[schema.soBerField] : false;
          // Recupera righe ordine
          so._lines = [];
          if (so.order_line && so.order_line.length) {
            try {
              so._lines = await OdooRPC.read("sale.order.line", so.order_line, [
                "id", "name", "product_id", "price_unit", "product_uom_qty", "price_subtotal",
              ]);
            } catch (_) { /* skip */ }
          }
          repair._so = so;
        }
      } catch (_) { /* skip */ }
    }

    // SO effettivo — i ticket figlio/rework ereditano il SO del genitore quando non ne hanno uno.
    // Percorre l'intera catena di antenati per gestire riparazioni nipoti.
    repair._effective_so_id = repair._so_id || null;
    repair._effective_so = repair._so;
    if (!repair._so_id && repair._parent_id) {
      try {
        let cursor = repair._parent_id;
        let parentSoId = null;
        while (cursor && !parentSoId) {
          const parentRecs = await OdooRPC.read("repair.order", [cursor], ["sale_order_id", "parent_repair_id"]);
          if (!parentRecs.length) break;
          parentSoId = OdooRPC.m2oId(parentRecs[0].sale_order_id);
          if (!parentSoId) cursor = OdooRPC.m2oId(parentRecs[0].parent_repair_id);
        }
        if (parentSoId) {
            repair._effective_so_id = parentSoId;
            const soFields = ["id", "name", "amount_total", "amount_untaxed", "state", "order_line"];
            if (schema.soBerField) soFields.push(schema.soBerField);
            const sos = await OdooRPC.read("sale.order", [parentSoId], soFields);
            if (sos.length) {
              const so = sos[0];
              so._is_ber = schema.soBerField ? !!so[schema.soBerField] : false;
              so._from_parent = true;
              so._lines = [];
              if (so.order_line && so.order_line.length) {
                try {
                  so._lines = await OdooRPC.read("sale.order.line", so.order_line, [
                    "id", "name", "product_id", "price_unit", "product_uom_qty", "price_subtotal",
                  ]);
                } catch (_) { /* skip */ }
              }
              repair._effective_so = so;
            }
          }
      } catch (_) { /* skip */ }
    }

    // Membri famiglia (per validazione a livello famiglia + aggregazione costi OOW).
    // Recupera sempre: rootId è l'id del genitore quando questo è un figlio, o l'id di questa
    // riparazione quando È la root. La query restituisce root + tutti i figli in una sola chiamata.
    repair._family = [];
    repair._family_oow_cost = repair._parts
      .filter(p => p.warranty_type === "OOW")
      .reduce((s, p) => s + p.price_unit * p.demand, 0);
    let rootId = repairId;
    if (repair._parent_id) {
      try {
        let cursor = repair._parent_id;
        while (cursor) {
          const pRecs = await OdooRPC.read("repair.order", [cursor], ["parent_repair_id"]);
          if (!pRecs.length) break;
          const grandparent = OdooRPC.m2oId(pRecs[0].parent_repair_id);
          if (!grandparent) { rootId = cursor; break; }
          cursor = grandparent;
        }
      } catch (_) { rootId = repair._parent_id; }
    }
    try {
      const family = await OdooRPC.searchRead("repair.order",
        ["|", ["id", "=", rootId], ["parent_repair_id", "=", rootId]],
        ["id", "name", "state", "move_ids", "is_rework", "parent_repair_id",
         ...(schema.tagField ? [schema.tagField] : [])],
      );
      repair._family = family;

      // Fetch massivo dei record stock.move da tutti i membri famiglia eccetto sé stesso, poi somma costo OOW
      const familyMoveIds = family
        .filter(f => f.id !== repairId)
        .flatMap(f => Array.isArray(f.move_ids) ? f.move_ids : [])
        .filter(Boolean);
      if (familyMoveIds.length) {
        try {
          const famMoves = await OdooRPC.read(
            schema.lineModel, familyMoveIds,
            ["price_unit", "product_uom_qty", "repair_line_type", "product_id"]
          );
          repair._family_oow_cost += famMoves.reduce((s, mv) => {
            const rlt = mv.repair_line_type || "";
            const pName = OdooRPC.m2oName(mv.product_id) || "";
            if (classifyWarranty(pName, "", rlt, "") === "OOW") {
              return s + (parseFloat(mv.price_unit) || 0) * (parseFloat(mv.product_uom_qty) || 0);
            }
            return s;
          }, 0);
        } catch (_) { /* skip */ }
      }
    } catch (_) { /* skip */ }

    return repair;
  }

  /* ────────────────────────────────────────────────────────────────── *
   *  MOTORE DI VALIDAZIONE
   * ────────────────────────────────────────────────────────────────── */

  function validate(repair) {
    const errors = [];
    const state = repair._state || "";
    const tags = repair._tags_lower || [];
    const parts = repair._parts || [];
    const notes = repair._notes || [];
    const resolution = (repair._resolution || "").toLowerCase();

    const hasBerTag = tags.some(t => BER_RELATED_TAGS.has(t));
    const isRtcTag = tags.includes("return to customer");
    const isDismantleTag = tags.includes("ber-approved for dismantle");
    const isNoRepair = resolution.includes("no repair");
    const isParentOrChild = repair._parent_id || repair._is_rework;

    function err(sev, cat, msg) { errors.push({ severity: sev, category: cat, message: msg }); }

    /* ── Livello 1: Intestazione ─────────────────────────────────────────── */

    if (!repair._lot_name) {
      err("error", "header", "Serial/Lot number is required but missing");
    }
    if (["under_repair", "done"].includes(state) && !repair._coverage_type) {
      err("warning", "header", "Eligible coverage type is missing");
    }
    if (["under_repair", "done"].includes(state) && !repair._user_name) {
      err("warning", "header", "Responsible user is not set");
    }
    if (["confirmed", "under_repair", "done"].includes(state) && !repair._assessment_name) {
      err("warning", "header", "Assessment responsible is not set");
    }
    if (["under_repair", "done"].includes(state) && parts.length === 0 &&
        !isRtcTag && !isNoRepair && !isParentOrChild) {
      err("warning", "header", "No parts attached to repair");
    }

    /* ── Livello 1: Parti ──────────────────────────────────────────── */

    parts.forEach(p => {
      if (!p.product_name) {
        err("error", "part", `Part ${p.idx}: Missing product`);
      }
      if (p.demand <= 0) {
        err("error", "part", `Part ${p.idx} (${p.product_name || "?"}): Demand must be > 0`);
      }
      if (!p.problem_statement) {
        err("error", "part", `Part ${p.idx} (${p.product_name || "?"}): Problem statement is missing`);
      }
      if (["under_repair", "done"].includes(state) && !p.coverage_type_name) {
        err("warning", "part", `Part ${p.idx} (${p.product_name || "?"}): Coverage type not selected`);
      }
    });

    // Mismatch variante device/parte touch.
    // I dispositivi 2-in-1 hanno un touchscreen e richiedono parti nella variante touch.
    // Le parti etichettate N/T (Non-Touch) su un 2-in-1 non si adatteranno o funzioneranno correttamente.
    const deviceName = (repair._product_name || "").toLowerCase();
    const deviceIs2in1 = /2\s*n\s*1|2in1|2\s*-\s*in\s*-\s*1/.test(deviceName);
    if (deviceIs2in1) {
      parts.forEach(p => {
        const rlt = (p.repair_line_type || "").toLowerCase();
        if (rlt === "remove" || rlt === "recycle") return;
        if (/\bn\/t\b|non[- ]?touch/i.test(p.product_name || "")) {
          err("error", "part",
            `Part ${p.idx} (${p.product_name}): N/T (Non-Touch) part selected but device is a 2-in-1 (touch) model — select the correct touch-variant part number`);
        }
      });
    }

    /* ── Livello 1: Note di log ─────────────────────────────────── */

    const hasNotes = notes.length > 0;
    const noteTexts = notes.map(n => (n.body || "").replace(/<[^>]+>/g, " ").trim());
    const nonEmpty = noteTexts.filter(t => t.length > 0);

    if (state === "done" && !hasNotes) {
      err("error", "note", "Completed repair has no log notes — document the work performed");
    } else if (["confirmed", "under_repair", "on_hold"].includes(state) && !hasNotes) {
      err("warning", "note", "No log note found — add assessment/repair notes");
    }
    if (hasNotes && nonEmpty.length > 0 && nonEmpty.every(t => t.length < 10)) {
      err("warning", "note", "Log note content too brief — describe the part and issue");
    }
    if (parts.length > 0 && nonEmpty.length > 0) {
      const allText = nonEmpty.join(" ").toLowerCase();
      const anyRef = parts.some(p => {
        const name = (p.product_name || "").toLowerCase();
        const categ = (p.categ_name || "").toLowerCase();
        // Tokenizza nome parte + abbreviazione categoria (es. "MB", "TP", "SPK") —
        // i tecnici spesso usano l'abbreviazione della categoria invece del nome completo.
        const tokens = [
          ...name.split(/[^a-z0-9]+/),
          ...categ.split(/[^a-z0-9]+/),
        ].filter(w => w.length >= 2);
        return tokens.some(w => allText.includes(w));
      });
      if (!anyRef) {
        err("warning", "note", "Log note does not reference any part");
      }
    }

    /* ── Livello 1: Copertura / CHS ─────────────────────────────────── */

    const allNoteText = nonEmpty.join(" ").toLowerCase();
    const chsKeywords = ["chs", "comprehensive", "complete care", "completecare"];
    const noteRefChs = chsKeywords.some(kw => allNoteText.includes(kw));
    const coverage = (repair._coverage_type || "").toLowerCase();
    const hasChs = chsKeywords.some(kw => coverage.includes(kw));

    if (noteRefChs && !hasChs) {
      err("error", "coverage",
        `Log note requests CHS incident / IW parts but selected coverage is '${repair._coverage_type || "none"}' — no CHS coverage is present`);
    }

    const iwParts = parts.filter(p => p.warranty_type === "IW");
    if (iwParts.length > 0) {
      const iwNames = iwParts.map(p => p.product_name).join(", ");
      // Se la nota menziona CHS ma non c'è copertura CHS → le parti IW non sono valide
      if (noteRefChs && !hasChs) {
        err("error", "coverage",
          `Selected part(s) are In Warranty (${iwNames}) but device has no active CHS coverage — use OOW or BER parts`);
      }
    }

    /* ── Livello 2: Tag ↔ State workflow ───────────────────────────── */

    // HOLD_REQUIRED_TAGS → dovrebbe essere on_hold
    for (const tag of tags) {
      if (tag in HOLD_REQUIRED_TAGS && state !== "on_hold") {
        // Eccezione: stato done + tag ber sulla famiglia BER
        if (state === "done" && BER_RELATED_TAGS.has(tag) && hasBerTag) continue;
        err("error", "workflow", HOLD_REQUIRED_TAGS[tag]);
      }
    }

    // PROCESS_TAGS su bozza
    if (state === "draft") {
      for (const tag of tags) {
        if (PROCESS_TAGS.has(tag)) {
          err("error", "workflow", `Draft order has process tag '${tag}' — confirm and assess the order first`);
        }
      }
    }

    // DONE_STALE_TAGS su completato
    if (state === "done") {
      for (const tag of tags) {
        if (DONE_STALE_TAGS.has(tag)) {
          if (BER_RELATED_TAGS.has(tag) && hasBerTag) continue; // BER family exception
          err("error", "workflow", `Completed repair still has pending tag '${tag}' — remove or update tag to reflect final disposition`);
        }
      }
    }

    // Regole tag specifiche
    if (isRtcTag && state === "done" && parts.length > 0) {
      err("warning", "workflow", "Tag 'Return to Customer' on completed repair with parts — workflow says remove parts if no repair was performed");
    }

    const partsOrdered = tags.includes("parts ordered") || tags.includes("part(s) ordered");
    if (partsOrdered && state === "done") {
      err("error", "workflow", "Tag 'Parts Ordered' still set on completed repair — change to 'Part(s) Received' or remove");
    } else if (partsOrdered && state !== "on_hold" && state !== "done") {
      err("warning", "workflow", "Tag 'Parts Ordered' present but state is not On Hold — per workflow, parts-waiting orders should be on hold");
    }

    const partsReceived = tags.includes("part(s) received") || tags.includes("parts received");
    if (partsReceived && state === "on_hold") {
      err("warning", "workflow", "Tag 'Part(s) Received' set but repair still On Hold — resume repair and assign to tech");
    }

    if (isDismantleTag && parts.length > 0) {
      err("warning", "workflow", "Tag 'BER-Approved for Dismantle' — workflow says remove parts from repair order before ending");
    }
    if (isDismantleTag && !["done", "cancel"].includes(state)) {
      err("warning", "workflow", "Tag 'BER-Approved for Dismantle' — repair should be ended (Done) after dismantling");
    }
    if (tags.includes("ber-approved for repair") && state === "on_hold") {
      err("warning", "workflow", "Tag 'BER-Approved for Repair' set but repair still On Hold — resume repair so tech can continue");
    }
    if (tags.includes("customer quote approved") && state === "on_hold") {
      err("warning", "workflow", "Tag 'Customer Quote Approved' set but repair still On Hold — resume repair and notify tech");
    }
    if (tags.includes("shipped to oem") && !["on_hold", "done", "cancel"].includes(state)) {
      err("warning", "workflow", "Tag 'Shipped to OEM' — repair should be On Hold while awaiting return from OEM");
    }
    if (tags.includes("waiting on replacement device") && state === "done") {
      err("warning", "workflow", "Tag 'Waiting on Replacement Device' still set on Done repair — remove tag after replacement received");
    }

    // Il tag 'Transferred to Imaging' è obbligatorio su tutte le riparazioni non-BER.
    // Attivo in due finestre:
    //   1. under_repair — deve essere aggiunto prima di terminare la riparazione.
    //   2. done — solo finché il dispositivo è ancora in WH/Stock/OSC-Imaging (riparazione terminata
    //      senza il tag; una volta che il dispositivo lascia l'imaging il controllo non è più rilevante).
    // Esentati: riparazioni con tag BER, approvate per smontaggio, SO contrassegnato come BER,
    //           tag "Return to Customer", o risoluzione "No Repair Required" —
    //           il dispositivo non è mai andato in imaging, viene restituito così com'è.
    const isBerRepair = hasBerTag || isDismantleTag || !!(repair._effective_so && repair._effective_so._is_ber);
    if (!isBerRepair && !isRtcTag && !isNoRepair) {
      const hasImagingTag = tags.includes("transferred to imaging");
      const isAtImaging   = (repair._device_location || "").toLowerCase().includes("osc-imaging");
      if (state === "under_repair" && !hasImagingTag) {
        err("error", "workflow", "Tag 'Transferred to Imaging' is required — add the tag before ending the repair");
      } else if (state === "done" && !hasImagingTag && isAtImaging) {
        err("error", "workflow", "Repair was ended without the 'Transferred to Imaging' tag and device is still at imaging — add the tag to complete the workflow");
      }
    }

    /* ── Livello 3: Requisiti campo specifici per stato ──────────────── */

    if (state === "confirmed" && !repair._assessment_name) {
      err("error", "workflow", "Confirmed repairs must have an Assessment Responsible assigned");
    }
    if (state === "under_repair" && !repair._user_name) {
      err("error", "workflow", "Under Repair requires a Repair Responsible (user) to be assigned");
    }
    if (state === "under_repair" && !repair._assessment_name) {
      err("error", "workflow", "Under Repair requires an Assessment Responsible to be assigned");
    }
    if (state === "on_hold") {
      const hasReasonTag = tags.some(t => HOLD_REASON_TAGS.has(t));
      if (!hasReasonTag) {
        err("warning", "workflow", "On Hold repair has no reason tag — add a tag (e.g., Pending Order Parts, DOA Part, BER-Threshold Met)");
      }
    }
    if (isNoRepair && !isRtcTag) {
      // Il requisito del tag dipende dalla posizione del dispositivo — ogni posizione implica un tag workflow diverso.
      const loc = (repair._device_location || "").toLowerCase();
      const isAtImaging = loc.includes("osc-imaging");
      const isAtStaging = loc.includes("b-14") || loc.includes("staging") || loc.includes("contingence");
      const isAtQc      = loc.includes("/qc");
      if (isAtImaging && !tags.includes("transferred to imaging")) {
        err("error", "workflow", "Resolution is 'No Repair Required' and device is at imaging — add the 'Transferred to Imaging' tag");
      } else if (isAtStaging && !tags.includes("sent to contingence")) {
        err("error", "workflow", "Resolution is 'No Repair Required' and device is at staging — add the 'Sent to Contingence' tag");
      } else if (isAtQc && !tags.includes("qc completed")) {
        err("error", "workflow", "Resolution is 'No Repair Required' and device is at QC — add the 'QC Completed' tag");
      }
    }
    if (isNoRepair && parts.length > 0) {
      err("warning", "workflow", "Resolution is 'No Repair Required' but parts are attached — remove parts if device was not repaired");
    }

    // Controlli DOA
    const doaTag = tags.includes("doa part") || tags.includes("part doa");
    if (doaTag && nonEmpty.length > 0) {
      const doaKw = ["doa", "defective", "dead on arrival"];
      const notesMentionDoa = doaKw.some(kw => allNoteText.includes(kw));
      if (!notesMentionDoa) {
        err("warning", "workflow", "Tag 'DOA Part' set but log note doesn't mention 'DOA' or 'defective' — describe the defective part");
      }
    }

    // BER-parti richieste
    const berPartsReq = tags.includes("ber-parts requested") || tags.includes("ber-part(s) requested");
    if (berPartsReq) {
      err("warning", "workflow", "Tag 'BER-Parts Requested' present — review requested BER parts workflow and keep repair On Hold");
      if (!hasNotes) {
        err("error", "workflow", "Tag 'BER-Parts Requested' set but no log note — workflow requires describing which BER part is needed");
      }
    }

    /* ── Controlli consumo (blocca End Repair) ─────────────────── */

    // Casi eccezione dove non ci si aspetta che le parti siano consumate
    const skipConsumption = isNoRepair || isRtcTag || isDismantleTag;

    if (["under_repair", "done"].includes(state) && !skipConsumption) {
      const consumableParts = parts.filter(p => {
        const rlt = (p.repair_line_type || "").toLowerCase();
        return rlt !== "remove" && rlt !== "recycle";
      });
      consumableParts.forEach(p => {
        // p.done è corretto dal DOM per riparazioni completate (vedi readDomPartsDone sopra).
        // 0.00 = il tecnico non ha genuinamente consumato la parte prima di cliccare End Repair.
        // 1.00 = correttamente consumata. Non usare p.picked — Odoo lo imposta durante il
        // flusso di completamento indipendentemente dal consumo effettivo.
        const isUsed = p.done >= p.demand;
        if (!isUsed) {
          err("error", "part",
            `Part ${p.idx} (${p.product_name}): Not consumed — Done (${p.done}) of ${p.demand} required (must be marked as used before completing the repair)`);
        }
      });
    }

    /* ── Validazione BER ────────────────────────────────────────── */

    const oowParts = parts.filter(p => p.warranty_type === "OOW");
    // Parti OOW il cui tipo copertura NON è CHS — queste sono veramente fatturabili e necessitano un preventivo
    const billedOowParts = oowParts.filter(p =>
      !chsKeywords.some(kw => (p.coverage_type_name || "").toLowerCase().includes(kw))
    );
    const effectiveSo   = repair._effective_so;
    const effectiveSoId = repair._effective_so_id;

    // Le riparazioni CHS devono usare solo parti IW (In Warranty) — parti OOW e BER non sono valide.
    // Le parti Recycle/Remove sono esenti: rappresentano parti sbagliate restituite a magazzino
    // (cioè la correzione stessa), non nuove parti aggiunte alla riparazione.
    if (hasChs) {
      const nonIwParts = parts.filter(p => {
        const rlt = (p.repair_line_type || "").toLowerCase();
        if (rlt === "recycle" || rlt === "remove") return false;
        return p.warranty_type === "OOW" || p.warranty_type === "BER";
      });
      if (nonIwParts.length > 0) {
        nonIwParts.forEach(p => {
          err("error", "coverage",
            `Part ${p.idx} (${p.product_name}): ${p.warranty_type} part is not valid on a CHS repair — CHS covers physical damage under warranty; only IW (In Warranty) parts should be selected`);
        });
      }
    }

    // Le riparazioni rework NON devono avere un proprio SO collegato — il SO va sulla riparazione genitore.
    // Se un rework ha un SO diretto è stato creato prima che la validazione fosse attiva; cancellarlo per sbloccare
    // End Repair (Odoo disabilita End Repair quando un SO non cancellato è collegato direttamente alla riparazione).
    if ((repair._is_rework || repair._parent_id) && repair._so_id && state !== "draft") {
      const soName = repair._so ? repair._so.name : repair._so_id;
      const soCancelled = repair._so && repair._so.state === "cancel";
      if (!soCancelled) {
        err("error", "ber",
          `Rework: Sales Order (${soName}) is linked directly to this rework — cancel this SO to re-enable End Repair, then ensure the correct SO is linked on the parent repair instead`);
      }
    }

    // Le riparazioni CHS NON devono avere un preventivo collegato — CHS è completamente coperto in garanzia.
    // Se esiste un SO è stato creato prima che la validazione fosse attiva e deve essere cancellato.
    if (hasChs && effectiveSoId && state !== "draft") {
      const effectiveSoCancelled = repair._effective_so && repair._effective_so.state === "cancel";
      if (!effectiveSoCancelled) {
        const soName = repair._effective_so ? repair._effective_so.name : effectiveSoId;
        const fromParent = repair._effective_so && repair._effective_so._from_parent ? " (inherited from parent repair)" : "";
        err("error", "coverage",
          `CHS repair has a linked Quotation/Sales Order (${soName}${fromParent}) — CHS is covered under warranty and requires no quotation; cancel or remove the linked SO`);
      }
    }

    // La copertura ESDP richiede un preventivo collegato solo se ci sono parti OOW — la copertura base (es. ND Dell)
    // copre i malfunzionamenti in garanzia e non richiede preventivo se tutti i pezzi sono IW.
    const hasOowParts = parts.some(p => (p.warranty_type || "").toUpperCase() === "OOW");
    if (repair._is_esdp && !isNoRepair && state !== "draft" && !effectiveSoId && hasOowParts) {
      err("error", "ber",
        "ESDP coverage requires a linked Quotation/Sales Order — create and link a quotation before completing the repair");
    }

    // ESDP: qualsiasi parte Recycle/Remove (rettifiche inventario — parti sbagliate sostituite)
    // devono essere riflesse nel SO collegato affinché la fatturazione resti accurata.
    if (repair._is_esdp && effectiveSoId && effectiveSo && state !== "draft") {
      const adjustmentParts = parts.filter(p => {
        const rlt = (p.repair_line_type || "").toLowerCase();
        return rlt === "recycle" || rlt === "remove";
      });
      if (adjustmentParts.length > 0) {
        err("warning", "ber",
          `ESDP: ${adjustmentParts.length} inventory adjustment part(s) present — verify all are accounted for on the linked Sales Order (${effectiveSo.name})`);
      }
    }

    if (state !== "draft" && effectiveSo) {
      const soLabel = effectiveSo._from_parent
        ? ` (${effectiveSo.name} — inherited from parent repair)`
        : ` (${effectiveSo.name})`;

      // Ogni riparazione con un SO deve avere una riga Manodopera nel preventivo.
      // Eccezioni: CHS (completamente coperto in garanzia), rework (la manodopera è sul SO della riparazione genitore), No Repair Required (nessuna riparazione eseguita).
      const isRework = repair._is_rework || !!repair._parent_id;
      const hasLabor = effectiveSo._lines.some(l =>
        (OdooRPC.m2oName(l.product_id) || l.name || "").toLowerCase().includes("labor")
      );
      if (!hasLabor && !hasChs && !isRework && !isNoRepair) {
        err("error", "ber", `BER: Quotation${soLabel} is missing a Labor line`);
      }

      // No Repair Required: il SO collegato deve essere cancellato — Odoo non permette di completare la riparazione con un SO attivo.
      if (isNoRepair && effectiveSo.state !== "cancel") {
        err("error", "ber", `No Repair Required: Quotation${soLabel} must be cancelled before completing the repair`);
      }

      // Rework: ogni parte OOW di tipo Add deve comparire nel SO genitore per essere fatturata correttamente.
      if (isRework && effectiveSo._from_parent) {
        const addOowParts = parts.filter(p =>
          (p.repair_line_type || "").toLowerCase() === "add" && p.warranty_type === "OOW"
        );
        addOowParts.forEach(p => {
          const inSo = effectiveSo._lines.some(l => OdooRPC.m2oId(l.product_id) === p.product_id);
          if (!inSo) {
            err("error", "ber",
              `Rework: Part ${p.idx} (${p.product_name}) is not listed in the parent SO (${effectiveSo.name}) — add this OOW part to the parent's quotation before completing`);
          }
        });
      }

      if (effectiveSo._is_ber) {
        // SO contrassegnato come BER — la riparazione dovrebbe essere On Hold a meno che un figlio attivo la gestisca
        if (state !== "on_hold") {
          const hasActiveChild = repair._family.some(f =>
            f.is_rework && f.id !== repair.id && !["done", "cancel"].includes(f.state)
          );
          if (!hasActiveChild) {
            err("error", "ber", `BER: Sale order${soLabel} is flagged as BER but repair is not On Hold — place on hold immediately`);
          }
        }
        if (!hasBerTag) {
          err("error", "ber", `BER: SO${soLabel} is flagged as BER but repair has no BER-related tag — add 'BER-Threshold Met' or 'BER-Pending Approval'`);
        }
      }
    }

    // Nessun SO ma parti OOW fatturate presenti → preventivo mancante
    // Le parti con tipo copertura CHS sono esentate — CHS le copre, nessun preventivo necessario
    if (state !== "draft" && !effectiveSoId && billedOowParts.length > 0) {
      err("error", "ber",
        `BER: Quotation/Sales Order not linked — ${billedOowParts.length} OOW part(s) present (not covered by CHS)`);
    }

    // Costo OOW complessivo famiglia vs. soglia BER
    // Salta interamente quando CHS è attivo — le parti OOW coperte da CHS non contano verso il costo BER
    const familyCost = repair._family_oow_cost || 0;
    if (state !== "draft" && !hasChs && familyCost >= BER_THRESHOLD && !hasBerTag) {
      const scope = repair._parent_id || repair._is_rework ? "family" : "repair";
      err("error", "ber",
        `BER threshold met: ${scope} OOW cost $${familyCost.toFixed(2)} ≥ $${BER_THRESHOLD} — add tag 'BER-Threshold Met' and place repair On Hold`);
    }

    return errors;
  }

  /* ────────────────────────────────────────────────────────────────── *
   *  API PUBBLICA
   * ────────────────────────────────────────────────────────────────── */

  async function validateRepair(repairId) {
    const repair = await fetchRepair(repairId);
    if (!repair) throw new Error(`Repair ${repairId} not found`);

    const errors = validate(repair);
    const errorCount = errors.filter(e => e.severity === "error").length;
    const warningCount = errors.filter(e => e.severity === "warning").length;

    return {
      id: repair.id,
      name: repair._name,
      state: repair._state,
      lot_name: repair._lot_name,
      device_location: repair._device_location,
      product_name: repair._product_name,
      partner_name: repair._partner_name,
      coverage_type: repair._coverage_type,
      is_esdp: repair._is_esdp || false,
      user_name: repair._user_name,
      assessment_name: repair._assessment_name,
      resolution: repair._resolution,
      tags: repair._tags,
      ticket_name: repair._ticket_name,
      ticket_stage: repair._ticket_stage,
      so_name: repair._so ? repair._so.name : null,
      effective_so_name: repair._effective_so ? repair._effective_so.name : null,
      effective_so_from_parent: repair._effective_so ? !!repair._effective_so._from_parent : false,
      family_oow_cost: repair._family_oow_cost || 0,
      family_size: repair._family.length || 1,
      parent_repair_id: repair._parent_id || null,
      parts: repair._parts,
      delivery_history: repair._delivery_history || [],
      return_history:   repair._return_history   || [],
      errors,
      error_count: errorCount,
      warning_count: warningCount,
      has_errors: errorCount > 0,
      has_warnings: warningCount > 0,
    };
  }

  /** Resetta lo schema in cache (es. dopo aver navigato su un'altra istanza Odoo). */
  function resetSchema() { _schemaCache = null; }

  return { validateRepair, resetSchema, classifyWarranty };
})();
