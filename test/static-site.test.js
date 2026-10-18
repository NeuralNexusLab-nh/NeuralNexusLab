const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, existsSync, readdirSync } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const publicDirectory = root;
const html = readFileSync(path.join(publicDirectory, "index.html"), "utf8").replace(/\r\n?/g, "\n");
const headers = readFileSync(path.join(publicDirectory, "_headers"), "utf8");
const activeHtml = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<template\b[^>]*>[\s\S]*?<\/template>/g, "");

test("production is static with no server, npm manifest, API implementation or ASCII data", () => {
  for (const file of [
    "server.js", "package.json", "package-lock.json", ".env.example",
    "lib/ascii.js", "lib/fetch-public.js", "lib/security-headers.js",
    "scripts/convert-ascii.js", "data/ascii/badapple.json.gz"
  ]) assert.equal(existsSync(path.join(root, file)), false, file);
  assert.ok(existsSync(path.join(publicDirectory, ".nojekyll")));
  assert.equal(readFileSync(path.join(publicDirectory, "CNAME"), "utf8").trim(), "nxlabtw.com");
  const workflow = readFileSync(path.join(root, ".github/workflows/pages.yml"), "utf8");
  assert.match(workflow, /path: \./);
  assert.doesNotMatch(workflow, /path: public/);
  assert.equal(existsSync(path.join(root, "public", "index.html")), false);
  assert.doesNotMatch(workflow, /npm|server\.js|setup-node/);
});

test("local homepage images, scripts and stylesheets exist in the publish directory", () => {
  const tags = html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/gi);
  for (const [, url] of tags) {
    if (!url.startsWith("/") || url.startsWith("//")) continue;
    assert.ok(existsSync(path.join(publicDirectory, url.split(/[?#]/)[0])), url);
  }
  assert.doesNotMatch(html, /(?:fetch\(|href=|src=)[^\n]*(?:\/api\/|\/ascii\/|\/ipinfo)/);
  assert.equal((activeHtml.match(/class="project" /g) || []).length, 2);
});

test("meta CSP and static host headers authorize the exact unchanged inline blocks", () => {
  const policy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(policy);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|upgrade-insecure-requests|frame-ancestors/);
  for (const file of readdirSync(publicDirectory).filter(name => name.endsWith(".html"))) {
    const source = readFileSync(path.join(publicDirectory, file), "utf8").replace(/\r\n?/g, "\n");
    for (const tag of ["script", "style"]) {
      const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");
      for (const [, body] of source.matchAll(pattern)) {
        if (!body.trim()) continue;
        const hash = "'sha256-" + createHash("sha256").update(body).digest("base64") + "'";
        assert.ok(policy.includes(hash), file + " " + tag);
        assert.ok(headers.includes(hash), "host header " + file + " " + tag);
      }
    }
  }
  assert.match(headers, /frame-ancestors 'none'/);
  for (const name of ["Strict-Transport-Security", "X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy"]) {
    assert.ok(headers.includes(name + ":"), name);
  }
});

test("paused projects and Onion entry points are inert but retain their source for restoration", () => {
  for (const id of ["paused-astranote", "paused-nexacaptcha", "paused-onion-navigation"]) {
    assert.ok(html.includes(`<template id="${id}">`));
  }
  const activeLinks = [...activeHtml.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map(([, href]) => href);
  assert.ok(activeLinks.every(href => !/(?:astranote\.|nexacaptcha\.|\.onion)/.test(href)));
  assert.doesNotMatch(activeHtml, /<meta\b[^>]*http-equiv="onion-location"/);
  assert.doesNotMatch(headers.split(/\r?\n/).filter(line => !line.trimStart().startsWith("#")).join("\n"), /Onion-Location:/i);
  const llms = readFileSync(path.join(root, "llms.txt"), "utf8");
  assert.doesNotMatch(llms, /astranote|nexacaptcha|\.onion/i);
  assert.match(llms, /neutron\.nxlabtw\.com/);
  assert.match(llms, /NeuralNexusLab-nh\/Browzen/);
});

test("paused Onion logic keeps clearnet links and hides the Dark Web badge on both hostnames", () => {
  const source = html.match(/const onionEnabled = false;[\s\S]*?(?=\s*function normalizeLanguage)/)?.[0];
  assert.ok(source);
  for (const hostname of ["nxlabtw.com", "nxlabtwhcegzi5f65qb6ri4iv72rtdp5q7s4w457pahcohtmegjregqd.onion"]) {
    const classes = new Map();
    const link = { dataset: { clearnetHref: "https://neutron.nxlabtw.com", onionHref: "http://neutron.example.onion/" } };
    vm.runInNewContext(source, {
      location: { hostname },
      document: {
        documentElement: { classList: { toggle(name, value) { classes.set(name, value); } } },
        querySelectorAll: () => [link]
      }
    });
    assert.equal(classes.get("is-onion"), false);
    assert.equal(link.href, "https://neutron.nxlabtw.com");
  }
});

test("SEO and both donation assets remain available without a backend", () => {
  assert.match(html, /<meta name="referrer" content="strict-origin-when-cross-origin">/);
  assert.ok(html.includes('data-onion-href="http://astranote.'));
  assert.ok(html.includes('data-onion-href="http://neutron.'));
  assert.ok(html.includes('data-onion-href="http://nexacaptcha.'));
  assert.ok(html.includes('id="bitcoin-qr"'));
  assert.ok(html.includes('id="monero-qr"'));
  assert.ok(html.includes('data-i18n="donateMoneroOpenUri"'));
  for (const file of ["robots.txt", "sitemap.xml", "llms.txt"]) {
    assert.ok(readFileSync(path.join(publicDirectory, file), "utf8").includes("nxlabtw.com"));
  }
});
