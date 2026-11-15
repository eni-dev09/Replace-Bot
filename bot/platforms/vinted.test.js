// Tests déterministes de l'adaptateur Vinted : aucun appel réseau réel.
const assert = require('assert');

process.env.VINTED_MIN_GAP_MS = '0';
process.env.VINTED_RETRY_DELAY_MS = '0';
process.env.VINTED_DOMAIN = 'vinted.fr';
const vinted = require('./vinted');

function response(status, body = {}, setCookies = [], extraHeaders = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      getSetCookie: () => setCookies,
      get: name => extraHeaders[name.toLowerCase()] || null,
    },
    json: async () => body,
  };
}

async function withMockFetch(mock, run) {
  const originalFetch = global.fetch;
  vinted._resetSession(); // chaque scénario repart d'une session vierge
  global.fetch = mock;
  try { await run(); } finally { global.fetch = originalFetch; }
}

(async () => {
  await withMockFetch(async (url, options = {}) => {
    if (url === 'https://www.vinted.fr/' && options.method === 'HEAD') {
      return response(200, {}, ['access_token_web=token-123; Path=/; Secure', 'anon_id=anon-456; Path=/']);
    }
    assert(url.startsWith('https://api.vinted.fr/svc-catalogue/items?'), `Unexpected URL: ${url}`);
    assert.strictEqual(options.headers.Authorization, 'Bearer token-123');
    assert.strictEqual(options.headers['x-anon-id'], 'anon-456');
    assert(options.headers.Cookie.includes('access_token_web=token-123'));
    const parsed = new URL(url);
    assert.strictEqual(parsed.searchParams.get('search_text'), 'rtx 3070 ti');
    assert.strictEqual(parsed.searchParams.get('price_to'), '300');
    assert.strictEqual(parsed.searchParams.get('per_page'), '12');
    return response(200, { items: [{ id: 42, title: 'RTX 3070 Ti', price: { amount: '280.00' }, url: '/items/42-gpu', photo: { url: 'https://images.example/gpu.jpg' } }] });
  }, async () => {
    const ads = await vinted.search({ query: ' rtx 3070 ti ', maxPrice: 300, limit: 12 });
    assert.strictEqual(ads.length, 1);
    assert.strictEqual(ads[0].id, 'vinted-42');
    assert.strictEqual(ads[0].price, 280);
    assert.strictEqual(ads[0].url, 'https://www.vinted.fr/items/42-gpu');
    console.log('ok vinted svc-catalogue endpoint/auth/normalization');
  });

  let apiCalls = 0;
  let bootstrapCalls = 0;
  await withMockFetch(async (url, options = {}) => {
    if (url === 'https://www.vinted.fr/' && options.method === 'HEAD') {
      bootstrapCalls++;
      return response(200, {}, [`access_token_web=${bootstrapCalls === 1 ? 'expired' : 'fresh'}; Path=/`, 'anon_id=anon; Path=/']);
    }
    apiCalls++;
    if (apiCalls === 1) return response(401);
    assert.strictEqual(options.headers.Authorization, 'Bearer fresh');
    return response(200, { items: [] });
  }, async () => {
    const ads = await vinted.search({ query: 'camera' });
    assert.deepStrictEqual(ads, []);
    assert.strictEqual(apiCalls, 2);
    assert.strictEqual(bootstrapCalls, 2);
    console.log('ok vinted refresh/retry on 401');
  });

  let missingRouteCalls = 0;
  await withMockFetch(async (url, options = {}) => {
    if (url === 'https://www.vinted.fr/' && options.method === 'HEAD') {
      return response(200, {}, ['access_token_web=token; Path=/', 'anon_id=anon; Path=/']);
    }
    missingRouteCalls++;
    return response(404, {});
  }, async () => {
    await assert.rejects(vinted.search({ query: 'camera' }), /HTTP 404/);
    assert.strictEqual(missingRouteCalls, 1, '404 must not be retried as an auth error');
    console.log('ok vinted 404 is not retried');
  });
})().catch(error => {
  console.error('FAIL Vinted adapter tests', error);
  process.exitCode = 1;
});
