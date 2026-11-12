const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  user: null, activeView: "browse", location: null, activeConversation: null, categories: [],
  config: null, mapsReady: false, pickers: [], reportsMap: null, mapMarkers: [], mapFitted: false, infoWindow: null, mapItems: [], mapTab: "reports",
  socialMap: null, socialMarker: null, socialCircle: null, socialPoint: null, discoverPlatform: "instagram",
  assistantLocation: null, visualMode: "similar", unread: null, lastMessageCount: 0, conversationMeta: null,
};
const pageMeta = {
  browse: ["DISCOVER", "Find what belongs to you"],
  map: ["MAP & DISCOVERY", "Explore lost and found items"],
  "report-lost": ["CREATE REPORT", "Report a lost item"],
  "report-found": ["CREATE REPORT", "Report a found item"],
  visual: ["COMPUTER VISION", "Search with an image"],
  assistant: ["AI ASSISTANT", "Describe what happened"],
  messages: ["PRIVATE CHAT", "Conversations"],
  reports: ["YOUR ACTIVITY", "My reports"],
};
const DEFAULT_CENTER = { lat: 33.6844, lng: 73.0479 };
const LOST_COLOR = "#d85a3b", FOUND_COLOR = "#126c4a";
const LOCATION_KINDS = {
  original: { badge: "📍 Original location", hint: "Where the item was lost or found. Pin the exact spot.", nameLabel: "Place name", nameName: "locationName", namePlaceholder: "e.g. Main library entrance", latName: "latitude", lngName: "longitude" },
  collection: { badge: "🤝 Collection point", hint: "Where the owner and finder will meet to hand over the item.", nameLabel: "Collection place name", nameName: "collectionLocationName", namePlaceholder: "e.g. Library front desk", latName: "collectionLatitude", lngName: "collectionLongitude" },
};

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character])); }
function displayDate(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)) : "Date not specified"; }
function toast(message, kind = "success") { const node = $("#toast"); node.textContent = message; node.className = `toast visible ${kind}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => node.className = "toast", 3500); }
function setLoading(button, loading) { if (!button) return; button.disabled = loading; button.dataset.label ||= button.textContent; button.textContent = loading ? "Working…" : button.dataset.label; }
function mapsLink(lat, lng) { return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`; }
function hasMaps() { return Boolean(window.google && window.google.maps); }

// ---- Google Maps loading (the key is restricted by HTTP referrer in Google Cloud and is safe to send to the browser) ----
let mapsPromise = null;
function loadMaps(key) {
  if (!mapsPromise) {
    mapsPromise = new Promise((resolve, reject) => {
      window.__recoverlyMapsReady = () => resolve(true);
      window.gm_authFailure = () => reject(new Error("Google Maps rejected this API key. Check GOOGLE_MAPS_API_KEY and its allowed referrers."));
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__recoverlyMapsReady`;
      script.async = true;
      script.onerror = () => reject(new Error("Google Maps could not be loaded."));
      document.head.append(script);
    });
  }
  return mapsPromise;
}
function setupMaps(key) {
  if (!key) return;
  loadMaps(key).then(() => {
    state.mapsReady = true;
    state.pickers.forEach(initPickerMap);
    if (state.activeView === "map") setMapTab(state.mapTab);
  }).catch((error) => toast(error.message, "error"));
}
function pinIcon(color, glyph) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="44" viewBox="0 0 36 44"><path d="M18 1C8.6 1 1 8.6 1 18c0 12.6 17 25 17 25s17-12.4 17-25C35 8.6 27.4 1 18 1z" fill="${color}" stroke="#fff" stroke-width="2"/><text x="18" y="23" text-anchor="middle" font-family="Arial,sans-serif" font-size="15" font-weight="700" fill="#fff">${glyph}</text></svg>`;
  return { url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, scaledSize: new google.maps.Size(36, 44), anchor: new google.maps.Point(18, 44) };
}
// Collection points are dark squares, so they never look like a lost or found pin.
function collectionIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30"><rect x="2" y="2" width="26" height="26" rx="7" fill="#17291f" stroke="#c9f064" stroke-width="2.5"/><text x="15" y="20" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="700" fill="#c9f064">C</text></svg>`;
  return { url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, scaledSize: new google.maps.Size(30, 30), anchor: new google.maps.Point(15, 15) };
}

// ---- Two-location picker used on both report forms (mandatory) ----
function readPoint(picker) {
  if (picker.latInput.value === "" || picker.lngInput.value === "") return null;
  const lat = Number(picker.latInput.value), lng = Number(picker.lngInput.value);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}
function choosePoint(picker, lat, lng, reverse = false) {
  picker.latInput.value = lat.toFixed(6); picker.lngInput.value = lng.toFixed(6);
  state.lastKnown = { lat, lng };
  if (picker.map) { picker.marker.setPosition({ lat, lng }); picker.marker.setMap(picker.map); }
  picker.status.textContent = `Pinned at ${lat.toFixed(5)}, ${lng.toFixed(5)}.`;
  picker.status.className = "picker-status tiny success";
  if (reverse && picker.geocoder && !picker.nameInput.value) {
    picker.geocoder.geocode({ location: { lat, lng } }, (results, status) => {
      if (status === "OK" && results[0] && !picker.nameInput.value) picker.nameInput.value = results[0].formatted_address.split(",")[0].slice(0, 180);
    });
  }
}
function initPickerMap(picker) {
  if (picker.map || !hasMaps()) return;
  const existing = readPoint(picker);
  picker.mapEl.innerHTML = "";
  picker.map = new google.maps.Map(picker.mapEl, { center: existing || state.lastKnown || DEFAULT_CENTER, zoom: existing ? 16 : 13, mapTypeControl: false, streetViewControl: false, fullscreenControl: false });
  picker.geocoder = new google.maps.Geocoder();
  // Icons need the Google Maps library, so they are created here rather than when the form is built.
  const icon = picker.kind === "collection" ? collectionIcon() : pinIcon(picker.pinColor, picker.reportType === "lost" ? "L" : "F");
  picker.marker = new google.maps.Marker({ draggable: true, icon, title: LOCATION_KINDS[picker.kind].badge });
  if (existing) { picker.marker.setPosition(existing); picker.marker.setMap(picker.map); }
  picker.map.addListener("click", (event) => choosePoint(picker, event.latLng.lat(), event.latLng.lng(), true));
  picker.marker.addListener("dragend", (event) => choosePoint(picker, event.latLng.lat(), event.latLng.lng(), true));
  picker.findButton.disabled = false;
  picker.mapEl.dataset.ready = "true";
}
function buildPicker(mount, kind, reportType) {
  const config = LOCATION_KINDS[kind];
  const pinColor = reportType === "lost" ? LOST_COLOR : FOUND_COLOR;
  const wrap = document.createElement("div");
  wrap.className = `location-block ${kind}`;
  wrap.innerHTML = `
    <div class="location-title"><span class="pin-badge ${kind}">${config.badge}</span><small class="muted tiny">${escapeHtml(config.hint)}</small></div>
    <div class="location-fields">
      <label>${config.nameLabel}<input name="${config.nameName}" maxlength="180" placeholder="${escapeHtml(config.namePlaceholder)}" required></label>
      <div class="search-row"><input data-role="search" placeholder="Search Google Maps for a place" aria-label="Search for a place"><button type="button" class="button secondary" data-role="find" disabled>Find</button><button type="button" class="button subtle" data-role="here">⌖ My location</button></div>
    </div>
    <div class="google-map picker-map" data-role="map" aria-label="${escapeHtml(config.nameLabel)} map"><div class="map-unavailable">${state.config?.googleMapsApiKey ? "Loading Google Maps…" : "Interactive map is off. Set GOOGLE_MAPS_API_KEY on the server; you can still type coordinates or use My location."}</div></div>
    <div class="coord-row">
      <label>Latitude<input name="${config.latName}" type="number" step="0.000001" min="-90" max="90" required placeholder="33.6844"></label>
      <label>Longitude<input name="${config.lngName}" type="number" step="0.000001" min="-180" max="180" required placeholder="73.0479"></label>
    </div>
    <p class="picker-status tiny muted" data-role="status">Not set yet — click the map, search, or use your location.</p>`;
  mount.replaceChildren(wrap);
  const picker = {
    kind, reportType, pinColor, wrap, map: null, marker: null, geocoder: null,
    mapEl: $("[data-role=map]", wrap), nameInput: $(`[name=${config.nameName}]`, wrap),
    latInput: $(`[name=${config.latName}]`, wrap), lngInput: $(`[name=${config.lngName}]`, wrap),
    status: $("[data-role=status]", wrap), findButton: $("[data-role=find]", wrap), searchInput: $("[data-role=search]", wrap),
  };
  picker.findButton.addEventListener("click", () => {
    const query = picker.searchInput.value.trim();
    if (!query || !picker.geocoder) return;
    picker.geocoder.geocode({ address: query }, (results, status) => {
      if (status !== "OK" || !results[0]) return toast("No place found for that search. Try another name or click the map.", "error");
      const location = results[0].geometry.location;
      choosePoint(picker, location.lat(), location.lng());
      picker.map.setCenter(location); picker.map.setZoom(16);
      if (!picker.nameInput.value) picker.nameInput.value = results[0].formatted_address.split(",")[0].slice(0, 180);
    });
  });
  $("[data-role=here]", wrap).addEventListener("click", () => {
    if (!navigator.geolocation) return toast("Location is not available in this browser.", "error");
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      choosePoint(picker, coords.latitude, coords.longitude, true);
      if (picker.map) picker.map.setCenter({ lat: coords.latitude, lng: coords.longitude });
    }, () => toast("Location permission was not granted.", "error"), { enableHighAccuracy: true, timeout: 10000 });
  });
  const syncFromInputs = () => { const point = readPoint(picker); if (point) choosePoint(picker, point.lat, point.lng); };
  picker.latInput.addEventListener("change", syncFromInputs); picker.lngInput.addEventListener("change", syncFromInputs);
  state.pickers.push(picker);
  return picker;
}
function refreshPickers(reportType) {
  state.pickers.filter((picker) => picker.reportType === reportType && picker.map).forEach((picker) => {
    google.maps.event.trigger(picker.map, "resize");
    const point = readPoint(picker);
    if (point) picker.map.setCenter(point);
  });
}

