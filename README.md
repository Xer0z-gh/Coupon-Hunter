# Coupon Hunter

![License](https://img.shields.io/badge/license-MIT-blue) ![Tests](https://img.shields.io/badge/tests-25%20passing-brightgreen) ![Dependencies](https://img.shields.io/badge/dependencies-0-555)

Finds working coupon codes for whatever store you're checking out on, tries them one after another,
and keeps whichever one takes the most off your total. It will never click anything that places
your order: 16 order-submitting button labels are pinned as dangerous in `tests/core.test.js:63`.
Free, open source, no account, no ads, no affiliate links.

## How it works

You don't click anything and the total drops. A content script watches the page for a coupon
field; the moment one appears, the service worker fans out in parallel to 19 public coupon sites,
plus the optional community pool, a public search-results page, and a generated-guess pass — 22
adapters in all (`Promise.all` over `ADAPTERS`, declared at `sources.js:385` and run at
`sources.js:455`) — and also pulls any codes the store advertises on the page itself. It then
types each candidate into the box, watches the order total react, and keeps whichever one drops
it the most.

### What it does about speed

No invented numbers here — this is what the code does, and where.

- **The fan-out is one round trip, not 22.** Every adapter is dispatched at once
  (`sources.js:455`), and a source that hangs is aborted at 8 seconds and simply contributes
  nothing rather than holding up the rest (`FETCH_TIMEOUT_MS`, `sources.js:17`).
- **Each attempt ends on the merchant's answer, not on a timer.** `waitForResult`
  (`content.js:1073`) resolves the moment the order total falls below the no-code baseline or the
  merchant prints its own rejection. It only falls back to the timeout once the checkout has also
  stopped showing a spinner (`content.js:1114`), so a slow checkout gets waited out and a fast one
  isn't padded.
- **The queue can stop before it's finished.** Codes are ranked best-first, and once the discount
  already banked beats the most any remaining code could possibly give, the loop breaks
  (`content.js:889`, using `suffixCeilings` from `core.js`).

What is deliberately *not* fast: the typing. A code goes in keystroke by keystroke with ~35–90ms
pauses (`content.js:999`) and there is a ~700ms gap between codes (`INTER_CODE_DELAY_MS`,
`content.js:974`), because merchants watch for bursts.

A few things it does that most coupon extensions don't:

- **Will never submit your order.** The apply step refuses to click anything that reads like
  "Place order", "Pay", "Buy now", "Continue", etc. It only clicks real apply/redeem buttons. The
  guard is the first thing in this repo anyone should check, so it is a table rather than a
  promise: `tests/core.test.js:63` asserts 16 order-submitting labels — including `Pay $42.99`,
  `Review order`, `Proceed to checkout` and the bare `Continue` — classify as dangerous, and 10
  legitimate ones (`Apply`, `Redeem`, `Use code`, `Add promo code`…) classify as apply.
- **Actually picks the best code.** It keeps testing past the first hit and remembers the lowest
  total it reached, so a working code is never mistaken for the best one. It stops early only when
  it can prove stopping is free: when nothing left in the queue could beat what's already banked
  (`content.js:889`). Otherwise it runs the whole queue, and re-applies the winner at the end so
  the checkout keeps the biggest discount.
- **Survives hosted checkouts.** On Shop Pay, Stripe, PayPal, Klarna and the like, the page's
  domain is the *payment processor*, not the store. It works out the real merchant (from the
  referrer, or the most-linked domain on the page — `resolveMerchant`, `content.js:83`) and only
  applies that store's codes. If it genuinely can't tell, it applies nothing instead of guessing
  wrong. The service worker won't pre-warm a processor's domain either (`background.js:411`).
- **Ranks by expected savings.** Codes proven to work (by you or the community) go first, then
  ones whose listing advertises a bigger discount, then everything else, with cross-source
  consensus breaking ties (`buildApplyQueue`, `core.js:261`).
- **No affiliate games.** It never rewrites links, injects tracking, or takes a cut of your
  checkout. There is no way for a merchant relationship to influence which code you get, because
  there are no merchant relationships — and merchant-curated code services (the Honey model) are
  not among the sources, since their incentive is to hide the biggest discounts.
- **Stops re-testing dead codes.** A code that failed here is skipped for 30 days in case it comes
  back (`FAIL_SKIP_MS`, `core.js:238`), and once the community has reported a code at least 5
  times with under 8% of them working, it's dropped from the try-order (`CROWD_MIN_SAMPLES` and
  `CROWD_DEAD_RATE`, `core.js:239-240`). Codes the store is advertising right now are always
  tried regardless. The popup applies its own lighter version of the same rule when it lists
  codes: 3 reports at 50%+ float to the top, under 8% are hidden (`popup.js:110-112`).

## Limitations

- Coupon sites rewrite their markup constantly. Extraction is structural first with a regex fallback, so when a source breaks you just get fewer hits from it, not a crash.
- A few sources sit behind bot protection and quietly return nothing. The rest still run.
- Auto-apply needs the checkout to use a recognizable coupon field and apply button. The coupon
  field is matched by name, id, placeholder or aria-label against 15 coupon words in several
  languages (`COUPON_TERMS` and `COUPON_INPUT_SELECTOR`, `content.js:171-195`), and the order
  total by a set of `data-test`, class and id patterns (`TOTAL_SELECTOR`, `content.js:197`). A
  checkout that obfuscates both — no recognizable field naming and no total it can read — may
  need a manual paste from the card.
- A discount is judged by the total moving, or by the merchant's own message. Where neither is
  readable, the attempt is recorded as failed, which is the conservative reading and can cost a
  good code a 30-day skip on that one store.
