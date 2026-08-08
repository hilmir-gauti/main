/**
 * Schema migrations, applied in version order and recorded in
 * `schema_migrations`. Migrations are append-only: never edit one that has
 * shipped, add the next number instead.
 *
 * Naming note: table and column names are English (the language of SQL), but
 * enum *values* are Icelandic because they are shown directly in the admin
 * console and in customer-facing messages.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const initialSchema = `
-- ===========================================================================
-- Operator: the single human who runs Rafræn Þjónusta.
-- ===========================================================================
CREATE TABLE operator (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  totp_secret   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE session (
  id            TEXT PRIMARY KEY,          -- HMAC of the cookie value, never the value itself
  operator_id   TEXT NOT NULL REFERENCES operator(id) ON DELETE CASCADE,
  csrf_secret   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX idx_session_expires ON session(expires_at);

CREATE TABLE login_attempt (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL,                -- ip address or submitted email
  success    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_login_attempt_lookup ON login_attempt(identifier, created_at);

-- ===========================================================================
-- Tenant: a small Icelandic business we provide services to.
-- ===========================================================================
CREATE TABLE tenant (
  id                  TEXT PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  legal_name          TEXT NOT NULL DEFAULT '',
  kennitala           TEXT,
  industry            TEXT NOT NULL DEFAULT 'annad',
  tagline             TEXT NOT NULL DEFAULT '',
  about               TEXT NOT NULL DEFAULT '',
  email               TEXT NOT NULL DEFAULT '',
  phone               TEXT NOT NULL DEFAULT '',
  website_domain      TEXT NOT NULL DEFAULT '',
  address             TEXT NOT NULL DEFAULT '',
  postcode            TEXT NOT NULL DEFAULT '',
  city                TEXT NOT NULL DEFAULT '',
  timezone            TEXT NOT NULL DEFAULT 'Atlantic/Reykjavik',
  locale              TEXT NOT NULL DEFAULT 'is-IS',
  currency            TEXT NOT NULL DEFAULT 'ISK',
  brand_color         TEXT NOT NULL DEFAULT '#1d4ed8',
  accent_color        TEXT NOT NULL DEFAULT '#0f172a',
  logo_url            TEXT NOT NULL DEFAULT '',
  -- Booking policy
  slot_granularity_min INTEGER NOT NULL DEFAULT 15,
  min_notice_min       INTEGER NOT NULL DEFAULT 120,
  max_advance_days     INTEGER NOT NULL DEFAULT 90,
  cancel_window_hours  INTEGER NOT NULL DEFAULT 24,
  respect_holidays     INTEGER NOT NULL DEFAULT 1,
  auto_confirm         INTEGER NOT NULL DEFAULT 1,
  -- Phone answering
  greeting             TEXT NOT NULL DEFAULT '',
  forward_number       TEXT NOT NULL DEFAULT '',
  voicemail_email      TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'undirbuningur'
                       CHECK (status IN ('undirbuningur','virkur','i_bid','haett')),
  plan                 TEXT NOT NULL DEFAULT 'grunnur',
  notes                TEXT NOT NULL DEFAULT '',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX idx_tenant_status ON tenant(status);

CREATE TABLE tenant_feature (
  tenant_id  TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  feature    TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  config     TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, feature)
);

-- ===========================================================================
-- Catalogue: services offered, and the staff who perform them.
-- ===========================================================================
CREATE TABLE service (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  duration_min      INTEGER NOT NULL,
  buffer_before_min INTEGER NOT NULL DEFAULT 0,
  buffer_after_min  INTEGER NOT NULL DEFAULT 0,
  price_isk         INTEGER NOT NULL DEFAULT 0,
  vsk_rate          REAL NOT NULL DEFAULT 0.24,
  -- How many of this service can run at once (e.g. two lifts in a garage).
  capacity          INTEGER NOT NULL DEFAULT 1,
  requires_staff    INTEGER NOT NULL DEFAULT 1,
  is_public         INTEGER NOT NULL DEFAULT 1,
  active            INTEGER NOT NULL DEFAULT 1,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  color             TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK (duration_min > 0 AND duration_min <= 1440),
  CHECK (capacity >= 1)
);
CREATE INDEX idx_service_tenant ON service(tenant_id, active, sort_order);

CREATE TABLE staff (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  title               TEXT NOT NULL DEFAULT '',
  email               TEXT NOT NULL DEFAULT '',
  phone               TEXT NOT NULL DEFAULT '',
  color               TEXT NOT NULL DEFAULT '',
  accepts_bookings    INTEGER NOT NULL DEFAULT 1,
  google_calendar_id  TEXT NOT NULL DEFAULT '',
  active              INTEGER NOT NULL DEFAULT 1,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_staff_tenant ON staff(tenant_id, active);

CREATE TABLE staff_service (
  staff_id   TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES service(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);
CREATE INDEX idx_staff_service_service ON staff_service(service_id);

-- ===========================================================================
-- Schedules. A NULL staff_id means the row applies to the whole business.
-- Several rows may share a weekday, which is how lunch breaks are expressed
-- (09:00–12:00 and 13:00–17:00).
-- ===========================================================================
CREATE TABLE opening_hours (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  staff_id   TEXT REFERENCES staff(id) ON DELETE CASCADE,
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  open_min   INTEGER NOT NULL CHECK (open_min BETWEEN 0 AND 1440),
  close_min  INTEGER NOT NULL CHECK (close_min BETWEEN 0 AND 1440),
  CHECK (close_min > open_min)
);
CREATE INDEX idx_opening_hours_lookup ON opening_hours(tenant_id, weekday, staff_id);

-- One-off overrides: holidays, holidays worked, staff leave, extended hours.
CREATE TABLE schedule_exception (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  staff_id   TEXT REFERENCES staff(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,               -- YYYY-MM-DD in the tenant's timezone
  closed     INTEGER NOT NULL DEFAULT 1,
  open_min   INTEGER,
  close_min  INTEGER,
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_schedule_exception_lookup ON schedule_exception(tenant_id, date);

-- ===========================================================================
-- Customers and bookings.
-- ===========================================================================
CREATE TABLE customer (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL DEFAULT '',
  phone             TEXT NOT NULL DEFAULT '',
  kennitala         TEXT,
  notes             TEXT NOT NULL DEFAULT '',
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  no_show_count     INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
-- A phone number identifies a returning customer; enforced only when present.
CREATE UNIQUE INDEX idx_customer_phone ON customer(tenant_id, phone) WHERE phone <> '';
CREATE INDEX idx_customer_name ON customer(tenant_id, name);

CREATE TABLE booking (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  service_id        TEXT NOT NULL REFERENCES service(id) ON DELETE RESTRICT,
  staff_id          TEXT REFERENCES staff(id) ON DELETE SET NULL,
  customer_id       TEXT NOT NULL REFERENCES customer(id) ON DELETE RESTRICT,
  -- The appointment the customer sees.
  starts_at         INTEGER NOT NULL,
  ends_at           INTEGER NOT NULL,
  -- The span the resource is actually occupied, including buffers. Overlap
  -- checks use these so a 10-minute cleanup buffer genuinely blocks the diary.
  block_start_at    INTEGER NOT NULL,
  block_end_at      INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'stadfest'
                    CHECK (status IN ('beidni','stadfest','maett','lokid','afbokad','ekki_maett')),
  source            TEXT NOT NULL DEFAULT 'vefur'
                    CHECK (source IN ('vefur','simi','stjornbord','app','sms')),
  price_isk         INTEGER NOT NULL DEFAULT 0,
  notes             TEXT NOT NULL DEFAULT '',      -- from the customer
  internal_notes    TEXT NOT NULL DEFAULT '',      -- staff only
  cancel_token      TEXT NOT NULL,
  google_event_id   TEXT NOT NULL DEFAULT '',
  google_calendar_id TEXT NOT NULL DEFAULT '',
  reminder_sent_at  INTEGER,
  confirmation_sent_at INTEGER,
  cancelled_at      INTEGER,
  cancel_reason     TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK (ends_at > starts_at),
  CHECK (block_end_at >= ends_at AND block_start_at <= starts_at)
);
CREATE INDEX idx_booking_tenant_time ON booking(tenant_id, starts_at);
CREATE INDEX idx_booking_staff_time ON booking(staff_id, block_start_at, block_end_at);
CREATE INDEX idx_booking_service_time ON booking(service_id, block_start_at);
CREATE INDEX idx_booking_status ON booking(tenant_id, status, starts_at);
CREATE INDEX idx_booking_reminders ON booking(status, reminder_sent_at, starts_at);
CREATE UNIQUE INDEX idx_booking_cancel_token ON booking(cancel_token);

-- Busy blocks imported from an external calendar, so personal appointments in
-- a staff member's Google Calendar reserve time here too.
CREATE TABLE external_busy (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  staff_id    TEXT REFERENCES staff(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'google',
  external_id TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL,
  synced_at   INTEGER NOT NULL
);
CREATE INDEX idx_external_busy_lookup ON external_busy(tenant_id, starts_at, ends_at);
CREATE UNIQUE INDEX idx_external_busy_external ON external_busy(tenant_id, source, external_id)
  WHERE external_id <> '';

-- ===========================================================================
-- Integrations.
-- ===========================================================================
CREATE TABLE oauth_account (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT REFERENCES tenant(id) ON DELETE CASCADE,  -- NULL = platform-wide
  provider       TEXT NOT NULL,
  account_email  TEXT NOT NULL DEFAULT '',
  subject        TEXT NOT NULL DEFAULT '',
  access_token   TEXT NOT NULL DEFAULT '',   -- AES-256-GCM sealed
  refresh_token  TEXT NOT NULL DEFAULT '',   -- AES-256-GCM sealed
  expires_at     INTEGER,
  scope          TEXT NOT NULL DEFAULT '',
  calendar_id    TEXT NOT NULL DEFAULT 'primary',
  last_sync_at   INTEGER,
  last_error     TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_oauth_tenant_provider ON oauth_account(tenant_id, provider);

-- Onboarding checklist generated by the provisioning pipeline.
CREATE TABLE provisioning_task (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'bidur'
                    CHECK (status IN ('bidur','i_vinnslu','lokid','stopp','sleppt')),
  detail            TEXT NOT NULL DEFAULT '',
  payload           TEXT NOT NULL DEFAULT '{}',
  -- 1 when a human must act (e.g. add DNS records at the registrar).
  requires_operator INTEGER NOT NULL DEFAULT 0,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  completed_at      INTEGER
);
CREATE UNIQUE INDEX idx_provisioning_task_key ON provisioning_task(tenant_id, key);
CREATE INDEX idx_provisioning_task_status ON provisioning_task(status, sort_order);

-- Phones paired to a tenant, for push notifications (iOS and Android).
CREATE TABLE device (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  label        TEXT NOT NULL DEFAULT '',
  platform     TEXT NOT NULL DEFAULT 'ios' CHECK (platform IN ('ios','android','vefur')),
  push_token   TEXT NOT NULL DEFAULT '',
  pairing_code TEXT,
  pairing_expires_at INTEGER,
  paired_at    INTEGER,
  last_seen_at INTEGER,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_device_tenant ON device(tenant_id, active);
CREATE UNIQUE INDEX idx_device_pairing ON device(pairing_code) WHERE pairing_code IS NOT NULL;
CREATE UNIQUE INDEX idx_device_token ON device(push_token) WHERE push_token <> '';

CREATE TABLE notification (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  device_id  TEXT REFERENCES device(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'bidur'
             CHECK (status IN ('bidur','sent','villa','thurrkeyrsla')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  sent_at    INTEGER
);
CREATE INDEX idx_notification_pending ON notification(status, created_at);
CREATE INDEX idx_notification_tenant ON notification(tenant_id, created_at DESC);

CREATE TABLE call_log (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT REFERENCES tenant(id) ON DELETE CASCADE,
  provider_call_id TEXT NOT NULL DEFAULT '',
  direction        TEXT NOT NULL DEFAULT 'inn' CHECK (direction IN ('inn','ut')),
  from_number      TEXT NOT NULL DEFAULT '',
  to_number        TEXT NOT NULL DEFAULT '',
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  duration_sec     INTEGER,
  outcome          TEXT NOT NULL DEFAULT 'i_gangi'
                   CHECK (outcome IN ('i_gangi','bokad','skilabod','aframsent','upplysingar','ekkert','villa')),
  transcript       TEXT NOT NULL DEFAULT '',
  recording_url    TEXT NOT NULL DEFAULT '',
  booking_id       TEXT REFERENCES booking(id) ON DELETE SET NULL,
  state            TEXT NOT NULL DEFAULT '{}',   -- IVR conversation state
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_call_log_tenant ON call_log(tenant_id, started_at DESC);
CREATE UNIQUE INDEX idx_call_log_provider ON call_log(provider_call_id) WHERE provider_call_id <> '';

CREATE TABLE message_log (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT REFERENCES tenant(id) ON DELETE CASCADE,
  channel            TEXT NOT NULL CHECK (channel IN ('tolvupostur','sms')),
  direction          TEXT NOT NULL DEFAULT 'ut' CHECK (direction IN ('inn','ut')),
  to_addr            TEXT NOT NULL,
  from_addr          TEXT NOT NULL DEFAULT '',
  subject            TEXT NOT NULL DEFAULT '',
  body               TEXT NOT NULL DEFAULT '',
  template           TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'bidur'
                     CHECK (status IN ('bidur','sent','villa','thurrkeyrsla')),
  provider           TEXT NOT NULL DEFAULT '',
  provider_id        TEXT NOT NULL DEFAULT '',
  error              TEXT NOT NULL DEFAULT '',
  related_booking_id TEXT REFERENCES booking(id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL,
  sent_at            INTEGER
);
CREATE INDEX idx_message_log_tenant ON message_log(tenant_id, created_at DESC);
CREATE INDEX idx_message_log_status ON message_log(status, created_at);

CREATE TABLE website_build (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  path       TEXT NOT NULL,
  template   TEXT NOT NULL DEFAULT '',
  checksum   TEXT NOT NULL DEFAULT '',
  page_count INTEGER NOT NULL DEFAULT 0,
  bytes      INTEGER NOT NULL DEFAULT 0,
  published  INTEGER NOT NULL DEFAULT 0,
  built_at   INTEGER NOT NULL
);
CREATE INDEX idx_website_build_tenant ON website_build(tenant_id, version DESC);

-- ===========================================================================
-- Cross-cutting.
-- ===========================================================================
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL DEFAULT 'kerfi',
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL DEFAULT '',
  entity_id  TEXT NOT NULL DEFAULT '',
  tenant_id  TEXT,
  meta       TEXT NOT NULL DEFAULT '{}',
  ip         TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);

CREATE TABLE app_setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * Intake answers are stored as a JSON blob on the booking rather than in a
 * normalised answer table. They are always read as a whole (to render a form
 * summary), the question set changes with the flow definition rather than with
 * the schema, and SQLite's JSON functions cover the rare aggregate query.
 */
