# NXLabTW

A static company homepage with two small EdgeOne Pages / Makers Edge Functions.
The entry page and publishing files stay at the repository root; images and the
local QR generator live in `assets/`. No Express server, production Node.js
process, third-party npm dependency, or frontend build is required.

## Deploy on EdgeOne Pages / Makers

Import this GitHub repository into an EdgeOne Pages / Makers project:

| Setting | Value |
| --- | --- |
| Framework preset | Other |
| Production branch | `main` |
| Root directory | Repository root (`./`) |
| Install command | Empty (no dependencies) |
| Build command | Empty (plain HTML) |
| Output directory | `.` |
| Start command | None; do not use `npm start` or `node server.js` |

`edgeone.json` records the empty install/build commands and root output directory.
It also mirrors the existing security headers from `_headers` in Makers' native
header configuration. Onion discovery stays disabled.
The minimal `package.json` declares ES modules and provides `npm test`; it does
not install Express or start a server. Keep `edge-functions/` at the project
root, next to `index.html`. Makers turns each file into its URL automatically.

### Environment variables

Set this in **Project settings -> Environment management -> Environment variables**:

```dotenv
TOKEN=your_ipinfo_lite_token
```

`TOKEN` is an **IPinfo API token**, not a Tencent Cloud or EdgeOne deployment
token. Enable it for Production, and for Preview if you want to test the API on
preview deployments. Redeploy after changing it. No environment example file is
included; the deployed functions read `context.env.TOKEN` from the platform, not
a committed `.env` file. Never put the real value in frontend JavaScript, Git, or a public
upload. `/ip` does not require any environment variable.

### API routes

| Request | Response |
| --- | --- |
| `GET /ip` | Visitor IP as plain text |
| `GET /ipinfo` | IPinfo Lite JSON for that visitor IP |

Both use `context.request.eo.clientIp` from the EdgeOne runtime, not arbitrary
client headers. Both support `HEAD` without a body; `/ipinfo` HEAD does not call
IPinfo. Other methods return `405` with `Allow: GET, HEAD`. Responses use
`Cache-Control: no-store`; do not add a CDN rule that forces caching of these URLs.

`/ipinfo` sends the visitor's IP to `https://api.ipinfo.io/lite/<IP>` server-side.
The token is not returned to the browser. Lite provides country/continent and
basic ASN information, not city-level geolocation. Missing runtime IP or token
returns `503`; provider rejection preserves its HTTP failure status, network or
invalid JSON errors return `502`, and an 8-second lookup timeout returns `504`.
Provider error bodies and exception details are not exposed. A token failure
does not stop the homepage or `/ip` from working.

These are public same-origin endpoints, not a proxy, VPN, authenticated lookup
service, or `/ipinfo/:ip` API. No wildcard CORS, database, KV, tracking or request
logging is added. Use the hosting platform's rate-limiting controls if needed;
there is no reliable shared in-memory rate limiter across serverless instances.

After deployment, test `/ip` and `/ipinfo` on the **Makers deployment domain**
first. Bind `nxlabtw.com` and apply the CNAME that Makers provides when ready.
Pushing code alone does not change DNS or move the domain off GitHub Pages.

