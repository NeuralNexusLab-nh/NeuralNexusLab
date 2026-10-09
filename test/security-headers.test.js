const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");

let child;
let origin;
const onionHost = "nxlabtwhcegzi5f65qb6ri4iv72rtdp5q7s4w457pahcohtmegjregqd.onion";
const httpsHeaders = { Host: "nxlabtw.com", "X-Forwarded-Proto": "https" };

function getWithHost(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, response => {
      response.resume();
      response.once("end", () => resolve(response));
      response.once("error", reject);
    });
    request.once("error", reject);
  });
}

before(async () => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  origin = "http://127.0.0.1:" + port;
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server startup timed out")), 5000);
    child.stdout.on("data", data => {
      if (data.toString().includes("is running at")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error("Server exited: " + code)); });
  });
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => { child.once("exit", resolve); child.kill(); });
  }
});

test("security headers cover HTML, static assets, API responses, and 404s", async () => {
  for (const [url, status] of [
    ["/", 200], ["/sso.html", 200], ["/assets/qrcode-generator.js", 200],
    ["/api/health", 200], ["/ascii", 200], ["/ascii/list", 200], ["/not-found", 404]
  ]) {
    const response = await fetch(origin + url, { headers: httpsHeaders });
    assert.equal(response.status, status, url);
    assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.match(response.headers.get("permissions-policy"), /clipboard-write=\(self\)/);
    assert.match(response.headers.get("permissions-policy"), /camera=\(\)/);
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-powered-by"), null);
    await response.arrayBuffer();
  }
});

test("HSTS is omitted for plain HTTP and onion hosts, while Onion-Location still works", async () => {
  const plain = await fetch(origin + "/api/health");
  assert.equal(plain.headers.get("strict-transport-security"), null);
  const onion = await getWithHost(origin + "/", {
    Host: onionHost, "X-Forwarded-Proto": "https"
  });
  assert.equal(onion.headers["strict-transport-security"], undefined);
  assert.equal(onion.headers["onion-location"], undefined);
  const clear = await getWithHost(origin + "/api/health?test=1", httpsHeaders);
  assert.equal(clear.headers["onion-location"], "http://" + onionHost + "/api/health?test=1");
  assert.ok(onion.headers["content-security-policy"]);
});

test("CSP hashes authorize the exact page scripts and styles without unsafe-inline or unsafe-eval", async () => {
  for (const url of ["/", "/sso.html"]) {
    const response = await fetch(origin + url);
    const policy = response.headers.get("content-security-policy");
    const html = (await response.text()).replace(/\r\n?/g, "\n");
    for (const tag of ["script", "style"]) {
      const blocks = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");
      for (const [, content] of html.matchAll(blocks)) {
        if (content.trim()) {
          const hash = createHash("sha256").update(content).digest("base64");
          assert.ok(policy.includes("'sha256-" + hash + "'"), tag + " in " + url);
        }
      }
    }
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|upgrade-insecure-requests/);
    assert.match(policy, /style-src-attr 'none'/);
    assert.match(policy, /https:\/\/fonts\.googleapis\.com/);
    assert.match(policy, /https:\/\/fonts\.gstatic\.com/);
    assert.doesNotMatch(html, /\sstyle\s*=/i);
  }
});

test("the legacy exit route is removed for GET and POST", async () => {
  for (const method of ["GET", "POST"]) {
    const response = await fetch(origin + "/exit?token=anything&url=https://example.com/", {
      method, headers: httpsHeaders
    });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "ERROR 404 - Not Found");
  }
});

test("the public-fetch sandbox is preserved alongside the other security headers", async () => {
  const response = await fetch(origin + "/api/fetch", { headers: httpsHeaders });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
});

test("malformed JSON still receives security headers", async () => {
  const response = await fetch(origin + "/api/health", {
    method: "POST", headers: { ...httpsHeaders, "Content-Type": "application/json" }, body: "{"
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
});
