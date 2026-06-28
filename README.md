# Coupon Hunter

![License](https://img.shields.io/badge/license-MIT-blue) ![Manifest](https://img.shields.io/badge/Manifest-V3-555)

Finds working coupon codes for whatever store you're checking out on and applies the best one automatically. Free, open source, no account, no ads.

It's a Manifest V3 extension, so it runs in Chrome, Edge, Brave, Arc, and Opera.

> **Status:** feature-complete and used daily. Not on the Chrome Web Store yet, so for now you load it unpacked (takes about a minute, steps below).

## How it works

A content script watches the page for a coupon field. The moment one appears, the service worker fans out to ~20 public coupon sites in parallel and also pulls any codes the store advertises on the page itself. It then types each candidate into the box, watches the order total react, and keeps whichever one drops it the most. You don't click anything.

A few things it does that most coupon extensions don't:

- **Actually picks the best code.** It tries every candidate instead of stopping at the first hit, and remembers the lowest total it reached. A provable early-exit stops the loop once nothing left could beat what's already banked, so it isn't slow about it.
- **Survives hosted checkouts.** On Shop Pay, Stripe, PayPal, Klarna and the like, the page's domain is the *payment processor*, not the store. It works out the real merchant (from the referrer, or the most-linked domain on the page) and only applies that store's codes. If it genuinely can't tell, it applies nothing instead of guessing wrong.
- **Will never submit your order.** The apply step refuses to click anything that reads like "Place order", "Pay", "Buy now", "Continue", etc. It only clicks real apply/redeem buttons, and that guard is unit-tested against a list of dangerous labels.
- **Ranks by expected savings.** Codes proven to work (by you or the community) go first, then ones whose listing advertises a bigger discount, then everything else.
- **Stops re-testing dead codes.** A code that failed here gets remembered and skipped for a month (in case it comes back), and once the community has tried a code enough times to know it's dead, nobody wastes time on it. Codes the store is advertising right now are always tried regardless.

## Install (unpacked)

1. Download or clone this repo.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder.

After editing any file, click the reload icon on the extension's card.

## The popup

Three tabs, with your lifetime savings pinned across the top:

- **Apply** — codes already found for the current store, and a button to apply the best one right now.
- **Scan** — type any domain and see what coupons are live for it. Doubles as a quick "does this store even have codes?" checker.
- **Add** — paste a code you know works so it gets tried first on that store, and optionally share it to the community collection.

The gear icon opens settings: pause on the current site, turn auto-hunt or auto-apply off, cache duration, and the community sharing toggle.

## Privacy

Everything the extension remembers (your savings, settings, and found codes) stays in your browser. No account, no analytics.

Two things touch the network:

1. **Coupon lookups** send the store's domain to public coupon sites. That's the same request you'd make by opening those sites yourself.
2. **The community backend** (only if you deploy it, below). Codes you choose to share, plus anonymous "this code worked / didn't" feedback, get sent to it. The feedback is on by default and can be turned off in settings; it's only `{ domain, code, worked? }` with nothing tying it to you.

Full write-up in [PRIVACY.md](PRIVACY.md).

## Community collection (optional)

There's a small Cloudflare Worker + D1 backend in [`worker/`](worker/) that turns shared codes into a crowd-rated collection ("worked for 87% of people"). It stays dormant until you stand it up:

```bash
cd worker
wrangler deploy
```

Then put the URL it prints into `API_BASE` at the top of `sources.js` and reload. The API and schema are documented in [worker/README.md](worker/README.md). Until `API_BASE` is set, the community source is simply skipped and nothing else changes.

## Project layout

```
manifest.json      MV3 manifest
core.js            Pure logic: merchant/POS resolution, code + button + result
                   classifiers, money parsing, ranking math. No DOM, no chrome
                   APIs, so it's unit-tested directly and shared by the content script.
background.js      Service worker: hunt orchestration, per-domain cache,
                   savings ledger, settings, keyboard shortcut, community feedback.
sources.js         The ~20 coupon-site adapters, the community client, and the
                   cross-source consensus merge.
content.js         The on-page card, merchant resolution, and the apply loop.
content.css        Card styles (light + dark).
popup.html/css/js  Toolbar popup: the three tabs, savings, settings.
welcome.html/js    First-run page.
worker/            Cloudflare Worker + D1 schema for the optional community API.
tests/             Node test suite.
build.js           Zips the runtime files for the Web Store.
icons/             16 / 32 / 48 / 128 px.
```

## Development

Plain JS, CSS, and HTML. No bundler, no install step for day-to-day work.

```bash
npm test       # unit tests (node --test)
npm run check  # syntax-check every script
npm run build  # zip the runtime files into dist/ for the Web Store
```

`core.js` holds the bug-prone, safety-relevant code on purpose: the never-click-Pay button classifier, the apply-result classifier, the currency parser, and the ranking/early-exit math. It runs in both a content script and Node (it assigns `globalThis.CHCore`), which is what lets the tests import it without a browser. If you change any of that logic, add a case to `tests/`.

## Limitations

- Coupon sites rewrite their markup constantly. Extraction is structural first with a regex fallback, so when a source breaks you just get fewer hits from it, not a crash.
- A few sources sit behind bot protection and quietly return nothing. The rest still run.
- Auto-apply needs the checkout to use a recognizable coupon field and apply button. The big platforms (Shopify, WooCommerce, BigCommerce, Magento, and most custom carts) work; an unusual one may need a manual paste from the card.
- It doesn't do cashback or price tracking. Those need to monetize your purchase history, which is the thing this is trying not to do.

## Contributing

PRs welcome. The two most useful contributions are adding a coupon source in `sources.js` and fixing checkout selectors in `content.js` for a store that gets missed. Details in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) — do what you want with it.
