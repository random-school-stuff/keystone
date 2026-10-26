# Architecture

Keystone is a small Node server plus a browser-side proxy engine. This document explains what each piece does, how a request moves through the system, and the decisions behind the parts that are not obvious.

---

## 1. Components

| Component | Package / file | Runs where | Role |
|-----------|----------------|-----------|------|
| Node server | `src/index.js` | Server | Serves static files, mounts the Wisp upgrade endpoint, exposes `/healthz` |
| Wisp server | `@mercuryworkshop/wisp-js` 0.5.1 | Server | Accepts WebSocket streams and makes the real outbound connections |
| Ultraviolet | `@titaniumnetwork-dev/ultraviolet` 3.2.10 | Browser service worker | Rewrites and serves proxied pages |
| bare-mux | `@mercuryworkshop/bare-mux` 2.1.9 | Browser page + worker | Transport abstraction; loads and switches transport modules |
| Epoxy | `@mercuryworkshop/epoxy-transport` 2.1.29 | Browser worker | Encrypted transport that speaks Wisp over a WebSocket |
| Caddy | `caddy:2-alpine` | Server (container) | TLS termination, HTTP/2, reverse proxy, WebSocket passthrough |
| Express | `express` 5.x | Server | Static file serving and routing |

Two of these are server-side and three are browser-side. The split matters: Ultraviolet never touches the network directly. It hands work to a transport, and the transport hands it to Wisp.

---

## 2. Request flow

### 2.1 First page load

```
Browser --GET /--> Caddy --> Express static --> public/index.html
```

The page loads `baremux/index.js`, `uv/uv.bundle.js`, `uv/uv.config.js`, `register-sw.js`, `search.js`, and `app.js`, in that order. `register-sw.js` registers `/uv/sw.js` as the service worker.

`public/uv/uv.config.js` is the piece that connects Ultraviolet to this deployment. It sets the URL prefix that proxied requests carry and points at the sibling bundle files:

```js
self.__uv$config = {
	prefix: "/uv/service/",
	encodeUrl: Ultraviolet.codec.xor.encode,
	decodeUrl: Ultraviolet.codec.xor.decode,
	handler: "/uv/uv.handler.js",
	client: "/uv/uv.client.js",
	bundle: "/uv/uv.bundle.js",
	config: "/uv/uv.config.js",
	sw: "/uv/uv.sw.js",
};
```

### 2.2 Selecting a transport

`app.js` creates a `BareMuxConnection` against `/baremux/worker.js`. On the first launch it installs Epoxy and tells it where the Wisp server is:

```js
await connection.setTransport("/epoxy/index.mjs", [{ wisp: wispUrl }]);
```

The Wisp URL defaults to the current origin — `wss://<host>/wisp/` on HTTPS, `ws://<host>/wisp/` on HTTP. The settings drawer can override it, and changing it forces a fresh transport on the next launch.

The result is cached in `activeWisp` so repeated launches do not reinstall the transport.

### 2.3 Navigating to a proxied URL

```
Browser
  |  GET /uv/service/<encoded target URL>
  v
Service worker (/uv/sw.js)
  |  decode target, build request through the transport
  v
bare-mux worker  ->  Epoxy  ->  WebSocket wss://<host>/wisp/
  v
Express upgrade handler  ->  Wisp server
  |  outbound HTTPS
  v
Target site
  |  response
  v
Wisp  ->  Epoxy  ->  service worker
  |  rewrite HTML/CSS/JS so links and assets stay under /uv/service/
  v
iframe in the page
```

The proxied page is rendered inside an iframe (`#uv-frame`). Ultraviolet rewrites absolute URLs, injects its client script, and redirects navigations back through the service worker, so following a link inside the frame keeps the session proxied.

### 2.4 The Wisp upgrade path

The Node server attaches a raw `upgrade` listener to its HTTP server:

```js
server.on("upgrade", (req, socket, head) => {
	// ...
	if (pathname === "/wisp/" || pathname === "/wisp") {
		wisp.routeRequest(req, socket, head);
		return;
	}
	socket.destroy();
});
```

