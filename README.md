# Keystone

A clean web proxy: search or paste any address and load it inside a sandboxed session.

Keystone is two things that ship together:

1. A **static site** in `docs/`. One self-contained HTML file plus the engine bundles it needs. This is the primary deployment and it runs on GitHub Pages at <https://random-school-stuff.github.io/keystone/>.
2. A **Node app** in `src/`. It serves its own page and also runs the proxy backend (a Wisp endpoint) at `/wisp/`. It deploys to a server, such as Oracle Cloud's Always Free tier.

The static site cannot proxy anything by itself. It is a browser page; the network work happens at a Wisp endpoint hosted somewhere else. The Node app provides both halves on one origin.

## What it does

You type a URL or a search query. A service worker in your browser rewrites and fetches the page for you, so the site you visit sees the proxy server's address, not yours. The interface has a search box, a settings drawer (theme, proxy engine, proxy server, transport, search engine), a quick theme toggle, and a connection status pill in the top bar.

## Themes

Seven themes ship in the page, all defined as token blocks in one stylesheet. The default, **Ember**, is built from the logo's amber-to-ember palette. **Indigo** is the blue/teal scheme the site used before, kept selectable.

| Theme | Scheme | Notes |
|---|---|---|
| Ember | dark | Default. Amber and ember, taken from the logo |
| Daylight | light | Warm white |
| Indigo | dark | The original blue/teal scheme |
| Neon | dark | Magenta and cyan on deep violet |
| Forest | dark | Green |
| Candy | light | Pink |
| Sepia | light | Cream paper |

Pick one in **Settings → Appearance**. The choice applies immediately, is remembered per browser, and every theme is verified at 4.5:1 contrast or better for body, muted and accent text. The header logo and favicon are generated from `Logo/logo.png` by `npm run build:logo`.

## Proxy engines

Three interchangeable engines are selectable in settings. Each is a separate service worker under its own path, and only the selected one is downloaded.

| Engine | Role | Service worker | Notes |
|---|---|---|---|
| **Scramjet** 1.1.0 | Default | `docs/scram/sw.js` | Successor to Ultraviolet, maintained by Mercury Workshop, CAPTCHA support, best site coverage |
| **Ultraviolet** 3.2.10 | Legacy | `docs/uv/sw.js` | Upstream is deprecated and unmaintained |
| **Keystone** | Built in | `docs/keystone/sw.js` | Written for this repo. Rewrites HTML and CSS only; no JavaScript emulation |

Keystone is the smallest of the three and the most limited. It handles static pages well and largely does not handle sites that are JavaScript applications. Scramjet is the default for that reason.

## How a request flows

```text
  Browser page (docs/index.html or public/index.html)
     |
     |  1. service worker registration, transport setup
     v
  Service worker  (the selected engine: scram/, uv/, or keystone/)
     |
     |  2. rewritten request
     v
  Epoxy transport  (.../epoxy/index.mjs)  <- orchestrated by bare-mux
     |
     |  3. WebSocket to the Wisp endpoint
     v
  Wisp server  (@mercuryworkshop/wisp-js, at /wisp/)
     |
     |  4. outbound HTTP/HTTPS
     v
  Target site
```

- **The engine** decodes the proxied URL inside the service worker and rewrites HTML, CSS, and (in Scramjet and Ultraviolet) JavaScript so links and assets stay proxied.
- **bare-mux** is the transport abstraction. The page tells it which transport module to load.
- **Epoxy** is that transport. It encrypts the stream and speaks the Wisp protocol. Libcurl is available as an alternative.
- **Wisp** is the server side. It accepts the WebSocket, opens the real connection to the target site, and relays bytes.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Two deployment targets

|  | Static site (`docs/`) | Node app (`src/`) |
|---|---|---|
| Host | GitHub Pages | Your own server |
| Serves the proxy backend | No | Yes, at `/wisp/` |
| Build step on the host | None | `npm run build` |
| Needs a Wisp endpoint elsewhere | Yes | No, it is built in |
| Page | `docs/index.html` (single file) | `public/index.html` |

GitHub Pages serves static files only. It cannot run the proxy backend, so a Pages deployment must point at a Wisp endpoint hosted somewhere else. The Node app serves both the page and the endpoint on one origin, which is simpler but requires a server.

## Option A: static site on GitHub Pages (primary)

The site is `docs/index.html`. Markup, CSS, and client JavaScript all live in that one file.

The engine files next to it (`docs/uv/`, `docs/scram/`, `docs/baremux/`, `docs/epoxy/`, `docs/libcurl/`) are committed to git and cannot be inlined. Browsers require service workers and worker scripts to be real same-origin files, so they have to sit beside the page as plain assets. `npm run build:site` refreshes them from `node_modules`:

