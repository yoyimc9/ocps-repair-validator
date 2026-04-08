/* ═══════════════════════════════════════════════════════════════════════
   background.js — Service worker MV3: ricarica automaticamente l'estensione
   non impacchettata quando i file cambiano su disco.

   Interroga GET /api/extension/version (server locale, restituisce MD5 di tutti
   i file sotto extension/) ogni 60 secondi tramite un allarme periodico chrome.alarms.
   Quando l'hash differisce dalla baseline memorizzata, chiama chrome.runtime.reload()
   così Chrome rilegge tutti i file script/CSS/manifest dal disco immediatamente.
   ═══════════════════════════════════════════════════════════════════════ */

const VERSION_URL = "http://10.56.65.139:3131/api/extension/version";
const POLL_ALARM  = "ocps-version-check";
const HASH_KEY    = "ocps_ext_hash";

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

// Controlla ad ogni tick dell'allarme (ogni 60 s).
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) checkVersion();
});

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
