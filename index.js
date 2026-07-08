import fs from 'fs';
import path from 'path';
import os from 'os';
import process from 'process';
import { connect } from 'puppeteer-real-browser';

/**
 * Resolves the path to the Chrome/Chromium executable.
 * Checks standard Linux locations, then local Playwright Chromium downloads.
 *
 * @returns {string|undefined} The resolved path to the executable, or undefined if not found.
 */
export function resolveChromePath() {
  const linuxCandidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];

  for (const c of linuxCandidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }

  const playwrightDir = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (fs.existsSync(playwrightDir)) {
    try {
      const folder = fs.readdirSync(playwrightDir).find(f => f.startsWith('chromium-'));
      if (folder) {
        const p = path.join(playwrightDir, folder, 'chrome-win64', 'chrome.exe');
        if (fs.existsSync(p)) {
          return p;
        }
      }
    } catch (err) {
      // Handle potential directory reading issues gracefully
    }
  }

  return undefined;
}

/**
 * Waits until the Cloudflare "Just a moment..." interstitial has been solved
 * and the real page has loaded.
 *
 * @param {import('puppeteer-real-browser').ConnectResult['page']} page
 * @param {number} [timeout=60000] Max time to wait, in milliseconds.
 * @returns {Promise<void>}
 */
export async function waitForCloudflare(page, timeout = 60000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const challenged = await page
      .evaluate(() => {
        const title = document.title || '';
        const onChallenge =
          /just a moment/i.test(title) ||
          !!document.querySelector('#challenge-form, #challenge-running, #cf-challenge-running');
        return onChallenge;
      })
      .catch(() => true); // navigation in flight — treat as still challenged

    if (!challenged) {
      return;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error('Timed out waiting for Cloudflare challenge to clear');
}

/**
 * Normalizes cookies into the subset of fields that page.setCookie accepts.
 * Chrome's getCookies returns extras (size, session, priority, sameParty,
 * sourceScheme) that setCookie rejects.
 *
 * @param {object[]} cookies
 * @param {string} [url] Fallback URL for cookies that have no domain.
 * @returns {object[]}
 */
export function sanitizeCookies(cookies, url) {
  if (!Array.isArray(cookies)) return [];
  return cookies
    .filter((c) => c && c.name && c.value)
    .map((c) => {
      const cookie = {
        name: c.name,
        value: c.value,
        path: c.path || '/',
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
      };
      if (c.domain) cookie.domain = c.domain;
      else if (url) cookie.url = url;
      if (typeof c.expires === 'number' && c.expires > 0) cookie.expires = c.expires;
      if (c.sameSite && ['Strict', 'Lax', 'None'].includes(c.sameSite)) cookie.sameSite = c.sameSite;
      return cookie;
    });
}

/**
 * Connects a real Chrome browser via puppeteer-real-browser, retrying through
 * the intermittent launch failures (e.g. the "reading 'on'" error).
 *
 * @param {object} [options]
 * @param {boolean} [options.headless=false]
 * @returns {Promise<import('puppeteer-real-browser').ConnectResult>}
 */
export async function connectBrowser({ headless = false } = {}) {
  const chromePath = resolveChromePath();
  let browser;
  let page;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      ({ browser, page } = await connect({
        headless,
        turnstile: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        customConfig: chromePath ? { chromePath } : {},
      }));
      return { browser, page };
    } catch (err) {
      lastErr = err;
      if (browser) await browser.close().catch(() => {});
      browser = undefined;
      page = undefined;
    }
  }
  throw lastErr || new Error('Failed to launch browser');
}

/**
 * Applies per-request options to a page and navigates to the URL, clearing the
 * Cloudflare challenge.
 *
 * @param {import('puppeteer-real-browser').ConnectResult['page']} page
 * @param {string} url
 * @param {object} [opts]
 * @param {object[]} [opts.cookies] Cookies to load before navigating.
 * @param {string} [opts.userAgent] Override the User-Agent.
 * @param {object} [opts.headers] Extra HTTP headers.
 * @param {string} [opts.waitUntil='domcontentloaded']
 * @param {number} [opts.timeout=60000] Navigation + challenge timeout (ms).
 * @param {string} [opts.waitForSelector] Wait for this selector after load.
 * @returns {Promise<void>}
 */
