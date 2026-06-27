# Chrome Web Store listing

Copy/paste fields for the developer dashboard. Keep within the noted limits.

---

## Title (max 45 chars)

```
Coupon Hunter: Auto Coupons & Savings
```

## Summary / short description (max 132 chars)

```
Automatically finds & applies the best working coupon code at checkout on any store. Free, open source, no sign-up.
```

## Category

Shopping

## Language

English (United States)

---

## Detailed description

```
Stop paying full price by accident. Coupon Hunter finds working coupon codes and applies them for you at checkout — automatically.

The moment you reach the payment page on a store, Coupon Hunter spots the promo-code box, searches the web for codes that actually work for that specific shop, tries them one by one, and keeps whichever saves you the most. You just watch the total drop.

It's completely free, has no ads, needs no account, and is open source — so anyone can read exactly what it does.

WHAT YOU GET
• Automatic at checkout — nothing to press. It runs the second a discount box appears.
• Real codes for the real store — checks 20+ coupon databases plus codes the store advertises on its own page. It even works behind hosted checkouts like Shop Pay and Stripe by figuring out which store you're actually buying from, so you never get some other shop's codes.
• Keeps the best one — tries each code, watches your order total, and applies the biggest discount.
• Your savings, tracked — see how much you've saved over time, right in the popup.
• You stay in control — pause it on any site, or switch it off entirely, anytime.

PRIVACY FIRST
Coupon Hunter has no servers of its own. It doesn't track you, doesn't make you sign in, and never sends your cart, payment details, or browsing history anywhere. Coupon lookups are ordinary requests to public coupon sites for the store you're on — nothing else. Because it's open source, you can verify all of this yourself.

SAFE BY DESIGN
Auto-apply only ever clicks buttons that apply a coupon. It will never click "Place Order", "Pay", or anything that completes a purchase.

Free forever. Open source (MIT). Built so everyone can save money.

Source code & issues: https://github.com/Xer0z-gh/coupon-hunter
```

---

## Single purpose (required)

```
Coupon Hunter has one purpose: to find working coupon codes for the store a user is checking out on and apply them to lower the order total.
```

## Permission justifications (required for review)

- **storage** — Save the user's settings and their local lifetime-savings total.
- **scripting** — Apply the chosen coupon on the checkout page the user is viewing (the popup's "Apply" button runs the apply routine in the active tab).
- **tabs** — Read the current tab's domain to look up coupons relevant to that store, and stream hunt progress back to the on-page card.
- **host access (`<all_urls>`)** — Coupon fields can appear on any online store, so the extension must be able to run on any checkout. It only takes action when a coupon field is actually present, and the user can pause it per-site.
- **notifications** — Let the user know when a coupon saved them money.

## Data use disclosures (privacy tab)

Select **does NOT** for every category. Coupon Hunter:
- does not collect or transmit personally identifiable information,
- does not collect financial/payment information,
- does not collect health, authentication, personal communications, location, web history, or user activity,
- does not sell or transfer data to third parties,
- does not use data for purposes unrelated to its single purpose,
- does not use data for creditworthiness/lending.

All data (savings, settings, cache) stays on the user's device. Privacy policy:
`PRIVACY.md` in the repo (host it as a public URL and paste the link in the
dashboard's Privacy policy field).

---

## Assets checklist

Required:
- [x] Store icon 128×128 (`icons/icon128.png`)
- [ ] At least 1 screenshot — 1280×800 (preferred) or 640×400, PNG/JPEG

Recommended screenshots to capture:
1. The on-page card mid-run on a real checkout (stats header + codes list).
2. The popup savings dashboard ("$XX saved · N coupons · M stores").
3. The welcome page.

Optional promo images:
- [ ] Small promo tile 440×280
- [ ] Marquee 1400×560

## URLs

- Homepage / support: `https://github.com/Xer0z-gh/coupon-hunter`
- Privacy policy: host `PRIVACY.md` (e.g. GitHub raw or Pages) and link it.

## Upload package

Run `npm run build` → upload `dist/coupon-hunter-v<version>.zip`.
