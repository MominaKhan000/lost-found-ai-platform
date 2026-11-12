require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { query, pool, migrate, close } = require("./db");
const { tokenize, haversine, scoreItems, scoreQuery, parseRequest, scoreRequest } = require("./services/matching");
const { perceptualHash, visualScore } = require("./services/vision");
const { searchSocial, discoverSocial, discoveryStatus } = require("./services/social");
const { findItemInScene } = require("./services/visual-finder");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
if (isProduction && !process.env.JWT_SECRET) throw new Error("JWT_SECRET is required in production.");
const JWT_SECRET = process.env.JWT_SECRET || "local-development-secret-change-me";
const uploadDir = path.join(__dirname, "..", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use("/uploads", express.static(uploadDir, { maxAge: isProduction ? "7d" : 0 }));
app.use(express.static(path.join(__dirname, "..", "public")));

const imageFilter = (req, file, done) => {
  if (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) return done(null, true);
  return done(new Error("Only JPEG, PNG, and WebP images are accepted."));
};
const storage = multer.diskStorage({
  destination: (req, file, done) => done(null, uploadDir),
  filename: (req, file, done) => done(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({ storage, fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024, files: 5 } });
const memoryUpload = multer({ storage: multer.memoryStorage(), fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024 } });

const CATEGORIES = ["Accessories", "Bags", "Books", "Cards & IDs", "Clothing", "Documents", "Electronics", "Jewelry", "Keys", "Sports", "Other"];
const itemColumns = `
  i.*, u.name AS reporter_name,
  COALESCE(json_agg(json_build_object('id', im.id, 'url', im.storage_path, 'altText', im.alt_text, 'visualHash', im.visual_hash) ORDER BY im.created_at)
    FILTER (WHERE im.id IS NOT NULL), '[]'::json) AS images`;
const itemJoins = ` FROM items i JOIN users u ON u.id = i.user_id LEFT JOIN item_images im ON im.item_id = i.id`;
const itemGroup = ` GROUP BY i.id, u.id`;

function cleanString(value, max = 200) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}
function parseKeywords(value) {
  return [...new Set(String(value || "").split(/[,\n]/).map((word) => cleanString(word, 40).toLowerCase()).filter(Boolean))].slice(0, 20);
}
function numberOrNull(value, min, max) {
  if (value === "" || value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}
const SEARCH_RADIUS_KM = 2;
const ACTIVE_STATUSES = ["open", "matched", "claimed"];

function itemForClient(row, viewerId) {
  if (!row) return null;
  const item = { ...row, images: row.images || [] };
  item.primaryImage = item.images[0]?.url || null;
  item.visual_hash = item.images[0]?.visualHash || null;
  delete item.password_hash;
  // The WhatsApp number is private unless the reporter chose to show it on the report.
  if (item.user_id !== viewerId && !item.whatsapp_visible) delete item.whatsapp;
  return item;
}
function digitsOnly(value) { return String(value || "").replace(/[^\d+]/g, ""); }
function distanceKm(latitude, longitude, row) {
  if (row.latitude === null || row.latitude === undefined || row.longitude === null || row.longitude === undefined) return null;
  return Math.round(haversine(latitude, longitude, Number(row.latitude), Number(row.longitude)) * 100) / 100;
}
function signUser(user) {
  return jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
}
function setSession(res, user) {
  res.cookie("session", signUser(user), { httpOnly: true, sameSite: "lax", secure: isProduction, maxAge: 7 * 24 * 60 * 60 * 1000, path: "/" });
}
function maybeUser(req, res, next) {
  const token = req.cookies.session || req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch { /* anonymous */ }
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please sign in to continue." });
  next();
}
async function notify(userId, kind, title, body, link = null) {
  await query("INSERT INTO notifications (user_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5)", [userId, kind, title, body, link]);
}
async function getItem(id, viewerId) {
  const { rows } = await query(`SELECT ${itemColumns}${itemJoins} WHERE i.id = $1${itemGroup}`, [id]);
  return itemForClient(rows[0], viewerId);
}
async function fetchAllItems(where = "", params = []) {
  const { rows } = await query(`SELECT ${itemColumns}${itemJoins} ${where}${itemGroup}`, params);
  return rows.map((row) => itemForClient(row));
}
async function findMatches(item) {
  const opposite = item.report_type === "lost" ? "found" : "lost";
  const candidates = await fetchAllItems("WHERE i.report_type = $1 AND i.status IN ('open', 'matched') AND i.id <> $2", [opposite, item.id]);
  return candidates.map((candidate) => ({ ...itemForClient(candidate), match: scoreItems(item, candidate) })).filter((candidate) => candidate.match.score >= 25).sort((a, b) => b.match.score - a.match.score).slice(0, 12);
}

app.use(maybeUser);
app.get("/api/health", async (req, res, next) => {
  try { await query("SELECT 1"); res.json({ ok: true, database: "neon-postgresql" }); } catch (error) { next(error); }
});
app.get("/api/categories", (req, res) => res.json({ categories: CATEGORIES }));

app.post("/api/auth/signup", async (req, res, next) => {
  try {
    const name = cleanString(req.body.name, 80);
    const email = cleanString(req.body.email, 255).toLowerCase();
    const password = String(req.body.password || "");
    if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return res.status(400).json({ error: "Enter a name, valid email, and password of at least 8 characters." });
    const passwordHash = await bcrypt.hash(password, 12);
    const { rows } = await query("INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id,name,email,avatar_url", [name, email, passwordHash]);
    setSession(res, rows[0]);
    res.status(201).json({ user: rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That email is already registered." });
    next(error);
  }
});
app.post("/api/auth/login", async (req, res, next) => {
  try {
    const email = cleanString(req.body.email, 255).toLowerCase();
    const password = String(req.body.password || "");
    const { rows } = await query("SELECT id,name,email,avatar_url,password_hash FROM users WHERE email = $1", [email]);
    if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) return res.status(401).json({ error: "Incorrect email or password." });
    const user = rows[0]; delete user.password_hash;
    setSession(res, user);
    res.json({ user });
  } catch (error) { next(error); }
});
app.post("/api/auth/logout", (req, res) => { res.clearCookie("session", { path: "/" }); res.json({ ok: true }); });
app.get("/api/me", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query("SELECT id,name,email,avatar_url,created_at FROM users WHERE id=$1", [req.user.id]);
    res.json({ user: rows[0] });
  } catch (error) { next(error); }
});
app.put("/api/me", requireAuth, async (req, res, next) => {
  try {
    const name = cleanString(req.body.name, 80);
    const email = cleanString(req.body.email, 255).toLowerCase();
    if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a name and valid email address." });
    const { rows } = await query("UPDATE users SET name=$1, email=$2, updated_at=now() WHERE id=$3 RETURNING id,name,email,avatar_url", [name, email, req.user.id]);
    setSession(res, rows[0]); res.json({ user: rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That email is already registered." });
    next(error);
  }
});

app.get("/api/items", async (req, res, next) => {
  try {
    const conditions = []; const params = [];
    const add = (sql, value) => { params.push(value); conditions.push(sql.replace("?", `$${params.length}`)); };
    if (["lost", "found"].includes(req.query.type)) add("i.report_type = ?", req.query.type);
    if (req.query.category && CATEGORIES.includes(req.query.category)) add("i.category = ?", req.query.category);
    if (req.query.status && ["open", "matched", "claimed", "returned", "closed"].includes(req.query.status)) add("i.status = ?", req.query.status);
    const q = cleanString(req.query.q, 160);
    if (q) add("lower(concat_ws(' ', i.title, i.description, i.category, i.color, i.location_name, array_to_string(i.keywords, ' '))) LIKE ?", `%${q.toLowerCase()}%`);
    const latitude = numberOrNull(req.query.latitude, -90, 90);
    const longitude = numberOrNull(req.query.longitude, -180, 180);
    const radius = numberOrNull(req.query.radiusKm, 0.1, 500);
    if (latitude !== null && longitude !== null && radius !== null) {
      params.push(latitude, longitude, radius);
      const [lat, lng, km] = [params.length - 2, params.length - 1, params.length];
      conditions.push(`i.latitude IS NOT NULL AND i.longitude IS NOT NULL AND 6371 * acos(LEAST(1, GREATEST(-1, cos(radians($${lat})) * cos(radians(i.latitude)) * cos(radians(i.longitude) - radians($${lng})) + sin(radians($${lat})) * sin(radians(i.latitude))))) <= $${km}`);
    }
    params.push(Math.min(Math.max(Number(req.query.limit) || 30, 1), 100));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await query(`SELECT ${itemColumns}${itemJoins} ${where}${itemGroup} ORDER BY i.created_at DESC LIMIT $${params.length}`, params);
    res.json({ items: rows.map((row) => itemForClient(row, req.user?.id)) });
  } catch (error) { next(error); }
});

app.post("/api/items", requireAuth, upload.array("images", 5), async (req, res, next) => {
  const uploaded = req.files || [];
  try {
    const reportType = cleanString(req.body.reportType, 5).toLowerCase();
    const title = cleanString(req.body.title, 140), category = cleanString(req.body.category, 80), locationName = cleanString(req.body.locationName, 180);
    const description = cleanString(req.body.description, 3000), color = cleanString(req.body.color, 80) || null;
    // Both locations are mandatory: the original lost/found spot and the agreed collection point, each with coordinates.
    const latitude = numberOrNull(req.body.latitude, -90, 90), longitude = numberOrNull(req.body.longitude, -180, 180);
    const collectionLocationName = cleanString(req.body.collectionLocationName, 180);
    const collectionLatitude = numberOrNull(req.body.collectionLatitude, -90, 90), collectionLongitude = numberOrNull(req.body.collectionLongitude, -180, 180);
    const occurredAt = req.body.occurredAt ? new Date(req.body.occurredAt) : null;
    if (!["lost", "found"].includes(reportType) || !title || !CATEGORIES.includes(category) || !locationName) return res.status(400).json({ error: "Report type, title, category, and original location name are required." });
    if (req.body.occurredAt && Number.isNaN(occurredAt.getTime())) return res.status(400).json({ error: "Enter a valid date and time." });
    if (latitude === null || longitude === null) return res.status(400).json({ error: "Select the original lost/found location on the map (latitude and longitude are required)." });
    if (!collectionLocationName || collectionLatitude === null || collectionLongitude === null) return res.status(400).json({ error: "Select a collection location on the map where the owner and finder will meet." });
    const whatsapp = digitsOnly(req.body.whatsapp).slice(0, 30);
    const whatsappVisible = ["true", "on", "1"].includes(String(req.body.whatsappVisible).toLowerCase());
    if (whatsappVisible && !/^\+?\d{7,15}$/.test(whatsapp)) return res.status(400).json({ error: "Enter a valid WhatsApp number (7–15 digits, with country code) or untick the WhatsApp option." });
    const client = await pool.connect(); let item;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`INSERT INTO items (user_id,report_type,title,description,category,color,keywords,location_name,latitude,longitude,collection_location_name,collection_latitude,collection_longitude,occurred_at,whatsapp,whatsapp_visible)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`, [req.user.id, reportType, title, description, category, color, parseKeywords(req.body.keywords), locationName, latitude, longitude, collectionLocationName, collectionLatitude, collectionLongitude, occurredAt, whatsapp || null, whatsappVisible && Boolean(whatsapp)]);
      item = rows[0];
      for (const file of uploaded) {
        const visualHash = await perceptualHash(file.path);
        await client.query("INSERT INTO item_images (item_id,storage_path,alt_text,visual_hash) VALUES ($1,$2,$3,$4)", [item.id, `/uploads/${file.filename}`, cleanString(req.body.imageAlt || title, 180), visualHash]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    const saved = await getItem(item.id, req.user.id);
    const matches = await findMatches(saved);
    if (matches[0]?.match.score >= 60) {
      await query("UPDATE items SET status='matched', updated_at=now() WHERE id=$1", [item.id]);
      await notify(req.user.id, "match", "Possible match found", `${matches[0].title} scored ${matches[0].match.score}% against your new report.`, `/items/${matches[0].id}`);
    }
    res.status(201).json({ item: await getItem(item.id, req.user.id), matches: matches.slice(0, 3) });
  } catch (error) {
    for (const file of uploaded) fs.unlink(file.path, () => {});
    next(error);
  }
});

app.get("/api/items/:id", async (req, res, next) => {
  try { const item = await getItem(req.params.id, req.user?.id); if (!item) return res.status(404).json({ error: "Item not found." }); res.json({ item }); } catch (error) { next(error); }
});
app.patch("/api/items/:id/status", requireAuth, async (req, res, next) => {
  try {
    const status = cleanString(req.body.status, 12);
    if (!["open", "matched", "claimed", "returned", "closed"].includes(status)) return res.status(400).json({ error: "Invalid status." });
    const { rows } = await query("UPDATE items SET status=$1,updated_at=now() WHERE id=$2 AND user_id=$3 RETURNING id", [status, req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: "Report not found or you do not own it." });
    res.json({ item: await getItem(req.params.id, req.user.id) });
  } catch (error) { next(error); }
});
app.delete("/api/items/:id", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query("DELETE FROM items WHERE id=$1 AND user_id=$2 RETURNING id", [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: "Report not found or you do not own it." });
    res.status(204).end();
  } catch (error) { next(error); }
});
app.get("/api/items/:id/matches", async (req, res, next) => {
  try { const item = await getItem(req.params.id, req.user?.id); if (!item) return res.status(404).json({ error: "Item not found." }); res.json({ matches: await findMatches(item) }); } catch (error) { next(error); }
});

app.post("/api/visual-search", requireAuth, memoryUpload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Upload an image to search." });
    const queryHash = await perceptualHash(req.file.buffer);
    const category = cleanString(req.body.category, 80);
    let candidates = await fetchAllItems(category && CATEGORIES.includes(category) ? "WHERE i.category = $1" : "", category && CATEGORIES.includes(category) ? [category] : []);
    const results = candidates.map((item) => ({ ...item, visualScore: visualScore(queryHash, item.visual_hash) })).filter((item) => item.visualScore !== null).sort((a, b) => b.visualScore - a.visualScore).slice(0, 20);
    res.json({ queryHash, results, method: "private perceptual image similarity" });
  } catch (error) { next(error); }
});

