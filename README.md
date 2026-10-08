# NXLabTW

Start the Express website with `npm install` followed by `npm start`.

## Reading external websites from frontend JavaScript

Use the same-origin server endpoint rather than requesting the external URL directly:

```js
const url = "https://example.com/";
const response = await fetch("/api/fetch?url=" + encodeURIComponent(url));
if (!response.ok) throw new Error("Fetch failed: " + response.status);
const html = await response.text();
```

For a JSON endpoint, use `await response.json()` instead. The endpoint preserves the
external HTTP status and returns its body. External HTML/XML is served as plain text;
read it as data rather than inserting it into the page as trusted HTML.

This endpoint supports public HTTP/HTTPS GET requests on standard ports, follows up
to three redirects, and limits each request to 10 seconds and 2 MiB (including
decompressed content). Each destination is checked and DNS is pinned to validated
public addresses. It does not forward browser cookies, authentication, or arbitrary
request headers. Reading logged-in pages, bypassing anti-bot checks, and browsing
an external website through an iframe are not provided by this endpoint.

The browser's normal `fetch("https://external-site/...")` still follows that site's
CORS policy. This endpoint works because Node.js fetches the content server-side.

## Security headers

All responses include CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, and a Permissions Policy that
disables camera, microphone, location, payments and USB while allowing same-origin
clipboard writes for the donation address.

HTTPS responses also include `Strict-Transport-Security: max-age=31536000` (one
year). HSTS does not include subdomains or preload, and is omitted on HTTP and
`.onion` hosts. Express uses the deployment proxy's forwarded protocol to detect
HTTPS.

CSP permits local assets, Google Fonts, and HTTPS frontend fetch requests. Existing
inline scripts and styles are authorized by SHA-256 hashes computed from the HTML
in `public` when the server starts. Restart the server after changing these files.
Inline event handlers, inline style attributes, embedded frames, and plugins are
blocked. The `/api/fetch` endpoint retains its stricter sandbox policy.

The legacy `/exit` route has been removed and returns 404.
