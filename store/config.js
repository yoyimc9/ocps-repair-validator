/* ═══════════════════════════════════════════════════════════════════════
   config.js — Client-side loader per la config dinamica server-driven.
   Espone Config.get() che restituisce un blob aggregato cacheato 5 min.
   I valori del server sovrascrivono i DEFAULTS bakeati qui.
   ═══════════════════════════════════════════════════════════════════════ */

// eslint-disable-next-line no-unused-vars
const Config = (() => {
  "use strict";

  // Fallback usati se il server è irraggiungibile o la chiamata fallisce.
  // Devono restare allineati a server/data/*.json.
  const DEFAULTS = {
    printers: {
      printers: [{
        id: "zt230-default",
        name: "Zebra ZT230",
        host: "10.56.67.23",
        port: 80,
        path: "/pstprnt",
        dpi: 203,
        label_width_in: 4,
        label_length_in: 7,
        default: true,
      }],
    },
    tagDictionary: {
      HOLD_REQUIRED_TAGS: {},  // popolato dal server; vuoto = usa hardcoded fallback in validator
      HOLD_REASON_TAGS: [],
      PROCESS_TAGS: [],
      BER_RELATED_TAGS: [],
      DONE_STALE_TAGS: [],
    },
    featureFlags: {
      categories: {
        header: true, part: true, note: true,
        coverage: true, workflow: true, ber: true,
      },
      rules: {},
    },
    thresholds: {
      ber_threshold_usd: 250,
      rpc_revalidate_debounce_ms: 2500,
      dom_revalidate_debounce_ms: 1500,
      recent_repair_warning_days: 30,
    },
    labelTemplates: {
      product_label: {
        width_dots: 812,
        length_dots: 1421,
        show_received: true,
        show_parts: true,
        max_parts_lines: 5,
        elements: {
          title:    { enabled: true, x: 720, y: 60, w: 1300, font: 55, lines: 2 },
          customer: { enabled: true, x: 620, y: 60, w: 1300, font: 32, lines: 2 },
          received: { enabled: true, x: 540, y: 60, w: 1300, font: 28, lines: 1 },
          code:     { enabled: true, x: 470, y: 60, w: 1300, font: 38, lines: 1 },
          parts:    { enabled: true, x: 400, y: 60, w: 1300, font: 26, lines: 5 },
          barcode:  { enabled: true, x: 60,  y: 60, w: 1300, h: 180 },
        },
      },
    },
  };

  const TTL_MS = 5 * 60 * 1000;
  const STORAGE_KEY = "ocps_ext_config_v1";

  let _cached = null;        // blob in memoria
  let _cachedAt = 0;
  let _inflight = null;      // promise di fetch in corso (dedupe)

  function _serverBase() {
    return (typeof OCPS_SERVER_URL === "string" && OCPS_SERVER_URL) ||
           "http://10.56.65.139:3131";
  }

  function _merge(defaults, override) {
    if (!override || typeof override !== "object") return defaults;
    const out = {};
    for (const k of Object.keys(defaults)) {
      const dv = defaults[k];
      const ov = override[k];
      if (ov === undefined || ov === null) {
        out[k] = dv;
      } else if (dv && typeof dv === "object" && !Array.isArray(dv) &&
                 typeof ov === "object" && !Array.isArray(ov)) {
        out[k] = _merge(dv, ov);
      } else {
        out[k] = ov;
      }
    }
    // chiavi extra dal server
    for (const k of Object.keys(override)) {
      if (!(k in out)) out[k] = override[k];
    }
    return out;
  }

  async function _loadFromStorage() {
    try {
      const r = await new Promise(res =>
        chrome.storage.local.get([STORAGE_KEY], res));
      const stored = r[STORAGE_KEY];
      if (stored && stored.blob && (Date.now() - stored.ts) < TTL_MS) {
        _cached = stored.blob;
        _cachedAt = stored.ts;
        return stored.blob;
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  async function _saveToStorage(blob) {
    try {
      await new Promise(res => chrome.storage.local.set(
        { [STORAGE_KEY]: { blob, ts: Date.now() } }, res));
    } catch (_) { /* ignore */ }
  }

  async function _fetch() {
    const url = _serverBase().replace(/\/+$/, "") + "/api/ext-config";
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const remote = await r.json();
      const merged = _merge(DEFAULTS, remote || {});
      _cached = merged;
      _cachedAt = Date.now();
      _saveToStorage(merged);
      return merged;
    } catch (_) {
      clearTimeout(t);
      // fallback: storage cached oppure DEFAULTS bakeati
      if (_cached) return _cached;
      const fromDisk = await _loadFromStorage();
      return fromDisk || DEFAULTS;
    }
  }

  /** Restituisce il blob config corrente (cached o fresh). */
  async function get() {
    const now = Date.now();
    if (_cached && (now - _cachedAt) < TTL_MS) return _cached;
    if (_inflight) return _inflight;
    _inflight = _fetch().finally(() => { _inflight = null; });
    return _inflight;
  }

  /** Forza refresh ignorando la cache (chiamato dall'event poller). */
  async function invalidate() {
    _cached = null;
    _cachedAt = 0;
    return get();
  }

  /** Restituisce la stampante di default o la prima disponibile. */
  function defaultPrinter(blob) {
    const list = (blob && blob.printers && blob.printers.printers) || [];
    return list.find(p => p.default) || list[0] || DEFAULTS.printers.printers[0];
  }

  return { get, invalidate, defaultPrinter, DEFAULTS };
})();
