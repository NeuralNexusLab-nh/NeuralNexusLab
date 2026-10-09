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
let upstreamStatus = 200;
let upstreamFailure = false;
let splitFrames = false;
const upstreamRequests = [];

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    resolve("http://127.0.0.1:" + server.address().port);
  }));
}

before(async () => {
  upstreamServer = http.createServer((req, res) => {
    upstreamRequests.push({ path: req.url, headers: req.headers });
    if (upstreamFailure) return req.socket.destroy();
    if (upstreamStatus !== 200) {
      res.writeHead(upstreamStatus);
      return res.end('{"error":"Frames not found"}');
    }
    res.writeHead(200);
    const frames = ["first", "next", "last"];
    let index = 0;
    let fragmentTimer;
    function draw() {
      const frame = "\x1b[2J\x1b[H" + frames[index] + "\n";
      index = (index + 1) % frames.length;
      if (splitFrames) {
        res.write(frame.slice(0, 2));
        fragmentTimer = setTimeout(() => res.write(frame.slice(2)), 2);
      } else res.write(frame);
    }
    draw();
    const timer = setInterval(draw, 20);
    res.once("close", () => { clearInterval(timer); clearTimeout(fragmentTimer); upstreamClosed++; });
  });
  upstreamOrigin = await listen(upstreamServer);
  const app = express();
  app.use("/ascii", createAsciiRouter({
    proxyDurationMs: 160,
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

function sample(pathname, count = 2, headers = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const request = http.get(origin + pathname, { headers }, response => {
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

test("help and list show only the three supported animations without upstream requests", async () => {
  const before = upstreamRequests.length;
  for (const pathname of ["/ascii", "/ascii/"]) {
    const response = await fetch(origin + pathname);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/plain/);
    const help = await response.text();
    for (const name of ["badapple", "rick", "parrot"]) {
      assert.ok(help.includes(`curl.exe -N https://nxlabtw.com/ascii/${name}`));
    }
    assert.match(help, /120 seconds/);
    assert.match(help, /219 seconds/);
  }
  const response = await fetch(origin + "/ascii/list");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.deepEqual(await response.json(), { frames: ["badapple", "rick", "parrot"] });
  for (const pathname of ["/ascii", "/ascii/", "/ascii/list"]) {
    const head = await fetch(origin + pathname, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  }
  assert.equal(upstreamRequests.length, before);
});

test("unsupported animation paths return 404 without upstream requests", async () => {
  const before = upstreamRequests.length;
  for (const pathname of ["/ascii/donut", "/ascii/missing"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(origin + pathname, { method });
      assert.equal(response.status, 404, method + " " + pathname);
      await response.text();
    }
  }
  assert.equal(upstreamRequests.length, before);
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
  const health = await fetch(origin + "/ascii/badapple", { method: "HEAD" });
  assert.equal(health.status, 200, "server continues responding after client disconnect");
});

test("HEAD does not start a never-ending playback or upstream connection", async () => {
  const before = upstreamRequests.length;
  for (const name of ["badapple", "parrot", "rick"]) {
    const response = await fetch(origin + "/ascii/" + name, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
  }
  assert.equal(upstreamRequests.length, before);
});

test("proxy streams unchanged and closes upstream when curl disconnects", async () => {
  const before = upstreamClosed;
  for (const name of ["parrot", "rick"]) {
    const result = await sample("/ascii/" + name);
    assert.equal(result.status, 200);
    assert.equal(result.chunks.join(""), "\x1b[2J\x1b[Hfirst\n\x1b[2J\x1b[Hnext\n");
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(upstreamClosed > before);
  const request = upstreamRequests.find(item => item.path === "/parrot");
  assert.match(request.headers["user-agent"], /curl/);
  assert.equal(request.headers["accept-encoding"], "identity");
  assert.equal(request.headers.cookie, undefined);
});

test("Rick and Parrot loop until the playback deadline, then end normally", async () => {
  const before = upstreamClosed;
  try {
    for (const fragmented of [false, true]) {
      splitFrames = fragmented;
      for (const name of ["rick", "parrot"]) {
        const started = Date.now();
        const response = await fetch(origin + "/ascii/" + name, { signal: AbortSignal.timeout(2000) });
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.ok(Date.now() - started >= 150, "playback does not stop at a cycle boundary");
        assert.ok((body.match(/first\n/g) || []).length >= 2, "animation loops before the deadline");
        assert.ok(body.endsWith("\x1b[0m"), "terminal colors reset on normal EOF");
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(upstreamClosed >= before + 4, "finished playback closes all upstream streams");
  } finally {
    splitFrames = false;
  }
});

test("proxy retains unknown-animation status and handles upstream failure", async () => {
  try {
    upstreamStatus = 404;
    const missing = await fetch(origin + "/ascii/rick");
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Frames not found/);
    upstreamFailure = true;
    const disconnected = await fetch(origin + "/ascii/rick");
    assert.equal(disconnected.status, 502);
    assert.deepEqual((await disconnected.json()).local, ["badapple"]);
  } finally {
    upstreamStatus = 200;
    upstreamFailure = false;
  }
});

test("destination URLs, query strings and client credentials are not forwarded", async () => {
  for (const name of ["https%3A%2F%2F127.0.0.1", "a%3Fb", "a%0Ab", "a".repeat(65)]) {
    const response = await fetch(origin + "/ascii/" + name);
    assert.equal(response.status, 404);
    await response.text();
  }
  await sample("/ascii/parrot?url=http://127.0.0.1", 2, {
    Cookie: "secret=123", Authorization: "Bearer secret"
  });
  const forwarded = upstreamRequests.at(-1);
  assert.equal(forwarded.path, "/parrot");
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

test("local playback ends after the last frame without looping and resets terminal colors", async () => {
  const { EventEmitter } = require("node:events");
  const app = createAsciiRouter({ animation: { fps: 10, frames: ["one", "two", "three"] } });
  const response = new EventEmitter();
  const frames = [];
  let ended;
  let ending;
  const completion = new Promise(resolve => { ended = resolve; });
  Object.assign(response, {
    set() {}, flushHeaders() {}, destroyed: false,
    write(frame) {
      frames.push(frame);
      return true;
    },
    end(text) {
      ending = text;
      response.emit("close");
      ended();
    }
  });
  app.handle({ method: "GET", url: "/badapple", headers: {} }, response, error => {
    if (error) throw error;
  });
  let timeout;
  try {
    await Promise.race([completion, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Playback did not finish")), 2000);
    })]);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(frames.length, 3);
    assert.deepEqual(frames.map(frame => frame.split("\x1b[H")[1]), ["one\n", "two\n", "three\n"]);
    assert.equal(ending, "\x1b[0m");
  } finally {
    clearTimeout(timeout);
    response.emit("close");
  }
});
