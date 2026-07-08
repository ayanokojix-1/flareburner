import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

import {
  sanitizeCookies,
  isTransientNavError,
  waitForCloudflare,
  buildResult,
  fetchFastPath,
  fetchBinaryFastPath,
  fetchProxyFastPath,
  navigate,
  save,
  resolveChromePath,
  BrowserPool,
} from '../index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A minimal fake puppeteer Response, enough for the fast-path fns. */
function fakeResponse({ status = 200, headers = {}, body = '', bytes } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const entries = Object.entries(lower);
  return {
    status,
    url: 'https://example.test/final',
    headers: {
      get: (k) => (k.toLowerCase() in lower ? lower[k.toLowerCase()] : null),
      getSetCookie: () => (lower['set-cookie'] ? [].concat(lower['set-cookie']) : []),
      [Symbol.iterator]: () => entries[Symbol.iterator](),
    },
    text: async () => body,
    arrayBuffer: async () => (bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : Buffer.from(body).buffer),
  };
}

/** Installs a fake global.fetch; returns a restore fn and a call log. */
function stubFetch(impl) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return impl(url, opts);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

// ---------------------------------------------------------------------------
// sanitizeCookies
// ---------------------------------------------------------------------------
describe('sanitizeCookies', () => {
  test('returns [] for non-array input', () => {
    assert.deepEqual(sanitizeCookies(null), []);
    assert.deepEqual(sanitizeCookies(undefined), []);
    assert.deepEqual(sanitizeCookies('nope'), []);
  });

  test('drops cookies missing name or value', () => {
    const out = sanitizeCookies([
      { name: 'a', value: '1' },
      { name: 'b' },
      { value: '2' },
      null,
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'a');
  });

  test('keeps only the setCookie-accepted subset and defaults path', () => {
    const [c] = sanitizeCookies([
      { name: 'x', value: 'y', size: 99, session: true, priority: 'High', sourceScheme: 'Secure' },
    ]);
    assert.deepEqual(Object.keys(c).sort(), ['httpOnly', 'name', 'path', 'secure', 'value'].sort());
    assert.equal(c.path, '/');
    assert.equal(c.httpOnly, false);
    assert.equal(c.secure, false);
  });

  test('preserves explicit path and coerces boolean flags', () => {
    const [c] = sanitizeCookies([
      { name: 'x', value: 'y', path: '/api', httpOnly: 1, secure: 'yes' },
    ]);
    assert.equal(c.path, '/api');
    assert.equal(c.httpOnly, true);
    assert.equal(c.secure, true);
  });

  test('uses domain when present, else falls back to url', () => {
    const [withDomain] = sanitizeCookies([{ name: 'a', value: '1', domain: '.example.com' }], 'https://x.test');
    assert.equal(withDomain.domain, '.example.com');
    assert.equal(withDomain.url, undefined);

    const [withUrl] = sanitizeCookies([{ name: 'a', value: '1' }], 'https://x.test');
    assert.equal(withUrl.url, 'https://x.test');
    assert.equal(withUrl.domain, undefined);
  });

  test('includes expires only when a positive number', () => {
    const [good] = sanitizeCookies([{ name: 'a', value: '1', expires: 123 }]);
    assert.equal(good.expires, 123);
    const [zero] = sanitizeCookies([{ name: 'a', value: '1', expires: 0 }]);
    assert.equal(zero.expires, undefined);
    const [neg] = sanitizeCookies([{ name: 'a', value: '1', expires: -1 }]);
    assert.equal(neg.expires, undefined);
  });

  test('only passes whitelisted sameSite values', () => {
    assert.equal(sanitizeCookies([{ name: 'a', value: '1', sameSite: 'Lax' }])[0].sameSite, 'Lax');
    assert.equal(sanitizeCookies([{ name: 'a', value: '1', sameSite: 'None' }])[0].sameSite, 'None');
    assert.equal(sanitizeCookies([{ name: 'a', value: '1', sameSite: 'no_restriction' }])[0].sameSite, undefined);
  });
});

// ---------------------------------------------------------------------------
// isTransientNavError
// ---------------------------------------------------------------------------
describe('isTransientNavError', () => {
  test('matches the known transient patterns', () => {
    for (const msg of [
      'Navigating frame was detached frame',
      'Execution context was destroyed',
      'frame got detached from the tree',
      'Error: Navigation failed because ...',
      'Protocol error: Target closed',
    ]) {
      assert.equal(isTransientNavError(new Error(msg)), true, msg);
    }
  });

  test('does not match unrelated errors', () => {
    assert.equal(isTransientNavError(new Error('ECONNREFUSED')), false);
    assert.equal(isTransientNavError(new Error('boom')), false);
  });

  test('tolerates non-Error / nullish input', () => {
    assert.equal(isTransientNavError(null), false);
    assert.equal(isTransientNavError(undefined), false);
    assert.equal(isTransientNavError('target closed'), true);
  });
});

// ---------------------------------------------------------------------------
// waitForCloudflare
// ---------------------------------------------------------------------------
describe('waitForCloudflare', () => {
  test('resolves immediately when not challenged', async () => {
    const page = { evaluate: async () => false };
    await assert.doesNotReject(waitForCloudflare(page, 5000));
  });

  test('throws once the deadline has passed', async () => {
    // timeout=0 => deadline is "now", so the loop body never runs and it throws
    // without incurring the 1s inter-poll sleep.
    const page = { evaluate: async () => true };
    await assert.rejects(waitForCloudflare(page, 0), /Timed out waiting for Cloudflare/);
  });

  test('clears after an initially-challenged poll', async () => {
    let n = 0;
    const page = { evaluate: async () => (n++ === 0 ? true : false) };
    await assert.doesNotReject(waitForCloudflare(page, 5000));
    assert.ok(n >= 2, 'should have polled more than once');
  });
});

// ---------------------------------------------------------------------------
// buildResult
// ---------------------------------------------------------------------------
describe('buildResult', () => {
  function fakePage({ json } = {}) {
    return {
      url: () => 'https://example.test/page',
      title: async () => 'Example',
      content: async () => '<html>hi</html>',
      cookies: async () => [{ name: 'cf', value: 'clearance' }],
      screenshot: async () => 'BASE64PNG',
      evaluate: async (fn) => {
        const src = fn.toString();
        if (src.includes('navigator.userAgent')) return 'UA/1.0';
        if (src.includes('innerText')) return json ?? '';
        return '';
      },
    };
  }

  test("returnType 'cookies' returns base + cookies only", async () => {
    const r = await buildResult(fakePage(), { returnType: 'cookies' });
    assert.deepEqual(r.cookies, [{ name: 'cf', value: 'clearance' }]);
    assert.equal(r.via, 'browser');
    assert.equal(r.html, undefined);
  });

  test("returnType 'html' returns the page content", async () => {
    const r = await buildResult(fakePage(), { returnType: 'html' });
    assert.equal(r.html, '<html>hi</html>');
    assert.equal(r.cookies, undefined);
  });

  test("returnType 'json' parses body innerText", async () => {
    const r = await buildResult(fakePage({ json: '{"ok":true}' }), { returnType: 'json' });
    assert.deepEqual(r.json, { ok: true });
  });

  test("returnType 'json' falls back to html on invalid JSON", async () => {
    const r = await buildResult(fakePage({ json: 'not json' }), { returnType: 'json' });
    assert.equal(r.json, undefined);
    assert.equal(r.html, '<html>hi</html>');
  });

  test("default 'full' includes ua, cookies and html, no screenshot", async () => {
    const r = await buildResult(fakePage());
    assert.equal(r.userAgent, 'UA/1.0');
    assert.equal(r.html, '<html>hi</html>');
    assert.deepEqual(r.cookies, [{ name: 'cf', value: 'clearance' }]);
    assert.equal(r.screenshot, undefined);
  });

  test("'full' with screenshot includes a base64 png", async () => {
    const r = await buildResult(fakePage(), { screenshot: true });
    assert.equal(r.screenshot, 'BASE64PNG');
  });
});

// ---------------------------------------------------------------------------
// fetchFastPath
// ---------------------------------------------------------------------------
describe('fetchFastPath', () => {
  let h;
  afterEach(() => h && h.restore());

  test('returns a result on a clean 200', async () => {
    h = stubFetch(() => fakeResponse({ status: 200, body: '<html>ok</html>' }));
    const r = await fetchFastPath('https://x.test', { cookies: [{ name: 'a', value: '1' }] });
    assert.equal(r.via, 'fetch');
    assert.equal(r.status, 200);
    assert.equal(r.html, '<html>ok</html>');
  });

  test('builds the cookie header and forwards the UA', async () => {
    h = stubFetch(() => fakeResponse({ body: 'ok' }));
    await fetchFastPath('https://x.test', {
      cookies: [{ name: 'a', value: '1' }, { name: 'b', value: '2' }, { junk: true }],
      userAgent: 'MyUA/9',
    });
    const { opts } = h.calls[0];
    assert.equal(opts.headers.cookie, 'a=1; b=2');
    assert.equal(opts.headers['user-agent'], 'MyUA/9');
  });

  test('returns null on a 403 challenge', async () => {
    h = stubFetch(() => fakeResponse({ status: 403, body: 'blocked' }));
    assert.equal(await fetchFastPath('https://x.test'), null);
  });

  test('returns null on a 503 challenge', async () => {
    h = stubFetch(() => fakeResponse({ status: 503, body: 'blocked' }));
    assert.equal(await fetchFastPath('https://x.test'), null);
  });

  test('returns null on the cf-mitigated header', async () => {
    h = stubFetch(() => fakeResponse({ status: 200, headers: { 'cf-mitigated': 'challenge' }, body: 'ok' }));
    assert.equal(await fetchFastPath('https://x.test'), null);
  });

  test('returns null when the body looks like a challenge page', async () => {
    h = stubFetch(() => fakeResponse({ status: 200, body: '<title>Just a moment...</title>' }));
    assert.equal(await fetchFastPath('https://x.test'), null);
  });

  test('returns null when fetch throws (network/timeout)', async () => {
    h = stubFetch(() => { throw new Error('ETIMEDOUT'); });
    assert.equal(await fetchFastPath('https://x.test'), null);
  });
});

// ---------------------------------------------------------------------------
// fetchBinaryFastPath
// ---------------------------------------------------------------------------
describe('fetchBinaryFastPath', () => {
  let h;
  afterEach(() => h && h.restore());

  test('returns raw bytes and content-type on success', async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    h = stubFetch(() => fakeResponse({ status: 200, headers: { 'content-type': 'image/png' }, bytes }));
    const r = await fetchBinaryFastPath('https://x.test/a.png');
    assert.ok(Buffer.isBuffer(r.buffer));
    assert.deepEqual([...r.buffer], [1, 2, 3, 4]);
    assert.equal(r.contentType, 'image/png');
    assert.equal(r.via, 'fetch');
  });

  test('treats an html content-type as a challenge (null)', async () => {
    h = stubFetch(() => fakeResponse({ status: 200, headers: { 'content-type': 'text/html' }, body: 'x' }));
    assert.equal(await fetchBinaryFastPath('https://x.test/a.png'), null);
  });

  test('returns null on 403/503', async () => {
    h = stubFetch(() => fakeResponse({ status: 403 }));
    assert.equal(await fetchBinaryFastPath('https://x.test/a.png'), null);
  });

  test('defaults content-type when the header is absent', async () => {
    h = stubFetch(() => fakeResponse({ status: 200, bytes: Buffer.from([9]) }));
    const r = await fetchBinaryFastPath('https://x.test/a');
    assert.equal(r.contentType, 'application/octet-stream');
  });
});

