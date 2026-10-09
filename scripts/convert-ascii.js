// Run once locally with FFmpeg installed; the deployed server does not need it.
const { spawn } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { gzipSync } = require("node:zlib");

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/convert-ascii.js "path/to/video.mp4"');
  process.exit(1);
}

const width = 80;
const height = 30;
const fps = 15;
const frameSize = width * height;
const shades = " .:-=+*#%@";
const frames = [];
let pending = Buffer.alloc(0);
const ffmpeg = spawn("ffmpeg", [
  "-v", "error", "-i", input, "-an",
  "-vf", `fps=${fps},scale=${width}:${height}:flags=area,format=gray`,
  "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });

ffmpeg.stdout.on("data", chunk => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= frameSize) {
    const pixels = pending.subarray(0, frameSize);
    const lines = [];
    for (let y = 0; y < height; y++) {
      let line = "";
      for (let x = 0; x < width; x++) {
        line += shades[Math.round(pixels[y * width + x] * (shades.length - 1) / 255)];
      }
      lines.push(line);
    }
    frames.push(lines.join("\n"));
    pending = pending.subarray(frameSize);
  }
});

ffmpeg.once("error", error => {
  console.error("Cannot start FFmpeg:", error.message);
  process.exitCode = 1;
});
ffmpeg.once("close", code => {
  if (code !== 0 || !frames.length || pending.length) {
    console.error("Video conversion failed; existing animation was not replaced.");
    process.exitCode = 1;
    return;
  }
  const output = path.join(__dirname, "..", "data", "ascii", "badapple.json.gz");
  const compressed = gzipSync(JSON.stringify({ width, height, fps, frames }), { level: 9 });
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, compressed);
  console.log(`${frames.length} frames, ${width}x${height}, ${fps} fps, ${compressed.length} bytes -> ${output}`);
});
