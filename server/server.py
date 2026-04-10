"""
OCPS Validator — Local Office Server
Serves the admin panel and exposes a REST API for the Chrome extension.

Install deps : pip install -r requirements.txt
Run          : python server.py
"""

import datetime
import hashlib
import json
import os
import threading
import uuid
from flask import Flask, jsonify, request, send_from_directory, abort
from flask_cors import CORS
from urllib.parse import urlparse

app = Flask(__name__)
CORS(app)  # Permetti all'estensione Chrome (chrome-extension://*) di chiamare l'API

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

EVENTS_COND = threading.Condition()
EVENTS = []
EVENTS_SEQ = 0
EVENTS_MAX = 200

# ── Helper ─────────────────────────────────────────────────────────────────

def _read(filename, default):
    path = os.path.join(DATA_DIR, filename)
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def _write(filename, data):
    path = os.path.join(DATA_DIR, filename)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def _publish_event(kind, payload=None):
    global EVENTS_SEQ
    with EVENTS_COND:
        EVENTS_SEQ += 1
        EVENTS.append({
            "seq": EVENTS_SEQ,
            "kind": kind,
            "payload": payload or {},
            "ts": datetime.datetime.utcnow().isoformat() + "Z",
        })
        if len(EVENTS) > EVENTS_MAX:
            del EVENTS[:-EVENTS_MAX]
        EVENTS_COND.notify_all()
        return EVENTS_SEQ

# ── Pannello admin ─────────────────────────────────────────────────────────

@app.route("/")
@app.route("/admin")
def admin():
    return send_from_directory(BASE_DIR, "admin.html")

# ── Annunci ────────────────────────────────────────────────────────────────

@app.route("/api/announcements", methods=["GET"])
def get_announcements():
    return jsonify(_read("announcements.json", {"announcements": []}))

@app.route("/api/announcements", methods=["PUT"])
def put_announcements():
    data = request.get_json(silent=True)
    if data is None:
        abort(400)
    _write("announcements.json", data)
    _publish_event("announcements")
    return jsonify({"ok": True})

@app.route("/api/announcements/<ann_id>/ack", methods=["POST"])
def ack_announcement(ann_id):
    data = request.get_json(silent=True)
    user = ((data or {}).get("user") or "").strip()
    if not user:
        abort(400)
    anns = _read("announcements.json", {"announcements": []})
    for a in anns["announcements"]:
        if a.get("id") == ann_id:
            if not any(r.get("user", "").lower() == user.lower() for r in a.get("ack_by", [])):
                a.setdefault("ack_by", []).append({
                    "user": user,
                    "ts": datetime.datetime.utcnow().isoformat() + "Z",
                })
            _write("announcements.json", anns)
            return jsonify({"ok": True})
    abort(404)

# ── Seriali bloccati ────────────────────────────────────────────────────────

@app.route("/api/blocked", methods=["GET"])
def get_blocked():
    return jsonify(_read("blocked-serials.json", {"blocked": []}))

@app.route("/api/blocked", methods=["PUT"])
def put_blocked():
    data = request.get_json(silent=True)
    if data is None:
        abort(400)
    _write("blocked-serials.json", data)
    return jsonify({"ok": True})
# ── Controlli UI ───────────────────────────────────────────────────────────

@app.route("/api/ui-controls", methods=["GET"])
def get_ui_controls():
    return jsonify(_read("ui-controls.json", {"controls": {}}))

@app.route("/api/ui-controls", methods=["PUT"])
def put_ui_controls():
    data = request.get_json(silent=True)
    if data is None:
        abort(400)
    _write("ui-controls.json", data)
    return jsonify({"ok": True})
# ── Versione estensione (hash dei file estensione) ─────────────────────────

def _get_extension_dir():
    """Ritorna la directory dell'estensione: variabile ambiente > config.json > fallback relativo."""
    cfg = _read("config.json", {})
    return (os.environ.get("OCPS_EXTENSION_DIR") or
            cfg.get("extension_dir") or
            os.path.abspath(os.path.join(BASE_DIR, "..", "extension")))

