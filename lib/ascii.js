const express = require("express");
const https = require("node:https");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const { pipeline } = require("node:stream");
const { performance } = require("node:perf_hooks");

const upstreamOrigin = "https://ascii.live";
let cachedAnimation;
function loadBadApple() {
  if (!cachedAnimation) {
    const file = path.join(__dirname, "..", "data", "ascii", "badapple.json.gz");
    cachedAnimation = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
  }
  return cachedAnimation;
}

function streamHeaders(res) {
  res.set({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no"
  });
}

function playBadApple(req, res, animation) {
  streamHeaders(res);
  if (req.method === "HEAD") return res.end();
  res.flushHeaders();
  const started = performance.now();
  const interval = 1000 / animation.fps;
  let timer;
  let stopped = false;
  function cleanup() {
    stopped = true;
    clearTimeout(timer);
    res.removeListener("drain", schedule);
  }
  function schedule() {
    if (stopped) return;
    const elapsed = performance.now() - started;
    timer = setTimeout(draw, Math.max(1, Math.ceil(interval - (elapsed % interval))));
  }
  function draw() {
    if (stopped || res.destroyed) return;
    // Follow playback time instead of buffering old frames for slow clients.
    const index = Math.floor((performance.now() - started) / interval) % animation.frames.length;
    const frame = "\x1b[0;37;40m\x1b[2J\x1b[H" + animation.frames[index] + "\n";
    if (res.write(frame)) schedule();
    else res.once("drain", schedule);
  }
  res.once("close", cleanup);
  res.once("error", cleanup);
  draw();
}

function proxyAscii(req, res, name, request) {
  // Only allowlisted names reach this proxy, never client URLs or headers.
  const upstream = request(`${upstreamOrigin}/${name}`, {
    headers: { "User-Agent": "curl/NXLabTW", "Accept-Encoding": "identity" }
  }, incoming => {
    if (res.destroyed) return incoming.destroy();
    res.status(incoming.statusCode || 502);
    streamHeaders(res);
    // pipe/pipeline honor backpressure; disconnecting also destroys the upstream.
    pipeline(incoming, res, () => {});
  });
  upstream.setTimeout(15000, () => upstream.destroy(new Error("Upstream timed out")));
  res.once("close", () => upstream.destroy());
  upstream.once("error", () => {
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else res.status(502).json({ error: "ascii.live is unavailable", local: ["badapple"] });
  });
}

function createAsciiRouter({ request = https.get, animation } = {}) {
  const router = express.Router();
  router.get("/:name", (req, res) => {
    const name = req.params.name;
    if (!["badapple", "rick", "parrot"].includes(name)) {
      return res.status(404).json({ error: "Unknown animation" });
    }
    if (req.method === "HEAD" && name !== "badapple") {
      streamHeaders(res);
      return res.end();
    }
    if (name === "badapple") {
      try {
        return playBadApple(req, res, animation || loadBadApple());
      } catch (error) {
        console.error("Cannot load Bad Apple animation:", error.message);
        return res.status(503).json({ error: "Bad Apple animation is unavailable" });
      }
    }
    res.set("Cache-Control", "no-store, no-transform");
    proxyAscii(req, res, name, request);
  });
  return router;
}

module.exports = { createAsciiRouter, loadBadApple };
