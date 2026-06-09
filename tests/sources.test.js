import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlausibleCode, extractCodesFromHtml } from "../sources.js";

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
