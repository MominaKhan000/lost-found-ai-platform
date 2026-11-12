<<<<<<< HEAD
# Recoverly — AI-Powered Lost & Found Platform

Recoverly is a complete full-stack starter for an intelligent lost-and-found service. It uses **Neon PostgreSQL** for persistent cloud data and provides a responsive web experience for reporting, searching, matching, and privately messaging about belongings.

## Included features

- Account registration, sign-in, sign-out, and profile editing with bcrypt password hashes and signed, HTTP-only session cookies.
- Lost and found reports with category, description, keywords, optional date/time, optional WhatsApp number, landmark, optional coordinates, and up to five images.
- Browse/search/filter across reports; optional radius search through the browser's location permission.
- Smart lost-versus-found recommendations that weigh category, description keywords, color, location, and visual similarity. Each recommendation carries an explainable percentage score.
- Image search based on a private perceptual hash. The uploaded search image is processed in memory and is not stored.
- AI-style natural-language search assistant that extracts meaningful terms, searches the platform database, and recommends ranked reports. It works without sending personal data to an external LLM.
- Private item conversations and in-app notifications; contact details are not exposed in public cards or details.
- Meta Graph API adapter for authorized Instagram Business/Creator media and Facebook Page posts, with result caching in Neon.
- Neon schema for users, item reports, images, chats, messages, notifications, and social search results.

## Mandatory two-location reporting and Google Maps

Lost and found reports both require two locations, each saved with latitude and longitude:

- **Original location** (`latitude`, `longitude`, `location_name`): where the item was lost or found.
- **Collection point** (`collection_latitude`, `collection_longitude`, `collection_location_name`): where the owner and finder will meet.

Both are chosen on Google Maps (click, drag, search, or "My location"). Item details show both locations as separate cards with "Open in Google Maps" links. Reports created before this change have no collection point and are labelled as such.

The **Map & social** view shows every located report from all users. Lost items are red pins, found items are green pins, and collection points are dark squares. Markers refresh every 30 seconds and when a report is published.

## Assistant, chat, and visual finder

- **AI Lost Item Assistant** understands requests such as "Have you found my mobile phone?" or "Can you find a black wallet near my location?". It searches only real active reports within **2 km** of the location the user shares, using latitude and longitude. Results show images, descriptions, both locations, and contact options. Without a shared location it searches citywide and says so.
- **Private chat** is linked to a report. Each message shows sender and recipient. Notifications arrive on the same 20-second refresh.
- **WhatsApp** is optional. A reporter has to tick "Show this WhatsApp number on the report" before it is visible to others.
- **AI Visual Finder** (Image search → AI Visual Finder) takes a crowded-area photo and a reference photo of the item. It uses OpenCV.js (WebAssembly, installed from npm, no model download): ORB feature matching with RANSAC homography for textured items, and multi-scale template matching verified by HSV colour histograms for plain items. It returns highlighted boxes, confidence scores, and a clear "no suitable match" result. Photos are processed in memory and not stored.

## Instagram and Facebook discovery

Discovery is in **Map & social → Instagram & Facebook**. Pick an area on the map (or type coordinates), choose a radius, and search. Results are labelled as external and link to the original post.

What Meta's platform allows, and what this build does:

- **Instagram:** hashtag search (`ig_hashtag_search`, `recent_media`). Hashtag results don't carry coordinates, so posts are kept only when their caption names the selected place. Meta limits each account to 30 unique hashtags per 7 days, so results are cached for 30 minutes.
- **Facebook:** Pages search (`pages/search`) returns Page locations, so results are filtered by real distance. Only Pages inside the selected radius are read. The deprecated place-search endpoint is not used.
- Both need an app with Meta app review (Instagram Public Content Access and Page Public Content Access). Until then the UI says "not connected yet". Meta does not allow arbitrary search of all public posts, so coverage is limited to what your approved app can read.

## Configuration

Add these to `.env`:

