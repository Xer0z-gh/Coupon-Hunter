-- Community coupon collection (Cloudflare D1). Already applied to the
-- provisioned database; kept here so the schema is reproducible.
CREATE TABLE IF NOT EXISTS coupons (
  domain     TEXT NOT NULL,
  code       TEXT NOT NULL,
  pct        INTEGER,
  amount     INTEGER,
  freeship   INTEGER NOT NULL DEFAULT 0,
  works      INTEGER NOT NULL DEFAULT 0,
  fails      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (domain, code)
);
CREATE INDEX IF NOT EXISTS idx_coupons_domain ON coupons (domain);
CREATE INDEX IF NOT EXISTS idx_coupons_rank ON coupons (domain, works DESC, fails ASC);