// ---------------------------------------------------------------------------
// fetchProxyFastPath
// ---------------------------------------------------------------------------
describe('fetchProxyFastPath', () => {
  let h;
  afterEach(() => h && h.restore());

  test('forces the clearance UA and drops the caller UA', async () => {
    h = stubFetch(() => fakeResponse({ status: 200, body: 'ok' }));
    await fetchProxyFastPath('https://x.test', {
      userAgent: 'Clearance/1',
      headers: { 'User-Agent': 'CallerUA/2', 'X-Custom': 'keep' },
    });
    const { opts } = h.calls[0];
    assert.equal(opts.headers['user-agent'], 'Clearance/1');
    assert.equal(opts.headers['x-custom'], 'keep');
  });

  test('merges clearance cookies with the caller cookie header', async () => {
    h = stubFetch(() => fakeResponse({ status: 200, body: 'ok' }));
    await fetchProxyFastPath('https://x.test', {
      cookies: [{ name: 'cf_clearance', value: 'abc' }],
      headers: { cookie: 'session=xyz' },
    });
    assert.equal(h.calls[0].opts.headers.cookie, 'cf_clearance=abc; session=xyz');
  });

  test('a 3xx under manual redirect is success, not a challenge', async () => {
    h = stubFetch(() => fakeResponse({ status: 302, headers: { location: '/next' }, body: '' }));
    const r = await fetchProxyFastPath('https://x.test', { redirect: 'manual' });
    assert.ok(r);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/next');
  });

  test('preserves multiple set-cookie values as an array', async () => {
    h = stubFetch(() => fakeResponse({ status: 200, headers: { 'set-cookie': ['a=1', 'b=2'] }, body: 'ok' }));
    const r = await fetchProxyFastPath('https://x.test');
    assert.deepEqual(r.setCookie, ['a=1', 'b=2']);
  });

  test('returns null on a genuine 403 challenge', async () => {
    h = stubFetch(() => fakeResponse({ status: 403, body: 'blocked' }));
    assert.equal(await fetchProxyFastPath('https://x.test'), null);
  });

  test('returns null when fetch throws', async () => {
    h = stubFetch(() => { throw new Error('ECONNRESET'); });
    assert.equal(await fetchProxyFastPath('https://x.test'), null);
  });
});

