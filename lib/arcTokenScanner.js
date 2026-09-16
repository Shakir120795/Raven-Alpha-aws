const store = require('./store');
const { getWallets } = require('./wallets');
const { sendAlert } = require('./scanner');

const ARC = {
  id: 'arc',
  apiBase: 'https://api.arc-scan.org/v1',
  rpcEndpoints: [
    'https://rpc.arc-scan.org',
    'https://niorfun.com/api/rpc',
    'https://petal.exchange/api/rpc?chain=5042',
    'https://valencia.exchange/api/rpc',
  ],
};

const ZERO = '0x0000000000000000000000000000000000000000';
const ARC_NATIVE_USDC = '0x3600000000000000000000000000000000000000';
const API_TIMEOUT_MS = 10000;
const API_PAGE_SIZE = 100;
const API_MAX_PAGES = 25;
const MAX_TX_LOOKUPS = 100;
const RPC_TIMEOUT_MS = 8000;
const RPC_ROUNDS = 2;
const RPC_BACKOFF_MS = 500;
const ENDPOINT_COOLDOWN_MS = 10000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let rpcId = 1;
let running = false;
const metaCache = new Map();
const endpointState = new Map(ARC.rpcEndpoints.map(url => [url, { failUntil: 0 }]));

function endpointOrder() {
  const now = Date.now();
  const available = ARC.rpcEndpoints.filter(url => (endpointState.get(url)?.failUntil || 0) <= now);
  const cooling = ARC.rpcEndpoints.filter(url => !available.includes(url));
  return [...available, ...cooling];
}

async function rpc(method, params) {
  let lastError = 'unknown error';
  for (let round = 1; round <= RPC_ROUNDS; round++) {
    for (const endpoint of endpointOrder()) {
      try {
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'Raven-Alpha/1.0' },
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
          body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
        });
        const raw = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = JSON.parse(raw);
        if (j?.error) throw new Error(`${j.error.code || 'RPC'} ${j.error.message || 'error'}`);
        if (j?.result === undefined) throw new Error('missing JSON-RPC result');
        endpointState.get(endpoint).failUntil = 0;
        return j.result;
      } catch (e) {
        lastError = e?.message || lastError;
        endpointState.get(endpoint).failUntil = Date.now() + ENDPOINT_COOLDOWN_MS;
      }
    }
    if (round < RPC_ROUNDS) await sleep(RPC_BACKOFF_MS * round);
  }
  console.error(`[ARC TOKEN RPC FAILED] ${method}: ${lastError}`);
  return null;
}

async function apiGet(path, quiet = false) {
  const url = `${ARC.apiBase}${path}`;
  try {
    const r = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'Raven-Alpha/1.0' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const raw = await r.text();
    if (!r.ok) {
      if (!quiet) console.error(`[ARC TOKEN API] ${path} failed: HTTP ${r.status}`);
      return null;
    }
    return JSON.parse(raw);
  } catch (e) {
    if (!quiet) console.error(`[ARC TOKEN API] ${path} failed: ${e?.message || e}`);
    return null;
  }
}

function unwrapItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['items', 'results', 'transfers', 'token_transfers', 'activity', 'data']) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = unwrapItems(payload[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function pick(obj, keys) {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return null;
}

function pickNextCursor(payload) {
  if (!payload || typeof payload !== 'object') return null;
  for (const key of ['next_cursor', 'nextCursor', 'next', 'cursor_next']) {
    if (typeof payload[key] === 'string' && payload[key]) return payload[key];
  }
  if (payload.pagination && typeof payload.pagination === 'object') {
    for (const key of ['next_cursor', 'nextCursor', 'next']) {
      if (typeof payload.pagination[key] === 'string' && payload.pagination[key]) return payload.pagination[key];
    }
  }
  return null;
}

function normalizeTransfer(row) {
  const token = String(pick(row, ['token_address', 'tokenAddress', 'contract', 'token', 'address']) || '').toLowerCase();
  const from = String(pick(row, ['from', 'from_address', 'fromAddress', 'sender']) || '').toLowerCase();
  const to = String(pick(row, ['to', 'to_address', 'toAddress', 'recipient']) || '').toLowerCase();
  const txHash = pick(row, ['tx_hash', 'txHash', 'transaction_hash', 'transactionHash', 'hash']);
  const block = Number(pick(row, ['block_number', 'blockNumber', 'block']) || 0);
  const logIndex = pick(row, ['log_index', 'logIndex', 'index']);
  const standard = String(pick(row, ['standard', 'token_standard', 'tokenStandard']) || '').toUpperCase();
  const kind = String(pick(row, ['kind', 'type', 'category', 'action']) || '').toLowerCase();
  const amount = pick(row, ['amount_raw', 'amountRaw', 'value_raw', 'valueRaw', 'amount', 'value']);
  return { token, from, to, txHash, block, logIndex, standard, kind, amount, raw: row };
}

function decodeAbiString(hex) {
  if (!hex || hex === '0x') return null;
  try {
    const s = hex.slice(2);
    const offset = Number(BigInt('0x' + s.slice(0, 64))) * 2;
    const len = Number(BigInt('0x' + s.slice(offset, offset + 64)));
    const body = s.slice(offset + 64, offset + 64 + len * 2);
    return Buffer.from(body, 'hex').toString('utf8').replace(/\0/g, '').trim() || null;
  } catch {
    return null;
  }
}

async function tokenMeta(contract) {
  const key = contract.toLowerCase();
  if (metaCache.has(key)) return metaCache.get(key);
  const [nameHex, symHex] = await Promise.all([
    rpc('eth_call', [{ to: contract, data: '0x06fdde03' }, 'latest']),
    rpc('eth_call', [{ to: contract, data: '0x95d89b41' }, 'latest']),
  ]);
  const meta = { name: decodeAbiString(nameHex) || 'New Token', symbol: decodeAbiString(symHex) || '' };
  metaCache.set(key, meta);
  return meta;
}

async function safeFetchJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json().catch(() => null) : null;
  } catch {
    return null;
  }
}

function pickBestPair(pairs, contract) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const needle = String(contract || '').toLowerCase();
  const matching = pairs.filter(p => {
    const base = String(p?.baseToken?.address || '').toLowerCase();
    const quote = String(p?.quoteToken?.address || '').toLowerCase();
    return base === needle || quote === needle;
  });
  const candidates = matching.length ? matching : pairs;
  return candidates.reduce((a, b) => Number(b?.liquidity?.usd || 0) > Number(a?.liquidity?.usd || 0) ? b : a);
}

async function fetchMarketData(contract) {
  if (!contract) return null;
  const tokenUrl = `https://api.dexscreener.com/latest/dex/tokens/${contract}`;
  const searchUrl = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(contract)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const tokenData = await safeFetchJson(tokenUrl);
    let best = pickBestPair(tokenData?.pairs, contract);
    if (!best) best = pickBestPair((await safeFetchJson(searchUrl))?.pairs, contract);
    if (best) {
      return {
        marketCap: best.fdv || best.marketCap || null,
        liquidityUsd: best.liquidity?.usd || null,
        volume24h: best.volume?.h24 || null,
        dex: best.dexId || null,
        priceUsd: best.priceUsd || null,
        url: best.url || null,
        baseTokenName: best.baseToken?.name || null,
        baseTokenSymbol: best.baseToken?.symbol || null,
      };
    }
    if (attempt < 2) await sleep(1500);
  }
  return null;
}

function collectTransferObjects(value, out = []) {
  if (!value || typeof value !== 'object' || out.length >= 100) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectTransferObjects(item, out);
    return out;
  }
  const looksLikeTransfer = value.from && value.to && (
    value.token_address || value.tokenAddress || value.contract || value.token ||
    value.value || value.value_raw || value.amount || value.amount_raw
  );
  if (looksLikeTransfer) out.push(value);
  for (const [key, child] of Object.entries(value)) {
    if (['transfers', 'token_transfers', 'erc20_transfers', 'value_transfers', 'movements', 'logs', 'decoded_logs', 'actions'].includes(key)) {
      collectTransferObjects(child, out);
    }
  }
  return out;
}

async function getTxActions(txHash) {
  return apiGet(`/txs/${encodeURIComponent(txHash)}/actions`, true);
}