```dotenv
GOOGLE_MAPS_API_KEY=...          # Maps JavaScript API + Geocoding API; restrict by HTTP referrer
META_ACCESS_TOKEN=...            # after Meta app review
META_IG_USER_ID=...              # Instagram Business/Creator account for hashtag search
META_FACEBOOK_PAGE_ID=...        # optional
```

The database schema is applied at startup. The new columns are added with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so existing data is kept.

## Testing notes

The server-side logic and the browser flows were tested against a local PostgreSQL instance, with Google Maps replaced by a stub. Meta endpoints were tested with stubbed responses only. Before going live, check the Google Maps key and the Meta permissions with real accounts.

## Run it

1. Install **Node.js 20+**.
2. In this folder, make a `.env` file from `.env.example`.
3. Put your pooled Neon connection string in `DATABASE_URL` and set a long random `JWT_SECRET`.
4. Run:

   ```bash
   npm install
   npm start
   ```

5. Visit [http://localhost:3000](http://localhost:3000).

The server applies `sql/schema.sql` at startup, so an empty Neon database needs no separate migration command.

## Optional Meta setup

The social endpoint is intentionally truthful about Meta platform limits: Meta does **not** allow arbitrary search across every public Facebook or Instagram post. When supplied with a permitted app token plus `META_IG_USER_ID` and/or `META_FACEBOOK_PAGE_ID`, Recoverly searches media the connected Business/Creator account or Page is authorized to read, then filters it by the user's item query.

Set these optional `.env` values after configuring your Meta app and the required permissions:

```dotenv
META_ACCESS_TOKEN=...
META_IG_USER_ID=...
META_FACEBOOK_PAGE_ID=...
META_API_VERSION=v21.0
```

## Folder structure

```text
lost-found-ai-platform/
├── public/
│   ├── app.js             # Single-page UI behavior
│   ├── index.html         # Responsive dashboard
│   └── style.css          # Responsive visual system
├── src/
│   ├── db.js              # Neon PostgreSQL pool and schema bootstrap
│   ├── server.js          # Express REST API, auth, uploads, chat
│   └── services/
│       ├── matching.js    # Explainable text/location recommendation scores
│       ├── social.js      # Authorized Meta Graph adapter
│       ├── vision.js      # Perceptual image hashing and comparison
│       ├── visual-finder.js # AI Visual Finder: OpenCV.js feature + template matching
│       └── social.js      # (see above)
├── sql/
│   └── schema.sql         # Neon database schema
├── .env.example           # Environment variable template
├── .gitignore
└── package.json
```

## Security notes

- Never commit `.env`; it is ignored by Git.
- Change `JWT_SECRET` before production and use HTTPS (`NODE_ENV=production`) when deployed.
- Public item cards do not disclose email, WhatsApp, or passwords. Use private conversation requests to coordinate recovery.
- Uploads accept JPEG, PNG, and WebP only, with a 5 MB limit per image.
- A production deployment should place image uploads in object storage (for example Cloudflare R2, S3, or Vercel Blob) instead of the local `uploads/` folder.

## API overview

| Area | Endpoints |
| --- | --- |
| Auth and profile | `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET/PUT /api/me` |
| Reports | `GET/POST /api/items`, `GET /api/items/:id`, `PATCH /api/items/:id/status`, `DELETE /api/items/:id` |
| Intelligent search | `GET /api/items/:id/matches`, `POST /api/assistant`, `POST /api/visual-search` |
| Chat and notifications | `POST/GET /api/conversations`, `GET/POST /api/conversations/:id/messages`, `GET /api/notifications` |
| Integrations | `POST /api/social/search`, `POST /api/social/discover`, `GET /api/stats`, `GET /api/categories`, `GET /api/config` |
| Map and visual finder | `GET /api/map/items`, `POST /api/visual-finder` |
=======
# lost-found-AI-platform
>>>>>>> 7b77d30b481a1cc4fa6dd4f070a2214fa21d42e3
#   l o s t - f o u n d - A I - p l a t f o r m  
 #   l o s t - f o u n d - A I - p l a t f o r m  
 