const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function inlineHashes(directory) {
  const scripts = new Set();
  const styles = new Set();
  function visit(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        // HTML parsing normalizes line endings before CSP hashes are checked.
        const html = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
        for (const [tag, hashes] of [["script", scripts], ["style", styles]]) {
          const blocks = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");
          for (const [, content] of html.matchAll(blocks)) {
            if (content.trim()) hashes.add(`'sha256-${createHash("sha256").update(content).digest("base64")}'`);
          }
        }
      }
    }
  }
  visit(directory);
  return { scripts: [...scripts], styles: [...styles] };
}

function securityHeaders(publicDirectory) {
  // Recomputed on every server start so ordinary page edits do not need manual hashes.
  const hashes = inlineHashes(publicDirectory);
  const policy = [
    "default-src 'self'",
    `script-src 'self' ${hashes.scripts.join(" ")}`,
    "script-src-attr 'none'",
    `style-src 'self' https://fonts.googleapis.com ${hashes.styles.join(" ")}`,
    "style-src-attr 'none'",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' https:",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'"
  ].join("; ");

  return (request, response, next) => {
    response.set({
      "Content-Security-Policy": policy,
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-write=(self)"
    });
    const onion = request.hostname.toLowerCase().endsWith(".onion");
    if (request.secure && !onion) {
      // Do not force unverified subdomains or HTTP onion services onto HTTPS.
      response.set("Strict-Transport-Security", "max-age=31536000");
    }
    next();
  };
}

module.exports = { securityHeaders };
