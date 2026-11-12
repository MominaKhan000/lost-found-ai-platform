const STOP_WORDS = new Set(["a", "an", "and", "are", "at", "for", "from", "i", "in", "is", "it", "lost", "my", "near", "of", "on", "or", "the", "this", "to", "was", "with"]);

function tokenize(value = "") {
  return [...new Set(String(value).toLowerCase().match(/[a-z0-9]{2,}/g)?.filter((word) => !STOP_WORDS.has(word)) || [])];
}

function overlap(left, right) {
  const a = new Set(Array.isArray(left) ? left : tokenize(left));
  const b = new Set(Array.isArray(right) ? right : tokenize(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / new Set([...a, ...b]).size;
}

function hammingSimilarity(left, right) {
  if (!left || !right || left.length !== right.length) return null;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    distance += left[index] !== right[index];
  }
  return 1 - distance / left.length;
}

function locationScore(left, right) {
  if (left.latitude && left.longitude && right.latitude && right.longitude) {
    const km = haversine(Number(left.latitude), Number(left.longitude), Number(right.latitude), Number(right.longitude));
    return Math.max(0, 1 - km / 12);
  }
  return overlap(left.location_name, right.location_name);
}

function haversine(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function scoreItems(source, candidate) {
  const sourceWords = tokenize([source.title, source.description, ...(source.keywords || [])].join(" "));
  const candidateWords = tokenize([candidate.title, candidate.description, ...(candidate.keywords || [])].join(" "));
  const text = overlap(sourceWords, candidateWords);
  const category = source.category && source.category.toLowerCase() === candidate.category?.toLowerCase() ? 1 : 0;
  const color = source.color && candidate.color && source.color.toLowerCase() === candidate.color.toLowerCase() ? 1 : 0;
  const location = locationScore(source, candidate);
  const visual = hammingSimilarity(source.visual_hash, candidate.visual_hash);
  const factors = { text: Math.round(text * 42), category: Math.round(category * 20), color: Math.round(color * 8), location: Math.round(location * 18) };
  if (visual !== null) factors.visual = Math.round(visual * 12);
  const raw = Object.values(factors).reduce((sum, value) => sum + value, 0);
  const maximum = visual === null ? 88 : 100;
  const score = Math.min(99, Math.round(raw / maximum * 100));
  const reasons = [];
  if (category) reasons.push("same category");
  if (text >= 0.16) reasons.push("similar description or keywords");
  if (location >= 0.25) reasons.push("nearby location");
  if (color) reasons.push("matching color");
  if (visual !== null && visual >= 0.7) reasons.push("visually similar image");
  return { score, factors, reasons, visualSimilarity: visual === null ? null : Math.round(visual * 100) };
}

function scoreQuery(query, item) {
  return scoreItems({ title: query, description: query, keywords: tokenize(query), category: "", location_name: query }, item);
}

// ---- Natural-language request understanding for the AI Lost Item Assistant ----
// Rule-based extraction: categories, colours, the type of report the user is looking for and meaningful keywords.
// The assistant then ranks real database reports; it never invents listings.
const CATEGORY_SYNONYMS = {
  Electronics: ["phone", "mobile", "smartphone", "iphone", "samsung", "laptop", "macbook", "tablet", "ipad", "charger", "earbuds", "airpods", "headphones", "camera", "powerbank", "calculator"],
  Bags: ["bag", "bags", "backpack", "rucksack", "handbag", "purse", "tote", "suitcase", "luggage", "clutch", "satchel", "briefcase"],
  Accessories: ["wallet", "watch", "belt", "sunglasses", "glasses", "umbrella", "scarf", "cap", "hat"],
  "Cards & IDs": ["id", "card", "cnic", "passport", "license", "licence", "atm", "debit", "credit", "badge"],
  Keys: ["key", "keys", "keychain", "keyring", "fob"],
  Jewelry: ["ring", "necklace", "bracelet", "earring", "earrings", "chain", "pendant", "jewelry", "jewellery"],
  Clothing: ["jacket", "coat", "shirt", "hoodie", "sweater", "shoes", "shoe", "sneakers", "dress", "shawl", "abaya"],
  Books: ["book", "notebook", "textbook", "diary"],
  Documents: ["document", "documents", "papers", "certificate", "folder", "file"],
  Sports: ["ball", "bat", "racket", "bicycle", "bike", "helmet", "gloves"],
};
const COLOR_WORDS = { black: "black", white: "white", red: "red", blue: "blue", green: "green", yellow: "yellow", orange: "orange", pink: "pink", purple: "purple", violet: "purple", brown: "brown", grey: "grey", gray: "grey", silver: "silver", gold: "gold", golden: "gold", beige: "beige", maroon: "maroon", navy: "blue", cream: "beige", teal: "teal" };
const INTENT_WORDS = new Set(["found", "find", "finds", "finding", "reporting", "search", "missing", "reported", "report", "anyone", "someone", "have", "has", "had", "can", "you", "please", "near", "nearby", "around", "location", "help", "where", "lost", "i", "my", "me", "the", "any", "did", "looking", "for", "there", "been", "was", "is", "do", "a", "an", "of", "in", "at", "on", "with", "it", "that", "this", "some", "one", "bring", "back", "item", "thing", "stuff"]);

function categoriesFor(words) {
  return Object.entries(CATEGORY_SYNONYMS).filter(([, synonyms]) => synonyms.some((word) => words.includes(word))).map(([category]) => category);
}

// Works out what the user is asking for in plain language.
function parseRequest(text = "") {
  const lower = String(text).toLowerCase();
  const words = tokenize(text);
  const colors = [...new Set(words.map((word) => COLOR_WORDS[word]).filter(Boolean))];
  const categories = categoriesFor(words);
  // "I found ..." means the user is the finder, so they need LOST reports. Otherwise the user lost something and needs FOUND reports.
  const userFound = /\b(i\s+(have\s+)?found|i'?ve\s+found|i\s+came\s+across|i\s+picked\s+up|i\s+saw\s+a)\b/.test(lower);
  const askingAboutFound = /\b(have\s+you\s+found|has\s+anyone\s+found|did\s+anyone\s+find|anyone\s+(has\s+)?found|someone\s+(has\s+)?found|has\s+anyone\s+reported|anyone\s+reported)\b/.test(lower);
  const seeking = userFound && !askingAboutFound ? "lost" : "found";
  const keywords = words.filter((word) => !COLOR_WORDS[word] && !INTENT_WORDS.has(word));
  return { text: String(text), words, colors, categories, keywords: [...new Set(keywords)], seeking };
}

// Scores one candidate report against a parsed request. Returns null when nothing relevant matches.
function scoreRequest(request, item) {
  if (item.report_type !== request.seeking) return null;
  const itemWords = tokenize([item.title, item.description, item.color, item.category, ...(item.keywords || [])].join(" "));
  const hits = request.keywords.filter((keyword) => itemWords.some((word) => word === keyword || (word.length >= 4 && keyword.length >= 4 && (word.startsWith(keyword) || keyword.startsWith(word)))));
  const keywordScore = request.keywords.length ? hits.length / request.keywords.length : 0;
  const categoryHit = request.categories.includes(item.category);
  const rawColor = String(item.color || "").trim().toLowerCase();
  const itemColor = COLOR_WORDS[rawColor] || rawColor;
  const colorHit = request.colors.length > 0 && request.colors.includes(itemColor);
  if (!categoryHit && !colorHit && hits.length === 0) return null;
  const score = Math.min(99, Math.round(keywordScore * 45 + (categoryHit ? 35 : 0) + (colorHit ? 20 : 0)));
  const reasons = [];
  if (categoryHit) reasons.push(`same category (${item.category})`);
  if (colorHit) reasons.push(`colour ${itemColor}`);
  if (hits.length) reasons.push(`matching words: ${hits.join(", ")}`);
  return { score, reasons, matchedWords: hits };
}

module.exports = { tokenize, overlap, haversine, hammingSimilarity, scoreItems, scoreQuery, parseRequest, scoreRequest, CATEGORY_SYNONYMS };
