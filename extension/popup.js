/* OCPS Repair Validator — Script Popup (Standalone) */
(function () {
  "use strict";

  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const checkBtn = document.getElementById("check-btn");
  const sessionInfo = document.getElementById("session-info");

  checkBtn.addEventListener("click", () => checkSession());

  // Controllo automatico all'apertura
  checkSession();

  async function checkSession() {
    statusDot.className = "dot dot-pending";
    statusText.textContent = "Checking Odoo session…";
    sessionInfo.style.display = "none";

    // Serve eseguire il controllo sulla tab Odoo attiva, non dall'origine del popup.
    // Usiamo chrome.tabs per eseguire uno script sulla tab Odoo corrente.
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || !tab.url.includes("odoo.com")) {
        statusDot.className = "dot dot-err";
        statusText.textContent = "Not on an Odoo page";
        sessionInfo.style.display = "block";
        sessionInfo.innerHTML = "Navigate to your Odoo instance first, then reopen this popup.";
        return;
      }

      // Esegui un piccolo script sulla tab attiva per verificare la sessione
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          try {
            const resp = await fetch("/web/session/get_session_info", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "call", params: {} }),
            });
            const json = await resp.json();
            if (json.result && json.result.uid) {
              return {
                ok: true,
                uid: json.result.uid,
                username: json.result.username || json.result.login || "",
                db: json.result.db || "",
                serverVersion: json.result.server_version || "",
              };
            }
            return { ok: false, error: "No active session" };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        },
      });

      const result = results && results[0] && results[0].result;
      if (result && result.ok) {
        statusDot.className = "dot dot-ok";
        statusText.textContent = `Logged in as ${result.username}`;
        sessionInfo.style.display = "none";
      } else {
        statusDot.className = "dot dot-err";
        statusText.textContent = "Not logged in";
        sessionInfo.style.display = "block";
        sessionInfo.innerHTML = result ? result.error : "Could not reach Odoo session API.";
      }
    } catch (err) {
      statusDot.className = "dot dot-err";
      statusText.textContent = "Check failed";
      sessionInfo.style.display = "block";
      sessionInfo.innerHTML = err.message || "Unknown error";
    }
  }
})();
