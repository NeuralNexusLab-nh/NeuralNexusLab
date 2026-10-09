const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { createAsciiRouter, loadBadApple } = require("../lib/ascii");

let server;
let upstreamServer;
let origin;
let upstreamOrigin;
let upstreamClosed = 0;
let listBody = JSON.stringify({ frames: ["parrot", "rick"] });
const upstreamRequests = [];

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    resolve("http://127.0.0.1:" + server.address().port);
  }));
}

before(async () => {
  upstreamServer = http.createServer((req, res) => {
    upstreamRequests.push({ path: req.url, headers: req.headers });
    if (req.url === "/list") return res.end(listBody);
    if (req.url === "/missing") {
      res.writeHead(404);
      return res.end('{"error":"Frames not found"}');
    }
    if (req.url === "/disconnect") return req.socket.destroy();
    res.writeHead(200);
    res.write("\x1b[2J\x1b[Hfirst\n");
    const timer = setInterval(() => res.write("\x1b[2J\x1b[Hnext\n"), 20);
    res.once("close", () => { clearInterval(timer); upstreamClosed++; });
  });
  upstreamOrigin = await listen(upstreamServer);
  const app = express();
  app.use("/ascii", createAsciiRouter({
    request(url, options, callback) {
      assert.equal(new URL(url).origin, "https://ascii.live");
      const target = upstreamOrigin + new URL(url).pathname;
      return http.get(target, options, callback);
    }
  }));
  server = http.createServer(app);
  origin = await listen(server);
});

after(async () => {
  for (const item of [server, upstreamServer]) {
    item.closeAllConnections();
    await new Promise(resolve => item.close(resolve));
  }
});

function sample(pathname, count = 2) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const request = http.get(origin + pathname, response => {
      response.on("data", chunk => {
        chunks.push(chunk.toString());
        if (chunks.length >= count) {
          request.destroy();
          resolve({ status: response.statusCode, headers: response.headers, chunks });
        }
      });
      response.once("error", error => {
        if (chunks.length < count) reject(error);
      });
    });
    request.once("error", reject);
    request.setTimeout(2000, () => request.destroy(new Error("Sample timed out")));
  });
}

