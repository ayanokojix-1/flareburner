import http from 'http';
import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
import {
  BrowserPool,
  navigate,
  buildResult,
  fetchFastPath,
  fetchBinaryFastPath,
  fetchProxyFastPath,
  waitForCloudflare,
  isTransientNavError,
} from './index.js';

// ---------------------------------------------------------------------------
// Config: .env file (if present) < process.env < CLI port arg.
// ---------------------------------------------------------------------------
function loadEnv() {
  const merged = { ...process.env };
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in merged)) merged[key] = val;
    }
  }
  return merged;
}

const env = loadEnv();
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const bool = (v, d) => (v == null ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

const config = {
  port: num(process.argv[2], num(env.PORT, 4001)),
  apiKey: env.API_KEY || '',
  poolSize: num(env.POOL_SIZE, 1),
  headless: bool(env.HEADLESS, false),
  navTimeout: num(env.NAV_TIMEOUT, 60000),
  defaultUrl: env.DEFAULT_URL || 'https://nowsecure.nl',
};

const startedAt = Date.now();
const pool = new BrowserPool({ size: config.poolSize, headless: config.headless });

// Most-recently-harvested Cloudflare clearance (cookies + UA). Lets the binary
// /binary endpoint fetch protected images via a plain fetch — no browser, fully
// concurrent — instead of serializing every image through the size-1 pool.
let lastClearance = { cookies: null, userAgent: null };

function rememberClearance(cookies, userAgent) {
  if (Array.isArray(cookies) && cookies.length) {
    lastClearance = { cookies, userAgent: userAgent || lastClearance.userAgent };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendBinary(res, status, buffer, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': buffer.length,
    // images are immutable content-addressed assets; let the caller cache hard
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(buffer);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2e6) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!config.apiKey) return true;
  const header = req.headers['x-api-key'] || '';
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return header === config.apiKey || bearer === config.apiKey;
}

/**
 * Runs a scrape: tries the cookie fast-path first (when eligible), otherwise
 * leases a warm browser from the pool.
 */
async function scrape(opts) {
  const {
    url,
    cookies,
    userAgent,
    headers,
    returnType = 'full',
    screenshot = false,
    waitUntil = 'domcontentloaded',
    waitForSelector,
    timeout = config.navTimeout,
    fastPath = true,
  } = opts;

  // Fast-path: plain fetch with supplied cookies — no Chrome. Only when the
  // caller can't need browser-only features (screenshot / cookie harvest).
  const fastEligible =
    fastPath &&
    !screenshot &&
    returnType !== 'cookies' &&
    Array.isArray(cookies) &&
    cookies.length > 0;

  if (fastEligible) {
    const fast = await fetchFastPath(url, { cookies, userAgent, headers, timeout });
    if (fast) {
      if (returnType === 'json') {
        try {
          return { url: fast.url, via: 'fetch', json: JSON.parse(fast.html) };
        } catch {
          return { url: fast.url, via: 'fetch', html: fast.html };
        }
      }
      if (returnType === 'html') {
        return { url: fast.url, via: 'fetch', html: fast.html };
      }
      return { url: fast.url, via: 'fetch', status: fast.status, cookies, html: fast.html };
    }
  }

  // Browser path via the pool.
  const slot = await pool.acquire();
  try {
    // The first hit to a site triggers a post-solve Cloudflare navigation that
    // can detach the frame mid-read; retry on the same (healthy) browser.
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await navigate(slot.page, url, {
          cookies,
          userAgent,
          headers,
          waitUntil,
          timeout,
          waitForSelector,
        });
        const result = await buildResult(slot.page, { returnType, screenshot });
        // Harvest clearance so the binary fast-path can reuse it.
        if (Array.isArray(result.cookies)) rememberClearance(result.cookies, result.userAgent);
        pool.release(slot);
        return result;
      } catch (err) {
        lastErr = err;
        if (!isTransientNavError(err)) throw err;
      }
    }
    throw lastErr;
  } catch (err) {
    await pool.replace(slot); // recreate the (possibly broken) slot, then release
    throw err;
  }
}

