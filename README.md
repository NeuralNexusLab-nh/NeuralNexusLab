# NXLabTW

A fully static company website. The entry page and publishing files live at the
repository root; images and the local QR generator live in `assets/`.
No Express server, package installation, build command, Node.js runtime, backend,
API key, or environment variables are required to publish the website.

## Deploy

- Publish directory: `.` (repository root)
- Build command: none
- Entry page: `index.html`
- Custom domain: `nxlabtw.com`, retained in `CNAME`
- The existing GitHub Pages workflow uploads the repository root on pushes to
  `main`. It does not install dependencies or run a server.
- Other static hosts can publish the same folder. If an old deployment still uses
  `npm start` or `node server.js`, switch it to static hosting with `.`
  as the publish directory. Those commands no longer exist.
- Do not publish ignored local files such as `.env`, `.git/`, or `node_modules/`,
  or enable an SPA fallback for removed APIs. Deploy from a clean checkout.

For a local preview (Python is only a development convenience):

```sh
python -m http.server 8000 --directory .
```

Open http://localhost:8000/. There is no production application server to start.

## Retained

- Homepage content and layout, black-hole animation, responsive navigation,
  anchor scrolling, and reduced-motion support.
- English, Traditional Chinese, and Japanese, including saved/browser language
  selection.
- Public project listing: Neutron and Browzen.
- Bitcoin and Monero donations: exact addresses, browser-generated QR codes,
  copy controls, and wallet URI links. No address is sent to a QR service.
- Email/social links, SEO/structured data, sitemap, robots, and `llms.txt`.
- Paused project and Onion source content is retained for later restoration.

## Temporarily hidden

AstraNote and NexaCAPTCHA are stored in inert HTML templates in `index.html`, so
they do not render, appear in the active navigation, or receive keyboard focus.
Their translations and links are retained. Public summaries and `llms.txt` list
only Neutron and Browzen.

The Onion navigation link is also in an inert template. `onionEnabled = false`
disables the Dark Web badge and onion link switching. Onion-Location discovery is
commented out in both the HTML meta tag and `_headers`.

To restore, unwrap the corresponding `paused-*` templates, restore the project
numbering/summaries and `llms.txt` entries, set `onionEnabled` to `true` if restoring
Onion, and uncomment its meta tag/header rules. Refresh CSP hashes after editing
inline JavaScript. This is a presentation pause, not an access restriction on the
separate project websites or onion service.

## Removed

The Express server, npm manifests/dependencies, environment-variable example,
backend implementations/tests, ASCII conversion utility, and bundled ASCII video
frames have been removed. The following former routes no longer exist:

- `/api/health` and `/api/fetch`
- `/ip`, `/ipinfo`, and `/ipinfo/:ip`
- `/ascii`, `/ascii/list`, and every ASCII animation stream
- `/.onion`, `/onion`, and `/tor` text endpoints
- `/studyx.ai` and `/StudyX.AI` server redirects

No serverless function, replacement proxy, fake static API, or external backend
has been added. Removed endpoints should return the static host's 404 response.
Deleted source/assets remain recoverable in Git history.

## Security and Onion discovery

The homepage includes a hash-based CSP meta policy and referrer policy, so those
protections do not depend on a server. Inline scripts/styles must match their
SHA-256 hashes; after changing an inline block, update its hash in both
`index.html` and `_headers`. The optional static tests catch stale hashes.

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

Node.js is used only for these developer checks, not to build or serve the
published website.