function setAuthMode(mode) {
  const signingUp = mode === "signup";
  $("#loginForm").classList.toggle("hidden", signingUp);
  $("#signupForm").classList.toggle("hidden", !signingUp);
  $("#authTitle").textContent = signingUp ? "Create your account" : "Welcome back";
  $("#authSubtitle").textContent = signingUp ? "Start reporting, searching, and reconnecting people with their belongings." : "Sign in to manage your reports and matches.";
  $("#switchLabel").textContent = signingUp ? "Already have an account?" : "New here?";
  $("#switchAuth").textContent = signingUp ? "Sign in" : "Create an account";
  $("#switchAuth").dataset.mode = signingUp ? "login" : "signup";
}
function enterApp(user) {
  state.user = user;
  $("#authScreen").classList.add("hidden"); $("#appShell").classList.remove("hidden");
  $("#profileName").textContent = user.name; $("#profileInitial").textContent = user.name.slice(0, 1).toUpperCase();
  showView("browse"); loadNotifications();
}
async function showView(view) {
  state.activeView = view;
  $$(".view").forEach((node) => node.classList.toggle("hidden", node.id !== `${view}View`));
  $$(".nav-link[data-view]").forEach((node) => node.classList.toggle("active", node.dataset.view === view));
  const [kicker, title] = pageMeta[view]; $("#pageKicker").textContent = kicker; $("#pageTitle").textContent = title;
  if (view === "browse") await loadItems();
  if (view === "map") setMapTab(state.mapTab);
  if (view === "messages") await loadConversations();
  if (view === "reports") await loadMyReports();
  if (view === "report-lost" || view === "report-found") refreshPickers(view.replace("report-", ""));
  if (view === "visual") setVisualMode(state.visualMode);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function categoryOptions() { return `<option value="">Choose category</option>${state.categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}`; }
async function initialise() {
  const [{ categories }, config] = await Promise.all([api("/api/categories"), api("/api/config")]);
  state.categories = categories; state.config = config;
  $("#categoryFilter").insertAdjacentHTML("beforeend", categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join(""));
  $("#visualCategory").insertAdjacentHTML("beforeend", categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join(""));
  mountReport("lost"); mountReport("found");
  setupMaps(config.googleMapsApiKey);
  renderSocialStatus();
  try { const { user } = await api("/api/me"); enterApp(user); } catch { setAuthMode("login"); }
}

$("#switchAuth").addEventListener("click", () => setAuthMode($("#switchAuth").dataset.mode));
$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = $("button", event.currentTarget); setLoading(button, true);
  try { const form = new FormData(event.currentTarget); const { user } = await api("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) }); enterApp(user); } catch (error) { toast(error.message, "error"); } finally { setLoading(button, false); }
});
$("#signupForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = $("button", event.currentTarget); setLoading(button, true);
  try { const form = new FormData(event.currentTarget); const { user } = await api("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) }); enterApp(user); } catch (error) { toast(error.message, "error"); } finally { setLoading(button, false); }
});
$("#logoutButton").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST" }); location.reload(); });
$$(".nav-link[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));

function mountReport(type) {
  const form = $("#reportTemplate").content.firstElementChild.cloneNode(true);
  form.dataset.reportType = type; $(".category-select", form).innerHTML = categoryOptions();
  form.addEventListener("submit", submitReport);
  $(`#${type === "lost" ? "lost" : "found"}FormMount`).replaceChildren(form);
  // Both locations are mandatory for lost AND found reports, so both pickers are built for each form.
  form.pickers = [
    buildPicker($("[data-location-mount=original]", form), "original", type),
    buildPicker($("[data-location-mount=collection]", form), "collection", type),
  ];
  form.pickers.forEach((picker) => { if (state.mapsReady) initPickerMap(picker); });
}
async function submitReport(event) {
  event.preventDefault(); const form = event.currentTarget; const button = $("button[type=submit]", form); setLoading(button, true);
  const missing = form.pickers.find((picker) => !readPoint(picker));
  if (missing) { setLoading(button, false); return toast(`Select the ${missing.kind === "original" ? "original lost/found location" : "collection location"} on the map before publishing.`, "error"); }
  try {
    const data = new FormData(form); data.append("reportType", form.dataset.reportType);
    const { item, matches } = await api("/api/items", { method: "POST", body: data });
    toast("Your report is live."); form.reset();
    form.pickers.forEach((picker) => { picker.marker?.setMap(null); picker.status.textContent = "Not set yet — click the map, search, or use your location."; picker.status.className = "picker-status tiny muted"; });
    if (state.mapsReady || state.activeView === "map") loadMapItems({ silent: true });
    if (matches.length) { showView("browse"); setTimeout(() => openDetail(item.id, matches), 200); } else showView("reports");
  } catch (error) { toast(error.message, "error"); } finally { setLoading(button, false); }
}

$("#searchForm").addEventListener("submit", (event) => { event.preventDefault(); loadItems(); });
$("#typeFilter").addEventListener("change", loadItems); $("#categoryFilter").addEventListener("change", loadItems);
$("#nearMeButton").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Location is not available in this browser.", "error");
  navigator.geolocation.getCurrentPosition(({ coords }) => { state.location = { latitude: coords.latitude, longitude: coords.longitude }; toast("Showing reports within 8 km of you."); loadItems(); }, () => toast("Location permission was not granted.", "error"));
});
async function loadItems() {
  const params = new URLSearchParams();
  const q = $("#searchInput").value.trim(), type = $("#typeFilter").value, category = $("#categoryFilter").value;
  if (q) params.set("q", q); if (type) params.set("type", type); if (category) params.set("category", category);
  if (state.location) { params.set("latitude", state.location.latitude); params.set("longitude", state.location.longitude); params.set("radiusKm", "8"); }
  try { const [{ items }, stats] = await Promise.all([api(`/api/items?${params}`), api("/api/stats")]); renderItems(items, $("#itemGrid")); renderStats(stats); } catch (error) { toast(error.message, "error"); }
}
function renderStats(stats) { $("#stats").innerHTML = `<div><strong>${stats.total}</strong><span>active reports</span></div><div><strong>${stats.found}</strong><span>found items</span></div><div><strong>${stats.returned}</strong><span>returned</span></div>`; }
function renderItems(items, target, options = {}) {
  if (!items.length) { target.innerHTML = `<div class="empty-state"><span>⌕</span><h3>Nothing matched this search yet.</h3><p>Try a broader location, different keywords, or create a report for automatic matching.</p></div>`; return; }
  target.innerHTML = items.map((item) => cardHtml(item, options)).join("");
  $$("[data-item-id]", target).forEach((card) => card.addEventListener("click", () => openDetail(card.dataset.itemId)));
}
// "Message" buttons on cards and in results open the in-app chat directly. Captured first so the card does not also open.
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-message-id]");
  if (!button) return;
  event.stopPropagation(); event.preventDefault();
  startConversation({ id: button.dataset.messageId });
}, true);
function cardHtml(item, options = {}) {
  const image = item.primaryImage ? `<img src="${escapeHtml(item.primaryImage)}" alt="${escapeHtml(item.title)}">` : `<span class="image-placeholder">${item.category === "Keys" ? "🔑" : "◌"}</span>`;
  const match = item.match ? `<span class="score">${item.match.score}% match</span>` : (item.visualScore !== undefined ? `<span class="score">${item.visualScore}% visual</span>` : "");
  const action = options.own ? `<span class="status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>` : "";
  const distance = item.distanceKm !== null && item.distanceKm !== undefined ? ` · ${item.distanceKm} km away` : "";
  const collection = item.collection_location_name ? `<p class="card-collection">🤝 Collect at ${escapeHtml(item.collection_location_name)}</p>` : "";
  const canMessage = !options.own && state.user && item.user_id !== state.user.id;
  const quick = canMessage ? `<button type="button" class="text-button card-message" data-message-id="${item.id}">✉ ${item.report_type === "lost" ? "Message owner" : "Message finder"}</button>` : "";
  return `<article class="item-card" data-item-id="${item.id}"><div class="card-image">${image}<span class="report-type ${item.report_type}">${item.report_type}</span></div><div class="card-body"><div class="card-title-row"><h3>${escapeHtml(item.title)}</h3>${match || action}</div><p class="card-meta">${escapeHtml(item.category)}${item.color ? ` · ${escapeHtml(item.color)}` : ""}${distance}</p><p class="card-location">📍 ${escapeHtml(item.location_name)}</p>${collection}<p class="card-description">${escapeHtml(item.description || "No extra description provided.")}</p>${quick}</div></article>`;
}
function locationCard(kind, item) {
  if (kind === "original") {
    const coords = item.latitude !== null && item.latitude !== undefined ? `${Number(item.latitude).toFixed(5)}, ${Number(item.longitude).toFixed(5)}` : "";
    return `<div class="location-card original"><span class="pin-badge original">📍 ${item.report_type === "lost" ? "Lost at" : "Found at"}</span><strong>${escapeHtml(item.location_name)}</strong>${coords ? `<small class="muted tiny">${coords}</small><a href="${mapsLink(item.latitude, item.longitude)}" target="_blank" rel="noopener noreferrer">Open in Google Maps ↗</a>` : ""}</div>`;
  }
  const hasCollection = item.collection_latitude !== null && item.collection_latitude !== undefined;
  return `<div class="location-card collection"><span class="pin-badge collection">🤝 Collection point</span><strong>${escapeHtml(item.collection_location_name || "Not recorded")}</strong>${hasCollection ? `<small class="muted tiny">${Number(item.collection_latitude).toFixed(5)}, ${Number(item.collection_longitude).toFixed(5)}</small><a href="${mapsLink(item.collection_latitude, item.collection_longitude)}" target="_blank" rel="noopener noreferrer">Open in Google Maps ↗</a>` : `<small class="muted tiny">This report was created before collection points were required.</small>`}</div>`;
}
async function openDetail(id, matchesFromCreate = null) {
  try {
    const { item } = await api(`/api/items/${id}`);
    const matches = matchesFromCreate || (await api(`/api/items/${id}/matches`)).matches;
    const isOwner = item.user_id === state.user.id;
    const gallery = item.images.length ? `<div class="detail-gallery">${item.images.map((image) => `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.altText || item.title)}">`).join("")}</div>` : "";
    const matchHtml = matches.length ? `<section class="match-panel"><div class="section-label">SMART MATCHES</div><h3>Possible connections</h3>${matches.slice(0, 3).map((match) => `<button class="match-row" data-match-id="${match.id}"><strong>${escapeHtml(match.title)}</strong><span>${match.match.score}% · ${escapeHtml(match.match.reasons.join(", ") || "similar report")}</span></button>`).join("")}</section>` : "";
    const whatsappDigits = item.whatsapp ? item.whatsapp.replace(/\D/g, "") : "";
    const contact = isOwner ? "" : `<div class="contact-row"><button id="messageOwner" class="button primary wide-button" type="button">${item.report_type === "lost" ? "Message owner" : "Message finder"}</button>${whatsappDigits ? `<a class="button secondary wide-button" href="https://wa.me/${whatsappDigits}" target="_blank" rel="noopener noreferrer">Contact on WhatsApp (optional)</a>` : ""}</div>`;
    const ownerControls = isOwner ? `<section class="owner-controls"><label>Report status<select id="statusSelect"><option value="open" ${item.status === "open" ? "selected" : ""}>Open</option><option value="matched" ${item.status === "matched" ? "selected" : ""}>Possible match</option><option value="claimed" ${item.status === "claimed" ? "selected" : ""}>Claimed</option><option value="returned" ${item.status === "returned" ? "selected" : ""}>Returned</option><option value="closed" ${item.status === "closed" ? "selected" : ""}>Closed</option></select></label><button id="saveStatus" class="button secondary">Update status</button><button id="deleteItem" class="text-button danger-text">Delete report</button></section>` : "";
    $("#detailContent").innerHTML = `${gallery}<div class="detail-content"><div class="detail-top"><span class="report-type ${item.report_type}">${item.report_type}</span><span class="status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></div><h2>${escapeHtml(item.title)}</h2><p class="detail-description">${escapeHtml(item.description || "No description provided.")}</p><dl class="detail-list"><div><dt>Category</dt><dd>${escapeHtml(item.category)}</dd></div><div><dt>Date</dt><dd>${displayDate(item.occurred_at)}</dd></div><div><dt>Posted by</dt><dd>${escapeHtml(item.reporter_name)}</dd></div>${item.keywords?.length ? `<div><dt>Keywords</dt><dd>${item.keywords.map(escapeHtml).join(", ")}</dd></div>` : ""}</dl><section class="location-cards">${locationCard("original", item)}${locationCard("collection", item)}</section>${hasMaps() && item.latitude != null ? `<div id="detailMap" class="google-map detail-map" aria-label="Both locations on Google Maps"></div>` : ""}${contact}${ownerControls}${matchHtml}</div>`;
    const dialog = $("#detailDialog"); dialog.showModal();
    if (hasMaps() && item.latitude != null) renderDetailMap(item);
    $$("[data-match-id]", dialog).forEach((button) => button.addEventListener("click", () => openDetail(button.dataset.matchId)));
    $("#messageOwner")?.addEventListener("click", () => startConversation(item));
    $("#saveStatus")?.addEventListener("click", () => updateStatus(item.id));
    $("#deleteItem")?.addEventListener("click", () => deleteReport(item.id));
  } catch (error) { toast(error.message, "error"); }
}
function renderDetailMap(item) {
  const bounds = new google.maps.LatLngBounds();
  const map = new google.maps.Map($("#detailMap"), { mapTypeControl: false, streetViewControl: false, fullscreenControl: false, zoom: 15, center: { lat: Number(item.latitude), lng: Number(item.longitude) } });
  const original = { lat: Number(item.latitude), lng: Number(item.longitude) };
  new google.maps.Marker({ map, position: original, icon: pinIcon(item.report_type === "lost" ? LOST_COLOR : FOUND_COLOR, item.report_type === "lost" ? "L" : "F"), title: `${item.report_type === "lost" ? "Lost" : "Found"} at ${item.location_name}` });
  bounds.extend(original);
  if (item.collection_latitude != null) {
    const collection = { lat: Number(item.collection_latitude), lng: Number(item.collection_longitude) };
    new google.maps.Marker({ map, position: collection, icon: collectionIcon(), title: `Collection point: ${item.collection_location_name}` });
    bounds.extend(collection);
  }
  if (item.collection_latitude != null) map.fitBounds(bounds, 40);
}
$("#closeDialog").addEventListener("click", () => $("#detailDialog").close());
async function updateStatus(id) { try { await api(`/api/items/${id}/status`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: $("#statusSelect").value }) }); toast("Status updated."); $("#detailDialog").close(); loadMyReports(); } catch (error) { toast(error.message, "error"); } }
async function deleteReport(id) { if (!confirm("Delete this report? This cannot be undone.")) return; try { await api(`/api/items/${id}`, { method: "DELETE" }); toast("Report deleted."); $("#detailDialog").close(); loadMyReports(); } catch (error) { toast(error.message, "error"); } }