// AI Lost Item Assistant: understands the request, searches real reports within 2 km of the user's location,
// and optionally adds public Instagram/Facebook posts when Meta is configured. It never invents listings.
app.post("/api/assistant", requireAuth, async (req, res, next) => {
  try {
    const question = cleanString(req.body.question, 500);
    if (question.length < 3) return res.status(400).json({ error: "Ask a little more about the item you need help finding." });
    const request = parseRequest(question);
    const latitude = numberOrNull(req.body.latitude, -90, 90), longitude = numberOrNull(req.body.longitude, -180, 180);
    const hasLocation = latitude !== null && longitude !== null;
    const params = [request.seeking, ACTIVE_STATUSES];
    let where = "WHERE i.report_type = $1 AND i.status = ANY($2)";
    if (hasLocation) {
      params.push(latitude, longitude, SEARCH_RADIUS_KM);
      where += ` AND i.latitude IS NOT NULL AND i.longitude IS NOT NULL AND 6371 * acos(LEAST(1, GREATEST(-1, cos(radians($3)) * cos(radians(i.latitude)) * cos(radians(i.longitude) - radians($4)) + sin(radians($3)) * sin(radians(i.latitude))))) <= $5`;
    }
    // A person's own reports are never suggested back to them.
    params.push(req.user.id);
    where += ` AND i.user_id <> $${params.length}`;
    const candidates = await fetchAllItems(where, params);
    const matches = candidates
      .map((item) => ({ ...item, match: scoreRequest(request, item), distanceKm: hasLocation ? distanceKm(latitude, longitude, item) : null }))
      .filter((item) => item.match && item.match.score >= 25)
      .sort((a, b) => b.match.score - a.match.score || (a.distanceKm ?? 0) - (b.distanceKm ?? 0))
      .slice(0, 8);
    const kind = request.seeking === "found" ? "found" : "lost";
    const scopeText = hasLocation ? `within ${SEARCH_RADIUS_KM} km of your location` : "citywide (share your location to limit the search to 2 km)";
    const understood = [request.categories.length ? `category: ${request.categories.join(", ")}` : null, request.colors.length ? `colour: ${request.colors.join(", ")}` : null, request.keywords.length ? `details: ${request.keywords.slice(0, 6).join(", ")}` : null].filter(Boolean);
    const answer = matches.length
      ? `I searched ${candidates.length} active ${kind} reports ${scopeText} and found ${matches.length} possible ${matches.length === 1 ? "match" : "matches"}${understood.length ? ` (${understood.join("; ")})` : ""}. Compare the photos, descriptions, and both locations, then message the person to verify before arranging a collection.`
      : `I searched ${candidates.length} active ${kind} reports ${scopeText} and found no strong match${understood.length ? ` for ${understood.join("; ")}` : ""}. Try adding a colour, a brand, a landmark, or distinctive marks. You can also post a report so you are notified when a match appears.`;
    // Optional public social results: only when Meta is configured and a location is available.
    let social = { configured: discoveryStatus().facebook.configured, results: [] };
    if (hasLocation && discoveryStatus().facebook.configured) {
      try {
        const result = await discoverSocial({ platform: "facebook", latitude, longitude, radiusKm: SEARCH_RADIUS_KM, query: request.keywords.join(" ") || request.categories.join(" "), areaName: "" });
        social = { configured: true, results: result.results, limitation: result.limitation };
      } catch (error) { social = { configured: true, results: [], limitation: `Facebook search unavailable: ${error.message}` }; }
    }
    res.json({ answer, understood: { type: kind, categories: request.categories, colors: request.colors, keywords: request.keywords, radiusKm: hasLocation ? SEARCH_RADIUS_KM : null, locationUsed: hasLocation, searchedCount: candidates.length }, extractedKeywords: request.keywords, matches, social });
  } catch (error) { next(error); }
});

