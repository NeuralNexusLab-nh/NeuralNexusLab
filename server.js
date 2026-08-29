const express = require("express");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;
const publicDirectory = path.join(__dirname, "public");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", true);

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

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", service: "NeuralNexusLab" });
});

app.use(express.static(publicDirectory));

app.listen(port, () => {
  console.log(`NeuralNexusLab is running at http://localhost:${port}`);
});
