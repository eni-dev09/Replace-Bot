// Cache mémoire des recherches (TTL court) : évite de re-solliciter Leboncoin/Vinted
// quand plusieurs personnes demandent le même produit. SEARCH_CACHE_TTL_S=0 le désactive.
const store = new Map();
const MAX_ENTRIES = 200;

async function cached(key, fn) {
  const ttl = parseInt(process.env.SEARCH_CACHE_TTL_S ?? '300', 10) * 1000;
  if (ttl <= 0) return fn();
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = fn();           // requêtes simultanées identiques = un seul appel
  store.set(key, { at: Date.now(), promise });
  if (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
  try { return await promise; } catch (e) { store.delete(key); throw e; }
}

module.exports = { cached };