async function hasBuyEvidence(txHash, walletAddress, boughtContract) {
  const payload = await getTxActions(txHash);
  if (!payload) return false;
  const rows = collectTransferObjects(payload);
  if (!rows.length) return false;
  const wallet = walletAddress.toLowerCase();
  const target = boughtContract.toLowerCase();
  let targetIn = false;
  let paymentOut = false;
  for (const row of rows) {
    const from = String(pick(row, ['from', 'from_address', 'fromAddress', 'sender']) || '').toLowerCase();
    const to = String(pick(row, ['to', 'to_address', 'toAddress', 'recipient']) || '').toLowerCase();
    const token = String(pick(row, ['token_address', 'tokenAddress', 'contract', 'token', 'address']) || '').toLowerCase();
    const amount = pick(row, ['amount_raw', 'amountRaw', 'value_raw', 'valueRaw', 'amount', 'value']);
    const nonZero = amount == null || String(amount) !== '0';
    if (to === wallet && token === target && nonZero) targetIn = true;
    if (from === wallet && to !== ZERO && nonZero && token && token !== target && token !== ARC_NATIVE_USDC) paymentOut = true;
    if (from === wallet && to !== ZERO && nonZero && !token) paymentOut = true;
  }
  return targetIn && paymentOut;
}

async function sendArcTokenBatch(entry) {
  const wallets = Object.values(entry.wallets);
  if (!wallets.length) return false;
  const trackedWallets = wallets.map(w => ({ walletId: w.walletId, address: w.address, label: w.label, count: w.count }));
  const meta = entry.meta || await tokenMeta(entry.contract);
  const marketData = await fetchMarketData(entry.contract);
  const marketLink = marketData?.url || `https://dexscreener.com/search?q=${encodeURIComponent(entry.contract)}`;
  await sendAlert({
    type: 'wallet_new_token',
    walletId: trackedWallets[0]?.walletId,
    walletLabel: trackedWallets[0]?.label,
    chain: 'arc',
    address: trackedWallets[0]?.address,
    hash: entry.hash,
    tokenName: meta.name,
    sym: meta.symbol,
    contract: entry.contract,
    minters: trackedWallets,
    totalMints: trackedWallets.reduce((sum, w) => sum + w.count, 0),
    marketData: { ...(marketData || {}), dex: marketData?.dex || 'DexScreener', url: marketLink },
  });
  return true;
}

function buildTokenTransferPath(cursor = null) {
  const params = new URLSearchParams();
  params.set('limit', String(API_PAGE_SIZE));
  if (cursor) params.set('cursor', cursor);
  return `/explore/token-transfers?${params.toString()}`;
}

async function fetchChainTransferPages(stopBlock) {
  const rows = [];
  let cursor = null;
  let pages = 0;
  let apiWorking = false;
  let oldestBlock = Number.MAX_SAFE_INTEGER;
  let newestBlock = stopBlock || 0;
  let reachedStopBlock = stopBlock <= 0;
  let sawNextCursor = false;

  while (pages < API_MAX_PAGES) {
    const payload = await apiGet(buildTokenTransferPath(cursor), false);
    if (!payload) break;
    apiWorking = true;
    const items = unwrapItems(payload);
    if (!items.length) break;
    pages++;
    let pageOldest = Number.MAX_SAFE_INTEGER;
    for (const raw of items) {
      const row = normalizeTransfer(raw);
      if (row.block) {
        pageOldest = Math.min(pageOldest, row.block);
        oldestBlock = Math.min(oldestBlock, row.block);
        newestBlock = Math.max(newestBlock, row.block);
      }
      if (row.block && row.block <= stopBlock) reachedStopBlock = true;
      if (row.block && row.block <= stopBlock) continue;
      rows.push(row);
    }
    if (pageOldest !== Number.MAX_SAFE_INTEGER && pageOldest <= stopBlock) reachedStopBlock = true;
    if (reachedStopBlock) break;
    const next = pickNextCursor(payload);
    if (!next || next === cursor) break;
    sawNextCursor = true;
    cursor = next;
  }

  return {
    rows,
    pages,
    apiWorking,
    reachedStopBlock,
    sawNextCursor,
    oldestBlock: oldestBlock === Number.MAX_SAFE_INTEGER ? stopBlock : oldestBlock,
    newestBlock,
  };
}

