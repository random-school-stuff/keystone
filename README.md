# Keystone

A clean, self-hosted web proxy: search or paste any address and load it inside a sandboxed session, served from your own domain over HTTPS.

## What it does

Keystone runs a web page that proxies other web pages. You type a URL (or a search query). A service worker in your browser rewrites and fetches the page for you, so the site you visit sees Keystone's server, not your browser. Everything runs on infrastructure you control — no third-party proxy service, no account, no external API.

The interface includes a search box, an address bar, a settings drawer (search engine and Wisp endpoint), and a light/dark theme toggle. A `/healthz` endpoint reports `{ok, uptime}` for container health checks.

## Architecture

```
  Browser
     |
     |  1. page load + service worker registration
     v
  Service Worker  (Ultraviolet 3.x, /uv/sw.js)
     |
     |  2. rewritten request
     v
  Epoxy transport  (/epoxy/index.mjs)  <- orchestrated by bare-mux
     |
     |  3. WebSocket, wss://<your-domain>/wisp/
     v
  Wisp server  (@mercuryworkshop/wisp-js, inside the Node app)
     |
     |  4. outbound HTTP/HTTPS
     v
  Target site
```

- **Ultraviolet** decodes the proxied URL inside the service worker and rewrites HTML, CSS, and JS so links and assets stay proxied.
- **bare-mux** is the transport abstraction; the page tells it which transport module to load.
- **Epoxy** is that transport. It encrypts the stream and speaks the Wisp protocol.
- **Wisp** is the server side: it accepts the WebSocket, opens the real connection to the target site, and relays bytes. It is mounted at `/wisp/` on the same Express server.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- Node.js 24 or newer (`package.json` sets `engines.node >= 24.0.0`)
- A modern browser with service worker support
- For anything other than localhost: a domain with a valid TLS certificate

## Quick start (local)

```bash
npm install
npm run build
npm start
```

Open <http://localhost:8080>.

`npm run build` is not optional. The browser bundles Ultraviolet, bare-mux, and Epoxy need are **not** committed to git; the build script copies them out of `node_modules` into `public/`. If you skip it, the server exits immediately and lists the missing files.

`http://localhost` is the only place plain HTTP works. Browsers only allow service workers on HTTPS or on `localhost`/`127.0.0.1`. On any other hostname the page will load but proxying will fail.

## Two ways to deploy

Keystone ships two independent front ends. Pick one, or run both.

| | Static site (`docs/`) | Node app (`src/`) |
|---|---|---|
| Host | GitHub Pages | Your own server |
| Serves the proxy backend | No | Yes |
| Build step on the host | None | `npm run build` |
| Needs a Wisp endpoint | Yes | No, it is built in |

GitHub Pages serves static files only, so it can host the page but not the proxy. A Pages deployment must point at a Wisp endpoint running somewhere else. The Node app provides both the page and that endpoint on one origin, which is simpler and avoids a second piece of infrastructure.

### Static site on GitHub Pages

The site is a single self-contained file, `docs/index.html`: markup, styles, and client logic all live in it. The Ultraviolet engine files sit next to it because browsers require service workers and worker scripts to be real same-origin files, and they are committed because Pages has no build step.

To publish:

1. Repo Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder **`/docs`**.
2. Set the backend URL in `docs/index.html`:

```js
const DEFAULT_WISP = "wss://your-server.example.com/wisp/";
```

Commit and push. Pages rebuilds automatically. The URL is `https://<user>.github.io/<repo>/`.

You can also leave `DEFAULT_WISP` empty and set the endpoint in the page's Settings drawer, or override it per link with `?wisp=wss://your-server/wisp/`. When no endpoint is set, the page shows a setup notice instead of failing silently.

`uv/uv.config.js` derives its base path from whichever context loads it, so the same files work at a domain root and under a Pages project subpath. `npm run build:site` refreshes the committed engine bundles after a dependency change.

### Node app on a server

See the Oracle section below.

## Deploy to Oracle Cloud (Always Free)

Target: an Ubuntu VM on Oracle Cloud's Always Free tier, running `docker compose` with two services — the Node app and Caddy for TLS.

### 1. Create the instance

Compute → Instances → Create instance. Pick an Ubuntu image, a shape in the Always Free tier, and download or keep the SSH key. Note the instance's **public IP address**.

### 2. Open ports 80 and 443 in the VCN security list

This is the step people miss. The instance firewall and the VCN security list are separate; both must allow the traffic.

Networking → Virtual Cloud Networks → your VCN → Security Lists → Default Security List → Add Ingress Rules:

| Stateless | Source Type | Source      | IP Protocol | Destination Port Range |
|-----------|-------------|-------------|-------------|------------------------|
| No        | CIDR        | `0.0.0.0/0` | TCP         | `80`                   |
| No        | CIDR        | `0.0.0.0/0` | TCP         | `443`                  |

### 3. SSH in and clone