// ---- Image search: similar report photos (existing) and AI Visual Finder for crowded photos (new) ----
function setVisualMode(mode) {
  state.visualMode = mode;
  $$("[data-visual-mode]").forEach((button) => { button.classList.toggle("active", button.dataset.visualMode === mode); button.setAttribute("aria-selected", String(button.dataset.visualMode === mode)); });
  $("#similarPanel").classList.toggle("hidden", mode !== "similar");
  $("#crowdPanel").classList.toggle("hidden", mode !== "crowd");
}
$$("[data-visual-mode]").forEach((button) => button.addEventListener("click", () => setVisualMode(button.dataset.visualMode)));
$("#visualForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = $("button", event.currentTarget); setLoading(button, true);
  try { const { results, method } = await api("/api/visual-search", { method: "POST", body: new FormData(event.currentTarget) }); renderItems(results, $("#visualResults")); toast(`Results use ${method}.`); } catch (error) { toast(error.message, "error"); } finally { setLoading(button, false); }
});
function previewFile(input, target) {
  const file = input.files?.[0];
  if (!file) { target.classList.add("hidden"); target.removeAttribute("src"); return; }
  target.src = URL.createObjectURL(file); target.classList.remove("hidden");
}
$("#crowdForm [name=scene]").addEventListener("change", (event) => previewFile(event.currentTarget, $("#scenePreview")));
$("#crowdForm [name=reference]").addEventListener("change", (event) => previewFile(event.currentTarget, $("#referencePreview")));
$("#crowdForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button[type=submit]", form); setLoading(button, true);
  $("#crowdResults").innerHTML = `<div class="scan-status"><span class="spinner" aria-hidden="true"></span> Analysing the crowded photo. This can take several seconds…</div>`;
  try {
    const result = await api("/api/visual-finder", { method: "POST", body: new FormData(form) });
    renderCrowdResults(result);
  } catch (error) { $("#crowdResults").innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`; } finally { setLoading(button, false); }
});
function renderCrowdResults(result) {
  const target = $("#crowdResults");
  if (!result.found) {
    target.innerHTML = `<div class="empty-state"><span>◉</span><h3>No suitable match detected</h3><p>${escapeHtml(result.note)}</p><p class="tiny muted">${escapeHtml(result.method)}</p></div>`;
    return;
  }
  const detections = result.detections.map((detection) => {
    const evidence = detection.method === "feature" ? `${detection.inliers} matching feature points` : `shape similarity ${detection.ncc}% · colour similarity ${detection.colorSimilarity}%`;
    return `<article class="detection">${detection.preview ? `<img src="${detection.preview}" alt="Detected object ${detection.id}">` : `<span class="image-placeholder">◌</span>`}<div><strong>Match ${detection.id}</strong><div class="confidence" role="img" aria-label="${detection.confidence}% confidence"><span style="width:${detection.confidence}%"></span></div><small>${detection.confidence}% confidence · ${escapeHtml(evidence)}</small><small class="muted">Position x ${detection.x}, y ${detection.y} · ${detection.width}×${detection.height}px</small></div></article>`;
  }).join("");
  target.innerHTML = `<div class="crowd-result"><button class="highlight-button" type="button" data-open-highlight><img src="${result.annotatedImage}" alt="Crowded area with highlighted matches"><span>Tap to view the highlighted photo full size</span></button><div class="detection-list">${detections}</div><p class="tiny muted">${escapeHtml(result.note)}</p><p class="tiny muted">${escapeHtml(result.method)}</p></div>`;
  $("[data-open-highlight]", target).addEventListener("click", () => {
    $("#detailContent").innerHTML = `<div class="detail-content"><h2>Highlighted matches</h2><img class="full-highlight" src="${result.annotatedImage}" alt="Crowded area with highlighted matches"><p class="tiny muted">${escapeHtml(result.note)}</p></div>`;
    $("#detailDialog").showModal();
  });
}

// ---- AI assistant: searches real reports within 2 km of the user ----
$("#assistantLocate").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Location is not available in this browser.", "error");
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    state.assistantLocation = { latitude: coords.latitude, longitude: coords.longitude };
    $("#assistantLocationStatus").textContent = "Shared. Results are limited to reports within 2 km of you.";
    toast("Location shared with the assistant for this search.");
  }, () => toast("Location permission was not granted.", "error"), { enableHighAccuracy: true, timeout: 10000 });
});
$("#assistantForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const input = $("input", event.currentTarget), question = input.value.trim(); if (!question) return;
  addAssistantMessage(escapeHtml(question), "user", true); input.value = ""; const button = $("button", event.currentTarget); setLoading(button, true);
  try {
    const body = { question, ...(state.assistantLocation || {}) };
    const data = await api("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    renderAssistantAnswer(data);
  } catch (error) { addAssistantMessage(escapeHtml(error.message), "bot", true); } finally { setLoading(button, false); }
});
function renderAssistantAnswer({ answer, understood, matches, social }) {
  const chips = [understood.type === "lost" ? "Looking for: found reports" : "Looking for: lost reports", understood.locationUsed ? `Radius: ${understood.radiusKm} km` : "Citywide (no location shared)", ...understood.categories.map((c) => `Category: ${c}`), ...understood.colors.map((c) => `Colour: ${c}`)];
  addAssistantMessage(`${escapeHtml(answer)}<div class="keyword-line">${chips.map(escapeHtml).map((chip) => `<span class="chip">${chip}</span>`).join("")}</div><div class="keyword-line muted tiny">Searched ${understood.searchedCount} active reports${understood.keywords.length ? ` · details: ${escapeHtml(understood.keywords.slice(0, 8).join(", "))}` : ""}.</div>`, "bot", true);
  if (matches.length) {
    const holder = document.createElement("div"); holder.className = "assistant-match-grid";
    holder.innerHTML = matches.map((item) => `<article class="assistant-result">
        <div class="assistant-result-image">${item.primaryImage ? `<img src="${escapeHtml(item.primaryImage)}" alt="${escapeHtml(item.title)}">` : `<span class="image-placeholder">◌</span>`}</div>
        <div class="assistant-result-body">
          <div class="card-title-row"><strong>${escapeHtml(item.title)}</strong><span class="score">${item.match.score}% match</span></div>
          <p class="tiny muted">${escapeHtml(item.category)}${item.color ? ` · ${escapeHtml(item.color)}` : ""}${item.distanceKm !== null && item.distanceKm !== undefined ? ` · ${item.distanceKm} km away` : ""}</p>
          <p class="tiny">${escapeHtml(item.description || "No description provided.")}</p>
          <p class="tiny"><strong>📍 ${item.report_type === "lost" ? "Lost at" : "Found at"}:</strong> ${escapeHtml(item.location_name)}</p>
          <p class="tiny"><strong>🤝 Collection point:</strong> ${escapeHtml(item.collection_location_name || "Not recorded")}</p>
          <p class="tiny muted">${item.match.reasons.map(escapeHtml).join(" · ")}</p>
          <div class="assistant-result-actions"><button type="button" class="button secondary small" data-item-id="${item.id}">View details</button><button type="button" class="button primary small" data-message-id="${item.id}">${item.report_type === "lost" ? "Message owner" : "Message finder"}</button>${item.whatsapp ? `<a class="button subtle small" href="https://wa.me/${item.whatsapp.replace(/\D/g, "")}" target="_blank" rel="noopener noreferrer">WhatsApp</a>` : ""}</div>
        </div></article>`).join("");
    $("#assistantMessages").append(holder);
    $$("[data-item-id]", holder).forEach((node) => node.addEventListener("click", () => openDetail(node.dataset.itemId)));
  }
  if (social?.configured && social.results?.length) {
    const block = document.createElement("div"); block.className = "assistant-social";
    block.innerHTML = `<p class="tiny muted"><strong>Public Facebook posts nearby</strong> (external, not Recoverly listings)</p>${social.results.map((post) => `<a class="social-card compact" href="${escapeHtml(post.url)}" target="_blank" rel="noopener noreferrer"><span class="external-badge">Facebook</span><div><strong>${escapeHtml(post.title)}</strong><p class="tiny">${escapeHtml(post.excerpt)}</p></div></a>`).join("")}`;
    $("#assistantMessages").append(block);
  }
  $("#assistantMessages").scrollTop = 1e6;
}
function addAssistantMessage(content, type, html = false) { const node = document.createElement("div"); node.className = `assistant-message ${type}`; if (html) node.innerHTML = content; else node.textContent = content; $("#assistantMessages").append(node); $("#assistantMessages").scrollTop = 1e6; }
$$("[data-prompt]").forEach((button) => button.addEventListener("click", () => { $("#assistantForm input").value = button.dataset.prompt; $("#assistantForm").requestSubmit(); }));

// ---- Private in-app chat between finder and owner, linked to a report ----
async function startConversation(item) { try { const { conversation } = await api("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: item.id }) }); $("#detailDialog").close(); await showView("messages"); await openConversation(conversation.id); } catch (error) { toast(error.message, "error"); } }
async function loadConversations() {
  try { const { conversations } = await api("/api/conversations"); const target = $("#conversationList"); target.innerHTML = conversations.length ? conversations.map((conversation) => `<button class="conversation ${state.activeConversation === conversation.id ? "selected" : ""}" data-conversation-id="${conversation.id}">${conversation.item_image ? `<img src="${escapeHtml(conversation.item_image)}" alt="">` : `<span>◌</span>`}<div><strong>${escapeHtml(conversation.counterpart_name)}</strong><small>${escapeHtml(conversation.item_title)} · ${conversation.report_type === "lost" ? "lost report" : "found report"}</small><p>${escapeHtml(conversation.last_message || "No messages yet")}</p></div></button>`).join("") : `<div class="empty-state small"><h3>No conversations yet.</h3><p>Open a report and choose “Message” to begin safely.</p></div>`; $$("[data-conversation-id]", target).forEach((node) => node.addEventListener("click", () => openConversation(node.dataset.conversationId))); if (state.activeConversation && conversations.some((c) => c.id === state.activeConversation)) await openConversation(state.activeConversation); } catch (error) { toast(error.message, "error"); }
}
async function openConversation(id, { silent = false } = {}) {
  state.activeConversation = id;
  try {
    const { conversation, messages } = await api(`/api/conversations/${id}/messages`);
    state.conversationMeta = conversation; state.lastMessageCount = messages.length;
    const target = $("#messagePane"); target.classList.remove("empty-pane");
    const recipientFor = (senderId) => (senderId === conversation.ownerId ? conversation.requesterName : conversation.ownerName);
    target.innerHTML = `<header class="chat-head"><div><strong>${escapeHtml(conversation.counterpartName)}</strong><small>${conversation.reportType === "lost" ? "Lost report" : "Found report"} · ${escapeHtml(conversation.itemTitle)}</small><small class="muted">You are the ${conversation.viewerRole === "owner" ? "item owner" : "finder or requester"}. Only you two can see this chat.</small></div><button type="button" class="button secondary small" id="viewChatItem" data-item="${escapeHtml(conversation.itemId)}">View report</button></header><div class="message-thread">${messages.length ? messages.map((message) => `<div class="message ${message.sender_id === state.user.id ? "mine" : ""}"><span>${escapeHtml(message.body)}</span><small>${escapeHtml(message.sender_name)} → ${escapeHtml(recipientFor(message.sender_id))} · ${displayDate(message.created_at)}</small></div>`).join("") : `<p class="muted pad">No messages yet. Introduce yourself and confirm the item details.</p>`}</div><form id="messageForm" class="message-form"><input name="body" maxlength="2000" placeholder="Write a message…" required><button class="button primary">Send</button></form>`;
    $("#messageForm").addEventListener("submit", (event) => sendMessage(event, id));
    $("#viewChatItem").addEventListener("click", () => openDetail(conversation.itemId));
    $(".message-thread", target).scrollTop = 1e6;
  } catch (error) { if (!silent) toast(error.message, "error"); }
}
async function sendMessage(event, id) { event.preventDefault(); const form = event.currentTarget; const input = $("input", form), body = input.value.trim(); if (!body) return; try { await api(`/api/conversations/${id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) }); input.value = ""; await openConversation(id); } catch (error) { toast(error.message, "error"); } }

