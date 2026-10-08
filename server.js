const express = require("express");
const path = require("path");
const { fetchPublic } = require("./lib/fetch-public");
const { securityHeaders } = require("./lib/security-headers");

const app = express();
const port = process.env.PORT || 3000;
const publicDirectory = path.join(__dirname, "public");
const onionOrigin = "http://nxlabtwhcegzi5f65qb6ri4iv72rtdp5q7s4w457pahcohtmegjregqd.onion";
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(securityHeaders(publicDirectory));
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
app.get("/api/fetch", async (req, res) => {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'"
  });
  try {
    const result = await fetchPublic(req.query.url);
    res.status(result.status).set("Content-Type", result.contentType).send(result.body);
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message });
  }
});

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

app.get("/studyx.ai", (req, res) => {
  res.redirect("https://astranote.nxlabtw.com/shared/Eds0HYkulIg7Y_Zbx3BEdregeVm8gyDJ3ZJjlc7sTiI")
});

app.get("/StudyX.AI", (req, res) => {
  res.redirect("https://astranote.nxlabtw.com/shared/Eds0HYkulIg7Y_Zbx3BEdregeVm8gyDJ3ZJjlc7sTiI")
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

app.use(express.static(publicDirectory));

app.use((req, res) => {
  res.status(404).send("ERROR 404 - Not Found");
});

app.listen(port, () => {
  console.log(`NXLabTW Official Website is running at http://localhost:${port}`);
});
