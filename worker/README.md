# Coupon Hunter — community API (Cloudflare Worker + D1)

An anonymous, no-account, no-PII backend for the shared coupon collection.
Codes users choose to share land here; everyone's extension can pull them and
report whether they worked, building a crowd success rate per code.

## What's already done

- A D1 database named **`coupon-hunter`** is provisioned
  (`database_id = df7f037e-2aa0-4b96-8f1c-a239bd8afd0a`) with the schema in
  [`schema.sql`](schema.sql) applied.
- The Worker code ([`worker.js`](worker.js)) and [`wrangler.toml`](wrangler.toml)
  are ready.

## Deploy (one command)

```bash
cd worker
npm i -g wrangler        # if you don't have it
wrangler login           # authorize with your Cloudflare account
wrangler deploy
```

This prints a URL like `https://coupon-hunter-api.<your-subdomain>.workers.dev`.

## Turn it on in the extension

Set that URL as `API_BASE` in **`sources.js`** (top of file):

```js
const API_BASE = "https://coupon-hunter-api.<your-subdomain>.workers.dev";
```

Reload the extension. Until `API_BASE` is set, the community source is simply
skipped — everything else works unchanged.

## API

| Method | Path | Body / Query | Purpose |
|---|---|---|---|
| `GET` | `/v1/coupons?domain=store.com` | — | Codes others shared, crowd-ranked |
| `POST` | `/v1/coupons` | `{domain, code, pct?, amount?, freeShip?}` | Contribute a code |
| `POST` | `/v1/feedback` | `{domain, code, status:"working"\|"failed"}` | Crowd success rate |

All input is validated (code `^[A-Z0-9]{4,20}$`, domain a hostname, pct 1–95,
amount 1–2000), CORS-open, and per-domain capped at 300 codes.

## Notes / hardening ideas

- For heavier abuse protection add Cloudflare **Rate Limiting Rules** on the
  Worker route, or a KV/Durable-Object per-IP limiter.
- No personal data is stored — only `(domain, code, discount, works, fails)`.
