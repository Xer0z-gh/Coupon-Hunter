# Privacy Policy — Coupon Hunter

_Last updated: 2026-06-27_

Coupon Hunter is a free, open-source browser extension. Your privacy is the
default, not a setting.

## The short version

- **No accounts. No tracking. No analytics. No ads.**
- Everything the extension remembers (your savings total, settings, cached
  codes) is stored **locally in your own browser**.
- The only data that ever leaves your browser is: (a) the **store's domain**
  when looking up coupons (the same thing happens with any coupon site), and
  (b) **only if you choose to**, a coupon code you explicitly share with the
  community, or anonymous "this code worked/didn't" feedback if you opt in.
- We never collect personal info, payment details, cart contents, or browsing
  history — ever.

## What the extension does on a page

When you reach a cart/checkout page that has a coupon field, Coupon Hunter:

1. Determines the **store domain** you're shopping on (for hosted checkouts like
   Shop Pay or Stripe, it resolves the real merchant from the page/referrer).
2. Fetches **public coupon-listing pages** for that store from third-party
   coupon sites (e.g. RetailMeNot, CouponFollow). These are ordinary,
   unauthenticated web requests — the same pages you could open yourself. Only
   the store's domain name is included.
3. Reads the current page to find coupon codes the store advertises and to type
   codes into the coupon box and read the order total.

## What it never does

- It never reads, stores, or transmits your **payment details, card numbers,
  addresses, or personal information**.
- It never sends your **browsing history, cart contents, or the pages you
  visit** to any server.

## The community collection (optional)

Coupon Hunter has an optional shared collection so codes that work for one
person can help everyone. It's anonymous and on your terms:

- **Looking up community codes** sends only the **store domain** to the Coupon
  Hunter API — exactly like a lookup to any other coupon site. No identity, no
  cart, no page contents.
- **Sharing a code** only happens when you tick "Share with the community" while
  adding a code. It sends `{ store domain, the code, optional discount }` — and
  nothing else.
- **Crowd success rate** ("worked for 87% of people") is built from anonymous
  "worked / didn't work" reports. This is **off by default**; it's only sent if
  you enable "Share which codes worked" in Settings. The report is
  `{ store domain, code, worked or failed }` — no identity attached.
- The API stores **no personal data** — only `(domain, code, discount, works,
  fails)`. The server code is open source under `worker/`.

If you never enable sharing and never tick the share box, the only thing that
leaves your browser is the domain lookups above.

## What's stored locally (and only locally)

- Your lifetime **savings total** and a short history of applied codes.
- Per-store records of which codes worked, to try the good ones first next time.
- A short-lived **cache** of fetched codes (cleared automatically; you can also
  clear it from the popup).
- Your **settings** (enabled/paused sites, auto toggles).

You can wipe all of it anytime by removing the extension, or use **Reset savings
counter** / **Clear cached codes** in the popup.

## Permissions, and why

- `storage` — save your savings/settings locally.
- `tabs` / `activeTab` / `scripting` — know which store you're on and run the
  coupon logic on the checkout page.
- `<all_urls>` host access — coupon boxes can appear on any store, so the
  extension has to be able to run on any site. It only acts when it detects a
  coupon field.
- `notifications` — tell you when a code saved you money.
- `alarms` — housekeeping for the code cache.

## Questions

This is an open-source project — read every line of what it does in the source,
or open an issue on the repository.
