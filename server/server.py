"""
OCPS Validator — Local Office Server
Serves the admin panel and exposes a REST API for the Chrome extension.

Install deps : pip install -r requirements.txt
Run          : python server.py
"""

import json
import os
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
# ── Run ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 52)
    print("  OCPS Validator — Local Server")
    print("  Admin panel : http://10.56.65.139:3131/admin")
    print("  API base    : http://10.56.65.139:3131/api")
    print("=" * 52)
    app.run(host="0.0.0.0", port=3131, debug=False)