```bash
ssh ubuntu@<public-ip>
git clone <your-repo-url> keystone
cd keystone
```

### 4. Configure the domain

```bash
cp .env.example .env
```

Edit `.env` and set `DOMAIN` to your domain, with an `A` record pointing at the public IP. If you have no domain, use `<public-ip>.sslip.io` — it resolves to that IP, and Caddy can still get a real Let's Encrypt certificate for it.

```
DOMAIN=203.0.113.10.sslip.io
```

### 5. Bootstrap the host

```bash
bash deploy/setup-oracle.sh
```

This installs Docker, adds your user to the `docker` group, and opens 80/443 in the instance's `iptables`. Log out and back in so the group membership applies.

### 6. Start it

```bash
docker compose up -d --build
```

Caddy obtains the certificate on first request. Visit `https://<your-domain>` once and wait a few seconds.

### Without Docker

`deploy/keystone.service` is a hardened systemd unit for running the Node app directly on port 8080 behind your own reverse proxy. The header comment in that file lists the setup commands. In that mode you are responsible for TLS.

Long-form walkthrough with the exact console navigation: [docs/DEPLOY-ORACLE.md](docs/DEPLOY-ORACLE.md).

## Configuration

Environment variables:

| Variable            | Default          | Used by        | Purpose                                                                 |
|---------------------|------------------|----------------|-------------------------------------------------------------------------|
| `PORT`              | `8080`           | Node app       | HTTP listen port.                                                       |
| `HOST`              | `0.0.0.0`        | Node app       | Bind address. Use `127.0.0.1` when a local reverse proxy fronts the app. |
| `DOMAIN`            | *(required)*     | Compose, Caddy | Hostname Caddy serves and issues a certificate for. Compose refuses to start without it. |
| `WISP_STREAM_LIMIT` | `200`            | Node app       | Maximum concurrent Wisp streams across all clients.                     |
| `TRUSTED_PROXIES`   | `127.0.0.1,::1`  | Node app       | Comma-separated peers allowed to set `X-Forwarded-For`; used for real client IPs. |

`PORT`, `HOST`, `WISP_STREAM_LIMIT`, and `TRUSTED_PROXIES` are read by the Node process. The shipped `docker-compose.yml` passes `PORT`, `WISP_STREAM_LIMIT`, and `TRUSTED_PROXIES` through from `.env`, and reads `DOMAIN` for Caddy. The per-host stream cap (50) and the private/loopback IP blocks are fixed in `src/index.js`.

Set `TRUSTED_PROXIES` to the address your reverse proxy connects from when the app is not reached directly. Under the bundled compose setup, Caddy reaches the app over the Docker network, so the source address is the `caddy` container rather than loopback.

The Wisp endpoint is `ws://<host>:<port>/wisp/` locally, or `wss://<your-domain>/wisp/` behind Caddy. The client defaults to the same origin and lets you override it in the settings drawer.

## Updating

```bash
git pull
docker compose up -d --build
```

The image rebuilds and re-runs `npm run build` inside the container, so generated bundles are always fresh. Rebuild after any dependency bump.

## Troubleshooting

**The page loads but nothing proxies.**
The browser cannot reach the Wisp endpoint. Check that `/wisp/` upgrades succeed — a proxy or load balancer in front of the app must forward WebSocket upgrades, and Caddy's `reverse_proxy` does this automatically. If you override the Wisp URL in settings, it must match the scheme of the page: `wss://` on an HTTPS page, `ws://` on HTTP. Mixed content (`ws://` from an `https://` page) is blocked by the browser. Also confirm the host in the Wisp URL is the host you actually reach Keystone on.

**The service worker will not register.**
Service workers require a secure context. Serve Keystone over HTTPS, or use `http://localhost` / `http://127.0.0.1`. Private LAN IPs such as `http://192.168.1.10` do not work.

**Caddy returns 502.**
The `app` container is down or unhealthy. Check `docker compose ps` and `docker compose logs app`. A common cause is a failed build, or a missing `public/uv/uv.config.js`.

**The certificate is never issued.**
Let's Encrypt must reach port 80 on your host, and DNS must already resolve to it. Confirm the `A` record, confirm port 80 is open in the VCN security list (not just the instance firewall), and check `docker compose logs caddy` for the ACME error. Recreating the instance changes the public IP; update DNS.

**Sites that require login break.**
Proxying rewrites URLs, cookies, and origins. Some login flows, OAuth redirects, and anti-bot checks will fail. This is a limitation of URL-rewriting proxies, not a misconfiguration. Try the site without the proxy to confirm.

## Legal

Keystone is a general-purpose proxying tool. Whoever runs an instance is responsible for how it is used and for complying with applicable law, the rules of the sites being accessed, and the terms of their hosting provider. Do not use it to bypass access controls you are not authorized to bypass.

## License

GNU AGPL v3. See [LICENSE](LICENSE). This project bundles components that carry that license.
