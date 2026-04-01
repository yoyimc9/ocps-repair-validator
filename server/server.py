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
import uuid
from flask import Flask, jsonify, request, send_from_directory, abort
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # Allow Chrome extension (chrome-extension://*) to call the API

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

# ── Helpers ────────────────────────────────────────────────────────────────

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

# ── Admin panel ────────────────────────────────────────────────────────────

@app.route("/")
@app.route("/admin")
def admin():
    return send_from_directory(BASE_DIR, "admin.html")

# ── Announcements ──────────────────────────────────────────────────────────

@app.route("/api/announcements", methods=["GET"])
def get_announcements():
    return jsonify(_read("announcements.json", {"announcements": []}))

@app.route("/api/announcements", methods=["PUT"])
def put_announcements():
    data = request.get_json(silent=True)
    if data is None:
        abort(400)
    _write("announcements.json", data)
    return jsonify({"ok": True})

# ── Blocked serials ────────────────────────────────────────────────────────

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
# ── UI Controls ───────────────────────────────────────────────────────────

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
# ── Extension version (hash of extension files) ──────────────────────────

EXTENSION_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "extension"))

@app.route("/api/extension/version", methods=["GET"])
def get_extension_version():
    """Returns an MD5 hash of all extension source files.
    The background service worker polls this; a changed hash triggers reload."""
    h = hashlib.md5()
    for root, dirs, files in os.walk(EXTENSION_DIR):
        dirs.sort()
        for fname in sorted(files):
            fpath = os.path.join(root, fname)
            rel = os.path.relpath(fpath, EXTENSION_DIR).replace("\\", "/")
            h.update(rel.encode())
            try:
                with open(fpath, "rb") as f:
                    h.update(f.read())
            except OSError:
                pass
    version = "unknown"
    try:
        with open(os.path.join(EXTENSION_DIR, "manifest.json"), "r", encoding="utf-8") as f:
            version = json.load(f).get("version", "unknown")
    except Exception:
        pass
    return jsonify({"hash": h.hexdigest(), "version": version})

# ── Messages ──────────────────────────────────────────────────────────────

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
    return jsonify({"id": entry["id"]}), 201

@app.route("/api/messages", methods=["GET"])
def get_messages():
    user = (request.args.get("user") or "").strip().lower()
    msgs = _read("messages.json", {"messages": []})
    if not user:
        return jsonify(msgs)
    result = [
        m for m in msgs["messages"]
        if (m.get("to", "*") == "*" or m.get("to", "").lower() == user)
        and not any(a.get("user", "").lower() == user for a in m.get("ack_by", []))
    ]
    return jsonify({"messages": result})

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
    return jsonify({"ok": True})

# ── Run ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 52)
    print("  OCPS Validator — Local Server")
    print("  Admin panel : http://10.56.65.139:3131/admin")
    print("  API base    : http://10.56.65.139:3131/api")
    print("=" * 52)
    app.run(host="0.0.0.0", port=3131, debug=False)