async function loadMyReports() {
  try { const { items } = await api("/api/items?limit=100"); renderItems(items.filter((item) => item.user_id === state.user.id), $("#myReports"), { own: true }); } catch (error) { toast(error.message, "error"); }
}
$("#editProfileButton").addEventListener("click", () => { $("#profileEditor").classList.toggle("hidden"); $("#profileForm [name=name]").value = state.user.name; $("#profileForm [name=email]").value = state.user.email; });
$("#profileForm").addEventListener("submit", async (event) => { event.preventDefault(); try { const name = new FormData(event.currentTarget).get("name"); const { user } = await api("/api/me", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email: new FormData(event.currentTarget).get("email") }) }); state.user = user; $("#profileName").textContent = user.name; $("#profileInitial").textContent = user.name.slice(0, 1).toUpperCase(); $("#profileEditor").classList.add("hidden"); toast("Profile updated."); } catch (error) { toast(error.message, "error"); } });

$("#notificationButton").addEventListener("click", () => $("#notificationPanel").classList.toggle("hidden"));
async function loadNotifications({ announce = false } = {}) {
  try {
    const { notifications } = await api("/api/notifications");
    const unread = notifications.filter((notification) => !notification.read_at).length;
    if (announce && state.unread !== null && unread > state.unread) { const newest = notifications.find((notification) => !notification.read_at); if (newest) toast(`${newest.title}${newest.body ? `: ${newest.body}` : ""}`); }
    state.unread = unread;
    $("#notificationCount").textContent = unread; $("#notificationCount").classList.toggle("hidden", unread === 0);
    $("#notificationList").innerHTML = notifications.length ? notifications.map((notification) => `<div class="notification-item ${notification.read_at ? "" : "unread"}"><strong>${escapeHtml(notification.title)}</strong><p>${escapeHtml(notification.body || "")}</p><small>${displayDate(notification.created_at)}</small></div>`).join("") : `<p class="muted pad">Nothing new right now.</p>`;
  } catch { /* session can be changing */ }
}
$("#readNotifications").addEventListener("click", async () => { await api("/api/notifications/read", { method: "PATCH" }); loadNotifications(); });

