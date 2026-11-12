const { tokenize, haversine } = require("./matching");

const version = process.env.META_API_VERSION || "v21.0";
const base = `https://graph.facebook.com/${version}`;

function configured() {
  return Boolean(process.env.META_ACCESS_TOKEN && (process.env.META_IG_USER_ID || process.env.META_FACEBOOK_PAGE_ID));
}

function filterPosts(posts, query) {
  const words = tokenize(query);
  return posts.filter((post) => {
    const body = `${post.caption || ""} ${post.message || ""}`.toLowerCase();
    return words.some((word) => body.includes(word));
  });
}

async function graph(path) {
  const url = new URL(`${base}/${path}`);
  url.searchParams.set("access_token", process.env.META_ACCESS_TOKEN);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Meta Graph API returned ${response.status}`);
  return response.json();
}

// Meta does not provide unrestricted search of all public Facebook/Instagram posts.
// This adapter searches media the connected Business/Creator account or Page is permitted to read.
async function searchSocial(query) {
  if (!configured()) return { configured: false, results: [], limitation: "Connect a Meta Business/Page access token to search authorized public-facing media." };
  const results = [];
  if (process.env.META_IG_USER_ID) {
    const media = await graph(`${process.env.META_IG_USER_ID}/media?fields=id,caption,media_type,media_url,permalink,timestamp&limit=100`);
    results.push(...filterPosts(media.data || [], query).map((post) => ({ source: "instagram", title: post.caption?.slice(0, 120) || "Instagram post", excerpt: post.caption || "", url: post.permalink, imageUrl: post.media_type === "IMAGE" ? post.media_url : null, publishedAt: post.timestamp })));
  }
  if (process.env.META_FACEBOOK_PAGE_ID) {
    const posts = await graph(`${process.env.META_FACEBOOK_PAGE_ID}/posts?fields=id,message,permalink_url,created_time,full_picture&limit=100`);
    results.push(...filterPosts(posts.data || [], query).map((post) => ({ source: "facebook", title: post.message?.slice(0, 120) || "Facebook post", excerpt: post.message || "", url: post.permalink_url, imageUrl: post.full_picture || null, publishedAt: post.created_time })));
  }
  return { configured: true, results, limitation: "Results are limited to content your approved Meta app is authorized to read." };
}

// ---- Area-based discovery of public lost & found posts (Instagram and Facebook) ----
// Instagram: hashtag search (ig_hashtag_search -> recent_media). Hashtag results do not include coordinates in the
//            documented fields, so posts are kept only when their caption names the selected place.
// Facebook:  Pages search (pages/search) returns Page locations. Only Pages whose location lies inside the selected
//            radius are read, so the geographic filter uses real coordinates.
// Both require Meta app review (Instagram Public Content Access / Page Public Content Access) for production use.
const LOST_FOUND_TERMS = /\b(lost|found|missing|misplaced|reward|lost\s*(&|and)\s*found)\b/i;

function slug(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

function discoveryStatus() {
  const token = Boolean(process.env.META_ACCESS_TOKEN);
  return {
    instagram: {
      configured: token && Boolean(process.env.META_IG_USER_ID),
      requires: ["META_ACCESS_TOKEN", "META_IG_USER_ID"],
      geoBasis: "Place named in the post caption (Instagram hashtag results do not return coordinates)",
    },
    facebook: {
      configured: token,
      requires: ["META_ACCESS_TOKEN"],
      geoBasis: "Page location coordinates inside the selected radius",
    },
  };
}

function isLostFound(text) { return LOST_FOUND_TERMS.test(text || ""); }

async function discoverInstagram({ areaName, query }) {
  if (!process.env.META_IG_USER_ID) return { configured: false, results: [], limitation: "Instagram needs META_ACCESS_TOKEN and META_IG_USER_ID." };
  if (!areaName) return { configured: true, results: [], limitation: "Instagram discovery needs a named place (for example “Lahore”) so posts can be matched to the selected area." };
  const area = slug(areaName);
  const words = [...new Set(String(query || "").toLowerCase().match(/[a-z]{3,}/g) || [])].slice(0, 1).map(slug);
  // Meta allows only 30 unique hashtags per 7 days, so the list stays short and results are cached by the server.
  const tags = [`lost${area}`, `found${area}`, words[0] ? `${words[0]}lost${area}` : `lostandfound${area}`].filter((tag) => tag.length >= 3 && tag.length <= 30);
  const results = []; const errors = [];
  for (const tag of tags) {
    try {
      const hashtag = await graph(`ig_hashtag_search?user_id=${process.env.META_IG_USER_ID}&q=${encodeURIComponent(tag)}`);
      const hashtagId = hashtag.data?.[0]?.id;
      if (!hashtagId) continue;
      const media = await graph(`${hashtagId}/recent_media?user_id=${process.env.META_IG_USER_ID}&fields=id,caption,media_type,media_url,permalink,timestamp&limit=25`);
      for (const post of media.data || []) {
        const caption = post.caption || "";
        const namesArea = caption.toLowerCase().includes(areaName.toLowerCase()) || slug(caption).includes(area);
        if (!namesArea || !isLostFound(caption)) continue;
        results.push({ id: `ig-${post.id}`, platform: "instagram", title: caption.slice(0, 120) || "Instagram post", excerpt: caption.slice(0, 400), url: post.permalink, imageUrl: post.media_type === "VIDEO" ? null : post.media_url, publishedAt: post.timestamp, sourceName: `#${tag}`, location: null, geoBasis: "place named in caption" });
      }
    } catch (error) { errors.push(`#${tag}: ${error.message}`); }
  }
  const unique = [...new Map(results.map((post) => [post.id, post])).values()];
  return { configured: true, results: unique, errors, limitation: "Instagram hashtag search covers recent public posts tagged with these hashtags, filtered to posts that name the selected place." };
}

