# Coupon Hunter

**Free &amp; open source (MIT).** A Chromium browser extension that hunts the web
for working coupon codes and auto-applies the best one at checkout on any store —
so you never overpay. No accounts, no tracking, no paywall. Clean Apple /
Cal-AI-style UI.

> Built so everyone can save money. If it helps you, star the repo and tell a
> friend. Contributions (especially new coupon sources and store fixes) welcome —
> see [CONTRIBUTING.md](CONTRIBUTING.md).

- 🆓 100% free, forever · 🔓 open source · 🛡️ runs entirely in your browser
  ([privacy](PRIVACY.md)) · 🧾 [MIT licensed](LICENSE)

## Install (unpacked, Chrome/Edge/Brave/Arc/Opera)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select this folder: `Dev/JS/CouponHunter`.
5. Pin the icon (puzzle-piece menu → pin).

## What it does — fully automatic, zero clicks

Out of the box it runs by itself. You don't press anything:

1. Detects when you're on a cart/checkout page (sees a `coupon`, `promo`,
   `discount`, or `voucher` input field).
2. Fans out in parallel to **20 coupon databases**: CouponFollow, RetailMeNot,
   Coupons.com, Wethrift, Dealspotr, Slickdeals, HotDeals, CouponCabin,
   PromoCodes.com, CouponBirds, Knoji, DontPayFull, SimplyCodes, CouponChief,
   Groupon, Offers.com, Savings.com, Goodshop, CouponSherpa, and a Google
   fallback — **plus an on-page scan** that reads codes the store itself
   advertises in banners / popups ("use code SUMMER20 at checkout").
   **Only real coupons found for the exact store you're on are applied** —
   generic guesses (`WELCOME10`, `SAVE5`…) are never tried. If nothing turns up
   on the first pass it **keeps searching** (re-hunting with backoff) until
   codes for that specific site appear.
3. De-duplicates with **cross-source consensus** — it records how many
   independent coupon sites list each code (shown as `CouponFollow +3`), the
   strongest signal that a code is actually live. Junk is **dropped the moment
   it's scanned** (numeric offer-IDs, pure numbers, UI words). It then orders by
   **expected savings, biggest first**: proven past winners → the discount the
   listing *advertises* (`30% OFF … BLACKFRIDAY` is read as 30%, not 0 just
   because the code has no digits) → a digit guess (`SAVE40` → 40); ties broken
   by trust (on-page > listed DB) then by how many sites corroborate it. It
   works through them all in that order — the only thing that ends the run early
   is step 4 below.
   For each it types the code, clicks the coupon Apply button, and resolves the
   page gives a **definitive verdict** — the total drops, or the merchant shows
   "applied" / "invalid". It never reacts to a mid-processing flicker, and it
   **waits for the loading spinner to clear before typing the next code**, so it
   never stacks two codes into the field at once (~250ms polling, up to 3.5s
   per code — longer while still loading — and ~700ms between codes).
   It keeps the code that yields the **lowest total**, re-applies that winner,
   and clears the field if none worked.
4. **Provably-worse early exit** (the only time it stops short): once it's
   banked a discount bigger than the *most* any remaining code could yield, it
   stops. Each remaining code is bounded by treating its number as `N%`-of-cart
   or `$N` (whichever is larger), and no-number codes as a typical
   free-shipping value — so it only ever skips codes that genuinely can't win.
5. Pops a desktop notification when a code lands: *"Coupon applied! SAVE20
   saved you $12.40."*
6. Caches per-store for 1 hour and **revalidates in the background** after 20
   min, so codes stay fresh.

A clean Apple / Cal-AI-style card streams the progress in the corner — a stats
header (amount saved · working codes found) above a live list of codes — but you
never have to touch it. Codes are **typed in like a person would** (key by key,
with small irregular pauses) so it doesn't behave like an obvious bot.
Everything is opt-out in the popup settings if you'd rather drive manually.

### Third-party checkouts (Shop Pay, Stripe, PayPal, Klarna…)

When you check out on a hosted processor like **shop.app** or
**checkout.stripe.com**, the page's own domain is the *processor*, not the
store — hunting it returns another shop's junk. So the extension resolves the
**real merchant** behind the checkout (from the referrer, falling back to the
most-referenced store domain on the page) and only ever applies codes for
*that* store. If it genuinely can't tell which store the cart belongs to, it
**applies nothing** rather than risk the wrong shop's codes.

### Safety: it will never buy anything

Because it auto-clicks buttons without you, the apply loop has a hard guard: it
**refuses to click any button** whose label looks like *Place Order, Pay, Pay
Now, Buy Now, Purchase, Checkout, Complete/Submit/Review Order, Continue,
Proceed, Next,* or *Go to Payment*. It only clicks buttons that clearly apply a
coupon (*Apply, Redeem, Use code, Add promo code…*). The Enter-to-apply
fallback is likewise skipped whenever the coupon field shares a form with any
order/pay button. (26 button-label cases are unit-tested for this.)