app.post("/api/conversations", requireAuth, async (req, res, next) => {
  try {
    const item = await getItem(req.body.itemId, req.user.id);
    if (!item) return res.status(404).json({ error: "Item not found." });
    if (item.user_id === req.user.id) return res.status(400).json({ error: "You cannot message yourself about this report." });
    const { rows } = await query(`INSERT INTO conversations (item_id,requester_id,owner_id) VALUES ($1,$2,$3)
      ON CONFLICT (item_id,requester_id) DO UPDATE SET item_id=EXCLUDED.item_id RETURNING id,item_id,requester_id,owner_id,created_at`, [item.id, req.user.id, item.user_id]);
    const conversation = rows[0];
    await notify(item.user_id, "message", "New inquiry", `${req.user.name} started a conversation about ${item.title}.`, `/messages/${conversation.id}`);
    res.status(201).json({ conversation });
  } catch (error) { next(error); }
});
app.get("/api/conversations", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT c.*, i.title AS item_title, i.report_type, (SELECT storage_path FROM item_images WHERE item_id=i.id ORDER BY created_at LIMIT 1) AS item_image,
      CASE WHEN c.owner_id=$1 THEN requester.name ELSE owner.name END AS counterpart_name,
      (SELECT body FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_message_at
      FROM conversations c JOIN items i ON i.id=c.item_id JOIN users owner ON owner.id=c.owner_id JOIN users requester ON requester.id=c.requester_id
      WHERE c.owner_id=$1 OR c.requester_id=$1 ORDER BY COALESCE((SELECT created_at FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1),c.created_at) DESC`, [req.user.id]);
    res.json({ conversations: rows });
  } catch (error) { next(error); }
});
app.get("/api/conversations/:id/messages", requireAuth, async (req, res, next) => {
  try {
    const { rows: found } = await query(`SELECT c.id, c.item_id, c.owner_id, c.requester_id, i.title AS item_title, i.report_type, i.status AS item_status,
        owner.name AS owner_name, requester.name AS requester_name
      FROM conversations c JOIN items i ON i.id=c.item_id JOIN users owner ON owner.id=c.owner_id JOIN users requester ON requester.id=c.requester_id
      WHERE c.id=$1 AND (c.owner_id=$2 OR c.requester_id=$2)`, [req.params.id, req.user.id]);
    if (!found[0]) return res.status(404).json({ error: "Conversation not found." });
    const c = found[0];
    const viewerIsOwner = c.owner_id === req.user.id;
    // Sender and receiver details for the chat header. Contact details are never included.
    const conversation = { id: c.id, itemId: c.item_id, itemTitle: c.item_title, reportType: c.report_type, itemStatus: c.item_status, ownerId: c.owner_id, ownerName: c.owner_name, requesterId: c.requester_id, requesterName: c.requester_name, viewerRole: viewerIsOwner ? "owner" : "requester", counterpartName: viewerIsOwner ? c.requester_name : c.owner_name };
    const { rows } = await query(`SELECT m.*, u.name AS sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=$1 ORDER BY m.created_at`, [req.params.id]);
    res.json({ conversation, messages: rows });
  } catch (error) { next(error); }
});
app.post("/api/conversations/:id/messages", requireAuth, async (req, res, next) => {
  try {
    const body = cleanString(req.body.body, 2000);
    if (!body) return res.status(400).json({ error: "Message cannot be empty." });
    const { rows: conversations } = await query("SELECT * FROM conversations WHERE id=$1 AND (owner_id=$2 OR requester_id=$2)", [req.params.id, req.user.id]);
    const conversation = conversations[0]; if (!conversation) return res.status(404).json({ error: "Conversation not found." });
    const { rows } = await query("INSERT INTO messages (conversation_id,sender_id,body) VALUES ($1,$2,$3) RETURNING *", [conversation.id, req.user.id, body]);
    const recipient = conversation.owner_id === req.user.id ? conversation.requester_id : conversation.owner_id;
    await notify(recipient, "message", "New message", `${req.user.name}: ${body.slice(0, 120)}`, `/messages/${conversation.id}`);
    res.status(201).json({ message: { ...rows[0], sender_name: req.user.name } });
  } catch (error) { next(error); }
});

app.get("/api/notifications", requireAuth, async (req, res, next) => {
  try { const { rows } = await query("SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30", [req.user.id]); res.json({ notifications: rows }); } catch (error) { next(error); }
});
app.patch("/api/notifications/read", requireAuth, async (req, res, next) => {
  try { await query("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL", [req.user.id]); res.json({ ok: true }); } catch (error) { next(error); }
});

app.post("/api/social/search", requireAuth, async (req, res, next) => {
  try {
    const search = cleanString(req.body.query, 300);
    if (!search) return res.status(400).json({ error: "Enter terms to search Meta-connected sources." });
    const result = await searchSocial(search);
    if (result.configured) await query("INSERT INTO social_search_cache (source,query,payload) VALUES ('meta',$1,$2)", [search, JSON.stringify(result.results)]);
    res.json(result);
  } catch (error) { next(error); }
});
// Public client configuration. Only the browser-restricted Google Maps key is shared; Meta tokens never leave the server.
app.get("/api/config", (req, res) => {
  const social = discoveryStatus();
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || null,
    searchRadiusKm: SEARCH_RADIUS_KM,
    social: { instagram: { configured: social.instagram.configured, geoBasis: social.instagram.geoBasis }, facebook: { configured: social.facebook.configured, geoBasis: social.facebook.geoBasis } },
  });
});

// Every report with coordinates, for the shared Google Map. No contact details are included.
app.get("/api/map/items", async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT i.id, i.title, i.report_type, i.category, i.color, i.status, i.location_name, i.latitude, i.longitude,
        i.collection_location_name, i.collection_latitude, i.collection_longitude, i.created_at,
        (SELECT storage_path FROM item_images WHERE item_id=i.id ORDER BY created_at LIMIT 1) AS image
      FROM items i WHERE i.latitude IS NOT NULL AND i.longitude IS NOT NULL ORDER BY i.created_at DESC LIMIT 1000`);
    res.json({ items: rows });
  } catch (error) { next(error); }
});

