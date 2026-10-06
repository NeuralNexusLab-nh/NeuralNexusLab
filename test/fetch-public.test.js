const { test } = require("node:test");
const assert = require("node:assert/strict");
const dns = require("node:dns/promises");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const zlib = require("node:zlib");
const { fetchPublic } = require("../lib/fetch-public");

function mockWeb(t, pages, hosts = {}) {
  const requests = [];
  t.mock.method(dns, "lookup", async (hostname) => {
    return hosts[hostname] || [{ address: "93.184.216.34", family: 4 }];
  });
  t.mock.method(http, "get", (url, options, callback) => {
    requests.push({ url: url.href, options });
    const page = pages[url.href];
    assert.ok(page, "Unexpected network request: " + url.href);
    const request = new EventEmitter();
    const response = Readable.from(page.chunks || [page.body || Buffer.alloc(0)]);
    response.statusCode = page.status || 200;
    response.headers = page.headers || {};
    queueMicrotask(() => callback(response));
    return request;
  });
  return requests;
}

test("rejects invalid URLs and private/reserved IPv4 and IPv6 targets before connecting", async (t) => {
  const requests = mockWeb(t, {});
  for (const url of [
    "http://127.0.0.1/", "http://10.1.2.3/", "http://172.16.0.1/",
    "http://192.168.0.1/", "http://169.254.169.254/", "http://100.64.0.1/",
    "http://0.0.0.0/", "http://2130706433/", "http://0x7f000001/",
    "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fc00::1]/",
    "http://[fe80::1]/", "http://[2001:db8::1]/", "http://example.test:8080/"
  ]) {
    await assert.rejects(fetchPublic(url), { status: 403 }, url);
  }
  for (const url of [undefined, ["http://example.test/"], "not a URL", "file:///tmp/a", "ftp://example.test/", "https://user:password@example.test/"]) {
    await assert.rejects(fetchPublic(url), { status: 400 });
  }
  assert.equal(requests.length, 0);
});

test("pins validated DNS addresses and returns JSON with the upstream HTTP status", async (t) => {
  const requests = mockWeb(t, {
    "http://example.test/data": {
      status: 404,
      headers: { "content-type": "application/json", "set-cookie": "external=secret" },
      body: Buffer.from('{"message":"Not found"}')
    }
  });
  const result = await fetchPublic("http://example.test/data");
  assert.equal(result.status, 404);
  assert.equal(result.contentType, "application/json");
  assert.deepEqual(JSON.parse(result.body), { message: "Not found" });
  assert.equal(result.headers, undefined);
  assert.equal(requests[0].options.headers.Cookie, undefined);
  assert.equal(requests[0].options.agent, false);
  requests[0].options.lookup("example.test", { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
  });
});

test("rejects DNS answers containing any private address, including mixed public/private answers", async (t) => {
  const requests = mockWeb(t, {}, {
    "mixed.test": [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ]
  });
  await assert.rejects(fetchPublic("http://mixed.test/"), { status: 403 });
  assert.equal(requests.length, 0);
});

test("resolves relative redirects and returns external HTML as non-executable text", async (t) => {
  const requests = mockWeb(t, {
    "http://example.test/start": { status: 302, headers: { location: "/end" } },
    "http://example.test/end": {
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from("<script>bad()</script><h1>Page</h1>")
    }
  });
  const result = await fetchPublic("http://example.test/start");
  assert.equal(result.contentType, "text/plain; charset=utf-8");
  assert.equal(result.body.toString(), "<script>bad()</script><h1>Page</h1>");
  assert.equal(requests.length, 2);
});

test("blocks a public redirect into a private network", async (t) => {
  const requests = mockWeb(t, {
    "http://example.test/": { status: 302, headers: { location: "http://internal.test/" } }
  }, { "internal.test": [{ address: "10.0.0.1", family: 4 }] });
  await assert.rejects(fetchPublic("http://example.test/"), { status: 403 });
  assert.equal(requests.length, 1);
});

test("limits redirect loops", async (t) => {
  const requests = mockWeb(t, {
    "http://example.test/": { status: 302, headers: { location: "/" } }
  });
  await assert.rejects(fetchPublic("http://example.test/"), { status: 502 });
  assert.equal(requests.length, 4);
});

test("decodes compressed JSON and limits both ordinary and decompressed response sizes", async (t) => {
  const oversize = Buffer.alloc(2 * 1024 * 1024 + 1, "a");
  mockWeb(t, {
    "http://example.test/json": {
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: zlib.gzipSync('{"ok":true}')
    },
    "http://example.test/large": { chunks: [oversize] },
    "http://example.test/bomb": {
      headers: { "content-encoding": "gzip" }, body: zlib.gzipSync(oversize)
    },
    "http://example.test/length": { headers: { "content-length": String(oversize.length) } }
  });
  const result = await fetchPublic("http://example.test/json");
  assert.deepEqual(JSON.parse(result.body), { ok: true });
  for (const name of ["large", "bomb", "length"]) {
    await assert.rejects(fetchPublic("http://example.test/" + name), { status: 413 });
  }
});
