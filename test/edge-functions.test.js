import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { onRequest as ipHandler } from "../edge-functions/ip.js";
import { onRequest as ipinfoHandler } from "../edge-functions/ipinfo.js";
import { onRequest as specificIpinfoHandler } from "../edge-functions/ipinfo/[ip].js";

function context({ ip = "203.0.113.42", method = "GET", token = "test-token" } = {}) {
  const request = new Request("https://nxlabtw.com/ipinfo", {
    method,
    headers: { "X-Forwarded-For": "1.1.1.1", "EO-Connecting-IP": "8.8.8.8" }
  });
  request.eo = { clientIp: ip };
  return { request, env: { TOKEN: token } };
}

function assertPrivateResponse(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
}

test("/ip returns the exact platform IPv4/IPv6 and ignores spoofable headers", async () => {
  for (const ip of ["203.0.113.42", "2001:db8::42"]) {
    const response = ipHandler(context({ ip }));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), ip);
    assert.match(response.headers.get("content-type"), /^text\/plain/);
    assertPrivateResponse(response);
  }
});

test("/ip never falls back to a caller-supplied IP when platform metadata is missing", async () => {
  const fixture = context();
  delete fixture.request.eo;
  const response = ipHandler(fixture);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Client IP unavailable");
  assertPrivateResponse(response);
});

test("both routes reject writes and support body-free HEAD requests without fetching", async t => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => { throw new Error("Must not fetch"); });
  for (const handler of [ipHandler, ipinfoHandler]) {
    const rejected = await handler(context({ method: "POST" }));
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get("allow"), "GET, HEAD");
    assertPrivateResponse(rejected);
    const head = await handler(context({ method: "HEAD" }));
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assertPrivateResponse(head);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("/ipinfo requires TOKEN and trusted visitor IP before making any request", async t => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => { throw new Error("Must not fetch"); });
  for (const token of ["", "   ", null]) {
    const response = await ipinfoHandler(context({ token }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "TOKEN is not configured" });
    assertPrivateResponse(response);
  }
  const missingEnv = context();
  delete missingEnv.env;
  assert.equal((await ipinfoHandler(missingEnv)).status, 503);
  const fixture = context();
  delete fixture.request.eo;
  const response = await ipinfoHandler(fixture);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Client IP unavailable" });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("/ipinfo sends the explicit visitor IPv4/IPv6 to IPinfo Lite with encoded credentials", async t => {
  const payload = { ip: "203.0.113.42", country: "Taiwan", country_code: "TW", asn: "AS1234" };
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload)));
  for (const ip of ["203.0.113.42", "2001:db8::42"]) {
    const response = await ipinfoHandler(context({ ip, token: "test&secret=+" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), payload);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assertPrivateResponse(response);
    const [url, options] = fetchMock.mock.calls.at(-1).arguments;
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.ipinfo.io");
    assert.equal(decodeURIComponent(parsed.pathname), `/lite/${ip}`);
    assert.equal(parsed.searchParams.get("token"), "test&secret=+");
    assert.equal([...parsed.searchParams].length, 1);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Accept, "application/json");
    assert.equal(options.headers["X-Forwarded-For"], undefined);
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test("/ipinfo preserves provider failure status but never relays error bodies or tokens", async t => {
  for (const status of [401, 403, 429, 500, 503]) {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("secret-provider-body", { status }));
    const response = await ipinfoHandler(context());
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: "IP information provider rejected the request" });
    assertPrivateResponse(response);
    fetchMock.mock.restore();
  }
});

test("/ipinfo handles network failures, invalid JSON and malformed provider data", async t => {
  const replies = [
    () => { throw new Error("request URL contains secret token"); },
    () => new Response("<html>not JSON</html>"),
    () => new Response("null"),
    () => new Response("[]"),
    () => new Response('{"country":"Taiwan"}')
  ];
  for (const reply of replies) {
    const fetchMock = t.mock.method(globalThis, "fetch", reply);
    const response = await ipinfoHandler(context());
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /secret|test-token|<html>/);
    assertPrivateResponse(response);
    fetchMock.mock.restore();
  }
});

