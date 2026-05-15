CREATE TABLE subscribers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  push_endpoint    TEXT NOT NULL,
  push_p256dh      TEXT NOT NULL,
  push_auth        TEXT NOT NULL,
  name             TEXT,
  home_city        TEXT,
  travel_markets   TEXT,
  travel_mode      TEXT,
  package_open     TEXT,
  trip_budget      TEXT,
  premium_open     TEXT,
  premium_types    TEXT,
  premium_spend    TEXT,
  annual_membership TEXT,
  membership_tier  TEXT,
  membership_venues TEXT,
  followed_tours   TEXT NOT NULL,
  alert_scope      TEXT,
  consented_at     TEXT NOT NULL,
  last_push_sent   TEXT,
  push_failures    INTEGER DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(push_endpoint)
);

CREATE TABLE tour_snapshots (
  tour_id       TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  checked_at    TEXT NOT NULL
);

CREATE TABLE push_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL,
  tour_id       TEXT NOT NULL,
  change_type   TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  status        TEXT NOT NULL,
  response_code INTEGER,
  sent_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
