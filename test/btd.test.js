import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GIFT_CODE, PARTY_DURATION } from "../assets/btd.js";

const page = readFileSync(new URL("../btd.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../assets/btd.css", import.meta.url), "utf8");
const source = readFileSync(new URL("../assets/btd.js", import.meta.url), "utf8");

test("birthday gift preserves the exact supplied code and stays off search indexes", () => {
  assert.equal(GIFT_CODE, "ELBILLUG");
  assert.doesNotMatch(page, /ELBILLUG|<code\b/);
  assert.match(page, /競爭者/);
  assert.match(page, /name="robots" content="noindex, nofollow"/);
  assert.match(page, /生日快樂/);
  assert.match(page, /noscript/);
});

test("birthday animations are brief, optional, and stop when the page is hidden", () => {
  assert.ok(PARTY_DURATION < 6000);
  assert.match(source, /elapsed >= PARTY_DURATION/);
  assert.match(source, /cancelAnimationFrame/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /infinite/);
});

test("the gift opens only on request, and never renders or announces the code", () => {
  assert.match(page, /許個願吧/);
  assert.match(page, /許好願了，打開禮物/);
  assert.match(page, /id="gift"[^>]* hidden/);
  assert.doesNotMatch(source, /REVEAL_DELAY|revealTimer|setTimeout\(reveal/);
  assert.match(source, /getElementById\("open-gift"\).addEventListener\("click", \(\) => reveal\(\)\)/);
  assert.doesNotMatch(source.split("\n").filter(line => /textContent|aria-label/.test(line)).join("\n"), /ELBILLUG|GIFT_CODE/);
});

test("birthday page is dependency-free and compatible with existing security headers", () => {
  assert.match(page, /src="\/assets\/btd.js"/);
  assert.match(page, /href="\/assets\/btd.css"/);
  assert.doesNotMatch(page, /\son\w+=|\sstyle=|<script\b[^>]*>\s*\S[\s\S]*?<\/script>/i);
  assert.doesNotMatch(page + source, /https?:\/\/[^"]*(?:api|cdn)|fetch\(|localStorage|sessionStorage|alert\(/);
  assert.doesNotMatch(page, /unsafe-inline|unsafe-eval/);
  assert.match(source, /clipboard.writeText\(GIFT_CODE\)/);
  assert.match(source, /textarea.value = GIFT_CODE/);
  assert.match(page, /role="status" aria-live="polite"/);
  assert.match(css, /:focus-visible/);
});