export async function navigate(page, url, opts = {}) {
  const {
    cookies,
    userAgent,
    headers,
    waitUntil = 'domcontentloaded',
    timeout = 60000,
    waitForSelector,
  } = opts;

  if (userAgent) await page.setUserAgent(userAgent);
  // Reset per-request headers each time so a pooled page doesn't leak them.
  await page.setExtraHTTPHeaders(headers && typeof headers === 'object' ? headers : {});

  const clean = sanitizeCookies(cookies, url);
  if (clean.length) await page.setCookie(...clean);

  await page.goto(url, { waitUntil, timeout });
  await waitForCloudflare(page, timeout);
  // Cloudflare does a final navigation after solving; let it settle so callers
  // don't read a detaching frame.
  await page
    .waitForFunction(() => document.readyState === 'complete', { timeout })
    .catch(() => {});
  if (waitForSelector) await page.waitForSelector(waitForSelector, { timeout });
}

/** Transient navigation errors that are safe to retry on the same browser. */
export function isTransientNavError(err) {
  return /detached frame|execution context was destroyed|frame got detached|navigation|target closed/i.test(
    String(err && err.message ? err.message : err),
  );
}

/**
 * Builds the response payload from a loaded page, shaped by `returnType`.
 *
 * @param {import('puppeteer-real-browser').ConnectResult['page']} page
 * @param {object} [opts]
 * @param {'full'|'html'|'cookies'|'json'} [opts.returnType='full']
 * @param {boolean} [opts.screenshot=false] Include a base64 PNG.
 * @returns {Promise<object>}
 */
export async function buildResult(page, opts = {}) {
  const { returnType = 'full', screenshot = false } = opts;
  const base = { url: page.url(), title: await page.title(), via: 'browser' };

  if (returnType === 'cookies') {
    return { ...base, cookies: await page.cookies() };
  }
  if (returnType === 'json') {
    const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    try {
      return { ...base, json: JSON.parse(text) };
    } catch {
      return { ...base, html: await page.content() };
    }
  }
  if (returnType === 'html') {
    return { ...base, html: await page.content() };
  }

  // full
  const result = {
    ...base,
    userAgent: await page.evaluate(() => navigator.userAgent),
    cookies: await page.cookies(),
    html: await page.content(),
  };
  if (screenshot) {
    result.screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
  }
  return result;
}

/**
 * Launches a one-off real Chrome browser and navigates to the target site.
 * For a long-running server prefer {@link BrowserPool}.
 *
 * @param {string} url The URL to open.
 * @param {object} [options] Options forwarded to {@link navigate}, plus `headless`.
 * @returns {Promise<import('puppeteer-real-browser').ConnectResult>}
 */
export async function open(url, options = {}) {
  if (!url) {
    throw new Error('open(url): a url is required');
  }
  const { browser, page } = await connectBrowser({ headless: options.headless });
  await navigate(page, url, options);
  return { browser, page };
}

/**
 * A pool of warm Chrome instances. Each slot keeps its own browser + page (so
 * the puppeteer-real-browser turnstile auto-solver stays attached), and the
 * pool serializes requests onto free slots, queueing when all are busy.
 */
export class BrowserPool {
  /**
   * @param {object} [options]
   * @param {number} [options.size=1] Number of concurrent browsers.
   * @param {boolean} [options.headless=false]
   */
  constructor({ size = 1, headless = false } = {}) {
    this.size = Math.max(1, size);
    this.headless = headless;
    this.slots = [];
    this.waiters = [];
  }

  async init() {
    for (let i = 0; i < this.size; i += 1) {
      this.slots.push({ ...(await connectBrowser({ headless: this.headless })), busy: false });
    }
    return this;
  }

  /** @returns {Promise<{browser:any,page:any,busy:boolean}>} */
  acquire() {
    return new Promise((resolve) => {
      const free = this.slots.find((s) => !s.busy);
      if (free) {
        free.busy = true;
        resolve(free);
      } else {
        this.waiters.push(resolve);
      }
    });
  }

