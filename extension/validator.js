/* ═══════════════════════════════════════════════════════════════════════
   validator.js — Standalone repair validation engine.
   Fetches all needed data from Odoo via JSON-RPC and runs every
   validation rule that the Python sync_engine applies.
   ═══════════════════════════════════════════════════════════════════════ */

// eslint-disable-next-line no-unused-vars
const Validator = (() => {
  "use strict";

  /* ────────────────────────────────────────────────────────────────── *
   *  TAG CONSTANTS (mirrors sync_engine.py)
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

  /** OOW cost (family-wide, USD) that triggers BER workflow — mirrors Odoo config. */
  const BER_THRESHOLD = 250;

  /* ────────────────────────────────────────────────────────────────── *
   *  WARRANTY CLASSIFICATION
   * ────────────────────────────────────────────────────────────────── */

  function classifyWarranty(productName, productCode, repairLineType, categName) {
    // Step 1: repair_line_type
    if (repairLineType) {
      const rlt = String(repairLineType).toLowerCase();
      if (rlt.includes("oow") || rlt.includes("out")) return "OOW";
      if (rlt.includes("ber") || rlt.includes("beyond")) return "BER";
      if (rlt.includes("iw") || rlt.includes("in_warranty") || rlt.includes("in warranty")) return "IW";
    }
    // Step 2: product code/name for OOW/BER
    for (const text of [productCode || "", productName || ""]) {
      const up = text.toUpperCase();
      if (up.includes("-OOW") || up.includes(" OOW")) return "OOW";
      if (up.includes("-BER") || up.includes(" BER")) return "BER";
    }
    // Step 3: IW suffix
    for (const text of [productCode || "", productName || ""]) {
      const up = text.trim().toUpperCase();
      if (up.endsWith(" IW") || up.endsWith("-IW")) return "IW";
    }
    // Step 4: categ_name
    if (categName) {
      const cat = String(categName).toUpperCase();
      if (cat.includes("-OOW") || cat.includes(" OOW")) return "OOW";
      if (cat.includes("-BER") || cat.includes(" BER")) return "BER";
      if (cat.includes("-IW") || cat.endsWith("/ IW")) return "IW";
    }
    return "Unknown";
  }

  /* ────────────────────────────────────────────────────────────────── *
   *  SCHEMA DISCOVERY (run once, cached)
   * ────────────────────────────────────────────────────────────────── */

  let _schemaCache = null;

  async function discoverSchema() {
    if (_schemaCache) return _schemaCache;
    const repairInfo = await OdooRPC.fieldsGet("repair.order");

    // ops field / line model
    const opsField = repairInfo["move_ids"] ? "move_ids" : null;
    const lineModel = opsField ? (repairInfo[opsField].relation || "stock.move") : "stock.move";

    // tag field
    let tagField = null;
    for (const [fname, fmeta] of Object.entries(repairInfo)) {
      if ((fmeta.string || "").toLowerCase().includes("tag") &&
          ["many2many", "one2many"].includes(fmeta.type)) {
        tagField = fname;
        break;
      }
    }

    // ticket field
    let ticketField = null;
    for (const [fname, fmeta] of Object.entries(repairInfo)) {
      if (fmeta.type === "many2one" && (fmeta.relation || "").includes("helpdesk.ticket")) {
        ticketField = fname;
        break;
      }
    }

    // line model schema
    const moveInfo = await OdooRPC.fieldsGet(lineModel);

    // sale.order BER field
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

    _schemaCache = { repairInfo, opsField, lineModel, moveInfo, tagField, ticketField, soBerField };
    return _schemaCache;
  }

  /* ────────────────────────────────────────────────────────────────── *
   *  DOM READERS
   *  Content script runs on the Odoo page — read rendered values
   *  directly from the DOM when possible (avoids permission errors on
   *  auxiliary models like udt.repair.coverage.type).
   * ────────────────────────────────────────────────────────────────── */

  function readDomTags(fieldName) {
    // Odoo renders many2many tag fields as .o_tag_badge_text inside [name="fieldname"]
    const els = document.querySelectorAll(`[name="${fieldName}"] .o_tag_badge_text`);
    if (els.length) return Array.from(els).map(el => el.textContent.trim()).filter(Boolean);
    // Fallback: badges/pills
    const badges = document.querySelectorAll(`[name="${fieldName}"] .badge`);
    if (badges.length) return Array.from(badges).map(el => el.textContent.trim()).filter(Boolean);
    return null;
  }

  function readDomField(fieldName) {
    // Reads the text content of a rendered field
    const el = document.querySelector(`[name="${fieldName}"] .o_field_widget, [name="${fieldName}"]`);
    return el ? el.textContent.trim() || null : null;
  }

  function readDomPartsDone() {
    // Reads the Done quantity for each row of the repair parts list, in DOM order.
    // This is the only reliable source for done repairs: Odoo cancels/zeroes the
    // stock.move quantity after repair completion, but the UI always shows the
    // correct consumed qty (0.00 = not consumed by tech, 1.00 = properly consumed).
    // Tries Odoo 17 field name ('quantity') then Odoo 16 ('qty_done').
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
    "repair_resolution_ids", "schedule_date", "write_date", "create_date",
    "move_ids", "internal_notes", "sale_order_id", "is_rework", "parent_repair_id",
  ];

  const MOVE_BASE_FIELDS = [
    "id", "product_id", "product_uom_qty", "quantity", "state",
    "name", "repair_line_type", "write_date", "price_unit",
  ];

  // Optional fields that may exist
  const MOVE_OPT_FIELDS = [
    "problem_statement_id", "x_studio_problem_statement", "coverage_type_id",
    "qty_done",   // Odoo 16 name for done quantity (renamed to 'quantity' in Odoo 17)
    "picked",     // Odoo 17 boolean — the 'Used' checkbox; stays True after repair completion
    "is_done",    // Some Odoo versions / custom modules use this name instead
  ];

  async function fetchRepair(repairId) {
    const schema = await discoverSchema();

    // Build repair field list
    const rFields = [...REPAIR_BASE_FIELDS];
    if (schema.tagField && !rFields.includes(schema.tagField)) rFields.push(schema.tagField);
    if (schema.ticketField && !rFields.includes(schema.ticketField)) rFields.push(schema.ticketField);
    // Filter to only existing fields
    const validRFields = rFields.filter(f => f in schema.repairInfo);

    const repairs = await OdooRPC.searchRead("repair.order", [["id", "=", repairId]], validRFields);
    if (!repairs.length) return null;
    const repair = repairs[0];

    // Resolve many2one display names
    repair._name = repair.name;
    repair._state = repair.state;
    repair._lot_name = OdooRPC.m2oName(repair.lot_id);
    repair._partner_name = OdooRPC.m2oName(repair.partner_id);
    repair._product_name = OdooRPC.m2oName(repair.product_id);
    repair._product_id = OdooRPC.m2oId(repair.product_id);
    repair._user_name = OdooRPC.m2oName(repair.user_id);
    repair._assessment_name = OdooRPC.m2oName(repair.assessment_responsible_id);
    // repair_resolution_ids is a Many2many — search_read returns only IDs.
    // Batch-fetch the names so validation checks can match on text.
    repair._resolution = "";
    const resolutionIds = Array.isArray(repair.repair_resolution_ids) ? repair.repair_resolution_ids : [];
    if (resolutionIds.length) {
      try {
        const resRecs = await OdooRPC.searchRead(
          "repair.resolution",
          [["id", "in", resolutionIds]],
          ["id", "name"]
        );
        repair._resolution = resRecs.map(r => r.name).join(", ");
      } catch (_) { /* field may not exist on all Odoo versions */ }
    }
    repair._so_id = OdooRPC.m2oId(repair.sale_order_id);
    repair._is_rework = repair.is_rework || false;
    repair._parent_id = OdooRPC.m2oId(repair.parent_repair_id);

    // Device location — query stock.quant by lot_id to find where the unit is right now
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

    // Delivery & return history — query stock.move.line by lot_id to find all customer deliveries.
    // location_dest_id.usage = "customer" → device went TO the customer (delivery / pickup)
    // location_id.usage = "customer"      → device came BACK from the customer (return / receipt)
    // Both queries run in parallel and default to [] on any error.
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

    // Enrich delivery entries with repair order data.
    // Batch-fetch stock.picking for all deliveries to get picking name + linked repair order (WH/RO).
    // Gracefully skipped if repair_id field is absent (older Odoo versions).
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
            // Prefer repair_id field; fall back to origin string match (Odoo sets origin = repair name)
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

    // Coverage type — read from DOM first (already rendered, avoids auxiliary model permission issues)
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

    // Tags — read from DOM first
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

    // Parts (stock.move)
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
          // qty_done (Odoo 16) or quantity (Odoo 17) — zeroed by Odoo after repair completion
          done: parseFloat(mv.qty_done !== undefined ? mv.qty_done : mv.quantity) || 0,
          // 'picked' (Odoo 17) / 'is_done' — the Used checkbox; stays True post-completion
          // This is the most reliable consumed indicator when available
          picked: mv.picked === true || mv.is_done === true,
          state: mv.state || "",
          price_unit: parseFloat(mv.price_unit) || 0,
          problem_statement: ps,
          coverage_type_name: covName,
        };
      });
    }

    // For done repairs, Odoo cancels/zeroes all demand stock moves after completion,
    // making RPC qty unreliable. The DOM 'Done' column always shows the real value:
    // 0.00 = tech left the part unconsumed, 1.00 = properly consumed.
    // Note: 'picked' is set by Odoo during the completion flow regardless of actual
    // consumption — it cannot be trusted as a consumed indicator here.
    if (repair._state === "done" && repair._parts.length) {
      const domDone = readDomPartsDone();
      if (domDone && domDone.length === repair._parts.length) {
        repair._parts.forEach((p, i) => {
          if (domDone[i] !== null) p.done = domDone[i];
        });
      }
    }

    // Fetch product category names for note-reference matching.
    // Techs often write the category abbreviation (e.g. "MB", "TP", "SPK", "KBB")
    // instead of the full part name. One batch read covers all unique products.
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

    // Log notes (mail.message)
    repair._notes = [];
    try {
      const notes = await OdooRPC.searchRead("mail.message", [
        ["res_id", "=", repairId],
        ["model", "=", "repair.order"],
        ["message_type", "in", ["comment", "email", "notification"]],
      ], ["body", "date", "author_id", "subtype_id"], { limit: 50, order: "date desc" });
      repair._notes = notes;
    } catch (_) { /* skip */ }

    // Sale order data
    repair._so = null;
    if (repair._so_id) {
      try {
        const soFields = ["id", "name", "amount_total", "amount_untaxed", "state", "order_line"];
        if (schema.soBerField) soFields.push(schema.soBerField);
        const sos = await OdooRPC.read("sale.order", [repair._so_id], soFields);
        if (sos.length) {
          const so = sos[0];
          so._is_ber = schema.soBerField ? !!so[schema.soBerField] : false;
          // Fetch order lines
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

    // Effective SO — child/rework tickets inherit the parent's SO when they have none.
    // Walks the full ancestor chain to handle grandchild repairs.
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

    // Family members (for family-level validation + OOW cost aggregation).
    // Always fetch: rootId is parent's id when this is a child, or this repair's id
    // when it IS the root. The query returns the root + all its children in one call.
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

      // Batch-fetch move records from all family members except self, then sum OOW cost
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
   *  VALIDATION ENGINE
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

    /* ── Tier 1: Header ─────────────────────────────────────────── */

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

    /* ── Tier 1: Parts ──────────────────────────────────────────── */

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

    // Device/part touch variant mismatch.
    // 2-in-1 devices have a touchscreen and require touch-variant parts.
    // Parts labelled N/T (Non-Touch) on a 2-in-1 will not fit or function correctly.
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

    /* ── Tier 1: Log notes ──────────────────────────────────────── */

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
        // Tokenize part name + category abbreviation (e.g. "MB", "TP", "SPK") —
        // techs often use the category shorthand rather than the full part name.
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

    /* ── Tier 1: Coverage / CHS ─────────────────────────────────── */

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
      // If note mentions CHS but no CHS coverage → IW parts invalid
      if (noteRefChs && !hasChs) {
        err("error", "coverage",
          `Selected part(s) are In Warranty (${iwNames}) but device has no active CHS coverage — use OOW or BER parts`);
      }
    }

    /* ── Tier 2: Tag ↔ State workflow ───────────────────────────── */

    // HOLD_REQUIRED_TAGS → should be on_hold
    for (const tag of tags) {
      if (tag in HOLD_REQUIRED_TAGS && state !== "on_hold") {
        // Exception: done state + ber tag on BER family
        if (state === "done" && BER_RELATED_TAGS.has(tag) && hasBerTag) continue;
        err("error", "workflow", HOLD_REQUIRED_TAGS[tag]);
      }
    }

    // PROCESS_TAGS on draft
    if (state === "draft") {
      for (const tag of tags) {
        if (PROCESS_TAGS.has(tag)) {
          err("error", "workflow", `Draft order has process tag '${tag}' — confirm and assess the order first`);
        }
      }
    }

    // DONE_STALE_TAGS on done
    if (state === "done") {
      for (const tag of tags) {
        if (DONE_STALE_TAGS.has(tag)) {
          if (BER_RELATED_TAGS.has(tag) && hasBerTag) continue; // BER family exception
          err("error", "workflow", `Completed repair still has pending tag '${tag}' — remove or update tag to reflect final disposition`);
        }
      }
    }

    // Specific tag rules
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

    // 'Transferred to Imaging' tag is required on all non-BER repairs.
    // Active in two windows:
    //   1. under_repair — must be added before ending the repair.
    //   2. done — only while device is still at WH/Stock/OSC-Imaging (repair was ended
    //      without the tag; once the device leaves imaging the check is no longer relevant).
    // Exempt: BER-tagged repairs, BER-approved for dismantle, SO flagged as BER,
    //         "Return to Customer" tag, or "No Repair Required" resolution —
    //         device never went to imaging, it is being returned as-is.
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

    /* ── Tier 3: State-specific field requirements ──────────────── */

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
      err("error", "workflow", "Resolution is 'No Repair Required' but missing 'Return to Customer' tag");
    }
    if (isNoRepair && parts.length > 0) {
      err("warning", "workflow", "Resolution is 'No Repair Required' but parts are attached — remove parts if device was not repaired");
    }

    // DOA checks
    const doaTag = tags.includes("doa part") || tags.includes("part doa");
    if (doaTag && nonEmpty.length > 0) {
      const doaKw = ["doa", "defective", "dead on arrival"];
      const notesMentionDoa = doaKw.some(kw => allNoteText.includes(kw));
      if (!notesMentionDoa) {
        err("warning", "workflow", "Tag 'DOA Part' set but log note doesn't mention 'DOA' or 'defective' — describe the defective part");
      }
    }

    // BER-parts requested
    const berPartsReq = tags.includes("ber-parts requested") || tags.includes("ber-part(s) requested");
    if (berPartsReq) {
      err("warning", "workflow", "Tag 'BER-Parts Requested' present — review requested BER parts workflow and keep repair On Hold");
      if (!hasNotes) {
        err("error", "workflow", "Tag 'BER-Parts Requested' set but no log note — workflow requires describing which BER part is needed");
      }
    }

    /* ── Consumption checks (blocks End Repair) ─────────────────── */

    // Exception cases where parts are not expected to be consumed
    const skipConsumption = isNoRepair || isRtcTag || isDismantleTag;

    if (["under_repair", "done"].includes(state) && !skipConsumption) {
      const consumableParts = parts.filter(p => {
        const rlt = (p.repair_line_type || "").toLowerCase();
        return rlt !== "remove" && rlt !== "recycle";
      });
      consumableParts.forEach(p => {
        // p.done is DOM-corrected for done repairs (see readDomPartsDone above).
        // 0.00 = tech genuinely did not consume the part before clicking End Repair.
        // 1.00 = properly consumed. Do not use p.picked — Odoo sets it during the
        // completion flow regardless of actual consumption.
        const isUsed = p.done >= p.demand;
        if (!isUsed) {
          err("error", "part",
            `Part ${p.idx} (${p.product_name}): Not consumed — Done (${p.done}) of ${p.demand} required (must be marked as used before completing the repair)`);
        }
      });
    }

    /* ── BER Validation ─────────────────────────────────────────── */

    const oowParts = parts.filter(p => p.warranty_type === "OOW");
    // OOW parts whose coverage type is NOT CHS — these are truly billable and need a quotation
    const billedOowParts = oowParts.filter(p =>
      !chsKeywords.some(kw => (p.coverage_type_name || "").toLowerCase().includes(kw))
    );
    const effectiveSo   = repair._effective_so;
    const effectiveSoId = repair._effective_so_id;

    // CHS repairs must only use IW (In Warranty) parts — OOW and BER parts are invalid.
    // Recycle/Remove parts are exempted: they represent wrong parts being returned to stock
    // (i.e. the correction itself), not new parts being added to the repair.
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

    // Rework repairs must NOT have their own SO directly linked — the SO belongs on the parent repair.
    // If a rework has a direct SO it was created before validation was live; cancel it to unblock
    // End Repair (Odoo disables End Repair when a non-cancelled SO is directly linked to the repair).
    if ((repair._is_rework || repair._parent_id) && repair._so_id && state !== "draft") {
      const soName = repair._so ? repair._so.name : repair._so_id;
      const soCancelled = repair._so && repair._so.state === "cancel";
      if (!soCancelled) {
        err("error", "ber",
          `Rework: Sales Order (${soName}) is linked directly to this rework — cancel this SO to re-enable End Repair, then ensure the correct SO is linked on the parent repair instead`);
      }
    }

    // CHS repairs must NOT have a linked quotation — CHS is fully covered under warranty.
    // If an SO exists it was created before validation was live and must be cancelled.
    if (hasChs && effectiveSoId && state !== "draft") {
      const effectiveSoCancelled = repair._effective_so && repair._effective_so.state === "cancel";
      if (!effectiveSoCancelled) {
        const soName = repair._effective_so ? repair._effective_so.name : effectiveSoId;
        const fromParent = repair._effective_so && repair._effective_so._from_parent ? " (inherited from parent repair)" : "";
        err("error", "coverage",
          `CHS repair has a linked Quotation/Sales Order (${soName}${fromParent}) — CHS is covered under warranty and requires no quotation; cancel or remove the linked SO`);
      }
    }

    // ESDP coverage requires a linked quotation (unless resolution is "no repair required")
    if (repair._is_esdp && !isNoRepair && state !== "draft" && !effectiveSoId) {
      err("error", "ber",
        "ESDP coverage requires a linked Quotation/Sales Order — create and link a quotation before completing the repair");
    }

    // ESDP: any Recycle/Remove parts (inventory adjustments — wrong parts being swapped out)
    // must be reflected on the linked SO so billing stays accurate.
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

      // Every repair with a SO must have a Labor line on the quotation.
      // Exceptions: CHS (fully covered under warranty), reworks (labor is on the parent repair's SO).
      const isRework = repair._is_rework || !!repair._parent_id;
      const hasLabor = effectiveSo._lines.some(l =>
        (OdooRPC.m2oName(l.product_id) || l.name || "").toLowerCase().includes("labor")
      );
      if (!hasLabor && !hasChs && !isRework) {
        err("error", "ber", `BER: Quotation${soLabel} is missing a Labor line`);
      }

      // Rework: every Add-type OOW part must appear in the parent SO so it gets billed correctly.
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
        // SO flagged as BER — repair should be On Hold unless an active child is handling it
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

    // No SO but billed OOW parts present → missing quotation
    // Parts whose coverage type is CHS are exempt — CHS covers them, no quotation needed
    if (state !== "draft" && !effectiveSoId && billedOowParts.length > 0) {
      err("error", "ber",
        `BER: Quotation/Sales Order not linked — ${billedOowParts.length} OOW part(s) present (not covered by CHS)`);
    }

    // Family-wide OOW cost vs. BER threshold
    // Skip entirely when CHS is active — CHS-covered OOW parts do not count toward BER cost
    const familyCost = repair._family_oow_cost || 0;
    if (state !== "draft" && !hasChs && familyCost >= BER_THRESHOLD && !hasBerTag) {
      const scope = repair._parent_id || repair._is_rework ? "family" : "repair";
      err("error", "ber",
        `BER threshold met: ${scope} OOW cost $${familyCost.toFixed(2)} ≥ $${BER_THRESHOLD} — add tag 'BER-Threshold Met' and place repair On Hold`);
    }

    return errors;
  }

  /* ────────────────────────────────────────────────────────────────── *
   *  PUBLIC API
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

  /** Reset cached schema (e.g. after navigating to a different Odoo instance). */
  function resetSchema() { _schemaCache = null; }

  return { validateRepair, resetSchema, classifyWarranty };
})();
