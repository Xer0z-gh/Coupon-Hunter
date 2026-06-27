# Coupon Hunter

A Manifest V3 browser extension for Chrome, Edge, Brave, Arc, and Opera that finds working coupon codes for any store and auto-applies the best one at checkout. No accounts, no telemetry, no paywall. MIT licensed.

## Install

**Load unpacked (recommended for development)**

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this folder
4. Pin the extension via the puzzle-piece menu

After any edit, click the **reload** icon on the extension card in `chrome://extensions`.

**Chrome Web Store** — coming soon. Use the unpacked method in the meantime.

## What it does

When a coupon/promo code input is detected at checkout, the extension:

1. Fans out in parallel to 20+ coupon databases (CouponFollow, RetailMeNot, Slickdeals, Wethrift, etc.) and also scans the page itself for codes the merchant advertises.
2. Deduplicates results with cross-source consensus — codes corroborated by multiple independent sites are tried first.
3. Applies each code in order of expected savings: proven past winners → advertised discount percentage → digit-in-code guess. Tries them all unless an early-exit condition is provably met (the banked saving beats the theoretical max any remaining code could yield).
4. Keeps whichever code produces the lowest order total and re-applies it.
5. Caches results per domain for 1 hour, revalidating in the background after 20 minutes.

**Third-party checkouts** (Shop Pay, Stripe, PayPal, Klarna, etc.): the extension resolves the real merchant from the referrer or the most-referenced domain in the page HTML, and only applies codes for that store. If attribution fails, nothing is applied.

**Safety**: the apply loop refuses to click any button whose label looks like "Place Order", "Pay", "Buy Now", "Continue", or anything that could submit an order. Only explicit coupon-apply buttons ("Apply", "Redeem", "Use code") are clicked.

## File layout

```
coupon-hunter/
├── manifest.json       MV3 manifest
├── core.js             Shared pure logic — domain/POS resolution, code validation,
│                       button and result classifiers, savings math. No DOM, no
│                       Chrome APIs. Loaded as first content script and by tests.
├── background.js       Service worker — hunt orchestration, cache, savings ledger,
│                       settings, keyboard shortcut handler
├── sources.js          Per-site coupon adapters (fan-out + extractors), consensus dedup
├── content.js          In-page floating card, merchant resolution, auto-apply loop
├── content.css         On-page card styles
├── popup.html/css/js   Toolbar popup — 3 tabs (Apply / Scan / Add) + savings + settings
├── welcome.html/js     First-run onboarding page
├── worker/             Cloudflare Worker + D1 schema for the community collection
├── tests/              Node unit tests (npm test)
├── build.js            Cross-platform release packager (npm run build)
├── icons/              PNG icons at 16/32/48/128px
├── LICENSE             MIT
└── PRIVACY.md          Privacy policy
```

## Popup: three tabs

- **Apply** — the codes already found for the current store, with an "Apply best
  code on this page" button. Shows the crowd success rate (`👍 87% · 124`) when
  the community has data.
- **Scan** — a public coupon checker for *any* store: type a domain, scan 20+
  databases + the community, see what's live. Streams progress.
- **Add** — contribute a code you know works so it's tried first on that store,
  and optionally **share it with the community** (anonymous). Settings (master
  on/off, per-site pause, auto toggles, cache, crowd-feedback opt-in) live behind
  the gear, reachable from any tab. The lifetime-savings hero is always visible.

## Community collection (optional)

A Cloudflare Worker + D1 backend (in [`worker/`](worker/)) lets codes that work
for one person help everyone, with a crowd success rate per code. It's **off
until you deploy it**: `cd worker && wrangler deploy`, then set `API_BASE` in
`sources.js` to the printed URL. Anonymous, no accounts, no PII — see
[`worker/README.md`](worker/README.md) and the privacy policy. Sharing is always
opt-in (a per-code checkbox; crowd feedback is a Settings toggle, default off).

## Development

No build step for day-to-day work — it's plain JS/CSS/HTML. Load unpacked, edit, reload.

```
npm test          # run unit tests with node --test
npm run check     # syntax-check all scripts with node --check
npm run build     # package dist/coupon-hunter-v<version>.zip for the store
```

`build.js` uses `zip` on macOS/Linux and falls back to PowerShell's `Compress-Archive` on Windows — no extra tools needed on any platform.

## Architecture notes

- `core.js` is the only file unit-tested in isolation. All bug-prone or safety-critical logic belongs there: `classifyButtonLabel` (the "never click Pay" guard), `classifyResultText`, `parseMoney`, `buildApplyQueue`, `suffixCeilings`.
- The service worker (`background.js`) owns the single shared cache and savings ledger. Content scripts and the popup communicate with it via `chrome.runtime.sendMessage`.
- `sources.js` uses ES module exports (`export function …`) and is imported by the service worker. `core.js` uses an IIFE that sets `globalThis.CHCore` so it works both as a content script and in Node (tests).

## Known limitations

- Coupon sites change markup constantly. Structural extraction runs first; a regex fallback over raw HTML catches changes. Worst case: fewer hits from one source.
- Sites behind Cloudflare bot protection return zero results silently. The other sources still run.
- The apply loop depends on the merchant's coupon input and apply button following common patterns (Shopify, WooCommerce, BigCommerce, Magento, and most custom checkouts). Unusual implementations may require manual copy-paste from the card.
- No cashback or price-drop tracking — those require monetizing purchase data. The optional community collection is the only network feature beyond coupon lookups, it's opt-in, anonymous, and stores no personal data.

## How it compares to Honey

| | Coupon Hunter | Typical coupon extension |
|---|---|---|
| Price | Free, MIT | Free, closed source |
| Business model | None | Affiliate commissions / selling data |
| Your data | Never leaves your browser | Tracks purchases and browsing |
| Best code selection | Tries all, keeps the biggest, with early-exit proof | Stops at first working code |
| Hosted checkouts | Resolves the real merchant | Often applies wrong store's codes |
| Safety | Hard guard — never clicks Pay/Place Order | — |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Most impactful: new coupon sources in `sources.js` and checkout selector fixes in `content.js`.

## License

[MIT](LICENSE)
