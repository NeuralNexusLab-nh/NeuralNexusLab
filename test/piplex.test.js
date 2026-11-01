import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { MAX_BYTES, LANGUAGES, utf8Length, decodeEntities, translateSegment } from "../assets/piplex.js";

const page = readFileSync(new URL("../piplex.html", import.meta.url), "utf8");
const source = readFileSync(new URL("../assets/piplex.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../assets/piplex.css", import.meta.url), "utf8");

test("PiPlex is a standalone static page with English to Traditional Chinese defaults", () => {
  assert.match(page, /<select id="source-language"[^>]*><option value="en">/);
  assert.match(page, /<select id="target-language"[^>]*><option value="zh-TW">/);
  assert.match(page, /https:\/\/nxlabtw\.com\/piplex\.html/);
  assert.match(page, /<html lang="en">/);
  for (const id of ["left-text", "right-text"]) {
    const textarea = page.match(new RegExp(`<textarea id="${id}"[^>]*>`))?.[0];
    assert.ok(textarea);
    assert.doesNotMatch(textarea, /readonly|disabled/);
    assert.match(textarea, /dir="auto"/);
  }
  assert.match(page, /Text is sent to MyMemory/);
  assert.match(page, /Avoid sensitive information/);
  assert.doesNotMatch(page, /<input[^>]+id="auto-translate"[^>]+checked/);
});

test("PiPlex keeps a minimal dark workspace and an entirely English interface", () => {
  assert.match(css, /color-scheme: dark/);
  assert.match(css, /--background: #0c0e13/);
  assert.match(page, /<h1>Translate<\/h1>/);
  assert.doesNotMatch(page, /introduction|language-art|details-strip|data-example/);
  assert.doesNotMatch(page + source, /[\u3400-\u9fff]/);
  assert.equal(LANGUAGES.find(([code]) => code === "zh-TW")[1], "Traditional Chinese");
  assert.match(source, /index === active \? "Source" : "Translation"/);
  assert.match(source, /copied \? "Copied" : "Select text to copy"/);
});

test("all 33 original languages are retained without duplicate codes", () => {
  assert.equal(LANGUAGES.length, 33);
  assert.equal(new Set(LANGUAGES.map(([code]) => code)).size, 33);
  for (const code of ["en", "zh-TW", "zh-CN", "ja", "ar", "he", "no", "vi"]) {
    assert.ok(LANGUAGES.some(([value]) => value === code));
  }
});

test("request limit is measured in UTF-8 bytes, not JavaScript string length", () => {
  assert.equal(MAX_BYTES, 500);
  assert.equal(utf8Length("a".repeat(500)), 500);
  assert.equal(utf8Length("中".repeat(166)), 498);
  assert.equal(utf8Length("中".repeat(167)), 501);
  assert.equal(utf8Length("🌍"), 4);
});

test("translation uses the original MyMemory GET API and preserves requested direction", async () => {
  for (const [source, target, text] of [["en", "zh-TW", "Hello & welcome!"], ["zh-TW", "en", "你好，世界！"]]) {
    let request;
    const translated = await translateSegment(text, source, target, {
      fetchImpl: async (url, options) => {
        request = { url: new URL(url), options };
        return new Response(JSON.stringify({ responseStatus: 200, responseData: { translatedText: "A &amp; B" } }));
      }
    });
    assert.equal(translated, "A & B");
    assert.equal(request.url.origin, "https://api.mymemory.translated.net");
    assert.equal(request.url.pathname, "/get");
    assert.equal(request.url.searchParams.get("q"), text);
    assert.equal(request.url.searchParams.get("langpair"), `${source}|${target}`);
    assert.equal(request.url.searchParams.size, 2);
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.cache, "no-store");
    assert.equal(request.options.referrerPolicy, "no-referrer");
  }
});

test("empty text and same-language translations do not spend API requests", async () => {
  const fetchImpl = () => { throw new Error("Unexpected network request"); };
  assert.equal(await translateSegment("   ", "en", "zh-TW", { fetchImpl }), "");
  assert.equal(await translateSegment("Hello!", "en", "en", { fetchImpl }), "Hello!");
});

test("oversized text and unsupported languages are rejected before any network call", async () => {
  const fetchImpl = () => { throw new Error("Unexpected network request"); };
  await assert.rejects(translateSegment("中".repeat(167), "zh-TW", "en", { fetchImpl }), { code: "limit" });
  await assert.rejects(translateSegment("Hello", "bogus", "en", { fetchImpl }), { code: "language" });
});

test("provider rate limits, provider errors and malformed responses never become translations", async () => {
  for (const payload of [
    { status: 429, body: "rate limited", code: "quota" },
    { status: 503, body: "provider down", code: "unavailable" },
    { status: 200, body: '{"responseStatus":429,"responseData":{"translatedText":"MYMEMORY WARNING"}}', code: "quota" },
    { status: 200, body: '{"responseStatus":200,"quotaFinished":true,"responseData":{"translatedText":"WARNING"}}', code: "quota" },
    { status: 200, body: '{"responseStatus":500}', code: "unavailable" },
    { status: 200, body: '{"responseStatus":403,"responseDetails":"Unsupported language"}', code: "unavailable" },
    { status: 200, body: '{"responseStatus":200,"responseData":{"translatedText":""}}', code: "unavailable" },
    { status: 200, body: "<html>not JSON</html>", code: "unavailable" },
    { status: 200, body: "null", code: "unavailable" }
  ]) {
    await assert.rejects(translateSegment("Hello", "en", "zh-TW", {
      fetchImpl: async () => new Response(payload.body, { status: payload.status })
    }), { code: payload.code });
  }
});

test("AbortSignal is forwarded so superseded translations can be cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(translateSegment("Hello", "en", "zh-TW", {
    signal: controller.signal,
    fetchImpl: async (_url, { signal }) => { assert.equal(signal, controller.signal); signal.throwIfAborted(); }
  }), { name: "AbortError" });
});

test("entity decoding returns text only and safely handles invalid numeric code points", () => {
  assert.equal(decodeEntities("Tom&#39;s &quot;idea&quot; &amp; &#x4e2d;"), 'Tom\'s "idea" & 中');
  assert.equal(decodeEntities("&lt;img src=x onerror=alert(1)&gt;"), "<img src=x onerror=alert(1)>");
  assert.equal(decodeEntities("&#x110000; &#0; &#xD800;"), "&#x110000; &#0; &#xD800;");
  assert.doesNotMatch(source, /innerHTML|DOMParser|localStorage|sessionStorage|eval\(/);
});

test("PiPlex respects the existing CSP with only local external application assets", () => {
  assert.doesNotMatch(page, /\son\w+=|\sstyle=|<script\b[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i);
  assert.doesNotMatch(page, /unsafe-inline|unsafe-eval/);
  assert.match(page, /script-src 'self'/);
  for (const file of ["assets/piplex.js", "assets/piplex.css", "assets/nx-logo-imagegen-final.png"]) {
    assert.ok(page.includes(file));
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)));
  }
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible/);
  assert.match(readFileSync(new URL("../sitemap.xml", import.meta.url), "utf8"), /https:\/\/nxlabtw\.com\/piplex\.html/);
});
