const express = require("express");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;
const publicDirectory = path.join(__dirname, "public");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add new routes here.
app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", service: "NeuralNexusLab" });
});

app.use(express.static(publicDirectory));

app.listen(port, () => {
  console.log(`NeuralNexusLab is running at http://localhost:${port}`);
});