## Track your savings &amp; stay in control

- **Lifetime savings dashboard** — the popup shows the total you've saved, the
  count of coupons applied, how many stores, and your **recent wins**
  (store · code · amount). Stored locally only.
- **Master on/off** and **"Pause on this site"** — full control over where it
  runs (it requests broad site access because coupon boxes can appear anywhere,
  but you decide where it's active).
- **First-run welcome page** explains what it does and the privacy stance.

## Power features

- **Keyboard shortcut** — `Ctrl/Cmd+Shift+U` finds &amp; applies the best coupon
  on the current page, no clicking required.
- **Works worldwide** — detects coupon fields in 9+ languages (German, French,
  Spanish, Portuguese, Italian, Dutch, Nordic…) and reads totals in **any
  currency / locale** (`€1.234,56`, `£49.99`, `¥1,980`, `R$ 1.299,90`).
- **Minimize to a pill** — collapse the card to a tiny corner pill; after a win
  it tucks itself away showing "✓ Saved $X".
- **Honest "best price" check** — if nothing beats your current total, it says
  so (no fake urgency, no dark patterns).
- **Survives extension reloads/updates** — open checkout tabs won't throw
  "context invalidated" errors; the script stops cleanly and tells you to reload.

## How it compares to Honey &amp; co.

| | Coupon Hunter | Typical coupon extension |
|---|---|---|
| Price | Free, open source (MIT) | Free, closed source |
| Business model | None — it just saves you money | Affiliate commissions / selling data |
| Your data | Never leaves your browser | Often tracks purchases &amp; browsing |
| Picks the **best** code | Yes — tries all, keeps the biggest, provably | Stops at the first that works |
| Hosted checkouts (Shop Pay/Stripe) | Resolves the real store | Often applies the wrong store's codes |
| Safety | Hard guard never clicks Pay/Place Order | — |

We deliberately **don't** do cashback, "Gold/points", or price-drop tracking —
those require an account, a server, and monetizing your shopping data. Staying
local and free is the point.

## UI surfaces

- **On-page card** (bottom-right): appears and runs on its own at checkout —
  a stats header (saved · working codes) over a live list, streaming progress.
  Close it anytime; the auto-apply still completes.
- **Popup** (click the toolbar icon): savings dashboard, manual hunt/apply
  override, found codes, and settings (enable / pause site / auto toggles).
  Press `Enter` to hunt, `Alt+Enter` to apply.

## Why "aggressive"?

The background worker hits every coupon source in parallel and keeps every
unique code it can extract — structural HTML extraction first, then a regex
fallback so layout changes don't kill the source. The apply loop then tries
every code in turn until one actually moves the order total.

## Known limits

- Coupon sites change their markup constantly. If a source goes quiet, the
  regex fallback usually still catches things; the worst case is fewer hits
  for that one source.
- Some sites block extension fetches with Cloudflare challenges — those return
  zero codes silently, the other 9 sources still run.
- The apply loop relies on the merchant's own coupon input + apply button.
  Most major checkouts (Shopify, BigCommerce, WooCommerce, Magento, custom)
  follow common patterns we detect; very bespoke checkouts may need manual
  copy-paste from the card.
- This isn't affiliate-monetized. It doesn't replace your referrals.

## File layout

```
CouponHunter/
├── manifest.json        MV3 manifest
├── core.js              Shared pure logic (tested in isolation, no DOM)
├── background.js        Service worker — hunts, savings ledger, settings/controls
├── sources.js           Per-site coupon adapters (fan-out + extractors)
├── content.js           In-page card + merchant resolution + auto-apply loop
├── content.css          Apple / Cal-AI-style card styles
├── popup.html/.css/.js  Toolbar popup (savings dashboard + settings)
├── welcome.html/.js     First-run onboarding page
├── tests/               Node unit tests (`npm test`)
├── package.ps1          Builds dist/coupon-hunter-vX.Y.Z.zip for the store
├── LICENSE              MIT
├── PRIVACY.md           Privacy policy
└── icons/               PNG icons (16/32/48/128)
```

## Tests

```
npm test          # node --test over tests/
npm run check     # syntax-check every script
```

The bug-prone, safety-critical logic (domain/POS resolution, code validation,
the "never click pay/order" button classifier, result detection, savings math)
lives in `core.js` and is covered by the unit tests.

## Build a release

```
powershell -ExecutionPolicy Bypass -File package.ps1
```

Produces `dist/coupon-hunter-v<version>.zip` containing only the runtime files —
ready to upload to the Chrome Web Store or share for unpacked install.

## Contributing

PRs welcome — this is for everyone. See [CONTRIBUTING.md](CONTRIBUTING.md). Most
valuable: new coupon sources in `sources.js`, and checkout selectors in
`content.js` for stores that get missed.

## License

[MIT](LICENSE) — free to use, modify, and share. Save money; help others do the
same.