```bash
npm install
npm run build:site
```

That script copies the Ultraviolet, Scramjet, bare-mux, Epoxy, and Libcurl bundles into `docs/`. It does not touch the hand-written files: `docs/uv/uv.config.js`, `docs/scram/sw.js`, `docs/keystone/`, and `docs/transports/`.

Only `baremux/index.js` is loaded by the page up front. The engine bundles are injected on demand when you pick an engine, because each bundle embeds its own copy of bare-mux and several copies on one page compete for the same `BroadcastChannel`, which breaks the transport.

### Publishing

1. Repo Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder **`/docs`**.
2. Commit and push. Pages rebuilds automatically.
3. The site is at `https://<user>.github.io/<repo>/`.

`docs/.nojekyll` is present so Pages serves the directory as-is.

### Choosing the Wisp endpoint

The site needs a Wisp server. Set it in `docs/index.html`:

```js
var DEFAULT_WISP = "wss://your-server.example.com/wisp/";
```

The value shipped in the repo is `wss://wisp.mercurywork.shop/`. That is a **public demo endpoint** shared with other people, meant for trying the page out. It is not sized or intended for real use. Run your own server for anything beyond a test; see Option B below.

The endpoint is resolved in this order:

1. The `?wisp=` query parameter, so `.../keystone/?wisp=wss://host/wisp/` overrides everything.
2. The value saved in the settings drawer, stored in `localStorage` under `keystone.wisp`.
3. `DEFAULT_WISP`.
4. Only on `localhost` or `127.0.0.1`: the same-origin `/wisp/`.

If none of those produce a value, the page shows an inline error with an "Open settings" action when you try to launch, instead of failing silently.

Input is normalized before use. `normalizeWisp()` accepts a bare host (`host` becomes `wss://host/wisp/`), converts `http://` to `ws://` and `https://` to `wss://`, and appends `/wisp/` when the path is empty.

An HTTPS page can only talk to a `wss://` endpoint. A `ws://` value is rejected both when you save it in the settings drawer and at launch, because the browser would block it as mixed content.

### Checking the endpoint

The settings drawer has a **Test** button. It opens a real WebSocket to the address and reports whether the server answered, with an 8 second timeout.

The pill in the top bar shows the current state:

| State | Meaning |
|---|---|
| `checking` | A launch is in progress |
| `ready` | An endpoint is configured and allowed on this page |
| `ok` | The transport was installed and the session opened |
| `fail` | The page is HTTPS and the endpoint is `ws://`, or the launch failed |
| `unset` | No endpoint is configured |

Clicking the pill opens the settings drawer.

### Previewing locally

Serve `docs/` over `http://localhost` with any static file server:

```bash
python -m http.server 8080 --directory docs
```

Then open <http://localhost:8080>. Service workers require a secure context: `http://localhost` and `http://127.0.0.1` qualify, other plain-HTTP hosts do not.

## Option B: Node app on a server

The Node app serves its own page from `public/` and runs the Wisp endpoint at `/wisp/` on the same origin. Its page defaults to that endpoint, so no configuration is needed.

### Local

```bash
npm install
npm run build
npm start
```

Open <http://localhost:8080>.

`npm run build` is not optional. The browser bundles are generated, not committed, and the server exits immediately with a list of missing files if you skip it.

### Oracle Cloud

Target: an Ubuntu VM on Oracle Cloud's Always Free tier, running `docker compose` with two services, the Node app and Caddy for TLS.

1. Create an Ubuntu instance. Note its public IP.
2. Open TCP 80 and 443 in the VCN security list. The VCN rules and the instance firewall are separate layers; both must allow the traffic.
3. `ssh ubuntu@<public-ip>`, clone the repo, `cd` into it.
4. `cp .env.example .env`, then set `DOMAIN` to your domain, with an `A` record pointing at the public IP. Without a domain, `<public-ip>.sslip.io` works and Caddy can still get a real certificate.
5. `bash deploy/setup-oracle.sh` installs Docker and opens 80/443 in `iptables`. Log out and back in so the `docker` group applies.
6. `docker compose up -d --build`.

Caddy obtains the certificate on the first request. Visit `https://<your-domain>` and wait a few seconds.

Full walkthrough with the exact console navigation and a verification checklist: [docs/DEPLOY-ORACLE.md](docs/DEPLOY-ORACLE.md).

Without Docker, `deploy/keystone.service` is a hardened systemd unit that runs the Node app on port 8080 behind your own reverse proxy. In that mode you supply TLS yourself.

## Repository layout