const intakeAnswers = `
ALTER TABLE booking ADD COLUMN intake TEXT NOT NULL DEFAULT '{}';

-- Which flow version produced the answers, so old bookings still render
-- correctly after a flow is edited.
ALTER TABLE booking ADD COLUMN intake_flow TEXT NOT NULL DEFAULT '';

-- Website design variants generated for the operator to choose between.
CREATE TABLE website_variant (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  variant     TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  path        TEXT NOT NULL,
  bytes       INTEGER NOT NULL DEFAULT 0,
  chosen      INTEGER NOT NULL DEFAULT 0,
  built_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_website_variant_key ON website_variant(tenant_id, variant);
`;

// Where a build ended up once it left this machine. Empty for a site that is
// only served locally, which stays a supported way to run.
const externalHosting = `
ALTER TABLE website_build ADD COLUMN deploy_url TEXT NOT NULL DEFAULT '';
ALTER TABLE website_build ADD COLUMN deploy_state TEXT NOT NULL DEFAULT '';
ALTER TABLE website_build ADD COLUMN deployed_at INTEGER;
`;

/**
 * The webstore.
 *
 * Some trades sell objects rather than hours — a joinery ships cutting boards
 * and coffee tables, and no amount of booking software helps with that. An
 * order is deliberately *not* modelled as a booking: it has no place in a
 * diary, it holds several lines, and it moves through a workshop rather than
 * through a calendar.
 *
 * Money is stored per line as it was at the moment of ordering. A price change
 * next month must not rewrite what someone already agreed to pay, so the line
 * carries its own name and unit price and the product reference is only used
 * for stock and for linking back.
 */
