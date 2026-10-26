# Deploying Keystone on Oracle Cloud (Always Free)

This is the long-form version of the deployment section in the [README](../README.md). It assumes you start with nothing on Oracle Cloud and end with Keystone reachable at `https://<your-domain>`.

The instance runs two Docker containers:

- `app` — the Node server, listening on 8080, not published to the host
- `caddy` — publishes 80 and 443, terminates TLS, proxies to `app:8080`

Caddy issues and renews the certificate automatically. You never touch a certificate file.

---

## 1. Prerequisites

- An Oracle Cloud account. The Always Free tier is enough.
- A domain name, **or** nothing at all: `<public-ip>.sslip.io` resolves to that IP and Caddy can get a real certificate for it.
- An SSH key pair. The Oracle console can generate one for you; download the private key at creation time, since it is not shown again.

---

## 2. Create the instance

Console navigation:

**Compute → Instances → Create instance**

Fill in the form as follows.

| Field | Value |
|-------|-------|
| Name | `keystone` (anything) |
| Compartment | your default compartment |
| Placement / Availability domain | any |
| Image and shape → Image | **Canonical Ubuntu 24.04** (or the newest Ubuntu listed) |
| Image and shape → Shape | `VM.Standard.A1.Flex` (Ampere, ARM) with 1 OCPU / 6 GB, or `VM.Standard.E2.1.Micro` (AMD) |
| Primary VNIC → Assign a public IPv4 address | **Yes** |
| Add SSH keys | upload your public key, or let Oracle generate a key pair and download the private key |

Leave the rest at defaults. The instance is created inside a VCN with a default security list — the next step fixes that list.

Notes:

- Ampere (`A1.Flex`) capacity in a given availability domain is often exhausted. If creation fails with an out-of-capacity error, try the other availability domains, or fall back to `VM.Standard.E2.1.Micro`.
- Both shapes are in the Always Free allowance. `E2.1.Micro` is small but sufficient; the Docker build is the heaviest step.
- Ubuntu images log in as user `ubuntu`, not `root`.

When the instance reaches **Running**, open **Compute → Instances → keystone → Instance details** and copy the **Public IP address**. You need it for DNS and for SSH.

---

## 3. Open ports 80 and 443 in the VCN security list

This is the single most common reason a deployment appears broken: the instance is up, Caddy is running, and every external connection times out. Oracle blocks inbound traffic at the network level before it ever reaches the instance's own firewall.

The VCN security list and the instance's `iptables` are **two separate layers**. Both must permit 80 and 443. `deploy/setup-oracle.sh` handles the second layer; you must handle this one by hand.

Console navigation:

**Networking → Virtual Cloud Networks → (your VCN) → Security Lists → Default Security List for (your VCN) → Add Ingress Rules**

Add two rules:

| Stateless | Source Type | Source      | IP Protocol | Source Port Range | Destination Port Range | Description |
|-----------|-------------|-------------|-------------|-------------------|------------------------|-------------|
| No        | CIDR        | `0.0.0.0/0` | TCP         | *(blank)*         | `80`                   | HTTP — ACME challenge and redirect |
| No        | CIDR        | `0.0.0.0/0` | TCP         | *(blank)*         | `443`                  | HTTPS |

Both rules are required:

- Port 80 is where Let's Encrypt validates your domain. Without it, no certificate is issued.
- Port 443 carries the site **and** the Wisp WebSocket. If it is closed, the page may load from cache but nothing will proxy.

If your instance uses a Network Security Group instead of (or in addition to) the default security list, add the same two rules there.

Optional: SSH (port 22) is open by default on Oracle images. Restricting its source to your own IP is a good idea but not required for Keystone to work.

---

## 4. Point DNS at the instance

Create an `A` record:

| Type | Name | Value |
|------|------|-------|
| A | `keystone` (or `@` for the apex) | `<public-ip>` |

Result: `keystone.example.com` → `<public-ip>`.

If you have no domain, skip this and use `<public-ip>.sslip.io` as the domain. `sslip.io` is a public DNS service that answers any `<ip>.sslip.io` query with that IP, so `203.0.113.10.sslip.io` resolves to `203.0.113.10` with no DNS setup on your side. Caddy can obtain a certificate for it normally.

Verify propagation from your own machine before continuing:

```bash
nslookup keystone.example.com
# or
dig +short keystone.example.com
```

The answer must be the instance's public IP. If it is not, fix DNS before going further — certificate issuance will fail.

---

## 5. SSH in and clone the repository

```bash
ssh -i /path/to/private-key ubuntu@<public-ip>
```

If you let Oracle generate the key pair, the file is usually downloaded as `ssh-key-YYYY-MM-DD.key`. Set permissions first:

```bash
chmod 600 /path/to/private-key
```

Then on the instance:

```bash
git clone <your-repo-url> keystone
cd keystone
```

---

## 6. Configure the domain

```bash
cp .env.example .env
nano .env
```

Set the single required value:

```dotenv
DOMAIN=keystone.example.com
```

`docker-compose.yml` uses `${DOMAIN:?Set DOMAIN in .env first}`, so compose refuses to start with a clear error if this is missing. Caddy reads the same value from its environment.