  /** @param {{busy:boolean}} slot */
  release(slot) {
    const next = this.waiters.shift();
    if (next) next(slot);
    else slot.busy = false;
  }

  /** Replaces a broken slot's browser, then releases it. */
  async replace(slot) {
    try {
      await slot.browser.close();
    } catch {
      // ignore
    }
    const fresh = await connectBrowser({ headless: this.headless });
    slot.browser = fresh.browser;
    slot.page = fresh.page;
    this.release(slot);
  }

  stats() {
    return { size: this.size, busy: this.slots.filter((s) => s.busy).length };
  }

  async close() {
    await Promise.all(this.slots.map((s) => s.browser.close().catch(() => {})));
    this.slots = [];
  }
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Attempts a plain HTTP fetch using the supplied cookies, skipping Chrome
 * entirely. Returns `null` when Cloudflare challenges the request, signalling
 * the caller to fall back to a real browser.
 *
 * Note: cf_clearance is bound to IP + User-Agent, so `userAgent` should match
 * the one that produced the cookies.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {object[]} [opts.cookies]
 * @param {string} [opts.userAgent]
 * @param {object} [opts.headers]
 * @param {number} [opts.timeout=20000]
 * @returns {Promise<{url:string,status:number,html:string,via:string}|null>}
 */
export async function fetchFastPath(url, opts = {}) {
  const { cookies, userAgent, headers, timeout = 20000 } = opts;
  const cookieHeader = (cookies || [])
    .filter((c) => c && c.name)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  let res;
  let body;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
      headers: {
        'user-agent': userAgent || DEFAULT_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...(headers && typeof headers === 'object' ? headers : {}),
      },
    });
    body = await res.text();
  } catch {
    return null; // network/timeout — let the browser try
  }

  const challenged =
    res.status === 403 ||
    res.status === 503 ||
    res.headers.get('cf-mitigated') === 'challenge' ||
    /just a moment|__cf_chl|challenge-platform|cf-browser-verification/i.test(body);

  if (challenged) return null;
  return { url: res.url, status: res.status, html: body, via: 'fetch' };
}

/**
 * Like {@link fetchFastPath} but for binary resources (images, etc): does a
 * plain HTTP fetch with the supplied cookies and returns the raw bytes as a
 * Buffer. Returns `null` when Cloudflare challenges the request (HTML body /
 * 403 / 503), signalling the caller to fall back to a real browser.
 *
 * cf_clearance is bound to IP + User-Agent, so this must run on the host that
 * solved the cookies, with a matching `userAgent`.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {object[]} [opts.cookies]
 * @param {string} [opts.userAgent]
 * @param {object} [opts.headers]
 * @param {number} [opts.timeout=20000]
 * @returns {Promise<{url:string,status:number,buffer:Buffer,contentType:string,via:string}|null>}
 */
export async function fetchBinaryFastPath(url, opts = {}) {
  const { cookies, userAgent, headers, timeout = 20000 } = opts;
  const cookieHeader = (cookies || [])
    .filter((c) => c && c.name)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
      headers: {
        'user-agent': userAgent || DEFAULT_UA,
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...(headers && typeof headers === 'object' ? headers : {}),
      },
    });
  } catch {
    return null; // network/timeout — let the browser try
  }

  const contentType = res.headers.get('content-type') || '';
  const challenged =
    res.status === 403 ||
    res.status === 503 ||
    res.headers.get('cf-mitigated') === 'challenge' ||
    // a challenge serves HTML instead of the image bytes
    /text\/html/i.test(contentType);
  if (challenged) return null;

  let buffer;
  try {
    buffer = Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
  return {
    url: res.url,
    status: res.status,
    buffer,
    contentType: contentType || 'application/octet-stream',
    via: 'fetch',
  };
}

