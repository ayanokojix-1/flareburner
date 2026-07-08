# flareburner

A small HTTP API that opens pages in a **real Chrome browser** to get past
Cloudflare ("Just a moment…") challenges, then hands you back the page's
**cookies** and **HTML** — or raw image bytes, or the result of any request you
want routed through it. Built on
[`puppeteer-real-browser`](https://www.npmjs.com/package/puppeteer-real-browser).

Use it like an API: `POST` a URL, get back the solved page.

- Warm **browser pool** — Chrome stays running between requests (fast, handles concurrency).
- **Cookie reuse / fast-path** — replay a previous `cf_clearance` and skip the browser when possible.
- **Per-request options** — choose what's returned (html / cookies / json), take screenshots, set headers, etc.
- **Binary passthrough** (`POST /binary`) — fetch a Cloudflare-protected image (or any binary) and stream back the **raw bytes**.
- **General proxy** (`POST /fetch`) — run any request (method/headers/body) from flareburner's host using its solved clearance.
- **Health endpoint + optional API key** — safe to expose.

---

## Table of contents

- [Quick start (from scratch)](#quick-start-from-scratch)
  - [Step 1 — Get the code](#step-1--get-the-code)
  - [Step 2 — Install the prerequisites](#step-2--install-the-prerequisites)
  - [Step 3 — Install dependencies](#step-3--install-dependencies)
  - [Step 4 — Start the server](#step-4--start-the-server)
  - [Step 5 — Make your first request](#step-5--make-your-first-request)
- [Even easier: run with Docker](#even-easier-run-with-docker)
- [Configuration (.env)](#configuration-env)
- [The secret key (API auth)](#the-secret-key-api-auth)
- [API reference](#api-reference)
  - [`GET /health`](#get-health)
  - [`GET /`](#get-)
  - [`POST /v1`](#post-v1)
  - [`POST /binary`](#post-binary)
  - [`POST /fetch`](#post-fetch)
- [Request body options (`/v1`)](#request-body-options-v1)
- [Response shapes (`/v1`)](#response-shapes-v1)
- [Cookie reuse & the fast-path](#cookie-reuse--the-fast-path)
- [curl cookbook](#curl-cookbook)
- [CLI (no server)](#cli-no-server)
- [Deploying to a server](#deploying-to-a-server)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)

---

## Quick start (from scratch)

New here? Follow these five steps in order and you'll have a working API in a
few minutes. (If you have Docker, the [Docker route](#even-easier-run-with-docker)
is even shorter — it installs Chrome for you.)

### Step 1 — Get the code

Clone the repository and move into the folder:

```bash
git clone https://github.com/arcane-nx/flareburner.git
cd flareburner
```

### Step 2 — Install the prerequisites

You need two things on your machine:

1. **Node.js 18 or newer** (20+ recommended). Check with:
   ```bash
   node -v
   ```
   If it's missing or too old, install it from [nodejs.org](https://nodejs.org/).

2. **Google Chrome (or Chromium).** flareburner drives a *real* Chrome, so one
   must be installed:
   - **Windows / macOS:** just install [Google Chrome](https://www.google.com/chrome/) normally.
   - **Linux server:** install `google-chrome-stable` (the [VPS script](#deploying-to-a-server) does this for you).

   flareburner finds Chrome automatically (`resolveChromePath()` in `index.js`
   checks the standard locations).

> **On a headless Linux server** the visible browser needs a virtual display
> (Xvfb). `puppeteer-real-browser` starts it for you; the deploy script and the
> Docker image install the `xvfb` package.

### Step 3 — Install dependencies

```bash
npm install
```

### Step 4 — Start the server

```bash
node server.js
```

You should see:

```
flareburner: warming 1 browser(s) (headless=false)…
flareburner API listening on http://0.0.0.0:4001
  GET  /health
  POST /v1   (open)
  POST /binary   (fetch protected image bytes)
  POST /fetch    (general Cloudflare-solving proxy)
```

That `(open)` means no API key is set yet — anyone who can reach the port can
use it. See [the secret key](#the-secret-key-api-auth) to lock it down.

Other ways to start it:

```bash
node server.js 8080   # override the port
npm start             # same as: node server.js
```

### Step 5 — Make your first request

In a **second terminal**, send a URL and get the solved page back:

```bash
curl -X POST http://localhost:4001/v1 \
  -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl"}'
```

You'll get JSON containing the page `title`, its `cookies` (including
`cf_clearance` if Cloudflare was solved), and the page `html`. 🎉

That's it — you're running. The rest of this README is reference material for
when you want to do more.

---

## Even easier: run with Docker

If you have Docker, you don't need to install Node or Chrome at all — they're
baked into the image.

```bash
git clone https://github.com/arcane-nx/flareburner.git
cd flareburner

docker compose up -d --build      # build + start in the background
docker compose logs -f            # watch the logs
```

Then make the same [first request](#step-5--make-your-first-request) against
`http://localhost:4001/v1`. To stop it: `docker compose down`.

More Docker detail (env vars, `--shm-size`, plain `docker run`) is in
[Deploying](#deploying-to-a-server).

---

## Configuration (.env)

All settings are optional. To change them, copy the example file and edit it:

```bash
cp .env.example .env
```

Config is loaded in this order (later wins): **`.env` file → real environment
variables → CLI port argument**.

| Variable      | Default               | Description |
|---------------|-----------------------|-------------|
| `PORT`        | `4001`                | HTTP port. (CLI arg `node server.js <port>` overrides everything.) |
| `API_KEY`     | *(empty)*             | If set, `POST /v1`, `/binary` and `/fetch` require this key. Empty = open. |
| `POOL_SIZE`   | `1`                   | Number of warm Chrome instances = max concurrent browser requests. |
| `HEADLESS`    | `false`               | Run Chrome headless. Cloudflare is harder to beat headless — keep `false` unless your target doesn't challenge. |
| `NAV_TIMEOUT` | `60000`               | Navigation + Cloudflare-wait timeout, in ms. |
| `DEFAULT_URL` | `https://nowsecure.nl`| URL used when a `/v1` request omits `url`. |

Example `.env`:

```ini
PORT=4001
API_KEY=
POOL_SIZE=2
HEADLESS=false
NAV_TIMEOUT=60000
DEFAULT_URL=https://nowsecure.nl
```

> Changes to `.env` require a **server restart** (config is read once at startup).

---

## The secret key (API auth)

`API_KEY` is an optional shared secret that protects the `POST` endpoints
(`/v1`, `/binary`, `/fetch`). `GET /health` and `GET /` stay open regardless.

**Enable it:** set a value in `.env` and restart:

```ini
API_KEY=my-super-secret-key
```

The startup log will then show `POST /v1 (API key required)`.

**Send the key** with every protected request — either header works:

```bash
# Header form
curl -X POST http://localhost:4001/v1 \
  -H "Content-Type: application/json" \
  -H "X-API-Key: my-super-secret-key" \
  -d '{"url":"https://nowsecure.nl"}'

# Bearer form
curl -X POST http://localhost:4001/v1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-super-secret-key" \
  -d '{"url":"https://nowsecure.nl"}'
```

- **Missing / wrong key →** `401 {"error":"Unauthorized"}`.
- **Disable auth →** set `API_KEY=` (empty) in `.env` and restart.

> The key is a plain shared secret. Always pair it with HTTPS (e.g. behind nginx)
> when exposing the service publicly, so the key isn't sent in the clear.

---

## API reference

Base URL: `http://localhost:4001`

### `GET /health`

Liveness probe + pool stats. Never requires a key.

```bash
curl http://localhost:4001/health
```

```json
{ "status": "ok", "uptimeSeconds": 42, "pool": { "size": 1, "busy": 0 } }
```

### `GET /`

Self-describing usage/help, including the request body schema and whether auth is on.

```bash
curl http://localhost:4001/
```

### `POST /v1`

Scrape a URL. **JSON body**, `Content-Type: application/json`. Requires the API
key only if `API_KEY` is configured.

Minimal:

```bash
curl -X POST http://localhost:4001/v1 \
  -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl"}'
```

See [Request body options](#request-body-options-v1) and
[Response shapes](#response-shapes-v1) for everything you can send and get back.

| Situation | Response |
|---|---|
| Method other than POST | `405 Method not allowed` |
| Body isn't valid JSON  | `400 Invalid JSON body` |
| Unknown route          | `404 Not found` |
| Scrape failed          | `500 {"error": "..."}` |

### `POST /binary`

Fetch a **Cloudflare-protected binary** — typically an image — and stream back
the **raw bytes** (not JSON, not HTML). Same auth as `/v1`.

**Why this exists:** `/v1` only ever returns text (html / cookies / json), and a
`cf_clearance` cookie is bound to the **IP that solved it**. So a caller on
another machine can't take flareburner's cookies and fetch the image directly —
Cloudflare would challenge *their* IP. Route the image through `/binary` instead
and flareburner fetches it from its own (already-cleared) IP.

**How it resolves (cheap first, browser only if needed):**

1. **Fast-path (no Chrome).** A plain `fetch` from flareburner's host using the
   most-recently-harvested clearance (cookies + UA from the last solve). Most
   images come back this way — concurrently, without touching the size-limited
   browser pool.
2. **Browser fallback.** If the fast-path is challenged, it leases a warm
   browser, navigates to the resource to solve the origin, reads the real bytes
   from the navigation response, and refreshes the cached clearance so
   subsequent images go back to the fast-path.

JSON body:

| Field     | Type   | Default       | Description |
|-----------|--------|---------------|-------------|
| `url`     | string | *(required)*  | The binary/image URL to fetch. |
| `timeout` | number | `NAV_TIMEOUT` | Fetch + challenge timeout, in ms. |

The response is the raw resource with its upstream `Content-Type` and a
`Cache-Control: public, max-age=86400` header.

```bash
# Fetch a protected image and save it to disk
curl -X POST http://localhost:4001/binary \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/protected/image.webp"}' \
  -o image.webp
```

| Situation | Response |
|---|---|
| Method other than POST   | `405 Method not allowed` |
| Body isn't valid JSON    | `400 Invalid JSON body` |
| Missing `url`            | `400 {"error":"url is required"}` |
| Fetch failed / challenged| `502 {"error": "..."}` |

> Best for content-addressed assets (images, fonts) where the bytes matter. For
> HTML/JSON pages use [`POST /v1`](#post-v1).

### `POST /fetch`

A **general-purpose Cloudflare-solving proxy**. Where `/v1` navigates a page in
the browser and `/binary` returns raw bytes, `/fetch` runs **any HTTP request you
describe** (method, headers, body, redirect mode) *from flareburner's host* using
its solved clearance — and returns the status, headers, any `Set-Cookie`s, and
the body as text.

**Why this exists:** some flows are multi-step — e.g. POST a form that `302`s to a
real media URL. The caller can't do this themselves because `cf_clearance` is
bound to flareburner's IP + User-Agent. `/fetch` lets you drive that request
through flareburner without ever holding the clearance yourself.

It resolves the same cheap-first way as `/binary`: try the cached-clearance
fast-path; if challenged, solve the request's origin in the browser, harvest
fresh clearance, then replay.

JSON body:

| Field      | Type   | Default       | Description |
|------------|--------|---------------|-------------|
| `url`      | string | *(required)*  | Target URL. |
| `method`   | string | `"GET"`       | HTTP method (`GET`, `POST`, …). |
| `headers`  | object | —             | Extra request headers. |
| `body`     | string | —             | Request body (for `POST`/`PUT`/…). |
| `redirect` | string | `"follow"`    | `"follow"` or `"manual"` (use `manual` to capture a `Location` instead of following it). |
| `timeout`  | number | `NAV_TIMEOUT` | Request + challenge timeout, in ms. |

Response (JSON):

```json
{
  "url": "https://example.com/final",
  "status": 200,
  "headers": { "content-type": "application/json", "...": "..." },
  "setCookie": ["session=…; Path=/"],
  "body": "…response body as text…",
  "via": "fetch"
}
```

```bash
# Follow a form POST that redirects to the real URL
curl -X POST http://localhost:4001/fetch \
  -H "Content-Type: application/json" \
  -d '{
        "url":"https://example.com/submit",
        "method":"POST",
        "headers":{"Content-Type":"application/x-www-form-urlencoded"},
        "body":"_token=abc&id=123",
        "redirect":"manual"
      }'
```

| Situation | Response |
|---|---|
| Method other than POST | `405 Method not allowed` |
| Body isn't valid JSON  | `400 Invalid JSON body` |
| Missing `url`          | `400 {"error":"url is required"}` |
| Failed / challenged    | `502 {"error": "..."}` |

---

## Request body options (`/v1`)

All fields are optional except that you'll usually want `url`.

| Field             | Type      | Default            | Description |
|-------------------|-----------|--------------------|-------------|
| `url`             | string    | `DEFAULT_URL`      | Target URL. |
| `cookies`         | array     | —                  | Cookies to load before navigating. Enables the [fast-path](#cookie-reuse--the-fast-path). Use a `cookies` array from a previous response. |
| `userAgent`       | string    | Chrome's default   | Override the User-Agent. Match the one that produced your cookies for reuse. |
| `headers`         | object    | —                  | Extra HTTP headers, e.g. `{"Accept-Language":"en-US"}`. |
| `returnType`      | string    | `"full"`           | `"full"` \| `"html"` \| `"cookies"` \| `"json"`. |
| `screenshot`      | boolean   | `false`            | Include a base64 PNG (`screenshot` field). Forces the browser path. |
| `waitUntil`       | string    | `"domcontentloaded"` | Puppeteer wait condition: `load`, `domcontentloaded`, `networkidle0`, `networkidle2`. |
| `waitForSelector` | string    | —                  | Wait for this CSS selector after load. |
| `timeout`         | number    | `NAV_TIMEOUT`      | Navigation + challenge timeout, in ms. |
| `fastPath`        | boolean   | `true`             | Set `false` to always use the browser, even with cookies. |

---

## Response shapes (`/v1`)

Every browser response includes `via: "browser"`; fast-path responses include
`via: "fetch"`.

**`returnType: "full"`** (default):

```json
{
  "url": "https://nowsecure.nl/",
  "title": "nowSecure",
  "via": "browser",
  "userAgent": "Mozilla/5.0 …",
  "cookies": [ { "name": "cf_clearance", "value": "…", "domain": "nowsecure.nl", "...": "..." } ],
  "html": "<!DOCTYPE html>…",
  "screenshot": "<base64 png, only if requested>"
}
```

- **`"html"`** → `{ url, title, via, html }`
- **`"cookies"`** → `{ url, title, via, cookies }`
- **`"json"`** → `{ url, title, via, json }` (parses the page body as JSON; falls back to `html` if it isn't JSON)

---

## Cookie reuse & the fast-path

Cloudflare's clearance cookie (`cf_clearance`) lets later requests skip the
challenge. flareburner supports two reuse modes:

1. **Fast-path (no Chrome).** When you send a `cookies` array, the server first
   tries a plain HTTP `fetch` with those cookies. If it isn't challenged, you get
   a near-instant `via: "fetch"` response.
2. **Browser fallback.** If the fast `fetch` is challenged (many sites also
   fingerprint TLS, which a plain fetch can't fake), it automatically falls back
   to the warm browser and still returns the page (`via: "browser"`).

**Easiest reuse (no `jq` needed):** a `/v1` response already contains `url` and
`cookies`, so just send the whole saved response back as the next body:

```bash
# 1) solve once, save the response
curl -s -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl"}' -o out.json

# 2) reuse — feed the file straight back
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  --data-binary @out.json
```

Check the `via` field to see which path served it.

> **Important:** `cf_clearance` is bound to your **IP address + User-Agent**.
> Reused cookies only work from the same machine/IP and with a matching
> User-Agent. That's why `full` responses echo the `userAgent` — send it back
> alongside the cookies.

---

## curl cookbook

```bash
# Health
curl http://localhost:4001/health

# Basic scrape (full)
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl"}'

# HTML only
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl","returnType":"html"}'

# Cookies only
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl","returnType":"cookies"}'

# JSON endpoint (parses the page body as JSON; falls back to html if it isn't)
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://httpbin.org/json","returnType":"json"}'

# Screenshot -> save PNG (no jq; uses node)
curl -s -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl","screenshot":true}' -o shot.json
node -e "require('fs').writeFileSync('shot.png',Buffer.from(require('./shot.json').screenshot,'base64'))"

# Custom UA + headers
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl","userAgent":"MyBot/1.0","headers":{"Accept-Language":"en-US"}}'

# Wait for a selector
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl","waitForSelector":"h1","timeout":45000}'

# Force browser (skip fast-path)
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl","fastPath":false}'

# Fetch a protected image -> save bytes
curl -X POST http://localhost:4001/binary -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/protected/image.webp"}' -o image.webp

# General proxy: run an arbitrary request through flareburner
curl -X POST http://localhost:4001/fetch -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/api","method":"GET"}'

# With API key (if enabled)
curl -X POST http://localhost:4001/v1 \
  -H "Content-Type: application/json" -H "X-API-Key: YOUR_KEY" \
  -d '{"url":"https://nowsecure.nl"}'
```

Handy flags: add `-i` to see status + headers, or
`-s -o out.json -w "HTTP %{http_code}\n"` to save the body and print just the
status code.

---

## CLI (no server)

`index.js` can open a single URL directly, print the title, and dump the cookies
and HTML to a `json/` folder:

```bash
node index.js https://nowsecure.nl
# -> json/cookies.json   (array of cookies)
# -> json/page.json      ({ url, html })
```

A URL argument is required.

---

## Deploying to a server

Two options — pick whichever fits your host:

| Option | Best for | Auto-restart |
|--------|----------|--------------|
| **A. Docker** | Anywhere with Docker (laptop, VPS, PaaS, CI). Most portable. | yes (`restart: unless-stopped`) |
| **B. VPS script** (`setup.sh`) | A bare Ubuntu/Debian box you control. Installs onto the host directly. | yes (systemd) |

### Option A — Docker

Everything (Chrome, Xvfb, fonts, deps) is baked into the image.

```bash
# docker compose (recommended)
docker compose up -d --build
docker compose logs -f
docker compose down

# or plain docker
docker build -t flareburner .
docker run -d --name flareburner -p 4001:4001 --shm-size=1g flareburner
```

Configure via environment variables (see the [config table](#configuration-env)) —
edit `docker-compose.yml`, or pass `-e`:

```bash
docker run -d -p 4001:4001 --shm-size=1g \
  -e POOL_SIZE=2 -e API_KEY=change-me flareburner
```

> **`--shm-size=1g`** matters: Docker's default 64 MB `/dev/shm` can crash Chrome.
> compose sets `shm_size: "1gb"` for you; with plain `docker run`, pass the flag.
> The image also launches Chrome with `--disable-dev-shm-usage` as a safety net.

### Option B — Linux VPS script (`setup.sh`)

`setup.sh` provisions an **Ubuntu/Debian** host end-to-end: installs Node, Google
Chrome, Xvfb and dependencies, seeds `.env`, and runs the API as a `systemd`
service. If systemd isn't available (e.g. a dev container / Codespace) it falls
back to launching with `nohup`.

> It only runs on Linux. On Windows/macOS it exits with a message — for local
> dev just use `node server.js`.

```bash
# On the VPS, from the project directory:
sudo bash setup.sh                 # serves on :4001
PORT=8080 sudo bash setup.sh       # different port
```

Manage the systemd service:

```bash
systemctl status flareburner       # state
journalctl -u flareburner -f       # live logs
systemctl restart flareburner      # after editing .env
systemctl stop flareburner         # stop
```

(no-systemd fallback: logs in `flareburner.log`, stop with `kill $(cat flareburner.pid)`.)

For either option, open the firewall / port if reaching it externally
(e.g. `sudo ufw allow 4001`), and ideally put it behind nginx with TLS —
especially when using `API_KEY`.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `{"error":"Unauthorized"}` | `API_KEY` is set. Send `X-API-Key`/`Bearer`, or clear `API_KEY=` in `.env` and restart. |
| `EADDRINUSE: …:4001` | Another instance is already on that port. Stop it, or use a different `PORT`. |
| Stuck on `"Just a moment…"` | The challenge needs the real browser; ensure `HEADLESS=false`. Increase `timeout` for slow networks. |
| `Attempted to use detached Frame` | Transient Cloudflare re-navigation; the server already retries this automatically. |
| Reused cookies still get challenged | `cf_clearance` is IP+UA bound — reuse from the same IP and send the matching `userAgent`. The server falls back to the browser anyway. |
| `setup.sh` does nothing on Windows | It's a Linux deploy script. Run `node server.js` locally; run `setup.sh` on the VPS. |
| Browser won't launch on the VPS | Chrome needs `--no-sandbox` (already set) and Xvfb (installed by `setup.sh`). Check `journalctl -u flareburner`. |
| Chrome crashes in Docker (`Target closed` / SIGTRAP) | `/dev/shm` too small — run with `--shm-size=1g` (compose already sets it). |
| `node: command not found` | Node.js isn't installed or isn't on your PATH — see [Step 2](#step-2--install-the-prerequisites). |

---

## How it works

- **`index.js`** — library: `resolveChromePath`, `connectBrowser` (with launch
  retries), `navigate` (cookies/UA/headers + `waitForCloudflare` + settle),
  `buildResult` (shapes the response), `BrowserPool` (warm, queued slots),
  `fetchFastPath` (cookie-only `fetch`), `fetchBinaryFastPath` (cookie-only
  `fetch` returning raw bytes), `fetchProxyFastPath` (arbitrary request via
  fetch), and `save` (CLI dump). Also runnable as a CLI.
- **`server.js`** — HTTP layer: `.env`/config loading, `/health`, `/`,
  `POST /v1` (fast-path-then-pool scraping), `POST /binary` (clearance-reusing
  binary fetch), `POST /fetch` (general clearance-reusing proxy), API-key auth,
  and graceful shutdown. Tracks the last-harvested clearance so `/binary` and
  `/fetch` can skip the browser.
- **`setup.sh`** — Ubuntu/Debian provisioning + `systemd` service (nohup fallback).
- **`Dockerfile` / `docker-compose.yml`** — containerized deploy (Chrome + Xvfb baked in).
- **`.env.example`** — documented config template.