test("bundled Bad Apple covers the whole supplied video at a fixed size and rate", () => {
  const animation = loadBadApple();
  assert.equal(animation.width, 80);
  assert.equal(animation.height, 30);
  assert.equal(animation.fps, 15);
  assert.ok(Math.abs(animation.frames.length / animation.fps - 219.08) < 0.1);
  assert.strictEqual(animation, loadBadApple(), "decoded frames are shared, not copied per viewer");
  for (const frame of animation.frames) {
    const lines = frame.split("\n");
    assert.equal(lines.length, 30);
    assert.ok(lines.every(line => line.length === 80));
    assert.match(frame, /^[ .:\-=+*#%@\n]+$/);
  }
  assert.notEqual(animation.frames[300], animation.frames[600]);
});

test("help and merged list expose local and upstream animation paths", async () => {
  const help = await fetch(origin + "/ascii/");
  assert.equal(help.status, 200);
  assert.match(await help.text(), /curl -N https:\/\/nxlabtw.com\/ascii\/badapple/);
  const response = await fetch(origin + "/ascii/list");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { frames: ["badapple", "parrot", "rick"] });
});

test("invalid or oversized upstream lists produce a bounded error, not a server crash", async () => {
  const original = listBody;
  try {
    for (const body of ["not JSON", JSON.stringify({ frames: null }), " ".repeat(65537)]) {
      listBody = body;
      const response = await fetch(origin + "/ascii/list");
      assert.equal(response.status, 502);
      assert.deepEqual((await response.json()).local, ["badapple"]);
    }
  } finally {
    listBody = original;
  }
});

test("Bad Apple streams frames locally without contacting ascii.live", async () => {
  const before = upstreamRequests.length;
  const result = await sample("/ascii/badapple", 3);
  assert.equal(result.status, 200);
  assert.match(result.headers["content-type"], /^text\/plain/);
  assert.equal(result.headers["x-accel-buffering"], "no");
  assert.equal(result.headers["cache-control"], "no-store, no-transform");
  for (const frame of result.chunks) assert.match(frame, /^\x1b\[0;37;40m\x1b\[2J\x1b\[H/);
  assert.equal(upstreamRequests.length, before);
  const health = await fetch(origin + "/ascii/");
  assert.equal(health.status, 200, "server continues responding after client disconnect");
});

test("HEAD does not start a never-ending playback or upstream connection", async () => {
  const before = upstreamRequests.length;
  for (const name of ["badapple", "parrot", "list"]) {
    const response = await fetch(origin + "/ascii/" + name, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
  }
  assert.equal(upstreamRequests.length, before);
});

test("proxy streams unchanged and closes upstream when curl disconnects", async () => {
  const before = upstreamClosed;
  const result = await sample("/ascii/parrot");
  assert.equal(result.status, 200);
  assert.equal(result.chunks.join(""), "\x1b[2J\x1b[Hfirst\n\x1b[2J\x1b[Hnext\n");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(upstreamClosed > before);
  const request = upstreamRequests.find(item => item.path === "/parrot");
  assert.match(request.headers["user-agent"], /curl/);
  assert.equal(request.headers["accept-encoding"], "identity");
  assert.equal(request.headers.cookie, undefined);
});

test("proxy retains unknown-animation status and handles upstream failure", async () => {
  const missing = await fetch(origin + "/ascii/missing");
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Frames not found/);
  const disconnected = await fetch(origin + "/ascii/disconnect");
  assert.equal(disconnected.status, 502);
  assert.deepEqual((await disconnected.json()).local, ["badapple"]);
});

test("destination URLs, query strings and client credentials are not forwarded", async () => {
  for (const name of ["https%3A%2F%2F127.0.0.1", "a%3Fb", "a%0Ab", "a".repeat(65)]) {
    const response = await fetch(origin + "/ascii/" + name);
    assert.equal(response.status, 404);
    await response.text();
  }
  const response = await fetch(origin + "/ascii/missing?url=http://127.0.0.1", {
    headers: { Cookie: "secret=123", Authorization: "Bearer secret" }
  });
  await response.text();
  const forwarded = upstreamRequests.at(-1);
  assert.equal(forwarded.path, "/missing");
  assert.equal(forwarded.headers.cookie, undefined);
  assert.equal(forwarded.headers.authorization, undefined);
});

test("local playback waits for slow clients and removes drain listeners on close", () => {
  const { EventEmitter } = require("node:events");
  const { mock } = require("node:test");
  // A stopped writer must not accumulate frames while it is waiting for drain.
  const app = createAsciiRouter({ animation: { fps: 15, frames: ["one", "two"] } });
  const response = new EventEmitter();
  Object.assign(response, {
    set() {}, flushHeaders() {}, destroyed: false,
    write: mock.fn(() => false)
  });
  app.handle({ method: "GET", url: "/badapple", headers: {} }, response, error => {
    if (error) throw error;
  });
  assert.equal(response.write.mock.callCount(), 1);
  assert.equal(response.listenerCount("drain"), 1);
  response.emit("close");
  assert.equal(response.listenerCount("drain"), 0);
});

test("local playback loops and stops sending frames after disconnect", async () => {
  const { EventEmitter } = require("node:events");
  const app = createAsciiRouter({ animation: { fps: 30, frames: ["repeat"] } });
  const response = new EventEmitter();
  const frames = [];
  let looped;
  const loop = new Promise(resolve => { looped = resolve; });
  Object.assign(response, {
    set() {}, flushHeaders() {}, destroyed: false,
    write(frame) {
      frames.push(frame);
      if (frames.length === 3) {
        response.emit("close");
        looped();
      }
      return true;
    }
  });
  app.handle({ method: "GET", url: "/badapple", headers: {} }, response, error => {
    if (error) throw error;
  });
  let timeout;
  try {
    await Promise.race([loop, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Playback did not loop")), 2000);
    })]);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(frames.length, 3);
    assert.ok(frames.every(frame => frame === frames[0]));
  } finally {
    clearTimeout(timeout);
    response.emit("close");
  }
});
