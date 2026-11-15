const API_BASE_URL = "";

const $ = (id) => document.getElementById(id);
const state = { origin: null, destination: null }; // {name, lat, lon}

// ---------- API helper ----------
async function api(path, opts = {}) {
  const res = await fetch(API_BASE_URL + path, {
    headers: { "Content-Type": "application/json" }, ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function say(text, kind = "") { const m = $("msg"); if (m) { m.textContent = text; m.className = "msg " + kind; } }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- API health badge ----------
async function checkHealth() {
  const b = $("apiBadge");
  if (!b) return;
  try {
    const d = await api("/api/health");
    // Updated to accept "online" or "ok" from Flask backend
    const ok = d.status === "online" || d.status === "ok";
    b.className = "pill " + (ok ? "online" : "offline");
    const boldText = b.querySelector("b");
    if (boldText) boldText.textContent = ok ? "API Online" : "API Offline";
  } catch {
    b.className = "pill offline"; 
    const boldText = b.querySelector("b");
    if (boldText) boldText.textContent = "API Offline";
  }
}
checkHealth(); setInterval(checkHealth, 15000);

// ---------- Tabs ----------
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  if ($("tab-planner")) $("tab-planner").hidden = name !== "planner";
  if ($("tab-saved")) $("tab-saved").hidden = name !== "saved";
  if (name === "planner" && typeof map !== 'undefined') setTimeout(() => map.invalidateSize(), 50);
  if (name === "saved") loadPlaces();
}
document.querySelectorAll("[data-tab]").forEach((el) => el.addEventListener("click", () => showTab(el.dataset.tab)));

// ---------- Map ----------
const map = L.map("map").setView([28.6139, 77.209], 11);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);
let layer = L.layerGroup().addTo(map);

// ---------- Autocomplete ----------
function wireSuggest(key) {
  const input = $(key), list = $("sugg-" + key);
  if (!input || !list) return;
  let timer;
  input.addEventListener("input", () => {
    state[key] = null; // typed text invalidates picked coordinates
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { list.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      try {
        const res = await api("/api/geocode?q=" + encodeURIComponent(q));
        list.innerHTML = "";
        res.forEach((p) => {
          const li = document.createElement("li");
          li.textContent = p.name;
          li.onclick = () => { state[key] = p; input.value = p.name; list.innerHTML = ""; };
          list.appendChild(li);
        });
      } catch { list.innerHTML = ""; }
    }, 450); // respects Nominatim's usage policy
  });
  document.addEventListener("click", (e) => { if (!list.contains(e.target) && e.target !== input) list.innerHTML = ""; });
}
wireSuggest("origin"); wireSuggest("destination");

async function resolve(key) {
  if (state[key]) return state[key];
  const q = $(key).value.trim();
  if (!q) throw new Error(`Enter a ${key}.`);
  const res = await api("/api/geocode?q=" + encodeURIComponent(q));
  if (!res.length) throw new Error(`Couldn't find "${q}".`);
  state[key] = res[0]; $(key).value = res[0].name;
  return res[0];
}

// ---------- Route ----------
const swapBtn = $("swap");
if (swapBtn) {
  swapBtn.onclick = () => {
    [state.origin, state.destination] = [state.destination, state.origin];
    const t = $("origin").value; $("origin").value = $("destination").value; $("destination").value = t;
  };
}

const findRouteBtn = $("findRoute");
if (findRouteBtn) {
  findRouteBtn.onclick = async () => {
    findRouteBtn.disabled = true; say("Finding route…");
    try {
      const [o, d] = [await resolve("origin"), await resolve("destination")];
      const modeEl = document.querySelector("input[name=mode]:checked");
      const mode = modeEl ? modeEl.value : "driving";
      const r = await api("/api/route", {
        method: "POST",
        body: JSON.stringify({ origin: [o.lat, o.lon], destination: [d.lat, d.lon], mode }),
      });
      if ($("kDist")) $("kDist").textContent = r.distance_km;
      if ($("kEta")) $("kEta").textContent = Math.round(r.duration_min);
      if ($("kCost")) $("kCost").textContent = r.est_cost;

      layer.clearLayers();
      const line = L.polyline(r.geometry, { color: "#0F766E", weight: 5, opacity: .9 }).addTo(layer);
      L.marker([o.lat, o.lon]).addTo(layer).bindPopup("Start: " + esc(o.name));
      L.marker([d.lat, d.lon]).addTo(layer).bindPopup("End: " + esc(d.name));
      map.fitBounds(line.getBounds(), { padding: [30, 30] });

      if ($("steps")) {
        $("steps").innerHTML = r.steps.map((s, i) =>
          `<tr><td>${i + 1}</td><td>${esc(s.instruction)}</td><td>${fmtDist(s.distance_m)}</td></tr>`).join("");
      }
      say("Route ready.", "ok");
    } catch (e) { say(e.message, "err"); }
    findRouteBtn.disabled = false;
  };
}
const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m");

// ---------- Saved places ----------
const saveDestBtn = $("saveDest");
if (saveDestBtn) {
  saveDestBtn.onclick = async () => {
    try {
      const d = await resolve("destination");
      await api("/api/places", { method: "POST", body: JSON.stringify({ name: d.name, lat: d.lat, lon: d.lon }) });
      say("Destination saved.", "ok");
    } catch (e) { say(e.message, "err"); }
  };
}

async function loadPlaces() {
  const body = $("places");
  if (!body) return;
  try {
    const places = await api("/api/places");
    if (!places.length) { body.innerHTML = '<tr><td colspan="3" class="empty">No saved places yet.</td></tr>'; return; }
    body.innerHTML = places.map((p) => `<tr>
      <td>${esc(p.name)}</td><td>${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</td>
      <td class="acts"><button class="btn ghost sm" data-load="${p.id}">Load into Route</button>
      <button class="btn ghost sm danger" data-del="${p.id}">Delete</button></td></tr>`).join("");
    body.querySelectorAll("[data-load]").forEach((b) => b.onclick = () => {
      const p = places.find((x) => x.id == b.dataset.load);
      state.destination = { name: p.name, lat: p.lat, lon: p.lon };
      $("destination").value = p.name; showTab("planner"); say("Destination loaded.", "ok");
    });
    body.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
      try { await api("/api/places/" + b.dataset.del, { method: "DELETE" }); loadPlaces(); }
      catch (e) { alert(e.message); }
    });
  } catch (e) { body.innerHTML = `<tr><td colspan="3" class="empty">${esc(e.message)}</td></tr>`; }
}
loadPlaces();
