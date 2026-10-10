const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const bitcoin = "bc1qxxarjr2qxy3cxwes7enxwucpyvxd9m3k3gdz6y";
const monero = "48dSub3ZDxmTHC5snu499fDKwfct7vB4cPrnbjASgx45NdeLbT5kEQeDMU42ES6XQbJRaRUn8aayGibVJhG4npsDQCjTXKc";

function donationFixture({ clipboardFails = false } = {}) {
  const elements = new Map();
  const copies = [];
  const fallbacks = [];
  const payloads = [];
  const timers = [];
  const context = {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, {
          dataset: {}, textContent: "", innerHTML: "",
          querySelector: () => ({ setAttribute() {} }),
          addEventListener(type, handler) { this[type] = handler; }
        });
        return elements.get(id);
      }
    },
    navigator: { clipboard: { async writeText(value) {
      if (clipboardFails) throw new Error("Permission denied");
      copies.push(value);
    } } },
    qrcode(_version, level) {
      return {
        addData(uri, mode) { payloads.push({ uri, level, mode }); },
        make() {},
        createSvgTag: () => "<svg></svg>"
      };
    },
    fallbackCopyAddress(address) { fallbacks.push(address); return true; },
    translations: { en: { donateCopied: "Copied" } },
    currentLanguage: "en",
    setTimeout(handler, milliseconds) { timers.push({ handler, milliseconds }); return timers.length; },
    clearTimeout() {}
  };
  const source = html.match(/const donationAssets = \[[\s\S]*?(?=\s*const revealElements =)/)?.[0];
  assert.ok(source, "shared donation initializer exists");
  vm.runInNewContext(source, context);
  return { elements, copies, fallbacks, payloads, timers };
}

test("Monero address is complete in the visible field and amount-free wallet link", () => {
  assert.equal(monero.length, 95);
  assert.ok(html.includes(`id="monero-address" title="${monero}">${monero}</code>`));
  assert.ok(html.includes(`href="monero:${monero}" data-i18n="donateMoneroOpenUri"`));
  assert.ok(html.includes(`href="bitcoin:${bitcoin}"`), "Bitcoin wallet link is unchanged");
});

test("QR payloads are generated locally with exact, distinct Bitcoin and Monero URIs", () => {
  const fixture = donationFixture();
  assert.deepEqual(fixture.payloads, [
    { uri: `bitcoin:${bitcoin}`, level: "H", mode: "Byte" },
    { uri: `monero:${monero}`, level: "M", mode: "Byte" }
  ]);
  assert.equal(fixture.elements.get("monero-qr").innerHTML, "<svg></svg>");
});

test("copy controls preserve full case-sensitive addresses and independent feedback", async () => {
  const fixture = donationFixture();
  await fixture.elements.get("copy-monero").click();
  await fixture.elements.get("copy-bitcoin").click();
  assert.deepEqual(fixture.copies, [monero, bitcoin]);
  assert.equal(fixture.elements.get("monero-copy-feedback").textContent, "Copied");
  assert.equal(fixture.elements.get("copy-feedback").textContent, "Copied");
  assert.ok(fixture.timers.every(timer => timer.milliseconds === 1800));
  fixture.timers[0].handler();
  assert.equal(fixture.elements.get("monero-address-row").dataset.copied, "false");
  assert.equal(fixture.elements.get("bitcoin-address-row").dataset.copied, "true");
});

test("denied Clipboard API falls back using the complete Monero address", async () => {
  const fixture = donationFixture({ clipboardFails: true });
  await fixture.elements.get("copy-monero").click();
  assert.deepEqual(fixture.fallbacks, [monero]);
  assert.equal(fixture.elements.get("monero-address-row").dataset.copied, "true");
});