async function discoverFacebook({ latitude, longitude, radiusKm, areaName, query }) {
  if (!process.env.META_ACCESS_TOKEN) return { configured: false, results: [], limitation: "Facebook needs META_ACCESS_TOKEN with Page Public Content Access." };
  if (latitude === null || longitude === null) return { configured: true, results: [], limitation: "Facebook discovery needs a selected area on the map." };
  const term = areaName || query || "lost found";
  const pages = await graph(`pages/search?q=${encodeURIComponent(term)}&fields=id,name,link,location`);
  const nearby = (pages.data || []).filter((page) => page.location?.latitude != null && page.location?.longitude != null && haversine(latitude, longitude, Number(page.location.latitude), Number(page.location.longitude)) <= radiusKm);
  const results = []; const errors = [];
  for (const page of nearby.slice(0, 8)) {
    try {
      const posts = await graph(`${page.id}/posts?fields=message,permalink_url,created_time,full_picture&limit=25`);
      for (const post of posts.data || []) {
        if (!isLostFound(post.message)) continue;
        results.push({ id: `fb-${post.id}`, platform: "facebook", title: post.message?.slice(0, 120) || "Facebook post", excerpt: (post.message || "").slice(0, 400), url: post.permalink_url, imageUrl: post.full_picture || null, publishedAt: post.created_time, sourceName: page.name, location: { latitude: Number(page.location.latitude), longitude: Number(page.location.longitude) }, geoBasis: "Page location inside radius" });
      }
    } catch (error) { errors.push(`${page.name}: ${error.message}`); }
  }
  return { configured: true, results, errors, limitation: nearby.length ? "Facebook results come from Pages located inside your selected radius that your app is authorized to read." : "No Facebook Pages with a location inside this radius were returned by the Pages search." };
}

async function discoverSocial(options) {
  const platform = options.platform;
  if (platform === "instagram") return { platform, ...(await discoverInstagram(options)) };
  if (platform === "facebook") return { platform, ...(await discoverFacebook(options)) };
  throw new Error("Choose Instagram or Facebook.");
}

module.exports = { searchSocial, configured, discoverSocial, discoveryStatus };
