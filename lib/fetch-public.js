const dns = require("node:dns/promises");
const http = require("node:http");
const https = require("node:https");
const { Transform, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const zlib = require("node:zlib");
const ipaddr = require("ipaddr.js");

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10000;

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function parseTarget(value, base) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw failure(400, "A valid HTTP or HTTPS URL is required");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw failure(400, "Only HTTP/HTTPS URLs without embedded credentials are allowed");
  }
  // Limit this endpoint to ordinary public web servers.
  if (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) {
    throw failure(403, "Only standard web ports are allowed");
  }
  url.hash = "";
  return url;
}

function isPublic(address) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function publicAddresses(url, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = ipaddr.isValid(hostname)
    ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === "ipv4" ? 4 : 6 }]
    : await abortable(dns.lookup(hostname, { all: true }), signal);
  if (!addresses.length || addresses.some(({ address }) => !isPublic(address))) {
    throw failure(403, "Private, local, and reserved network addresses are not allowed");
  }
  return addresses;
}

function requestPage(url, addresses, signal) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.get(url, {
      agent: false,
      signal,
      headers: {
        "User-Agent": "NXLabTW-PublicFetch/1.0",
        "Accept": "*/*",
        "Accept-Encoding": "identity"
      },
      // Connect only to the addresses checked above, preventing a second DNS lookup.
      lookup(_hostname, options, callback) {
        const candidates = options.family
          ? addresses.filter(({ family }) => family === options.family)
          : addresses;
        if (!candidates.length) return callback(failure(502, "No usable public address"));
        if (options.all) return callback(null, candidates);
        callback(null, candidates[0].address, candidates[0].family);
      }
    }, resolve);
    request.on("error", reject);
  });
}

async function readBody(response, signal) {
  if (Number(response.headers["content-length"]) > MAX_BYTES) {
    response.destroy();
    throw failure(413, "External response exceeds 2 MiB");
  }
  const encoding = (response.headers["content-encoding"] || "identity").trim().toLowerCase();
  const decoders = {
    gzip: zlib.createGunzip,
    deflate: zlib.createInflate,
    br: zlib.createBrotliDecompress
  };
  if (encoding !== "identity" && !decoders[encoding]) {
    response.destroy();
    throw failure(502, "Unsupported external content encoding");
  }
  let downloaded = 0;
  let decoded = 0;
  const chunks = [];
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      downloaded += chunk.length;
      callback(downloaded > MAX_BYTES ? failure(413, "External response exceeds 2 MiB") : null, chunk);
    }
  });
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      decoded += chunk.length;
      if (decoded > MAX_BYTES) return callback(failure(413, "External response exceeds 2 MiB"));
      chunks.push(chunk);
      callback();
    }
  });
  const streams = [response, limit];
  if (decoders[encoding]) streams.push(decoders[encoding]());
  streams.push(sink);
  await pipeline(...streams, { signal });
  return Buffer.concat(chunks, decoded);
}

async function fetchPublic(value) {
  if (typeof value !== "string" || !value || value.length > 4096) {
    throw failure(400, "Provide one URL of up to 4096 characters");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(failure(504, "External request timed out")), TIMEOUT_MS);
  timeout.unref();
  try {
    let url = parseTarget(value);
    for (let redirects = 0; ; redirects++) {
      const addresses = await publicAddresses(url, controller.signal);
      const response = await requestPage(url, addresses, controller.signal);
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        const location = response.headers.location;
        response.destroy();
        if (redirects >= MAX_REDIRECTS) throw failure(502, "Too many external redirects");
        url = parseTarget(location, url);
        continue;
      }
      const body = await readBody(response, controller.signal);
      const contentType = response.headers["content-type"] || "application/octet-stream";
      // HTML/XML must be readable as data, never executable on the NXLabTW origin.
      const executable = /(?:html|xml|svg|javascript)/i.test(contentType);
      return {
        status: response.statusCode,
        contentType: executable ? "text/plain; charset=utf-8" : contentType,
        body
      };
    }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error.status ? error : failure(502, "Unable to fetch the external website");
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchPublic };
