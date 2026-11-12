CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(80) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_type VARCHAR(5) NOT NULL CHECK (report_type IN ('lost', 'found')),
  title VARCHAR(140) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category VARCHAR(80) NOT NULL,
  color VARCHAR(80),
  keywords TEXT[] NOT NULL DEFAULT '{}',
  location_name VARCHAR(180) NOT NULL,
  latitude NUMERIC(9, 6),
  longitude NUMERIC(9, 6),
  occurred_at TIMESTAMPTZ,
  whatsapp VARCHAR(30),
  status VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'claimed', 'returned', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS items_type_category_idx ON items(report_type, category);
CREATE INDEX IF NOT EXISTS items_status_created_idx ON items(status, created_at DESC);
CREATE INDEX IF NOT EXISTS items_keywords_gin_idx ON items USING GIN(keywords);

CREATE TABLE IF NOT EXISTS item_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  alt_text VARCHAR(180),
  visual_hash VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS item_images_item_idx ON item_images(item_id);

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(item_id, requester_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(40) NOT NULL,
  title VARCHAR(140) NOT NULL,
  body TEXT,
  link TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS social_search_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(30) NOT NULL,
  query TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_search_cache_lookup_idx ON social_search_cache(source, query, created_at DESC);

-- Mandatory two-location reporting. latitude/longitude hold the ORIGINAL lost/found location.
-- The collection location is stored separately. Legacy rows created before this change keep NULLs here.
ALTER TABLE items ADD COLUMN IF NOT EXISTS collection_location_name VARCHAR(180);
ALTER TABLE items ADD COLUMN IF NOT EXISTS collection_latitude NUMERIC(9, 6);
ALTER TABLE items ADD COLUMN IF NOT EXISTS collection_longitude NUMERIC(9, 6);
-- WhatsApp contact is optional and off by default; the reporter must choose to show the number.
ALTER TABLE items ADD COLUMN IF NOT EXISTS whatsapp_visible BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS items_coordinates_idx ON items(latitude, longitude);