/**
 * Fetches a (possibly Cloudflare-protected) binary resource — e.g. an image.
 *
 * Tries a plain fetch with the last-harvested clearance first (no browser, so
 * many images resolve concurrently). Only when that's challenged does it lease
 * the warm browser to solve the origin, then reads the real bytes from the
 * navigation response and refreshes the cached clearance.
 *
 * @returns {Promise<{status:number,buffer:Buffer,contentType:string,via:string}>}
 */
async function fetchBinary(url, { timeout = config.navTimeout } = {}) {
  // 1) Fast-path: plain fetch from this host using cached clearance.
  if (lastClearance.cookies) {
    const fast = await fetchBinaryFastPath(url, {
      cookies: lastClearance.cookies,
      userAgent: lastClearance.userAgent,
      timeout,
    });
    if (fast) return fast;
  }

  // 2) Browser path: navigate (solving any challenge), then read the bytes.
  const slot = await pool.acquire();
  try {
    let resp = await slot.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const ct = resp ? resp.headers()['content-type'] || '' : '';
    const challenged = !resp || resp.status() === 403 || resp.status() === 503 || /text\/html/i.test(ct);
    if (challenged) {
      await waitForCloudflare(slot.page, timeout);
      // Re-request now that clearance is set, to capture the real image bytes.
      resp = await slot.page.goto(url, { waitUntil: 'networkidle2', timeout });
    }
    const buffer = await resp.buffer();
    const contentType = resp.headers()['content-type'] || 'application/octet-stream';
    rememberClearance(await slot.page.cookies(), await slot.page.evaluate(() => navigator.userAgent));
    pool.release(slot);
    return { status: resp.status(), buffer, contentType, via: 'browser' };
  } catch (err) {
    await pool.replace(slot);
    throw err;
  }
}

/**
 * General-purpose Cloudflare-solving proxy. Runs an arbitrary HTTP request
 * (method / headers / body / redirect mode) FROM this host using the harvested
 * clearance, so callers can drive multi-step flows — e.g. a kwik form POST that
 * 302s to the real media URL — without ever holding cf_clearance themselves
 * (it's bound to this host's IP + UA).
 *
 * Tries the plain-fetch fast-path with cached clearance first; if Cloudflare
 * challenges, it leases the warm browser to solve the request's ORIGIN, harvests
 * fresh clearance, then replays the real request via the fast-path.
 *
 * @returns {Promise<{url:string,status:number,headers:object,setCookie:string[],body:string,via:string}>}
 */
