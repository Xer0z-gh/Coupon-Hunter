# Contributing to Coupon Hunter

Thanks for helping more people save money. This is a small, dependency-free
MV3 extension — easy to hack on.

## Run it locally

1. Clone the repo.
2. Open `chrome://extensions` (works in Chrome, Edge, Brave, Arc, Opera).
3. Turn on **Developer mode**, click **Load unpacked**, pick this folder.
4. After any edit, hit the **reload** ↻ on the extension card.

There's no build step — it's plain JS/CSS/HTML. `npm`/bundlers are not required.

## Project layout

```
manifest.json   MV3 manifest
core.js         Shared pure logic (domain/POS, code validation, button &
                result classifiers, savings math) — no DOM, fully unit-tested
background.js   Service worker: hunt orchestration, savings ledger, settings
sources.js      Per-site coupon adapters (the 20 databases) + extractors
content.js      On-page card, merchant resolution, auto-apply loop (uses core.js)
content.css     Card styles
popup.* / welcome.*   Toolbar popup + first-run page
tests/          Node test suite (run with `npm test`)
```

`core.js` holds the bug-prone, security-relevant logic so it can be tested in
isolation and shared by the content script. Put new pure helpers there.

## Good first contributions

- **Add a coupon source.** Drop a `from<Name>(domain)` function in `sources.js`
  using `fetchText` + `extractCodesFromHtml`, then add it to `ADAPTERS`.
- **Fix a store we miss.** If a checkout's coupon box or order total isn't
  detected, extend `COUPON_INPUT_SELECTORS` / `TOTAL_SELECTORS` in `content.js`.
- **Improve detection.** The success/invalid/rate-limit phrase matchers and the
  `parseMoney` currency parser live in `core.js` (`classifyResultText`,
  `RE_SUCCESS`, `RE_INVALID`, `RE_RATELIMIT`) — add cases + a test in `tests/`.
- **Support another language.** Add the local word for "coupon" to
  `COUPON_TERMS` in `content.js` so the field is detected in that locale.
- **New POS/checkout host.** Add it to `POS_HOSTS` so the real merchant is
  resolved instead of the processor.

## Ground rules

- **Never** click anything that could place an order or pay. The apply loop has
  a hard `APPLY_DANGER` guard — keep it intact and extend it if you find a
  risky button label.
- Keep it **dependency-free** and **local-only** (see `PRIVACY.md`). No backends,
  no analytics, no remote code.
- Match the existing style; keep changes surgical.

## Sanity check before a PR

```
npm run check    # syntax-check every script
npm test         # run the unit tests in tests/
npm run build    # build the store zip — make sure it produces a valid package
```

Then load it unpacked and confirm a real checkout still gets a code applied.