---

## 7. Bootstrap the host

```bash
bash deploy/setup-oracle.sh
```

The script:

1. Refuses to run as root. Run it as `ubuntu`.
2. Installs `ca-certificates`, `curl`, `gnupg`, and `iptables-persistent`.
3. Adds Docker's official apt repository and installs `docker-ce`, the CLI, `containerd`, `buildx`, and the compose plugin.
4. Adds your user to the `docker` group.
5. Inserts `iptables` ACCEPT rules for TCP 80 and 443 at the top of the `INPUT` chain and persists them with `netfilter-persistent save`.

Oracle's Ubuntu images ship with a restrictive `iptables` ruleset that drops most inbound traffic even when the VCN allows it. Step 5 is what makes the open ports effective.

After it finishes, **log out and back in** so the `docker` group membership takes effect. Confirm Docker works without `sudo`:

```bash
docker run --rm hello-world
```

If that prints a permission error, the group change has not applied yet.

---

## 8. Start Keystone

```bash
docker compose up -d --build
```

The first run builds the image: `npm ci`, then `npm run build` (which vendors the browser bundles into `public/`), then a slim runtime stage. Expect a few minutes on a Micro instance.

Watch it come up:

```bash
docker compose ps
docker compose logs -f caddy
```

Then open `https://keystone.example.com`. The first request triggers certificate issuance; it can take ten to thirty seconds. Once the page renders, type a URL and confirm the proxied page loads inside the frame.

---

## 9. Verification checklist

Run these in order. Each one isolates a different layer, so the first failure tells you where the problem is.

**On the instance:**

```bash
# 1. Both containers are up and app is healthy
docker compose ps

# 2. The app answers its own health check
curl -s http://127.0.0.1:8080/healthz
#    expect: {"ok":true,"uptime":<seconds>}

# 3. The app is reachable through Caddy over HTTP (ACME path + redirect)
curl -sI http://127.0.0.1/

# 4. The instance firewall allows 80 and 443
sudo iptables -S INPUT | grep -E 'dport (80|443)'
#    expect two ACCEPT rules

# 5. Caddy obtained a certificate
docker compose logs caddy | grep -i "certificate obtained"
```

**From your own machine:**

```bash
# 6. DNS points at the instance
dig +short keystone.example.com

# 7. Port 80 is open through the VCN
curl -sI http://keystone.example.com/
#    expect: 308 redirect to https://

# 8. TLS is valid and trusted
curl -sI https://keystone.example.com/
#    expect: HTTP/2 200, strict-transport-security header present

# 9. The Wisp endpoint upgrades
curl -sI https://keystone.example.com/wisp/ \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
#    expect: 101 Switching Protocols
```

**In a browser:**

- Open `https://keystone.example.com` in a Chromium-based browser.
- DevTools → Application → Service Workers: `/uv/sw.js` is listed and **activated**.
- Enter `example.com` and submit. The proxied page renders in the frame.
- DevTools → Network → WS: a connection to `wss://keystone.example.com/wisp/` shows frames moving.

---

## 10. Operating notes

**Updating:**

```bash
cd ~/keystone
git pull
docker compose up -d --build
```

Rebuild after every pull. The browser bundles are generated during the image build, so a restart alone does not pick up dependency changes.

**Logs:**

```bash
docker compose logs -f app
docker compose logs -f caddy
```

**Certificate renewal** is automatic. Caddy stores certificates in the `caddy_data` volume. Do not delete that volume unless you want to re-issue from scratch, and be aware of Let's Encrypt rate limits if you do it repeatedly.

**Stream limit.** Wisp caps concurrent streams at 200 total by default, 50 per host. The shipped `docker-compose.yml` reads `WISP_STREAM_LIMIT` from `.env`, so setting it there is enough:

```bash
# .env
WISP_STREAM_LIMIT=400
```

Then apply it:

```bash
docker compose up -d app
```

**Real client IPs.** The app trusts `X-Forwarded-For` only from `127.0.0.1` and `::1` by default. Behind Caddy in Docker, the connecting peer is the `caddy` container, not loopback. `TRUSTED_PROXIES` matches addresses exactly, so a CIDR range will not work. If you need accurate per-client IPs, pin the Docker network and use the Caddy container's address, or set `TRUSTED_PROXIES` in `.env` to that address.

**Backups.** The only state is `caddy_data` (certificates) and your `.env`. The application itself is stateless.

---

## 11. Without Docker

`deploy/keystone.service` is a hardened systemd unit that runs `node src/index.js` directly as an unprivileged `keystone` user with `HOST=127.0.0.1`. The comment block at the top of the file lists the setup sequence: create the user, copy the tree to `/opt/keystone`, run `npm ci` and `npm run build` as that user, install the unit, enable it.

In this mode you must supply TLS yourself — install Caddy or nginx on the host and reverse proxy to `127.0.0.1:8080`, including WebSocket upgrades on `/wisp/`. Keep `HOST=127.0.0.1` so the app is not directly reachable from the network.

The instance firewall rules from `deploy/setup-oracle.sh` and the VCN ingress rules are still required either way.