async function fetchProxy(url, opts = {}) {
  const { method = 'GET', headers, body, redirect = 'follow', timeout = config.navTimeout } = opts;

  const tryFast = (clearance) =>
    fetchProxyFastPath(url, {
      cookies: clearance.cookies,
      userAgent: clearance.userAgent,
      method,
      headers,
      body,
      redirect,
      timeout,
    });

  // 1) Fast-path with whatever clearance we last harvested.
  if (lastClearance.cookies) {
    const fast = await tryFast(lastClearance);
    if (fast) return fast;
  }

  // 2) Browser: solve Cloudflare for this origin, harvest clearance, then replay.
  const origin = new URL(url).origin;
  const slot = await pool.acquire();
  let clearance;
  try {
    await slot.page.goto(origin, { waitUntil: 'domcontentloaded', timeout });
    await waitForCloudflare(slot.page, timeout);
    clearance = {
      cookies: await slot.page.cookies(),
      userAgent: await slot.page.evaluate(() => navigator.userAgent),
    };
    rememberClearance(clearance.cookies, clearance.userAgent);
    pool.release(slot);
  } catch (err) {
    await pool.replace(slot);
    throw err;
  }

  const fast = await tryFast(clearance);
  if (fast) return fast;
  throw new Error('fetch challenged even after solving Cloudflare');
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === '/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      pool: pool.stats(),
    });
  }

  if (pathname === '/' && req.method === 'GET') {
    return sendJson(res, 200, {
      service: 'flareburner',
      endpoints: {
        'GET /health': 'liveness + pool stats',
        'POST /v1': 'scrape a URL through a real browser (Cloudflare-aware)',
        'POST /binary': 'fetch a Cloudflare-protected binary (e.g. image) and return the raw bytes; body: { url, timeout? }',
        'POST /fetch': 'general Cloudflare-solving proxy; runs an arbitrary request from this host and returns { status, headers, setCookie, body }; body: { url, method?, headers?, body?, redirect?, timeout? }',
      },
      body: {
        url: 'string (required) — target URL',
        cookies: 'array (optional) — reuse a prior cookies set; enables the no-Chrome fast-path',
        userAgent: 'string (optional)',
        headers: 'object (optional) — extra HTTP headers',
        returnType: "'full' | 'html' | 'cookies' | 'json' (default 'full')",
        screenshot: 'boolean (optional) — include base64 PNG',
        waitUntil: "puppeteer waitUntil (default 'domcontentloaded')",
        waitForSelector: 'string (optional) — wait for this selector',
        timeout: `ms (default ${config.navTimeout})`,
        fastPath: 'boolean (default true) — set false to force the browser',
      },
      auth: config.apiKey ? 'send X-API-Key or Authorization: Bearer <key>' : 'none',
    });
  }

  if (pathname === '/v1') {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
    }
    if (!authorized(req)) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    let body = {};
    try {
      const raw = await readBody(req);
      if (raw.trim()) body = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }

    const url =
      typeof body.url === 'string' && body.url.trim() ? body.url.trim() : config.defaultUrl;

    try {
      const result = await scrape({ ...body, url });
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  }

  if (pathname === '/binary') {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
    }
    if (!authorized(req)) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    let body = {};
    try {
      const raw = await readBody(req);
      if (raw.trim()) body = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }

    if (typeof body.url !== 'string' || !body.url.trim()) {
      return sendJson(res, 400, { error: 'url is required' });
    }

    try {
      const { status, buffer, contentType } = await fetchBinary(body.url.trim(), {
        timeout: body.timeout,
      });
      return sendBinary(res, status >= 200 && status < 300 ? 200 : status, buffer, contentType);
    } catch (err) {
      return sendJson(res, 502, { error: String(err && err.message ? err.message : err) });
    }
  }

  if (pathname === '/fetch') {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
    }
    if (!authorized(req)) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    let body = {};
    try {
      const raw = await readBody(req);
      if (raw.trim()) body = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }

    if (typeof body.url !== 'string' || !body.url.trim()) {
      return sendJson(res, 400, { error: 'url is required' });
    }

    try {
      const result = await fetchProxy(body.url.trim(), {
        method: body.method,
        headers: body.headers,
        body: body.body,
        redirect: body.redirect,
        timeout: body.timeout,
      });
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 502, { error: String(err && err.message ? err.message : err) });
    }
  }

  return sendJson(res, 404, { error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
(async () => {
  console.log(`flareburner: warming ${config.poolSize} browser(s) (headless=${config.headless})…`);
  await pool.init();
  server.listen(config.port, () => {
    console.log(`flareburner API listening on http://0.0.0.0:${config.port}`);
    console.log(`  GET  /health`);
    console.log(`  POST /v1   ${config.apiKey ? '(API key required)' : '(open)'}`);
    console.log(`  POST /binary   (fetch protected image bytes)`);
    console.log(`  POST /fetch    (general Cloudflare-solving proxy)`);
    console.log(
      `Try: curl -X POST http://localhost:${config.port}/v1 -H "Content-Type: application/json" -d '{"url":"${config.defaultUrl}"}'`,
    );
  });
})().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});

// Graceful shutdown so Chrome processes don't linger.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n${sig} — shutting down…`);
    server.close();
    await pool.close();
    process.exit(0);
  });
}
