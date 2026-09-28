const express = require("express");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;
const publicDirectory = path.join(__dirname, "public");
const onionOrigin = "http://nxlabtwhcegzi5f65qb6ri4iv72rtdp5q7s4w457pahcohtmegjregqd.onion";
app.set("trust proxy", true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((request, response, next) => {
  if (["nxlabtw.com", "www.nxlabtw.com"].includes(request.hostname.toLowerCase())) {
    response.set("Onion-Location", `${onionOrigin}${request.originalUrl}`);
  }
  next();
});

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", service: "NXLabTW" });
});

// Add new routes here.
app.get("/ip", (req, res) => {
  res.send(req.ip);
});

app.get("/.onion", (req, res) => {
  res.send("nxlabtwhcegzi5f65qb6ri4iv72rtdp5q7s4w457pahcohtmegjregqd.onion");
});

app.get("/onion", (req, res) => {
  res.send("nxlabtwhcegzi5f65qb6ri4iv72rtdp5q7s4w457pahcohtmegjregqd.onion");
});

app.get("/tor", (req, res) => {
  res.send("nxlabtwhcegzi5f65qb6ri4iv72rtdp5q7s4w457pahcohtmegjregqd.onion");
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

app.all("*", (req, res) => {
  res.status(404).send("ERROR 404 - Not Found");
});

app.listen(port, () => {
  console.log(`NXLabTW Official Website is running at http://localhost:${port}`);
});