/**
 * Like {@link fetchFastPath} but a general-purpose proxy: forwards an arbitrary
 * method / body / redirect mode and returns the status, response headers
 * (with set-cookie preserved as an array) and the text body. Used by the
 * `/fetch` endpoint so callers can run multi-step flows (e.g. a 302-capturing
 * form POST) through flareburner's solved Cloudflare clearance.
 *
 * The supplied `cookies` are flareburner's harvested clearance; they are MERGED
 * with any `cookie` header the caller sent (the caller's session cookies still
 * matter), but the caller's `user-agent` is dropped — cf_clearance is bound to
 * the UA that solved it, so we always present the clearance UA.
 *
 * Returns `null` when Cloudflare challenges the request, signalling the caller
 * to solve via a real browser and retry. A 3xx under `redirect: 'manual'` is
 * the expected success (we want the Location), not a challenge.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {object[]} [opts.cookies] Harvested clearance cookies.
 * @param {string} [opts.userAgent] Clearance User-Agent (forced).
 * @param {string} [opts.method='GET']
 * @param {object} [opts.headers] Caller headers (cookie merged, user-agent dropped).
 * @param {string} [opts.body] Request body.
 * @param {'follow'|'manual'|'error'} [opts.redirect='follow']
 * @param {number} [opts.timeout=20000]
 * @returns {Promise<{url:string,status:number,headers:object,setCookie:string[],body:string,via:string}|null>}
 */
export async function fetchProxyFastPath(url, opts = {}) {
  const {
    cookies,
    userAgent,
    method = 'GET',
    headers,
    body,
    redirect = 'follow',
    timeout = 20000,
  } = opts;

  const clearanceCookie = (cookies || [])
    .filter((c) => c && c.name)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  // Split the caller's headers: keep its cookie (merge), drop its user-agent.
  let callerCookie = '';
  const passthrough = {};
  for (const [k, v] of Object.entries(headers && typeof headers === 'object' ? headers : {})) {
    const lk = k.toLowerCase();
    if (lk === 'cookie') callerCookie = v;
    else if (lk === 'user-agent') continue;
    else passthrough[lk] = v;
  }
  const mergedCookie = [clearanceCookie, callerCookie].filter(Boolean).join('; ');

  let res;
  let text;
  try {
    res = await fetch(url, {
      method,
      redirect,
      body: body != null ? body : undefined,
      signal: AbortSignal.timeout(timeout),
      headers: {
        'user-agent': userAgent || DEFAULT_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(mergedCookie ? { cookie: mergedCookie } : {}),
        ...passthrough,
      },
    });
    text = await res.text();
  } catch {
    return null; // network/timeout — let the browser try
  }

  const isRedirect = res.status >= 300 && res.status < 400;
  const challenged =
    (!isRedirect && (res.status === 403 || res.status === 503)) ||
    res.headers.get('cf-mitigated') === 'challenge' ||
    /just a moment|__cf_chl|challenge-platform|cf-browser-verification/i.test(text);
  if (challenged) return null;

  // Flatten headers; preserve multiple set-cookie values as an array (iterating
  // res.headers comma-joins them, which corrupts cookie values).
  const headersObj = {};
  for (const [k, v] of res.headers) headersObj[k] = v;
  const setCookie =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];

  return { url: res.url, status: res.status, headers: headersObj, setCookie, body: text, via: 'fetch' };
}

/**
 * Saves the page's cookies and full HTML into a JSON folder.
 *
 * @param {import('puppeteer-real-browser').ConnectResult['page']} page
 * @param {string} [dir='json'] Output folder for the JSON files.
 * @returns {Promise<{ cookiesPath: string, pagePath: string }>}
 */
export async function save(page, dir = 'json') {
  fs.mkdirSync(dir, { recursive: true });

  const cookies = await page.cookies();
  const html = await page.content();

  const cookiesPath = path.join(dir, 'cookies.json');
  const pagePath = path.join(dir, 'page.json');

  fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
  fs.writeFileSync(
    pagePath,
    JSON.stringify({ url: page.url(), html }, null, 2),
  );

  return { cookiesPath, pagePath };
}

// Run directly: `node index.js`
if (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node index.js <url>');
    process.exit(1);
  }
  open(url)
    .then(async ({ browser, page }) => {
      console.log(`Opened: ${await page.title()}`);
      const { cookiesPath, pagePath } = await save(page);
      console.log(`Saved cookies -> ${cookiesPath}`);
      console.log(`Saved page    -> ${pagePath}`);
      await browser.close();
    })
    .catch((err) => {
      console.error('Failed to open page:', err);
      process.exit(1);
    });
}