@app.route("/api/extension/version", methods=["GET"])
def get_extension_version():
    """Returns an MD5 hash of all extension source files.
    The background service worker polls this; a changed hash triggers reload."""
    ext_dir = _get_extension_dir()
    h = hashlib.md5()
    for root, dirs, files in os.walk(ext_dir):
        dirs.sort()
        for fname in sorted(files):
            fpath = os.path.join(root, fname)
            rel = os.path.relpath(fpath, ext_dir).replace("\\", "/")
            h.update(rel.encode())
            try:
                with open(fpath, "rb") as f:
                    h.update(f.read())
            except OSError:
                pass
    # Mix in the force-reload nonce so the admin panel can trigger a reload
    # even when the extension files themselves haven't changed.
    nonce = _read("reload_nonce.json", {"nonce": ""}).get("nonce", "")
    if nonce:
        h.update(nonce.encode())
    version = "unknown"
    try:
        with open(os.path.join(ext_dir, "manifest.json"), "r", encoding="utf-8") as f:
            version = json.load(f).get("version", "unknown")
    except Exception:
        pass
    return jsonify({"hash": h.hexdigest(), "version": version})

@app.route("/api/extension/force-reload", methods=["POST"])
def force_reload():
    """Writes a new random nonce that is mixed into the extension version hash.
    All connected extensions detect the hash change on their next poll (≤60 s)
    and automatically reload."""
    _write("reload_nonce.json", {"nonce": uuid.uuid4().hex})
    return jsonify({"ok": True})

# ── Configurazione Server ──────────────────────────────────────────────────

def _patch_url_in_files(ext_dir, old_url, new_url):
    """Rewrites URL strings in background.js, content.js, and manifest.json
    host_permissions. Returns a list of warning strings."""
    warns = []
    for fname in ("background.js", "content.js"):
        fpath = os.path.join(ext_dir, fname)
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                src = f.read()
            if old_url in src:
                with open(fpath, "w", encoding="utf-8") as f:
                    f.write(src.replace(old_url, new_url))
            else:
                warns.append(f"{fname}: old URL not found — may already be up to date")
        except OSError as e:
            warns.append(f"{fname}: {e}")
    try:
        mpath = os.path.join(ext_dir, "manifest.json")
        with open(mpath, "r", encoding="utf-8") as f:
            mf = json.load(f)
        parsed = urlparse(new_url)
        new_perm = f"{parsed.scheme}://{parsed.netloc}/*"
        kept = [p for p in mf.get("host_permissions", [])
                if "odoo.com" in p or "github" in p]
        kept.append(new_perm)
        mf["host_permissions"] = kept
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(mf, f, indent=2, ensure_ascii=False)
            f.write("\n")
    except Exception as e:
        warns.append(f"manifest.json: {e}")
    return warns

@app.route("/api/config", methods=["GET"])
def get_config():
    cfg = _read("config.json", {})
    return jsonify({
        "server_url": cfg.get("server_url", "http://10.56.65.139:3131"),
        "extension_dir": _get_extension_dir(),
    })

@app.route("/api/config", methods=["PUT"])
def put_config():
    data = request.get_json(silent=True)
    if data is None:
        abort(400)
    cfg = _read("config.json", {})
    warns = []
    if "server_url" in data:
        new_url = (data["server_url"] or "").rstrip("/").strip()
        if new_url:
            old_url = cfg.get("server_url", "http://10.56.65.139:3131")
            cfg["server_url"] = new_url
            warns.extend(_patch_url_in_files(_get_extension_dir(), old_url, new_url))
    if "extension_dir" in data:
        new_dir = (data["extension_dir"] or "").strip()
        if new_dir:
            cfg["extension_dir"] = new_dir
    _write("config.json", cfg)
    resp = {"ok": True}
    if warns:
        resp["warn"] = " | ".join(warns)
    return jsonify(resp)