// ---------------------------------------------------------------------------
// navigate
// ---------------------------------------------------------------------------
describe('navigate', () => {
  function fakePage() {
    const log = { calls: [] };
    const rec = (name) => (...args) => { log.calls.push([name, ...args]); return Promise.resolve(); };
    return {
      log,
      setUserAgent: rec('setUserAgent'),
      setExtraHTTPHeaders: rec('setExtraHTTPHeaders'),
      setCookie: rec('setCookie'),
      goto: rec('goto'),
      waitForSelector: rec('waitForSelector'),
      waitForFunction: async () => {},
      evaluate: async () => false, // waitForCloudflare: not challenged
    };
  }

  test('sets UA, resets headers, loads cookies, navigates', async () => {
    const page = fakePage();
    await navigate(page, 'https://x.test', {
      userAgent: 'UA/1',
      headers: { 'X-A': 'b' },
      cookies: [{ name: 'a', value: '1' }],
    });
    const names = page.log.calls.map((c) => c[0]);
    assert.deepEqual(names.filter((n) => n === 'setUserAgent').length, 1);
    assert.ok(names.includes('setCookie'));
    assert.ok(names.includes('goto'));
    const goto = page.log.calls.find((c) => c[0] === 'goto');
    assert.equal(goto[1], 'https://x.test');
  });

  test('always resets headers even when none are supplied', async () => {
    const page = fakePage();
    await navigate(page, 'https://x.test');
    const setHeaders = page.log.calls.find((c) => c[0] === 'setExtraHTTPHeaders');
    assert.deepEqual(setHeaders[1], {});
  });

  test('does not set cookies when none survive sanitizing', async () => {
    const page = fakePage();
    await navigate(page, 'https://x.test', { cookies: [{ junk: true }] });
    assert.ok(!page.log.calls.some((c) => c[0] === 'setCookie'));
  });

  test('waits for a selector when requested', async () => {
    const page = fakePage();
    await navigate(page, 'https://x.test', { waitForSelector: '#done' });
    const w = page.log.calls.find((c) => c[0] === 'waitForSelector');
    assert.equal(w[1], '#done');
  });
});

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------
describe('save', () => {
  let mkdir, write;
  beforeEach(() => {
    mkdir = mock.method(fs, 'mkdirSync', () => {});
    write = mock.method(fs, 'writeFileSync', () => {});
  });
  afterEach(() => mock.restoreAll());

  test('writes cookies.json and page.json and returns their paths', async () => {
    const page = {
      url: () => 'https://x.test',
      cookies: async () => [{ name: 'a', value: '1' }],
      content: async () => '<html></html>',
    };
    const { cookiesPath, pagePath } = await save(page, 'out');
    assert.match(cookiesPath, /out.*cookies\.json$/);
    assert.match(pagePath, /out.*page\.json$/);
    assert.equal(mkdir.mock.callCount(), 1);
    assert.equal(write.mock.callCount(), 2);
    // page.json payload embeds url + html
    const pageWrite = write.mock.calls.find((c) => String(c.arguments[0]).endsWith('page.json'));
    const parsed = JSON.parse(pageWrite.arguments[1]);
    assert.equal(parsed.url, 'https://x.test');
    assert.equal(parsed.html, '<html></html>');
  });
});