test("/ipinfo aborts a stalled lookup after 8 seconds and always clears its timer", async t => {
  let abortLookup;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    assert.equal(delay, 8000);
    abortLookup = callback;
    return 123;
  });
  const clearMock = t.mock.method(globalThis, "clearTimeout", () => {});
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    abortLookup();
    assert.equal(signal.aborted, true);
    throw new Error("Aborted");
  });
  const response = await ipinfoHandler(context());
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "IP information request timed out" });
  assertPrivateResponse(response);
  assert.equal(clearMock.mock.calls[0].arguments[0], 123);
});

test("Edge handlers execute with Web APIs only, without Node, Express or npm globals", async () => {
  for (const file of ["ip.js", "ipinfo.js"]) {
    const source = readFileSync(new URL(`../edge-functions/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\b(?:require|process|Buffer)\b|node:|addEventListener\(['"]fetch/);
    const fixture = context();
    const sandbox = {
      Request, Response, AbortController, setTimeout, clearTimeout,
      fetch: async () => new Response('{"ip":"203.0.113.42"}')
    };
    vm.createContext(sandbox);
    vm.runInContext(source.replaceAll("export ", ""), sandbox);
    const response = await sandbox.onRequest(fixture);
    assert.equal(response.status, 200);
    assertPrivateResponse(response);
  }
});

test("/ipinfo/{ip} looks up validated IPv4 and IPv6 instead of the visitor IP", async t => {
  const addresses = [
    "8.8.8.8", "1.1.1.1", "255.255.255.255", "0.0.0.0",
    "2001:4860:4860::8888", "::1", "::", "2001:DB8:0:0:0:0:0:42", "::ffff:192.0.2.1"
  ];
  for (const ip of addresses) {
    const fixture = context({ token: "specific&token=+" });
    fixture.params = { ip };
    delete fixture.request.eo;
    const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ip })));
    const response = await specificIpinfoHandler(fixture);
    assert.equal(response.status, 200, ip);
    assert.deepEqual(await response.json(), { ip });
    assertPrivateResponse(response);
    const url = new URL(fetchMock.mock.calls[0].arguments[0]);
    assert.equal(url.origin, "https://api.ipinfo.io");
    assert.equal(decodeURIComponent(url.pathname), `/lite/${ip}`);
    assert.equal(url.searchParams.get("token"), "specific&token=+");
    assert.equal([...url.searchParams].length, 1);
    fetchMock.mock.restore();
  }
});

test("/ipinfo/{ip} rejects malformed IPs, hostnames, URL injection and zone IDs without fetching", async t => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => { throw new Error("Must not fetch"); });
  for (const ip of [
    undefined, null, "", "example.com", "localhost", "127.1", "1234", "256.0.0.1",
    "01.2.3.4", "1.2.3.4.5", "1.2.3.-1", "8.8.8.8:443", " 8.8.8.8", "8.8.8.8\n",
    "https://example.com", "8.8.8.8?token=other", "8.8.8.8/path", "8.8.8.8%2fme",
    "[::1]", "fe80::1%eth0", ":::1", "1::2::3", "::ffff:999.1.1.1", "abcd:".repeat(30)
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const fixture = context({ method });
      fixture.params = { ip };
      const response = await specificIpinfoHandler(fixture);
      assert.equal(response.status, 400, String(ip));
      assertPrivateResponse(response);
      assert.equal(await response.text(), method === "HEAD" ? "" : '{"error":"Invalid IP address"}');
    }
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("/ipinfo/{ip} shares token, method, HEAD and upstream failure handling", async t => {
  const fixture = options => ({ ...context(options), params: { ip: "8.8.8.8" } });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("secret", { status: 429 }));
  assert.equal((await specificIpinfoHandler(fixture({ method: "POST" }))).status, 405);
  assert.equal((await specificIpinfoHandler(fixture({ token: "" }))).status, 503);
  const head = await specificIpinfoHandler(fixture({ method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(fetchMock.mock.callCount(), 0);
  const rejected = await specificIpinfoHandler(fixture());
  assert.equal(rejected.status, 429);
  assert.deepEqual(await rejected.json(), { error: "IP information provider rejected the request" });
  assertPrivateResponse(rejected);
});
