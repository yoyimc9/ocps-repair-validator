/* ═══════════════════════════════════════════════════════════════════════
   odoo-rpc.js — Lightweight Odoo JSON-RPC client for the browser.
   Uses /web/dataset/call_kw with the session cookie (same origin).
   ═══════════════════════════════════════════════════════════════════════ */

// eslint-disable-next-line no-unused-vars
const OdooRPC = (() => {
  "use strict";

  let _uid = null;
  let _rpcId = 0;

  /* ── Low-level web RPC (session-authenticated) ─────────────────── */

  async function callKw(model, method, args, kwargs) {
    _rpcId++;
    const payload = {
      jsonrpc: "2.0",
      id: _rpcId,
      method: "call",
      params: {
        model,
        method,
        args: args || [],
        kwargs: kwargs || {},
      },
    };
    const url = `/web/dataset/call_kw/${model}/${method}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (json.error) {
      const msg =
        json.error.data?.message || json.error.message || "RPC error";
      throw new Error(msg);
    }
    return json.result;
  }

  /* ── Session check ─────────────────────────────────────────────── */

  async function ensureSession() {
    if (_uid) return _uid;
    try {
      const resp = await fetch("/web/session/get_session_info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ jsonrpc: "2.0", id: ++_rpcId, method: "call", params: {} }),
      });
      const json = await resp.json();
      if (json.result && json.result.uid) {
        _uid = json.result.uid;
        return _uid;
      }
    } catch (_) { /* fall through */ }
    throw new Error("Not logged in to Odoo");
  }

  /* ── High-level helpers ────────────────────────────────────────── */

  async function searchRead(model, domain, fields, opts = {}) {
    await ensureSession();
    const kwargs = { fields, limit: opts.limit || 0 };
    if (opts.offset) kwargs.offset = opts.offset;
    if (opts.order) kwargs.order = opts.order;
    return callKw(model, "search_read", [domain], kwargs);
  }

  async function read(model, ids, fields) {
    if (!ids.length) return [];
    await ensureSession();
    return callKw(model, "read", [ids], { fields });
  }

  async function fieldsGet(model, attributes) {
    await ensureSession();
    return callKw(model, "fields_get", [], {
      attributes: attributes || ["string", "type", "relation"],
    });
  }

  /* ── Many2one helpers ──────────────────────────────────────────── */

  function m2oId(val) {
    if (Array.isArray(val)) return val[0] || null;
    if (typeof val === "number") return val;
    return null;
  }

  function m2oName(val) {
    if (Array.isArray(val)) return val[1] || "";
    if (typeof val === "string") return val;
    return "";
  }

  /* ── Public API ────────────────────────────────────────────────── */

  return { callKw, ensureSession, searchRead, read, fieldsGet, m2oId, m2oName };
})();
