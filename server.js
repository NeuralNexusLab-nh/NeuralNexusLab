const express = require("express");
const path = require("path");
const fetch = require("node-fetch");
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

app.get("/ipinfo", (req, res) => {
  fetch(`https://api.ipinfo.io/lite/${req.ip}?token=${process.env.TOKEN}`).then(res => res.json()).then(res.json);
});

app.get("/ipinfo/:ip", (req, res) => {
  fetch(`https://api.ipinfo.io/lite/${req.params.ip}?token=${process.env.TOKEN}`).then(res => res.json()).then(res.json);
});
  
app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", service: "NeuralNexusLab" });
});

app.use(express.static(publicDirectory));

app.listen(port, () => {
  console.log(`NeuralNexusLab is running at http://localhost:${port}`);
});