Only `/wisp/` (and `/wisp`) reaches Wisp. Any other upgrade path is destroyed immediately, so nothing else on the host can be reached through a stray WebSocket. Caddy forwards the upgrade because `reverse_proxy` handles WebSocket transparently — no special directive is needed.

---

## 3. Why the browser bundles are generated, not committed

`scripts/build.mjs` copies files out of `node_modules` into `public/`:

| Source package | Destination | Files |
|----------------|-------------|-------|
| `@titaniumnetwork-dev/ultraviolet` (`uvPath`) | `public/uv/` | `sw.js`, `uv.bundle.js`, `uv.client.js`, `uv.handler.js`, `uv.sw.js` |
| `@mercuryworkshop/bare-mux` (`baremuxPath`) | `public/baremux/` | `worker.js`, `index.js`, `index.mjs` |
| `@mercuryworkshop/epoxy-transport` (`epoxyPath`) | `public/epoxy/` | `index.mjs` |

The build resolves those directories from the packages themselves rather than hard-coding paths, so an upstream layout change surfaces as a build error instead of a silently stale file.

Why not commit them:

1. **One source of truth.** `package.json` and `package-lock.json` pin the versions. Copied bundles in git can drift from the installed packages, and a reader cannot tell which one is authoritative. Here, `public/` is derived output.
2. **No manual upgrades.** Bumping Ultraviolet is `npm install` plus a rebuild. Nothing has to be re-copied by hand, and nothing can be forgotten.
3. **Smaller history.** These are compiled bundles, some hundreds of kilobytes each. Committing them adds noise and merge conflicts on every dependency change.
4. **Reproducible builds.** The Docker build runs `npm ci && npm run build`, so the image always contains bundles matching the lockfile.

The exception is `public/uv/uv.config.js`. It is hand-written, kept in git, and deliberately excluded from the copy list. It is the one file that must differ from upstream — it carries Keystone's URL prefix and absolute asset paths. Leaving it out of the build means the upstream bundle is used unmodified and the local override is never overwritten.

Because the bundles are absent in a fresh clone, `src/index.js` verifies them at startup and exits with a clear message if any are missing:

```
Missing browser bundles:
  public/uv/uv.bundle.js
  ...
Run `npm run build` first, then start the server again.
```

The check covers `uv/uv.bundle.js`, `uv/uv.sw.js`, `uv/uv.config.js`, `baremux/index.js`, and `epoxy/index.mjs` — one representative from each vendored group plus the hand-written config. `uv.config.js` is included on purpose: a fresh clone without it fails the same way, which is the correct outcome.

`.gitignore` excludes exactly the copied files, not all of `public/`, so the hand-written assets stay tracked:

```
public/uv/sw.js
public/uv/uv.bundle.js
public/uv/uv.client.js
public/uv/uv.handler.js
public/uv/uv.sw.js
public/baremux/
public/epoxy/
```

---

## 4. Security posture

Keystone is a public proxy endpoint. Anyone who can reach `/wisp/` can ask the server to fetch arbitrary URLs, and those requests originate from your server's IP. The defaults are set accordingly.

### 4.1 Wisp refuses internal addresses

```js
wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;
```

Without these, a visitor could use the proxy to reach RFC1918 addresses, `127.0.0.1`, or link-local metadata endpoints from inside your network — effectively turning the proxy into an SSRF pivot into your VCN, your other containers, and cloud instance metadata. Both are disabled.

`allow_direct_ip` is left enabled: connections to a literal public IP are allowed, which some sites need. Private and loopback ranges are still blocked, so a literal IP that falls inside them is rejected by the checks above.

### 4.2 Stream limits

```js
wisp.options.stream_limit_total = Number(process.env.WISP_STREAM_LIMIT ?? 200);
wisp.options.stream_limit_per_host = 50;
```

Each proxied request, subresource, and WebSocket is a stream. The limits bound two failure modes:

- **Total (default 200, `WISP_STREAM_LIMIT`)** — caps how much memory and how many outbound sockets one instance can hold. Without it, a single client opening many tabs could exhaust the process.
- **Per host (50)** — prevents one client from monopolizing the budget against a single destination, and limits the amplification a single target can cause.

These are deliberately modest. Raise the total if you have few users and heavy pages; the per-host cap is fixed in code.

### 4.3 Real client IP handling

```js
const trustedProxies = (process.env.TRUSTED_PROXIES ?? "127.0.0.1,::1")...;
wisp.options.parse_real_ip = true;
wisp.options.parse_real_ip_from = trustedProxies;
```

`X-Forwarded-For` is trivially spoofable. If the server trusted it from anyone, a client could forge an address and sidestep per-client accounting. Trust is restricted to a configured peer list, defaulting to loopback. Only those peers may set the header used for real-IP parsing.

Behind the bundled Caddy container, the connecting peer is the `caddy` service address rather than loopback. Set `TRUSTED_PROXIES` to that address if you want forwarded IPs honored in that topology.

### 4.4 HTTP surface

The Express app is intentionally thin:

- `x-powered-by` is disabled, so the framework and version are not advertised.
- `X-Content-Type-Options: nosniff` is set on every response.
- `Referrer-Policy: no-referrer` is set on every response.
- Unknown routes return `public/404.html` with status 404.
- Static caching is split: HTML is `no-cache` (the shell must not go stale), while `/uv/`, `/baremux/`, and `/epoxy/` are `public, max-age=86400` (versioned vendor assets).
- `/healthz` returns `{ok, uptime}` and nothing else — no version, no dependency detail.

Caddy adds TLS and a year-long HSTS header, and strips the `Server` header.

### 4.5 Transport and process hardening

- Epoxy encrypts the browser-to-server stream, so an observer between the client and Keystone sees ciphertext rather than the proxied URLs.
- The container runs as the unprivileged `node` user, not root, with only `public/`, `src/`, `node_modules/`, and `package.json` copied into the runtime stage.
- The non-Docker systemd unit (`deploy/keystone.service`) applies `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome`, `ProtectKernelTunables`, `ProtectControlGroups`, and restricts address families to `AF_INET`, `AF_INET6`, and `AF_UNIX`. It binds `HOST=127.0.0.1` so only the local reverse proxy can reach it.
- SIGINT and SIGTERM trigger a graceful close with a 5-second ceiling, so open proxy streams cannot block a restart indefinitely.

### 4.6 What is not protected

- **No authentication.** Anyone who finds the URL can use the proxy. If you need access control, put it in front — Cloudflare Access, an nginx `auth_basic`, a VPN, or an IP allowlist in the VCN.
- **No per-client rate limiting.** Stream limits are global and per-host, not per IP. A determined client can consume the whole budget.
- **No content filtering.** Keystone does not block categories of sites.
- **Your IP is the one sites see.** Abuse complaints arrive at your hosting provider and your account.

The operator is responsible for what the instance is used for.

---

## 5. Server lifecycle

```
startup
  |- verify browser bundles exist          -> exit 1 with a list if not
  |- configure Wisp options
  |- build Express app (headers, /healthz, static, 404)
  |- attach the upgrade listener for /wisp/
  +- listen on HOST:PORT                   (default 0.0.0.0:8080)

shutdown (SIGINT / SIGTERM)
  |- stop accepting connections
  +- force exit after 5s if streams are still open
```

The Docker image has a `HEALTHCHECK` that fetches `/healthz` every 30 seconds, and `docker-compose.yml` sets `restart: unless-stopped` on both services, so a crashed app container is restarted and Caddy reconnects to it.

---

## 6. Configuration summary

| Variable | Default | Effect |
|----------|---------|--------|
| `PORT` | `8080` | HTTP listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `DOMAIN` | — | Caddy site address and certificate name; compose requires it |
| `WISP_STREAM_LIMIT` | `200` | `wisp.options.stream_limit_total` |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | Peers allowed to set `X-Forwarded-For` for real-IP parsing |

The per-host stream cap (50) and the private/loopback IP blocks are hard-coded in `src/index.js` and are not configurable by environment.
