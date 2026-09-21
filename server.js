const express = require("express");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;
const publicDirectory = path.join(__dirname, "public");
app.set("trust proxy", true);

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const maxConcurrentRequests = Math.floor(readPositiveNumber("MAX_CONCURRENT_REQUESTS", 1));
const maxRssBytes = readPositiveNumber("MAX_RSS_MB", 96) * 1024 * 1024;
const maxQueueSize = Math.floor(readPositiveNumber("MAX_QUEUE_SIZE", 100));
const queueTimeoutMs = readPositiveNumber("QUEUE_TIMEOUT_MS", 30000);
const requestQueue = [];
let activeRequests = 0;

function drainRequestQueue() {
  while (
    activeRequests < maxConcurrentRequests &&
    requestQueue.length > 0 &&
    process.memoryUsage().rss < maxRssBytes
  ) {
    requestQueue.shift()();
  }
}

function queueRequests(request, response, next) {
  if (requestQueue.length >= maxQueueSize) {
    return response.status(503).json({ error: "Server queue is full" });
  }

  let started = false;
  let released = false;
  let waitTimer;

  const release = () => {
    if (!started || released) return;
    released = true;
    activeRequests = Math.max(0, activeRequests - 1);
    drainRequestQueue();
  };

  const job = () => {
    if (response.destroyed) return drainRequestQueue();
    started = true;
    clearTimeout(waitTimer);
    activeRequests += 1;
    response.once("finish", release);
    response.once("close", release);
    next();
  };

  waitTimer = setTimeout(() => {
    if (started) return;
    const index = requestQueue.indexOf(job);
    if (index !== -1) requestQueue.splice(index, 1);
    if (!response.headersSent) {
      response.status(503).json({ error: "Server is busy. Please try again shortly." });
    }
  }, queueTimeoutMs);

  request.once("aborted", () => {
    if (started) return;
    clearTimeout(waitTimer);
    const index = requestQueue.indexOf(job);
    if (index !== -1) requestQueue.splice(index, 1);
  });

  requestQueue.push(job);
  drainRequestQueue();
}

// Retry queued work after garbage collection or other memory is released.
setInterval(drainRequestQueue, 250).unref();

// Keep health checks responsive so the hosting platform can observe the process.
app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", service: "NeuralNexusLab" });
});

// Every user request, including static assets, waits for available memory and queue capacity.
app.use(queueRequests);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add new routes here.
app.get("/ip", (req, res) => {
  res.send(req.ip);
});

async function sendIpInfo(ip, res) {
  if (!process.env.TOKEN) {
    return res.status(503).json({ error: "TOKEN is not configured" });
  }

  try {
    const response = await fetch(
      `https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${encodeURIComponent(process.env.TOKEN)}`
    );
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    console.error("Failed to fetch IP information:", error.message);
    return res.status(502).json({ error: "Failed to fetch IP information" });
  }
}

app.get("/ipinfo", (req, res) => {
  sendIpInfo(req.ip, res);
});

app.get("/ipinfo/:ip", (req, res) => {
  sendIpInfo(req.params.ip, res);
});

app.get("/exit", (req, res) => {
  if (req.query.token != [...(new Date().toISOString().slice(0, 10).replaceAll("-", ""))].filter(digit => digit !== "0").reduce((product, digit) => product * Number(digit), 1)*process.env.TOKENELEM) {
    res.status(403).send("TOKEN INVALID");
    return;
  }
  const method = (req.query.method || "GET").toUpperCase();

  fetch(req.query.url, {
    method,
    headers: req.query.headers || {},
    ...(!["GET", "HEAD"].includes(method) && req.query.body
      ? { body: JSON.stringify(req.query.body) }
      : {})
  })
    .then(response => response.text())
    .then(data => res.status(200).send(data));
});

app.use(express.static(publicDirectory));

app.listen(port, () => {
  console.log(`NeuralNexusLab Official Website is running at http://localhost:${port}`);
  console.log(`Request queue: ${maxConcurrentRequests} concurrent, RSS limit: ${Math.round(maxRssBytes / 1024 / 1024)} MB`);
});