const webshop = `
CREATE TABLE product (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  tagline       TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  -- What it is made of and how big it is: the two questions every buyer of a
  -- handmade wooden object asks, and the two facts every listing photo lacks.
  material      TEXT NOT NULL DEFAULT '',
  dimensions    TEXT NOT NULL DEFAULT '',
  price_isk     INTEGER NOT NULL DEFAULT 0,
  vsk_rate      REAL NOT NULL DEFAULT 0.24,
  -- Made to order: no stock is tracked, and the lead time is shown instead.
  made_to_order INTEGER NOT NULL DEFAULT 0,
  lead_time_days INTEGER NOT NULL DEFAULT 0,
  stock         INTEGER NOT NULL DEFAULT 0,
  image_url     TEXT NOT NULL DEFAULT '',
  is_public     INTEGER NOT NULL DEFAULT 1,
  active        INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  CHECK (price_isk >= 0),
  CHECK (stock >= 0)
);
CREATE INDEX idx_product_tenant ON product(tenant_id, active, sort_order);
CREATE UNIQUE INDEX idx_product_slug ON product(tenant_id, slug);

CREATE TABLE shop_order (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  -- Short reference the customer reads over the phone, e.g. "P-4K7Q".
  reference       TEXT NOT NULL,
  customer_id     TEXT NOT NULL REFERENCES customer(id) ON DELETE RESTRICT,
  status          TEXT NOT NULL DEFAULT 'ny'
                  CHECK (status IN ('ny','stadfest','i_smidum','tilbuin','afhent','haett')),
  delivery        TEXT NOT NULL DEFAULT 'saekja' CHECK (delivery IN ('saekja','sending')),
  source          TEXT NOT NULL DEFAULT 'vefur'
                  CHECK (source IN ('vefur','simi','stjornbord')),
  address         TEXT NOT NULL DEFAULT '',
  postcode        TEXT NOT NULL DEFAULT '',
  city            TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',      -- from the customer
  internal_notes  TEXT NOT NULL DEFAULT '',      -- workshop only
  items_isk       INTEGER NOT NULL DEFAULT 0,
  shipping_isk    INTEGER NOT NULL DEFAULT 0,
  total_isk       INTEGER NOT NULL DEFAULT 0,
  vsk_isk         INTEGER NOT NULL DEFAULT 0,
  -- Opaque token behind the customer's own status page.
  status_token    TEXT NOT NULL,
  confirmation_sent_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  cancelled_at    INTEGER
);
CREATE INDEX idx_shop_order_tenant ON shop_order(tenant_id, created_at DESC);
CREATE INDEX idx_shop_order_status ON shop_order(tenant_id, status, created_at DESC);
CREATE UNIQUE INDEX idx_shop_order_reference ON shop_order(tenant_id, reference);
CREATE UNIQUE INDEX idx_shop_order_token ON shop_order(status_token);

CREATE TABLE order_item (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES shop_order(id) ON DELETE CASCADE,
  product_id      TEXT REFERENCES product(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  variant         TEXT NOT NULL DEFAULT '',      -- e.g. engraving, chosen wood
  unit_price_isk  INTEGER NOT NULL DEFAULT 0,
  vsk_rate        REAL NOT NULL DEFAULT 0.24,
  quantity        INTEGER NOT NULL DEFAULT 1,
  line_total_isk  INTEGER NOT NULL DEFAULT 0,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  CHECK (quantity > 0)
);
CREATE INDEX idx_order_item_order ON order_item(order_id, sort_order);
CREATE INDEX idx_order_item_product ON order_item(product_id);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'upphafsskema', sql: initialSchema },
  { version: 2, name: 'innskraningarspurningar_og_vefutgafur', sql: intakeAnswers },
  { version: 3, name: 'ytri_vefhysing', sql: externalHosting },
  { version: 4, name: 'vefverslun', sql: webshop },
];