// AI Visual Finder: locates a reference item inside a crowded-area photo (see services/visual-finder.js).
// Uploaded photos are processed in memory and are not stored.
const finderUpload = memoryUpload.fields([{ name: "scene", maxCount: 1 }, { name: "reference", maxCount: 1 }]);
app.post("/api/visual-finder", requireAuth, finderUpload, async (req, res, next) => {
  try {
    const scene = req.files?.scene?.[0], reference = req.files?.reference?.[0];
    if (!scene || !reference) return res.status(400).json({ error: "Upload both the crowded-area photo and a reference photo of your item." });
    let result;
    try {
      result = await findItemInScene(scene.buffer, reference.buffer);
    } catch (error) {
      if (/did not initialise/.test(error.message)) return res.status(503).json({ error: "The visual analysis engine did not start. Please try again." });
      if (/unsupported image|input buffer|bad extract|Input file/i.test(error.message)) return res.status(400).json({ error: "We could not read one of the photos. Upload a clear JPEG, PNG, or WebP image." });
      throw error;
    }
    res.json({ ...result, note: result.found ? "Matches are candidates from image analysis. Confirm by looking at the highlighted photo before you contact anyone." : "No suitable match was detected. Try a sharper photo of the item, a closer crowd photo, or a reference photo with the item against a plain background." });
  } catch (error) { next(error); }
});

