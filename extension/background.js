/* ═══════════════════════════════════════════════════════════════════════
   background.js — MV3 service worker: auto-reloads the unpacked extension
   when extension files change on disk.

   Polls GET /api/extension/version (local server, returns MD5 of all files
   under extension/) every 60 seconds via a chrome.alarms periodic alarm.
   When the hash differs from the stored baseline, calls chrome.runtime.reload()
   so Chrome re-reads all script/CSS/manifest files from disk immediately.
   ═══════════════════════════════════════════════════════════════════════ */

const VERSION_URL = "http://10.56.65.139:3131/api/extension/version";
const POLL_ALARM  = "ocps-version-check";
const HASH_KEY    = "ocps_ext_hash";

// Ensure the alarm is registered whenever the service worker starts.
// Chrome may terminate and restart the SW at any time; recreating the alarm
// here guarantees polling continues across those restarts.
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
    return; // server not reachable — skip silently, don't break anything
  }

  const stored = await chrome.storage.local.get(HASH_KEY);
  const knownHash = stored[HASH_KEY];

  if (!knownHash) {
    // First run after install/enable — record the current hash as the baseline.
    await chrome.storage.local.set({ [HASH_KEY]: serverHash });
    console.log("[OCPS] Version baseline stored:", serverHash.slice(0, 8));
    return;
  }

  if (serverHash !== knownHash) {
    console.log("[OCPS] Extension files changed — reloading...", knownHash.slice(0, 8), "→", serverHash.slice(0, 8));
    await chrome.storage.local.set({ [HASH_KEY]: serverHash });
    chrome.runtime.reload();
  }
}

// Check immediately on service worker startup (covers manual "Reload" clicks in chrome://extensions).
checkVersion();

// Check on every alarm tick (every 60 s).
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) checkVersion();
});