References: [Edge Functions](https://pages.edgeone.ai/document/edge-functions),
[build/environment settings](https://pages.edgeone.ai/document/build-guide),
[IPinfo Lite](https://ipinfo.io/developers/lite-api).

## Static hosting fallback

- Publish directory: `.` (repository root)
- Build command: none
- Entry page: `index.html`
- Custom domain: `nxlabtw.com`, retained in `CNAME`
- The existing GitHub Pages workflow uploads the repository root on pushes to
  `main`. It does not install dependencies or run a server.
- GitHub Pages still serves the unchanged homepage, but **cannot execute these
  Edge Functions**. `/ip` and `/ipinfo` only work on EdgeOne Pages / Makers.
- Other static hosts can publish the same folder. If an old deployment still uses
  `npm start` or `node server.js`, switch it to static hosting with `.`
  as the publish directory. Those commands no longer exist.
- Do not publish ignored local files such as `.env`, `.git/`, or `node_modules/`,
  or enable an SPA fallback for removed APIs. Deploy from a clean checkout.

For a local preview (Python is only a development convenience):

```sh
python -m http.server 8000 --directory .
```

Open http://localhost:8000/. This static preview does not emulate EdgeOne APIs;
the real platform IP metadata must be verified on a Makers deployment.

## Retained

- Homepage content and layout, black-hole animation, responsive navigation,
  anchor scrolling, and reduced-motion support.
- English, Traditional Chinese, and Japanese, including saved/browser language
  selection.
- Public project listing: AtlasNote, Neutron, and Browzen, in that order.
- Bitcoin and Monero donations: exact addresses, browser-generated QR codes,
  copy controls, and wallet URI links. No address is sent to a QR service.
- Email/social links, SEO/structured data, sitemap, robots, and `llms.txt`.
- Paused project and Onion source content is retained for later restoration.

## Temporarily hidden

AstraNote and NexaCAPTCHA are stored in inert HTML templates in `index.html`, so
they do not render, appear in the active navigation, or receive keyboard focus.
Their translations and links are retained. Public summaries and `llms.txt` list
AtlasNote, Neutron, and Browzen. AtlasNote is a separate project; AstraNote remains paused.

The Onion navigation link is also in an inert template. `onionEnabled = false`
disables the Dark Web badge and onion link switching. Onion-Location discovery is
commented out in both the HTML meta tag and `_headers`.

To restore, unwrap the corresponding `paused-*` templates, restore the project
numbering/summaries and `llms.txt` entries, set `onionEnabled` to `true` if restoring
Onion, and uncomment its meta tag/header rules. Refresh CSP hashes after editing
inline JavaScript. This is a presentation pause, not an access restriction on the
separate project websites or onion service.

## Removed

The old Express server/dependencies, proxy implementations, ASCII conversion
utility, and bundled ASCII video frames remain removed. The following former
routes are not restored:

- `/api/health` and `/api/fetch`
- `/ipinfo/:ip`
- `/ascii`, `/ascii/list`, and every ASCII animation stream
- `/.onion`, `/onion`, and `/tor` text endpoints
- `/studyx.ai` and `/StudyX.AI` server redirects

Only `/ip` and `/ipinfo` have been reintroduced as Edge Functions. No replacement
proxy or fake static API has been added. Other removed endpoints should return
404. Deleted source/assets remain recoverable in Git history.

## Security and Onion discovery

The homepage includes a hash-based CSP meta policy and referrer policy, so those
protections do not depend on a server. Inline scripts/styles must match their
SHA-256 hashes; after changing an inline block, update its hash in both
`index.html`, `sso.html`, `_headers`, and `edgeone.json`. The optional static tests
catch stale hashes and differences between host header configurations.

`_headers` preserves the HTTP security settings for hosts supporting that
format: CSP (including `frame-ancestors`), HSTS without subdomain/preload flags,
X-Frame-Options, X-Content-Type-Options, Referrer-Policy, and Permissions-Policy.
Onion-Location rules are retained as disabled comments. HSTS is for the HTTPS clearnet deployment, not a
requirement to enable HTTPS on the onion service.

GitHub Pages does **not** apply this custom header file. On Pages, the HTML meta
CSP/referrer policy still applies, but HTTP-only protections (HSTS, frame-ancestors,
X-Frame-Options, etc.) must be controlled by the hosting platform or an external
CDN/reverse proxy. HTML cannot pretend to set those response headers.

The Tor-supported `onion-location` HTML meta tag is retained as a disabled comment.
If restored, it points to the onion homepage; unlike a dynamic response header,
it cannot preserve an arbitrary requested path. Onion navigation is currently paused.

References: [Tor Onion-Location](https://community.torproject.org/onion-services/advanced/onion-location/),
[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site),
[static host header configuration](https://docs.netlify.com/manage/routing/headers/).

## Optional development checks

The tests are dependency-free and can be run with Node.js installed locally:

```sh
node --test
```

Use Node.js 22 or newer for these developer checks (`npm test` is equivalent).
API tests use mocked EdgeOne request metadata and IPinfo responses, including
IPv4/IPv6, missing configuration, errors, timeout, methods, and no-cache behavior;
they do not contact IPinfo or need a real token. Node.js is not the production
Edge Functions runtime. Live visitor-IP and provider checks still require an
actual Makers deployment with `TOKEN` configured.