// Area-based Instagram / Facebook discovery. Results are cached for 30 minutes to respect Meta rate limits.
app.post("/api/social/discover", requireAuth, async (req, res, next) => {
  try {
    const platform = cleanString(req.body.platform, 12).toLowerCase();
    if (!["instagram", "facebook"].includes(platform)) return res.status(400).json({ error: "Choose Instagram or Facebook." });
    const latitude = numberOrNull(req.body.latitude, -90, 90), longitude = numberOrNull(req.body.longitude, -180, 180);
    const radiusKm = Math.min(Math.max(Number(req.body.radiusKm) || SEARCH_RADIUS_KM, 0.5), 10);
    const areaName = cleanString(req.body.areaName, 120), queryText = cleanString(req.body.query, 160);
    if (latitude === null || longitude === null) return res.status(400).json({ error: "Select an area on the map first." });
    const cacheKey = JSON.stringify({ platform, latitude: latitude.toFixed(3), longitude: longitude.toFixed(3), radiusKm, areaName: areaName.toLowerCase(), queryText: queryText.toLowerCase() });
    const { rows: cached } = await query("SELECT payload FROM social_search_cache WHERE source=$1 AND query=$2 AND created_at > now() - interval '30 minutes' ORDER BY created_at DESC LIMIT 1", [`discover-${platform}`, cacheKey]);
    if (cached[0]) return res.json({ ...cached[0].payload, cached: true });
    const result = await discoverSocial({ platform, latitude, longitude, radiusKm, areaName, query: queryText });
    const payload = { ...result, area: { latitude, longitude, radiusKm, areaName: areaName || null }, disclaimer: "These posts come from Meta's platform, not from Recoverly's own listings. Open the original post to verify it." };
    if (!result.errors?.length) await query("INSERT INTO social_search_cache (source,query,payload) VALUES ($1,$2,$3)", [`discover-${platform}`, cacheKey, JSON.stringify(payload)]);
    res.json(payload);
  } catch (error) {
    if (/Meta Graph API returned/.test(error.message)) return res.status(502).json({ error: `${error.message}. Check the Meta app token, permissions, and app review status.` });
    next(error);
  }
});

app.get("/api/stats", async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE report_type='lost')::int AS lost, COUNT(*) FILTER (WHERE report_type='found')::int AS found, COUNT(*) FILTER (WHERE status='returned')::int AS returned FROM items`);
    res.json(rows[0]);
  } catch (error) { next(error); }
});

app.use((req, res) => res.status(404).json({ error: "Route not found." }));
app.use((error, req, res, next) => {
  console.error(error);
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.message });
  const status = error.status || 500;
  res.status(status).json({ error: status === 500 ? "Something went wrong. Please try again." : error.message });
});

async function start() {
  await migrate();
  app.listen(PORT, () => console.log(`Recoverly is running at http://localhost:${PORT}`));
}
start().catch((error) => { console.error("Startup failed:", error.message); process.exit(1); });
process.on("SIGINT", async () => { await close(); process.exit(0); });
process.on("SIGTERM", async () => { await close(); process.exit(0); });

