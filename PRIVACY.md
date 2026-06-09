# Privacy Policy — Coupon Hunter

_Last updated: 2026-06-09_

Coupon Hunter is a free, open-source browser extension. Your privacy is the
default, not a setting.

## The short version

- **No accounts. No tracking. No analytics. No ads.**
- **Nothing about you leaves your browser** except anonymous requests to public
  coupon websites for the store you're actively shopping on.
- Everything the extension remembers (your savings total, settings, cached
  codes) is stored **locally in your own browser** via the standard extension
  storage APIs.

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
- It has **no backend** owned by the project — there is no server collecting
  anything. The only network requests are to the public coupon sites listed in
  `sources.js`.

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