- It doesn't do cashback or price tracking. Those need to monetize your purchase history, which is the thing this is trying not to do.

## Install (unpacked)

It's a Manifest V3 extension, so it runs in Chrome, Edge, Brave, Arc, and Opera. The manifest sets
no minimum browser version, so the real floor is whatever supports MV3 service workers.
Feature-complete, but not on the Chrome Web Store, so for now you load it unpacked. Takes about a
minute.

1. Download or clone this repo.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder.

After editing any file, click the reload icon on the extension's card.

`manifest.json` requests four permissions — `storage`, `scripting`, `tabs`, `notifications` — plus
host access to `<all_urls>`, which Chrome shows you at install as "Read and change all your data on
all websites".

- `<all_urls>` is there because a checkout can be on any domain: the content script has to be able
  to find a coupon field wherever you end up.
- `tabs` is what lets the service worker read the URL of an open tab. It uses that to pre-warm a
  hunt when a tab finishes loading a store page (`background.js:399`), to stream hunt progress to
  the on-page card in whichever tab is on that store (`background.js:189`), and to send the
  Ctrl/Cmd+Shift+U shortcut to the active tab (`background.js:391`).
- `storage` holds your savings, settings, per-domain code cache and results log; `scripting` and
  `notifications` cover the injected card and the "saved you money" toast.

What it actually does with the access is narrow — it reads the coupon field and the order-total
row, types codes, and sends the store's domain to the coupon sites. Nothing else leaves your
browser ([Privacy](#privacy)).

## The popup

Three tabs, with your lifetime savings pinned across the top:

- **Apply** — codes already found for the current store, and a button to apply the best one right now.
- **Scan** — type any domain and see what coupons are live for it. Doubles as a quick "does this store even have codes?" checker.
- **Add** — paste a code you know works so it gets tried first on that store, and optionally share it to the community collection.

The gear icon opens settings: a master on/off, pause on the current site, auto-hunt, auto-apply,
the floating card, the community feedback toggle, and how many hours to cache codes for.

## Privacy

Everything the extension remembers (your savings, settings, and found codes) stays in your browser. No account, no analytics.

Two things touch the network:

1. **Coupon lookups** send the store's domain to public coupon sites. That's the same request you'd make by opening those sites yourself.
2. **The community backend** (only if you deploy it, below). Codes you choose to share, plus anonymous "this code worked / didn't" feedback, get sent to it. The feedback is on by default and can be turned off in settings; it's only `{ domain, code, worked? }` with nothing tying it to you.

Full write-up in [PRIVACY.md](PRIVACY.md).

## The coupon network (optional backend)

With the backend deployed, Coupon Hunter becomes a shared network instead of a private cache, and the three tabs map onto it:

- **Scan** — when anyone scans a store, the codes they find are contributed to that store's shared pool (deduped and capped server-side). The pool grows from everyone's scans.
- **Add** — codes people add by hand go into the same pool.
- Every apply attempt reports an anonymous worked/failed result, which builds a crowd success rate per code.
- **Apply** — crowd success rate is shown as a badge and sorts the list, and codes the network has
  confirmed dead are hidden entirely (`popup.js:110-116`).

The backend is a small Cloudflare Worker + D1 database in [`worker/`](worker/). It stays dormant until you stand it up — `API_BASE` at the top of `sources.js` (line 22) is an empty string by default and the community source returns immediately when it's unset, so until then everything runs locally and works exactly the same, just without the shared pool:

```bash
cd worker
wrangler deploy
```

Then put the URL it prints into `API_BASE` and reload. The API and schema are documented in [worker/README.md](worker/README.md).

## Project layout

```
manifest.json      MV3 manifest
core.js            Pure logic: merchant/POS resolution, code + button + result
                   classifiers, money parsing, ranking and stop-policy math. No
                   DOM, no chrome APIs, so it's unit-tested directly and shared
                   by the content script.
background.js      Service worker: hunt orchestration, per-domain cache,
                   savings ledger, settings, keyboard shortcut, community feedback.
sources.js         22 adapters — 19 coupon sites, the community client, a
                   search-results pass and a generated-guess pass — plus the
                   cross-source consensus merge.
content.js         The on-page card, merchant resolution, and the apply loop.
content.css        Card styles (light + dark).
popup.html/css/js  Toolbar popup: the three tabs, savings, settings.
welcome.html/js    First-run page.
worker/            Cloudflare Worker + D1 schema for the optional community API.
tests/             Node test suite: core.test.js (the pure logic in core.js) and
                   sources.test.js (code extraction and the consensus merge).
build.js           Zips the runtime files for the Web Store.
icons/             16 / 32 / 48 / 128 px.
```

## Development

Plain JS, CSS, and HTML. No bundler, no dependencies, no install step.

```bash
npm test       # 25 tests, ~0.1s (node --test)
npm run check  # syntax-check every script
npm run build  # zip the runtime files into dist/ for the Web Store
```

`core.js` holds the bug-prone, safety-relevant code on purpose: the never-click-Pay button
classifier, the apply-result classifier, the currency parser, and the ranking, early-exit and
dead-code math. It runs in both a content script and Node (it assigns `globalThis.CHCore`), which
is what lets the tests import it without a browser. If you change any of that logic, add a case to
`tests/`.

The apply loop in `content.js` and the fan-out in `background.js` are not covered by the test
suite — they need a real page and a real network, so changes there have to be checked by loading
the extension unpacked and running a checkout.

## Contributing

PRs welcome. The two most useful contributions are adding a coupon source in `sources.js` and fixing checkout selectors in `content.js` for a store that gets missed. Details in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) — use it in anything, including commercially; keep the copyright notice with it.
