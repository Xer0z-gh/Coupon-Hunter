import { test } from "node:test";
import assert from "node:assert/strict";
import "../core.js"; // side-effect: sets globalThis.CHCore

const C = globalThis.CHCore;

test("rootDomainOf normalizes hosts and ccTLDs", () => {
  assert.equal(C.rootDomainOf("www.teaktuning.com"), "teaktuning.com");
  assert.equal(C.rootDomainOf("TEAKTUNING.com"), "teaktuning.com");
  assert.equal(C.rootDomainOf("a.b.example.com"), "example.com");
  assert.equal(C.rootDomainOf("shop.co.uk"), "shop.co.uk");
  assert.equal(C.rootDomainOf("cart.shop.co.uk"), "shop.co.uk");
  assert.equal(C.rootDomainOf("shop.app"), "shop.app");
  assert.equal(C.rootDomainOf(""), "");
});

test("isPOS detects processors incl. subdomains", () => {
  for (const h of ["shop.app", "checkout.stripe.com", "www.paypal.com", "sub.myshopify.com", "klarna.com"]) {
    assert.equal(C.isPOS(h), true, h);
  }
  for (const h of ["teaktuning.com", "example.com", "joycult.com", ""]) {
    assert.equal(C.isPOS(h), false, h);
  }
});

test("guessMerchantFromHtml picks the real store, not infra/POS", () => {
  const html = `
    <a href="https://teaktuning.com/cart">cart</a>
    <a href="https://teaktuning.com/policies/refund">refund</a>
    <script src="https://www.googletagmanager.com/gtm.js"></script>
    <img src="https://cdn.shopify.com/s/files/a.png">`;
  assert.equal(C.guessMerchantFromHtml(html), "teaktuning.com");
  // single mention isn't trusted
  assert.equal(C.guessMerchantFromHtml(`<a href="https://teaktuning.com">x</a>`), null);
  // only POS/infra domains -> can't attribute
  assert.equal(
    C.guessMerchantFromHtml(`<a href="https://shop.app/a">a</a><a href="https://shop.app/b">b</a>`),
    null
  );
});

test("isGoodCode accepts real codes, rejects junk", () => {
  const good = ["WELCOME10", "SAVE20", "FINGER15", "IBEROSTAR", "FREESHIP", "TEAK10", "HOLIDAY25", "THEQUEEN"];
  const bad = ["16580828", "123", "00000000", "AAAA", "FREE", "CODE", "APPLY", "SHIPPING", "ABC", "ABCD", "toolongcouponcode1234", "with space"];
  for (const c of good) assert.equal(C.isGoodCode(c), true, c);
  for (const c of bad) assert.equal(C.isGoodCode(c), false, c);
});

test("mergeCodes dedupes, drops generated + junk, keeps on-page flags", () => {
  const merged = C.mergeCodes(
    [{ code: "WELCOME10", onPage: true }],
    [
      { code: "welcome10", source: "DB" }, // dup (case)
      { code: "SAVE5", generated: true }, // guess -> dropped
      { code: "16580828", source: "DB" }, // junk -> dropped
      { code: "BIG20", source: "DB" },
    ]
  );
  assert.deepEqual(merged.map((c) => c.code).sort(), ["BIG20", "WELCOME10"]);
  assert.equal(merged.find((c) => c.code === "WELCOME10").onPage, true);
});

test("classifyButtonLabel: NEVER mislabels a pay/order button as apply", () => {
  const danger = [
    "Place Order", "Place your order", "Pay now", "Pay $42.99", "Buy now",
    "Complete order", "Submit order", "Review order", "Continue to payment",
    "Proceed to checkout", "Checkout", "Check out", "Complete purchase",
    "Next", "Continue", "Go to payment",
  ];
  for (const d of danger) assert.equal(C.classifyButtonLabel(d), "danger", d);

  const apply = [
    "Apply", "Apply Code", "Apply coupon", "Redeem", "Use code",
    "Add promo code", "Enter discount code", "APPLY", "Submit code", "Add coupon",
  ];
  for (const a of apply) assert.equal(C.classifyButtonLabel(a), "apply", a);

  assert.equal(C.classifyButtonLabel("Hello world"), "none");
  assert.equal(C.classifyButtonLabel(""), "none");
  assert.equal(C.classifyButtonLabel("x".repeat(50)), "none");
});

test("classifyResultText: success/invalid/ratelimit incl. curly apostrophes", () => {
  for (const s of ["Invalid coupon code", "That promo code is expired", "Coupon not found", "that code doesn’t exist", "this isn’t valid", "Code has expired"]) {
    assert.equal(C.classifyResultText(s), "invalid", s);
  }
  for (const s of ["Discount applied!", "Promo code successfully applied", "You saved $12.40", "Coupon added to your order"]) {
    assert.equal(C.classifyResultText(s), "success", s);
  }
  for (const s of ["Too many attempts, try again later", "Please wait before trying again", "temporarily locked"]) {
    assert.equal(C.classifyResultText(s), "ratelimit", s);
  }
  assert.equal(C.classifyResultText("Subtotal $40.00 Total $46.00"), "");
});

test("parseMoney handles symbols, commas, negatives", () => {
  assert.equal(C.parseMoney("$16.95"), 16.95);
  assert.equal(C.parseMoney("USD $1,234.50"), 1234.5);
  assert.equal(C.parseMoney("Total: 42"), 42);
  assert.equal(C.parseMoney("-$5.00"), 5);
  assert.equal(C.parseMoney("Free"), null);
  assert.equal(C.parseMoney(""), null);
});

test("potentialFromCode extracts discount, ignores years/IDs", () => {
  assert.equal(C.potentialFromCode("SAVE40"), 40);
  assert.equal(C.potentialFromCode("WELCOME10"), 10);
  assert.equal(C.potentialFromCode("FREESHIP"), 0);
  assert.equal(C.potentialFromCode("SUMMER2024"), 0);
  assert.equal(C.potentialFromCode("GET100"), 0);
  assert.equal(C.potentialFromCode("TAKE15OFF20"), 20);
});

test("ceilSavings bounds dollars: max(N%, $N) or free-ship cap", () => {
  assert.equal(C.ceilSavings("SAVE50", 100), 50);
  assert.equal(C.ceilSavings("SAVE50", 200), 100);
  assert.equal(C.ceilSavings("GET5", 1000), 50);
  assert.equal(C.ceilSavings("FREESHIP", 100), 30);
  assert.equal(C.ceilSavings("FREESHIP", 100, 10), 10);
});

test("scanCodesFromText finds advertised codes", () => {
  const t =
    "Limited time! Use code SUMMER20 at checkout to save. " +
    "Promo code: WELCOME10 for new users. Enter coupon code SAVE5 now.";
  const found = C.scanCodesFromText(t).map((c) => c.code).sort();
  assert.ok(found.includes("SUMMER20"), "SUMMER20");
  assert.ok(found.includes("WELCOME10"), "WELCOME10");
  assert.ok(found.includes("SAVE5"), "SAVE5");
  for (const c of C.scanCodesFromText(t)) assert.equal(c.onPage, true);
});