// ---- Map & discovery: all reports on Google Maps, plus area-based Instagram / Facebook posts ----
function setMapTab(tab) {
  state.mapTab = tab;
  $$("[data-map-tab]").forEach((button) => button.classList.toggle("active", button.dataset.mapTab === tab));
  $("#mapReportsPanel").classList.toggle("hidden", tab !== "reports");
  $("#mapSocialPanel").classList.toggle("hidden", tab !== "social");
  if (tab === "reports") loadMapItems({ silent: true });
  else ensureSocialMap();
}
$$("[data-map-tab]").forEach((button) => button.addEventListener("click", () => setMapTab(button.dataset.mapTab)));

async function loadMapItems({ silent = false } = {}) {
  try {
    const { items } = await api("/api/map/items");
    state.mapItems = items;
    $("#mapCount").textContent = `${items.length} located report${items.length === 1 ? "" : "s"}`;
    if (!hasMaps()) {
      $("#mapStatus").textContent = state.config?.googleMapsApiKey ? "Loading Google Maps…" : "The interactive map is off until GOOGLE_MAPS_API_KEY is set on the server. Every located report is listed below.";
      renderItems(items, $("#reportsMap"));
      return;
    }
    ensureReportsMap();
    renderMapMarkers(items);
    $("#mapStatus").textContent = `Updated ${new Date().toLocaleTimeString()}. The map refreshes automatically.`;
  } catch (error) { if (!silent) toast(error.message, "error"); }
}
function ensureReportsMap() {
  if (state.reportsMap) { google.maps.event.trigger(state.reportsMap, "resize"); return; }
  $("#reportsMap").innerHTML = "";
  state.reportsMap = new google.maps.Map($("#reportsMap"), { center: DEFAULT_CENTER, zoom: 12, mapTypeControl: false, streetViewControl: false, fullscreenControl: false });
  state.infoWindow = new google.maps.InfoWindow();
}
function renderMapMarkers(items) {
  state.mapMarkers.forEach((marker) => marker.setMap(null));
  state.mapMarkers = [];
  const bounds = new google.maps.LatLngBounds();
  for (const item of items) {
    const position = { lat: Number(item.latitude), lng: Number(item.longitude) };
    const marker = new google.maps.Marker({ map: state.reportsMap, position, icon: pinIcon(item.report_type === "lost" ? LOST_COLOR : FOUND_COLOR, item.report_type === "lost" ? "L" : "F"), title: `${item.report_type === "lost" ? "Lost" : "Found"}: ${item.title}` });
    marker.addListener("click", () => openMapInfo(marker, item, "original"));
    state.mapMarkers.push(marker); bounds.extend(position);
    if (item.collection_latitude != null && item.collection_longitude != null) {
      const collectionPosition = { lat: Number(item.collection_latitude), lng: Number(item.collection_longitude) };
      const collectionMarker = new google.maps.Marker({ map: state.reportsMap, position: collectionPosition, icon: collectionIcon(), title: `Collection point: ${item.collection_location_name || item.title}` });
      collectionMarker.addListener("click", () => openMapInfo(collectionMarker, item, "collection"));
      state.mapMarkers.push(collectionMarker); bounds.extend(collectionPosition);
    }
  }
  if (items.length && !state.mapFitted) {
    if (items.length === 1) { state.reportsMap.setCenter(bounds.getCenter()); state.reportsMap.setZoom(15); }
    else state.reportsMap.fitBounds(bounds, 48);
    state.mapFitted = true;
  }
}
function openMapInfo(marker, item, which) {
  const collection = which === "collection";
  const heading = collection ? "🤝 Collection point" : (item.report_type === "lost" ? "📍 Lost at" : "📍 Found at");
  const place = collection ? (item.collection_location_name || "Not recorded") : item.location_name;
  state.infoWindow.setContent(`<div class="map-info"><span class="report-type ${item.report_type}">${item.report_type}</span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(heading)}: ${escapeHtml(place)}</small>${item.image ? `<img src="${escapeHtml(item.image)}" alt="">` : ""}<p class="tiny muted">${escapeHtml(item.category)} · ${escapeHtml(item.status)}</p><button type="button" class="button primary small" data-open-item="${escapeHtml(item.id)}">Open details</button></div>`);
  state.infoWindow.open({ anchor: marker, map: state.reportsMap });
  google.maps.event.addListenerOnce(state.infoWindow, "domready", () => $(`[data-open-item="${item.id}"]`)?.addEventListener("click", () => openDetail(item.id)));
}