// ---------------------------------------------------------------------------
// resolveChromePath
// ---------------------------------------------------------------------------
describe('resolveChromePath', () => {
  let exists;
  afterEach(() => mock.restoreAll());

  test('returns the first existing linux candidate', () => {
    exists = mock.method(fs, 'existsSync', (p) => p === '/usr/bin/chromium');
    assert.equal(resolveChromePath(), '/usr/bin/chromium');
  });

  test('prefers google-chrome-stable when several exist', () => {
    exists = mock.method(fs, 'existsSync', () => true);
    assert.equal(resolveChromePath(), '/usr/bin/google-chrome-stable');
  });

  test('returns undefined when nothing is found', () => {
    exists = mock.method(fs, 'existsSync', () => false);
    assert.equal(resolveChromePath(), undefined);
  });
});

// ---------------------------------------------------------------------------
// BrowserPool
// ---------------------------------------------------------------------------
describe('BrowserPool', () => {
  function fakeSlot() {
    return { browser: { close: mock.fn(async () => {}) }, page: {}, busy: false };
  }

  test('clamps size to at least 1', () => {
    assert.equal(new BrowserPool({ size: 0 }).size, 1);
    assert.equal(new BrowserPool({ size: -5 }).size, 1);
    assert.equal(new BrowserPool({ size: 3 }).size, 3);
  });

  test('acquire hands out a free slot and marks it busy', async () => {
    const pool = new BrowserPool({ size: 1 });
    pool.slots = [fakeSlot()];
    const slot = await pool.acquire();
    assert.equal(slot.busy, true);
    assert.deepEqual(pool.stats(), { size: 1, busy: 1 });
  });

  test('acquire queues when all slots are busy, release wakes the waiter', async () => {
    const pool = new BrowserPool({ size: 1 });
    pool.slots = [fakeSlot()];
    const first = await pool.acquire();

    let second = null;
    const pending = pool.acquire().then((s) => { second = s; });
    // Not resolved yet — the only slot is busy.
    await Promise.resolve();
    assert.equal(second, null);

    pool.release(first);
    await pending;
    assert.equal(second, first, 'waiter should receive the released slot');
    assert.equal(second.busy, true);
  });

  test('release with no waiters marks the slot free', async () => {
    const pool = new BrowserPool({ size: 1 });
    pool.slots = [fakeSlot()];
    const slot = await pool.acquire();
    pool.release(slot);
    assert.equal(slot.busy, false);
    assert.deepEqual(pool.stats(), { size: 1, busy: 0 });
  });

  test('close closes every browser and empties the pool', async () => {
    const pool = new BrowserPool({ size: 2 });
    const a = fakeSlot();
    const b = fakeSlot();
    pool.slots = [a, b];
    await pool.close();
    assert.equal(a.browser.close.mock.callCount(), 1);
    assert.equal(b.browser.close.mock.callCount(), 1);
    assert.equal(pool.slots.length, 0);
  });

  test('close tolerates a browser that throws on close', async () => {
    const pool = new BrowserPool({ size: 1 });
    pool.slots = [{ browser: { close: async () => { throw new Error('already dead'); } } }];
    await assert.doesNotReject(pool.close());
  });
});
