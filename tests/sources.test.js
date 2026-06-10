import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlausibleCode, extractCodesFromHtml, parseDiscountHint, dedupeWithConsensus } from "../sources.js";
import * as C2 from "../sources.js";

test("isPlausibleCode rejects numeric IDs and UI words", () => {
  for (const c of ["16580828", "123", "00000000", "COUPON", "PROMO", "FREE", "abc"]) {
    assert.equal(isPlausibleCode(c), false, c);
  }
  for (const c of ["WELCOME10", "SAVE20", "IBEROSTAR", "FREESHIP", "TEAK10"]) {
    assert.equal(isPlausibleCode(c), true, c);
  }
});

test("extractCodesFromHtml pulls codes from attributes + tags, drops numeric IDs", () => {
  const html = `
    <button data-clipboard-text="SAVE20">Show code</button>
    <code class="coupon-code">WELCOME10</code>
    <span class="promo">HOLIDAY25</span>
    <div data-coupon-code="16580828">offer</div>`;
  const result = extractCodesFromHtml(html, "TestSource");
  const codes = result.map((c) => c.code).sort();
  assert.ok(codes.includes("SAVE20"), "SAVE20 from data-clipboard-text");
  assert.ok(codes.includes("WELCOME10"), "WELCOME10 from <code>");
  assert.ok(codes.includes("HOLIDAY25"), "HOLIDAY25 from promo span");
  assert.ok(!codes.includes("16580828"), "numeric offer id rejected");
  for (const c of result) assert.equal(c.source, "TestSource");
});

test("extractCodesFromHtml returns [] for empty/garbage input", () => {
  assert.deepEqual(extractCodesFromHtml("", "X"), []);
  assert.deepEqual(extractCodesFromHtml(null, "X"), []);
  assert.deepEqual(extractCodesFromHtml("<p>no codes here</p>", "X"), []);
});

test("parseDiscountHint reads %, $ off, and free shipping", () => {
  assert.equal(parseDiscountHint("30% OFF everything").pct, 30);
  assert.equal(parseDiscountHint("Get $15 off your order").amount, 15);
  assert.equal(parseDiscountHint("Save $50 today").amount, 50);
  assert.equal(parseDiscountHint("Free shipping on all orders").freeShip, true);
  assert.equal(parseDiscountHint("just some text").pct, undefined);
  assert.deepEqual(parseDiscountHint(""), {});
});

test("extractCodesFromHtml attaches the advertised discount near the code", () => {
  const html = `
    <div class="card"><h3>30% OFF sitewide</h3>
      <button data-clipboard-text="BLACKFRIDAY">Show code</button></div>
    <div class="card"><h3>$20 off orders over $100</h3>
      <code class="coupon-code">TWENTYBUCKS</code></div>`;
  const byCode = Object.fromEntries(
    extractCodesFromHtml(html, "T").map((c) => [c.code, c])
  );
  assert.equal(byCode.BLACKFRIDAY.pct, 30);
  assert.equal(byCode.TWENTYBUCKS.amount, 20);
});

test("dedupeWithConsensus counts independent sources and sorts by them", () => {
  const flat = [
    { code: "SAVE10", source: "CouponFollow" },
    { code: "SAVE10", source: "RetailMeNot" },
    { code: "SAVE10", source: "Wethrift", pct: 10 },
    { code: "LONELY", source: "Knoji" },
    { code: "GUESS20", source: "Common/Hidden", generated: true }, // no consensus
    { code: "SAVE10", source: "Common/Hidden", generated: true }, // doesn't count
  ];
  const out = C2.dedupeWithConsensus(flat);
  const byCode = Object.fromEntries(out.map((c) => [c.code, c]));
  assert.equal(byCode.SAVE10.sourceCount, 3); // 3 real sites, guess ignored
  assert.equal(byCode.SAVE10.pct, 10); // discount filled in from whichever had it
  assert.equal(byCode.LONELY.sourceCount, 1);
  assert.equal(byCode.GUESS20.sourceCount, 0); // generated source never counts
  assert.equal(out[0].code, "SAVE10"); // most-corroborated first
});