function renderSocialStatus() {
  const social = state.config?.social;
  if (!social) return;
  const label = (name, status) => `${name}: ${status.configured ? "connected" : "not connected yet"}`;
  $("#discoverLimitation").classList.remove("hidden");
  $("#discoverLimitation").innerHTML = `<strong>${escapeHtml(label("Instagram", social.instagram))}</strong> · <strong>${escapeHtml(label("Facebook", social.facebook))}</strong><br><span class="tiny">${escapeHtml(social.instagram.geoBasis)}. ${escapeHtml(social.facebook.geoBasis)}.</span>`;
}
function setPlatform(platform) {
  state.discoverPlatform = platform;
  $$("[data-platform]").forEach((button) => button.classList.toggle("active", button.dataset.platform === platform));
}
$$("[data-platform]").forEach((button) => button.addEventListener("click", () => setPlatform(button.dataset.platform)));
function ensureSocialMap() {
  if (!hasMaps()) { $("#socialMap").innerHTML = `<div class="map-unavailable">Map selection needs GOOGLE_MAPS_API_KEY. Type the latitude and longitude of the area, or use your location.</div>`; return; }
  if (state.socialMap) { google.maps.event.trigger(state.socialMap, "resize"); if (state.socialPoint) state.socialMap.setCenter(state.socialPoint); return; }
  $("#socialMap").innerHTML = "";
  state.socialMap = new google.maps.Map($("#socialMap"), { center: state.socialPoint || state.lastKnown || DEFAULT_CENTER, zoom: 13, mapTypeControl: false, streetViewControl: false, fullscreenControl: false });
  state.socialMarker = new google.maps.Marker({ map: null, draggable: true });
  state.socialMap.addListener("click", (event) => setSocialPoint(event.latLng.lat(), event.latLng.lng()));
  state.socialMarker.addListener("dragend", (event) => setSocialPoint(event.latLng.lat(), event.latLng.lng()));
  if (state.socialPoint) setSocialPoint(state.socialPoint.lat, state.socialPoint.lng);
}
function setSocialPoint(lat, lng) {
  state.socialPoint = { lat, lng };
  $("#socialLatitude").value = lat.toFixed(6); $("#socialLongitude").value = lng.toFixed(6);
  if (state.socialMap) {
    state.socialMarker.setPosition({ lat, lng }); state.socialMarker.setMap(state.socialMap);
    if (!state.socialCircle) state.socialCircle = new google.maps.Circle({ map: state.socialMap, strokeColor: FOUND_COLOR, strokeWeight: 2, fillColor: "#c9f064", fillOpacity: 0.25 });
    state.socialCircle.setOptions({ center: { lat, lng }, radius: Number($("#socialRadius").value) * 1000, map: state.socialMap });
  }
  $("#socialAreaNote").textContent = `Area set at ${lat.toFixed(4)}, ${lng.toFixed(4)} with a ${$("#socialRadius").value} km radius.`;
}
$("#socialRadius").addEventListener("change", () => { if (state.socialPoint) setSocialPoint(state.socialPoint.lat, state.socialPoint.lng); });
$("#socialLatitude").addEventListener("change", () => { const p = { lat: Number($("#socialLatitude").value), lng: Number($("#socialLongitude").value) }; if ($("#socialLongitude").value !== "" && Number.isFinite(p.lat) && Number.isFinite(p.lng)) setSocialPoint(p.lat, p.lng); });
$("#socialLongitude").addEventListener("change", () => { const p = { lat: Number($("#socialLatitude").value), lng: Number($("#socialLongitude").value) }; if ($("#socialLatitude").value !== "" && Number.isFinite(p.lat) && Number.isFinite(p.lng)) setSocialPoint(p.lat, p.lng); });
$("#socialLocate").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Location is not available in this browser.", "error");
  navigator.geolocation.getCurrentPosition(({ coords }) => { setSocialPoint(coords.latitude, coords.longitude); if (state.socialMap) state.socialMap.setCenter(state.socialPoint); }, () => toast("Location permission was not granted.", "error"), { enableHighAccuracy: true, timeout: 10000 });
});
$("#socialSearchButton").addEventListener("click", async () => {
  if (!state.socialPoint) return toast("Choose an area on the map, type coordinates, or use your location first.", "error");
  const button = $("#socialSearchButton"); setLoading(button, true);
  $("#discoverResults").innerHTML = `<div class="scan-status"><span class="spinner" aria-hidden="true"></span> Searching public posts in this area…</div>`;
  try {
    const data = await api("/api/social/discover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: state.discoverPlatform, latitude: state.socialPoint.lat, longitude: state.socialPoint.lng, radiusKm: Number($("#socialRadius").value), areaName: $("#socialAreaName").value.trim(), query: $("#socialQuery").value.trim() }) });
    renderDiscover(data);
  } catch (error) {
    $("#discoverResults").innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
  } finally { setLoading(button, false); }
});
function renderDiscover(data) {
  const name = data.platform === "instagram" ? "Instagram" : "Facebook";
  const notice = $("#discoverLimitation");
  notice.classList.remove("hidden");
  notice.innerHTML = `<strong>${name}</strong>${data.configured ? "" : " is not connected yet."} <span>${escapeHtml(data.limitation || "")}</span>${data.configured ? "" : `<br><span class="tiny">An administrator must set ${data.platform === "instagram" ? "META_ACCESS_TOKEN and META_IG_USER_ID" : "META_ACCESS_TOKEN"} on the server after Meta app review (see README).</span>`}${data.cached ? `<br><span class="tiny muted">Showing results cached within the last 30 minutes.</span>` : ""}${data.disclaimer ? `<br><span class="tiny muted">${escapeHtml(data.disclaimer)}</span>` : ""}`;
  const list = $("#discoverResults");
  if (!data.results?.length) { list.innerHTML = `<div class="empty-state small"><span>◎</span><h3>No public posts found here yet.</h3><p>Try a larger radius, a place name, or different keywords.</p></div>`; return; }
  list.innerHTML = data.results.map((post) => `<article class="social-card"><span class="external-badge ${post.platform}">${name} · external</span>${post.imageUrl ? `<img src="${escapeHtml(post.imageUrl)}" alt="">` : ""}<div><strong>${escapeHtml(post.title)}</strong><p class="tiny">${escapeHtml(post.excerpt)}</p><p class="tiny muted">${escapeHtml(post.sourceName || "")}${post.publishedAt ? ` · ${displayDate(post.publishedAt)}` : ""}</p><a href="${escapeHtml(post.url)}" target="_blank" rel="noopener noreferrer">View original post ↗</a></div></article>`).join("");
}

$("#socialButton").addEventListener("click", async () => {
  const query = $("#searchInput").value.trim() || prompt("What item should we look for in connected sources?"); if (!query) return;
  try { const result = await api("/api/social/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) }); const target = $("#socialResults"); target.classList.remove("hidden"); target.innerHTML = `<div class="social-head"><strong>Connected social sources</strong><span>${escapeHtml(result.limitation)}</span></div>${result.configured ? (result.results.length ? result.results.map((post) => `<a href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer" class="social-post"><span>${post.source === "instagram" ? "◎" : "f"}</span><div><strong>${escapeHtml(post.title)}</strong><p>${escapeHtml(post.excerpt)}</p></div></a>`).join("") : `<p class="muted pad">No authorized posts matched those terms.</p>`) : `<p class="muted pad">${escapeHtml(result.limitation)}</p>`}`; } catch (error) { toast(error.message, "error"); }
});

$("#mobileMenu").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
initialise().catch((error) => toast(error.message, "error"));
// Live updates: notifications, open chat threads and the map refresh without a page reload.
setInterval(() => {
  if (!state.user) return;
  loadNotifications({ announce: true });
  if (document.visibilityState !== "visible") return;
  if (state.activeView === "messages" && state.activeConversation) {
    api(`/api/conversations/${state.activeConversation}/messages`).then(({ messages }) => { if (messages.length !== state.lastMessageCount) openConversation(state.activeConversation, { silent: true }); }).catch(() => {});
  }
  if (state.activeView === "map" && state.mapTab === "reports") loadMapItems({ silent: true });
}, 20000);