| Path | Contents |
|---|---|
| `docs/index.html` | The GitHub Pages site. Self-contained. |
| `docs/logo.png`, `docs/favicon.png`, `docs/apple-touch-icon.png` | Generated from `Logo/logo.png` by `npm run build:logo` |
| `docs/uv/`, `docs/scram/`, `docs/baremux/`, `docs/epoxy/`, `docs/libcurl/` | Committed engine and transport bundles for the Pages site |
| `docs/keystone/` | The built-in Keystone engine: config, service worker, runtime shim |
| `docs/transports/libcurl.mjs` | Adapter that normalizes the header shape bare-mux passes to libcurl |
| `Logo/logo.png` | Source artwork for the brand mark and icons |
| `public/` | The Node app's page and its generated engine bundles |
| `src/index.js` | Node server: static files, `/wisp/` upgrade, `/healthz` |
| `scripts/build.mjs` | Vendors bundles into `public/` |
| `scripts/build-site.mjs` | Vendors bundles into `docs/` |
| `scripts/build-logo.mjs` | Crops and downsamples the logo into the three served PNGs |
| `deploy/` | Caddyfile, Oracle host setup script, systemd unit |

## Configuration

Environment variables, read by the Node app:

| Variable | Default | Used by | Purpose |
|---|---|---|---|
| `PORT` | `8080` | Node app | HTTP listen port |
| `HOST` | `0.0.0.0` | Node app | Bind address. Use `127.0.0.1` when a local reverse proxy fronts the app |
| `DOMAIN` | *(required)* | Compose, Caddy | Hostname Caddy serves and issues a certificate for. Compose refuses to start without it |
| `WISP_STREAM_LIMIT` | `200` | Node app | Maximum concurrent Wisp streams across all clients |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | Node app | Comma-separated peers allowed to set `X-Forwarded-For`, used for real client IPs |

The per-host stream cap (50) and the private/loopback IP blocks are fixed in `src/index.js`.

Under the bundled compose setup, Caddy reaches the app over the Docker network, so the connecting peer is the `caddy` container rather than loopback. Set `TRUSTED_PROXIES` to that address if you want forwarded client IPs honored.

The Pages site has no environment variables. Its only configuration is `DEFAULT_WISP` in `docs/index.html`, the settings drawer, and the `?wisp=` parameter.

## Limitations

These are properties of URL-rewriting proxies and of the upstream sites, not bugs to file.

- **Bot detection.** Google search, Reddit, and similar sites often return "unusual traffic" or "blocked by network security" pages when reached through a shared or datacenter IP. That is the destination site's policy about the address the proxy connects from.
- **Heavy client-rendered apps.** YouTube and similar sites may load only their shell, because parts of the page cannot be rewritten or fetched through the proxy.
- **Login flows.** OAuth redirects, cookie-bound sessions, and CSRF checks often break, since URLs and origins are rewritten.
- **Simple pages work.** Wikipedia and GitHub render fully.
- **No authentication.** Anyone who finds the URL can use the proxy.
- **The proxy server's IP is the one sites see.** Abuse complaints go to whoever runs the server.

## Troubleshooting

**The page loads but nothing proxies.**
The browser cannot reach the Wisp endpoint. Use the Test button in settings. A reverse proxy or load balancer in front of the server must forward WebSocket upgrades; Caddy's `reverse_proxy` does this automatically.

**"This page is served over HTTPS, but the proxy server uses ws://".**
Mixed content. Change the endpoint to `wss://`. This applies to the Pages site, which is always HTTPS.

**The pill says "Not set".**
No endpoint resolved. Set `DEFAULT_WISP`, save one in settings, or pass `?wisp=`.

**The service worker will not register.**
Service workers require a secure context. Use HTTPS, or `http://localhost` / `http://127.0.0.1`. Private LAN addresses such as `http://192.168.1.10` do not work.

**Pages serves a 404.**
Pages Source must be set to branch `main`, folder `/docs`, and the page must be reached at `https://<user>.github.io/<repo>/`, not at the repo root.

**Caddy returns 502.**
The `app` container is down or unhealthy. Check `docker compose ps` and `docker compose logs app`. A common cause is a failed build, or a missing `public/uv/uv.config.js`.

**The certificate is never issued.**
Let's Encrypt must reach port 80, and DNS must already resolve to the host. Confirm the `A` record and the VCN ingress rule, then check `docker compose logs caddy` for the ACME error.

## Legal

Keystone is a general-purpose proxying tool. Whoever runs an instance is responsible for how it is used and for complying with applicable law, the rules of the sites being accessed, and the terms of their hosting provider. Do not use it to bypass access controls you are not authorized to bypass.

## License

GNU AGPL v3. See [LICENSE](LICENSE). This project bundles components that carry that license.
