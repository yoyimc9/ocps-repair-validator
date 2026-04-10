/* ═══════════════════════════════════════════════════════════════════════
   background.js — Service worker MV3: ricarica automaticamente l'estensione
   non impacchettata quando i file cambiano su disco.

   Interroga GET /api/extension/version (server locale, restituisce MD5 di tutti
   i file sotto extension/) ogni 60 secondi tramite un allarme periodico chrome.alarms.
   Quando l'hash differisce dalla baseline memorizzata, chiama chrome.runtime.reload()
   così Chrome rilegge tutti i file script/CSS/manifest dal disco immediatamente.
   ═══════════════════════════════════════════════════════════════════════ */

const VERSION_URL  = "http://10.56.65.139:3131/api/extension/version";
const ANNOUNCE_URL = "http://10.56.65.139:3131/api/announcements";
const MESSAGES_URL = "http://10.56.65.139:3131/api/messages";
const POLL_ALARM   = "ocps-version-check";
const HASH_KEY     = "ocps_ext_hash";
const SEEN_KEY     = "ocps_seen_announcements";
const USERNAME_KEY = "ocps_odoo_username";

// Assicura che l'allarme sia registrato ogni volta che il service worker parte.
// Chrome può terminare e riavviare il SW in qualsiasi momento; ricreare l'allarme
// qui garantisce che il polling continui attraverso quei riavvii.
chrome.alarms.get(POLL_ALARM, (existing) => {
  if (!existing) chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
});

async function checkVersion() {
  let serverHash;
  try {
    const resp = await fetch(VERSION_URL + "?_=" + Date.now());
    if (!resp.ok) return;
    const data = await resp.json();
    serverHash = data.hash;
    if (!serverHash) return;
  } catch {
    return; // server non raggiungibile — salta silenziosamente, non rompere nulla
  }

  const stored = await chrome.storage.local.get(HASH_KEY);
  const knownHash = stored[HASH_KEY];

  if (!knownHash) {
    // Prima esecuzione dopo installazione/abilitazione — registra l'hash corrente come baseline.
    await chrome.storage.local.set({ [HASH_KEY]: serverHash });
    console.log("[OCPS] Version baseline stored:", serverHash.slice(0, 8));
    return;
  }

  if (serverHash !== knownHash) {
    console.log("[OCPS] Extension files changed — reloading...", knownHash.slice(0, 8), "→", serverHash.slice(0, 8));
    await chrome.storage.local.set({ [HASH_KEY]: serverHash });
    // Ricarica tutte le tab Odoo aperte così i nuovi content script hanno effetto subito.
    // chrome.runtime.reload() da solo NON re-inietta i content script nelle tab esistenti.
    try {
      const tabs = await chrome.tabs.query({ url: "*://*.odoo.com/*" });
      for (const tab of tabs) { chrome.tabs.reload(tab.id); }
    } catch (_) { /* skip */ }
    chrome.runtime.reload();
  }
}

// Controlla subito all'avvio del service worker (copre i click "Ricarica" manuali in chrome://extensions).
checkVersion();
checkAnnouncementsBackground();
checkMessagesBackground();

// Controlla ad ogni tick dell'allarme (ogni 60 s).
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    checkVersion();
    checkAnnouncementsBackground();
    checkMessagesBackground();
  }
});

// ── Notifiche di sistema per annunci e messaggi (qualsiasi pagina) ─────────

async function getBgSeenIds() {
  const d = await chrome.storage.local.get(SEEN_KEY);
  return (d && d[SEEN_KEY]) || [];
}

async function markBgSeen(id) {
  let seen = await getBgSeenIds();
  if (!seen.includes(id)) {
    seen.push(id);
    if (seen.length > 300) seen = seen.slice(-300);
    await chrome.storage.local.set({ [SEEN_KEY]: seen });
  }
}

async function checkAnnouncementsBackground() {
  try {
    const resp = await fetch(ANNOUNCE_URL + "?_=" + Date.now());
    if (!resp.ok) return;
    const data = await resp.json();
    const list = (data.announcements || []).filter(a => a.active !== false);
    if (!list.length) return;
    const seen = await getBgSeenIds();
    const unseen = list.filter(a => !seen.includes(a.id));
    // Urgenti prima
    const sorted = [...unseen.filter(a => a.priority === "urgent"), ...unseen.filter(a => a.priority !== "urgent")];
    for (const ann of sorted) {
      await markBgSeen(ann.id);
      const isUrgent = ann.priority === "urgent";
      chrome.notifications.create(`ocps-ann-${ann.id}`, {
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: (isUrgent ? "🚨 " : "📢 ") + (ann.title || (isUrgent ? "System Alert" : "Announcement")),
        message: ann.message || "",
        priority: isUrgent ? 2 : 0,
        requireInteraction: isUrgent,
      });
      // Ack al server se lo username è in cache
      try {
        const sd = await chrome.storage.local.get(USERNAME_KEY);
        const user = (sd && sd[USERNAME_KEY]) || "";
        if (user) {
          fetch(`${ANNOUNCE_URL}/${ann.id}/ack`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user }),
          }).catch(() => {});
        }
      } catch { /* silenzioso */ }
    }
  } catch { /* silenzioso — gli annunci non sono critici */ }
}

async function checkMessagesBackground() {
  try {
    const d = await chrome.storage.local.get(USERNAME_KEY);
    const user = ((d && d[USERNAME_KEY]) || "").trim();
    if (!user) return; // username non ancora in cache — salta fino alla prima visita Odoo
    const resp = await fetch(`${MESSAGES_URL}?user=${encodeURIComponent(user)}&_=${Date.now()}`);
    if (!resp.ok) return;
    const data = await resp.json();
    const list = data.messages || [];
    for (const msg of list) {
      chrome.notifications.create(`ocps-msg-${msg.id}`, {
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: "💬 Message from Admin",
        message: msg.text || "",
        priority: 1,
        requireInteraction: true,
      });
      fetch(`${MESSAGES_URL}/${msg.id}/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user }),
      }).catch(() => {});
    }
  } catch { /* silenzioso */ }
}

// Inietta i content script nelle tab Odoo già aperte che hanno perso l'iniezione iniziale.
// Copre: installazione fresca dell'estensione, ricarica manuale in chrome://extensions, riavvio Chrome.
// Il flag __ocpsInit sulla pagina previene doppia iniezione (ed errori di ri-dichiarazione const).
async function injectIntoExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: "*://*.odoo.com/*" });
    for (const tab of tabs) {
      try {
        const [check] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => !!window.__ocpsInit,
        });
        if (check && check.result) continue; // already running — skip
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["odoo-rpc.js", "validator.js", "content.js"] });
      } catch (_) { /* tab may not be injectable (e.g. chrome:// pages) */ }
    }
  } catch (_) { /* scripting API not available */ }
}

chrome.runtime.onInstalled.addListener(() => injectIntoExistingTabs());
chrome.runtime.onStartup.addListener(() => injectIntoExistingTabs());
