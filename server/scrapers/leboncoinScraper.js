const { spawn } = require('child_process');
const path = require('path');

const BRIDGE = path.join(__dirname, '..', 'lbc_bridge.py');
const PYTHON = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const MIN_GAP_MS = 10000;  // pause mini entre 2 requêtes Leboncoin (anti-Datadome)
const TIMEOUT_MS = 120000; // allPages peut paginer beaucoup

const status = { error: null, at: null, lastQuery: null };
let chain = Promise.resolve();
let lastRun = 0;

function runBridge(payload) {
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON, [BRIDGE], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('Timeout Leboncoin')); }, TIMEOUT_MS);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(timer); reject(new Error(`Python introuvable (${PYTHON}) : ${e.message}`)); });
    p.on('close', code => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(out);
        if (json.error) return reject(new Error(json.error));
        resolve(json);
      } catch (e) {
        reject(new Error(err.trim().split('\n').pop() || `Bridge Python en erreur (code ${code})`));
      }
    });
    p.stdin.end(JSON.stringify(payload));
  });
}

function enqueue(job) {
  const task = chain.then(async () => {
    const wait = lastRun + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRun = Date.now();
    return job();
  });
  chain = task.catch(() => {});
  return task;
}

function scrapeLeBonCoin({ query, maxPrice, minPrice, category, allPages, sort, ownerType, shippable, searchInTitleOnly, fetchSellers, limit }) {
  const job = enqueue(() => runBridge({
    action: 'search',
    query: query || '',
    maxPrice,
    minPrice,
    category: category || 'all',
    allPages: !!allPages,
    sort: sort || 'newest',
    ownerType: ownerType || '',
    shippable: shippable === true || shippable === 'true' ? true : (shippable === false || shippable === 'false' ? false : undefined),
    searchInTitleOnly: !!searchInTitleOnly,
    fetchSellers: !!fetchSellers,
    limit: limit || undefined
  }));
  return job
    .then(data => {
      status.error = null;
      status.at = new Date().toISOString();
      status.lastQuery = query || (category || '') || 'toutes';
      return data;
    })
    .catch(e => {
      status.error = e.message;
      status.at = new Date().toISOString();
      status.lastQuery = query || (category || '') || 'toutes';
      console.error('Erreur Leboncoin:', e.message);
      return { results: [], total: 0, totalFetched: 0, maxPages: 0, pagination: 'error', error: e.message };
    });
}

function getLeBonCoinDetail(id) {
  const cleanId = String(id || '').replace('leboncoin-', '');
  const job = enqueue(() => runBridge({ action: 'detail', id: cleanId }));
  return job
    .then(ad => {
      status.error = null;
      status.at = new Date().toISOString();
      return ad;
    })
    .catch(e => {
      status.error = e.message;
      status.at = new Date().toISOString();
      console.error('Erreur détail Leboncoin:', e.message);
      return { error: e.message };
    });
}

const getLbcStatus = () => ({ ...status });

module.exports = { scrapeLeBonCoin, getLeBonCoinDetail, getLbcStatus };