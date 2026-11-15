import os, sqlite3
import requests
from flask import Flask, jsonify, request, g, send_from_directory
from flask_cors import CORS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if "RENDER" in os.environ:
    DB_PATH = "/tmp/navigator.db"
else:
    DB_PATH = os.path.join(BASE_DIR, "navigator.db")
UA = {"User-Agent": "NavPulse/1.0 (NSUT student project)"}

app = Flask(__name__, static_folder=os.path.join(BASE_DIR, "frontend"), static_url_path="")
CORS(app)

# Mode config: OSRM-compatible endpoint, average speed (km/h, None = trust OSRM), cost per km (INR)
MODES = {
    "driving": {"url": "https://routing.openstreetmap.de/routed-car", "speed": None, "cost_km": 7.0},
    "cycling": {"url": "https://routing.openstreetmap.de/routed-bike", "speed": 15.0, "cost_km": 0.0},
    "walking": {"url": "https://routing.openstreetmap.de/routed-foot", "speed": 5.0, "cost_km": 0.0},
}

# ---------- SQLite ----------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db

@app.teardown_appcontext
def close_db(_):
    db = g.pop("db", None)
    if db:
        db.close()

def init_db():
    with sqlite3.connect(DB_PATH) as c:
        c.execute("""CREATE TABLE IF NOT EXISTS places (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP)""")

init_db()

# ---------- Routes ----------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")

@app.get("/api/health")
def health():
    return jsonify({"status": "ok"})

@app.get("/api/geocode")
def geocode():
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify([])
    try:
        r = requests.get("https://nominatim.openstreetmap.org/search",
                         params={"q": q, "format": "json", "limit": 5},
                         headers=UA, timeout=10)
        r.raise_for_status()
    except requests.RequestException as e:
        return jsonify({"error": f"Geocoding failed: {e}"}), 502
    return jsonify([{"name": p["display_name"], "lat": float(p["lat"]), "lon": float(p["lon"])}
                    for p in r.json()])

def describe(step):
    m = step.get("maneuver", {})
    t, mod = m.get("type", ""), m.get("modifier", "")
    road = step.get("name") or "the road"
    if t == "depart":
        return f"Head {mod or 'out'} on {road}".replace("Head out", "Start")
    if t == "arrive":
        return "Arrive at your destination"
    if t in ("roundabout", "rotary"):
        return f"Enter the roundabout and exit onto {road}"
    if t in ("turn", "end of road", "fork", "on ramp", "off ramp"):
        return f"Turn {mod} onto {road}" if mod else f"Continue onto {road}"
    return f"Continue {mod} on {road}".replace("  ", " ")

@app.post("/api/route")
def route():
    data = request.get_json(silent=True) or {}
    try:
        (olat, olon), (dlat, dlon) = data["origin"], data["destination"]
        olat, olon, dlat, dlon = map(float, (olat, olon, dlat, dlon))
    except (KeyError, ValueError, TypeError):
        return jsonify({"error": "origin and destination must be [lat, lon]"}), 400
    mode = data.get("mode", "driving")
    cfg = MODES.get(mode)
    if not cfg:
        return jsonify({"error": "mode must be driving, cycling or walking"}), 400
    url = f"{cfg['url']}/route/v1/driving/{olon},{olat};{dlon},{dlat}"
    try:
        r = requests.get(url, params={"overview": "full", "geometries": "geojson", "steps": "true"},
                         headers=UA, timeout=15)
        r.raise_for_status()
        j = r.json()
    except requests.RequestException as e:
        return jsonify({"error": f"Routing failed: {e}"}), 502
    if j.get("code") != "Ok" or not j.get("routes"):
        return jsonify({"error": "No route found between these points"}), 404
    rt = j["routes"][0]
    km = rt["distance"] / 1000
    minutes = (km / cfg["speed"] * 60) if cfg["speed"] else rt["duration"] / 60
    cost = km * cfg["cost_km"]
    steps = [{"instruction": describe(s), "distance_m": round(s["distance"], 1)}
             for leg in rt["legs"] for s in leg["steps"]]
    return jsonify({
        "distance_km": round(km, 2),
        "duration_min": round(minutes, 1),
        "est_cost": f"₹{cost:,.0f}" if cost else "₹0 (free)",
        "geometry": [[c[1], c[0]] for c in rt["geometry"]["coordinates"]],
        "steps": steps,
    })

@app.get("/api/places")
def list_places():
    rows = get_db().execute("SELECT id, name, lat, lon, created_at FROM places ORDER BY id DESC").fetchall()
    return jsonify([dict(r) for r in rows])

@app.post("/api/places")
def add_place():
    d = request.get_json(silent=True) or {}
    try:
        name, lat, lon = str(d["name"]).strip(), float(d["lat"]), float(d["lon"])
        if not name:
            raise ValueError
    except (KeyError, ValueError, TypeError):
        return jsonify({"error": "name, lat and lon are required"}), 400
    db = get_db()
    cur = db.execute("INSERT INTO places (name, lat, lon) VALUES (?,?,?)", (name, lat, lon))
    db.commit()
    return jsonify({"id": cur.lastrowid, "name": name, "lat": lat, "lon": lon}), 201

@app.delete("/api/places/<int:pid>")
def delete_place(pid):
    db = get_db()
    cur = db.execute("DELETE FROM places WHERE id = ?", (pid,))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "not found"}), 404
    return jsonify({"deleted": pid})

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