# ── Eventi push leggeri (long-poll) ───────────────────────────────────────

@app.route("/api/events/poll", methods=["GET"])
def poll_events():
    try:
        since = int((request.args.get("since") or "0").strip())
    except ValueError:
        since = 0

    try:
        timeout = float((request.args.get("timeout") or "25").strip())
    except ValueError:
        timeout = 25.0

    timeout = max(0.0, min(timeout, 25.0))

    with EVENTS_COND:
        if EVENTS_SEQ <= since:
            EVENTS_COND.wait(timeout=timeout)
        events = [e for e in EVENTS if e["seq"] > since]
        latest_seq = EVENTS[-1]["seq"] if EVENTS else EVENTS_SEQ

    return jsonify({"events": events, "latest_seq": latest_seq})

# ── Messaggi ──────────────────────────────────────────────────────────────

@app.route("/api/messages", methods=["POST"])
def post_message():
    data = request.get_json(silent=True)
    if not data or not data.get("text"):
        abort(400)
    entry = {
        "id": uuid.uuid4().hex[:12],
        "to": (data.get("to") or "*").strip() or "*",
        "text": data["text"].strip(),
        "created": datetime.datetime.utcnow().isoformat() + "Z",
        "ack_by": [],
    }
    msgs = _read("messages.json", {"messages": []})
    msgs["messages"].insert(0, entry)
    _write("messages.json", msgs)
    _publish_event("messages", {"id": entry["id"], "to": entry["to"]})
    return jsonify({"id": entry["id"]}), 201

@app.route("/api/messages", methods=["GET"])
def get_messages():
    user = (request.args.get("user") or "").strip().lower()
    msgs = _read("messages.json", {"messages": []})
    if not user:
        return jsonify(msgs)
    # Registra utente come visto
    users = _read("users.json", {"users": []})
    if user not in users["users"]:
        users["users"].append(user)
        users["users"].sort()
        _write("users.json", users)
    result = [
        m for m in msgs["messages"]
        if (m.get("to", "*") == "*" or m.get("to", "").lower() == user)
        and not any(a.get("user", "").lower() == user for a in m.get("ack_by", []))
    ]
    return jsonify({"messages": result})

@app.route("/api/users", methods=["GET"])
def get_users():
    return jsonify(_read("users.json", {"users": []}))

@app.route("/api/messages/<msg_id>/ack", methods=["POST"])
def ack_message(msg_id):
    data = request.get_json(silent=True)
    user = ((data or {}).get("user") or "").strip()
    if not user:
        abort(400)
    msgs = _read("messages.json", {"messages": []})
    for m in msgs["messages"]:
        if m["id"] == msg_id:
            if not any(a.get("user", "").lower() == user.lower() for a in m.get("ack_by", [])):
                m.setdefault("ack_by", []).append({
                    "user": user,
                    "ts": datetime.datetime.utcnow().isoformat() + "Z",
                })
            _write("messages.json", msgs)
            return jsonify({"ok": True})
    abort(404)

@app.route("/api/messages/<msg_id>", methods=["DELETE"])
def delete_message(msg_id):
    msgs = _read("messages.json", {"messages": []})
    updated = [m for m in msgs["messages"] if m["id"] != msg_id]
    if len(updated) == len(msgs["messages"]):
        abort(404)
    msgs["messages"] = updated
    _write("messages.json", msgs)
    _publish_event("messages")
    return jsonify({"ok": True})

# ── Avvio ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    _ext_dir = _get_extension_dir()
    print("=" * 52)
    print("  OCPS Validator — Local Server  (port 3131)")
    print(f"  Extension dir: {_ext_dir}  (exists: {os.path.isdir(_ext_dir)})")
    print("=" * 52)
    app.run(host="0.0.0.0", port=3131, debug=False)