async function runArcTokenScan() {
  if (running) return { skipped: true, reason: 'Arc token scan already running' };
  running = true;
  try {
    const wallets = getWallets().filter(w => w.chain === 'arc');
    if (!wallets.length) return { walletsScanned: 0, tokenAlerts: 0, tokenTransfers: 0, baselineReady: true };

    const tracked = new Map(wallets.map(w => [String(w.address || '').toLowerCase(), w]));
    const cursor = Number(store.get('arc_token_last_block', 0) || 0);
    const seen = store.get('arc_token_seen_v8', {});
    const seenKeys = Object.keys(seen);
    if (seenKeys.length > 50000) for (const key of seenKeys.slice(0, seenKeys.length - 50000)) delete seen[key];

    const feed = await fetchChainTransferPages(cursor);
    if (!feed.apiWorking) {
      console.warn('[ARC TOKEN] ArcScan chain-wide token transfer API unavailable; scanner cycle aborted without advancing cursor');
      return { walletsScanned: wallets.length, tokenAlerts: 0, tokenTransfers: 0, error: 'ArcScan chain-wide token transfer API unavailable', baselineReady: cursor > 0 };
    }

    if (!cursor) {
      const baseline = feed.newestBlock || 0;
      if (baseline > 0) store.set('arc_token_last_block', baseline);
      store.set('arc_token_seen_v8', seen);
      console.log(`[ARC TOKEN] baseline initialized from chain-wide feed at block ${baseline}; no historical token alerts`);
      return { walletsScanned: wallets.length, tokenAlerts: 0, tokenTransfers: 0, baselineReady: true, cursor: baseline, pages: feed.pages };
    }

    const unique = new Map();
    for (const row of feed.rows) {
      if (!row.block || row.block <= cursor) continue;
      if (!row.to || !tracked.has(row.to)) continue;
      if (row.standard && row.standard !== 'ERC-20') continue;
      if (row.kind && !['transfer', 'erc20', 'token'].some(k => row.kind.includes(k))) continue;
      if (!row.token || row.token === ARC_NATIVE_USDC || !row.txHash) continue;
      const wallet = tracked.get(row.to);
      const eventId = `${row.txHash}:${row.logIndex ?? ''}:${wallet.id}:${row.token}`;
      if (!unique.has(eventId)) unique.set(eventId, { row, wallet, eventId });
    }

    let buyCandidateCount = 0;
    let buyConfirmedCount = 0;
    let lookupCount = 0;
    const cycle = {};

    for (const { row, wallet, eventId } of unique.values()) {
      if (seen[eventId]) continue;
      seen[eventId] = Date.now();
      buyCandidateCount++;
      if (lookupCount >= MAX_TX_LOOKUPS) continue;
      lookupCount++;
      if (!(await hasBuyEvidence(row.txHash, wallet.address, row.token))) continue;
      buyConfirmedCount++;
      const entry = cycle[row.token] ||= { contract: row.token, hash: row.txHash, meta: null, wallets: {} };
      const w = entry.wallets[wallet.id] ||= { walletId: wallet.id, address: wallet.address, label: wallet.label, count: 0 };
      w.count += 1;
    }

    const newestIndexedBlock = Math.max(cursor, feed.newestBlock || cursor);
    if (feed.reachedStopBlock || !feed.sawNextCursor) {
      store.set('arc_token_last_block', newestIndexedBlock);
      store.set('arc_token_seen_v8', seen);
    } else {
      console.warn(`[ARC TOKEN] page cap reached before cursor ${cursor}; cursor NOT advanced to avoid missing transfers`);
    }

    let tokenAlerts = 0;
    for (const entry of Object.values(cycle)) {
      entry.meta = await tokenMeta(entry.contract);
      if (await sendArcTokenBatch(entry)) tokenAlerts++;
    }

    console.log(`[ARC TOKEN] scanned ${wallets.length} wallets via chain feed, ${feed.pages} API pages, ${feed.rows.length} new feed rows, ${unique.size} tracked incoming ERC20 candidates, ${buyCandidateCount} buy candidates, ${buyConfirmedCount} confirmed buys, ${tokenAlerts} token alerts, cursor=${newestIndexedBlock}`);
    return {
      walletsScanned: wallets.length,
      tokenAlerts,
      tokenTransfers: unique.size,
      buyCandidates: buyCandidateCount,
      confirmedBuys: buyConfirmedCount,
      baselineReady: true,
      pages: feed.pages,
      feedRows: feed.rows.length,
      cursor: newestIndexedBlock,
    };
  } finally {
    running = false;
  }
}

module.exports = { runArcTokenScan };