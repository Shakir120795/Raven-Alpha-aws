const store = require('./store');
const { getWallets } = require('./wallets');
const { sendAlert } = require('./scanner');

const ARC = {
  id: 'arc',
  chainId: '0x13b2',
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
const RPC_TIMEOUT_MS = 8000;
const API_TIMEOUT_MS = 10000;
const RPC_ROUNDS = 2;
const RPC_BACKOFF_MS = 500;
const API_PAGE_SIZE = 1000;
const MAX_API_PAGES = 10;
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
        let j;
        try { j = JSON.parse(raw); } catch { throw new Error(`non-JSON response: ${raw.slice(0, 80)}`); }
        if (j?.error) throw new Error(`${j.error.code || 'RPC'} ${j.error.message || 'error'}`);
        if (j?.result === undefined) throw new Error('missing JSON-RPC result');
        if (method === 'eth_chainId' && String(j.result).toLowerCase() !== ARC.chainId) {
          throw new Error(`wrong chain id ${j.result}`);
        }
        endpointState.get(endpoint).failUntil = 0;
        return j.result;
      } catch (e) {
        lastError = e?.message || lastError;
        endpointState.get(endpoint).failUntil = Date.now() + ENDPOINT_COOLDOWN_MS;
        console.warn(`[ARC TOKEN RPC] ${method} failed on ${endpoint}: ${lastError}`);
      }
    }
    if (round < RPC_ROUNDS) await sleep(RPC_BACKOFF_MS * round);
  }
  console.error(`[ARC TOKEN RPC FAILED] ${method}: ${lastError}`);
  return null;
}

async function apiGet(path) {
  const url = `${ARC.apiBase}${path}`;
  try {
    const r = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'Raven-Alpha/1.0' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const raw = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`non-JSON response: ${raw.slice(0, 100)}`);
    }
  } catch (e) {
    console.error(`[ARC TOKEN API] ${path} failed: ${e?.message || e}`);
    return null;
  }
}

function unwrapItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['items', 'results', 'transfers', 'token_transfers', 'data']) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = unwrapItems(payload[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function getNextCursor(payload) {
  if (!payload || typeof payload !== 'object') return null;
  for (const key of ['next_cursor', 'nextCursor', 'cursor']) {
    if (typeof payload[key] === 'string' && payload[key]) return payload[key];
  }
  for (const key of ['meta', 'pagination', 'page']) {
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = getNextCursor(payload[key]);
      if (nested) return nested;
    }
  }
  return null;
}

function pick(obj, keys) {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj?.[key] !== null && obj[key] !== '') return obj[key];
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
  const kind = String(pick(row, ['kind', 'type']) || '').toLowerCase();
  const amount = pick(row, ['amount_raw', 'amountRaw', 'value_raw', 'valueRaw', 'amount', 'value']);
  return { token, from, to, txHash, block, logIndex, standard, kind, amount, raw: row };
}

async function tokenMeta(contract) {
  const key = contract.toLowerCase();
  if (metaCache.has(key)) return metaCache.get(key);
  const [nameHex, symHex] = await Promise.all([
    rpc('eth_call', [{ to: contract, data: '0x06fdde03' }, 'latest']),
    rpc('eth_call', [{ to: contract, data: '0x95d89b41' }, 'latest']),
  ]);
  const meta = {
    name: decodeAbiString(nameHex) || 'New Token',
    symbol: decodeAbiString(symHex) || '',
  };
  metaCache.set(key, meta);
  return meta;
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
  if (!value || typeof value !== 'object' || out.length > 100) return out;
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
    if (['transfers', 'token_transfers', 'erc20_transfers', 'value_transfers', 'movements', 'logs', 'decoded_logs'].includes(key)) {
      collectTransferObjects(child, out);
    }
  }
  return out;
}

async function hasBuyEvidence(txHash, walletAddress, boughtContract) {
  if (!txHash || !walletAddress || !boughtContract) return false;
  const payload = await apiGet(`/txs/${encodeURIComponent(txHash)}`);
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
    if (from === wallet && to !== ZERO && nonZero && token && token !== target) paymentOut = true;
  }
  return targetIn && paymentOut;
}

async function sendArcTokenBatch(entry) {
  const wallets = Object.values(entry.wallets);
  if (!wallets.length) return false;
  const minters = wallets.map(w => ({ walletId: w.walletId, address: w.address, label: w.label, count: w.count }));
  const totalMints = minters.reduce((sum, w) => sum + w.count, 0);
  const meta = entry.meta || await tokenMeta(entry.contract);
  const marketData = await fetchMarketData(entry.contract);
  const marketLink = marketData?.url || `https://dexscreener.com/search?q=${encodeURIComponent(entry.contract)}`;
  await sendAlert({
    type: 'wallet_new_token',
    walletId: minters[0]?.walletId,
    walletLabel: minters[0]?.label,
    chain: 'arc',
    address: minters[0]?.address,
    hash: entry.hash,
    tokenName: meta.name,
    sym: meta.symbol,
    contract: entry.contract,
    minters,
    totalMints,
    marketData: { ...(marketData || {}), dex: marketData?.dex || 'DexScreener', url: marketLink },
  });
  return true;
}

async function runArcTokenScan() {
  if (running) return { skipped: true, reason: 'Arc token scan already running' };
  running = true;
  try {
    const wallets = getWallets().filter(w => w.chain === 'arc');
    if (!wallets.length) return { walletsScanned: 0, tokenAlerts: 0, tokenTransfers: 0, baselineReady: true };

    const latestHex = await rpc('eth_blockNumber', []);
    if (!latestHex) return { walletsScanned: wallets.length, tokenAlerts: 0, tokenTransfers: 0, error: 'latest block unavailable' };
    const latest = parseInt(latestHex, 16);

    const cursor = store.get('arc_token_last_block', null);
    if (cursor == null) {
      store.set('arc_token_last_block', latest);
      console.log(`[ARC TOKEN] baseline block=${latest} recorded; historical transfers suppressed`);
      return { walletsScanned: wallets.length, tokenAlerts: 0, tokenTransfers: 0, baselineReady: true };
    }

    const fromBlock = Number(cursor) + 1;
    if (fromBlock > latest) return { walletsScanned: wallets.length, tokenAlerts: 0, tokenTransfers: 0, baselineReady: true };

    const tracked = new Map(wallets.map(w => [String(w.address || '').toLowerCase(), w]));
    const seen = store.get('arc_token_seen_v3', {});
    const cycle = {};
    let transferCount = 0;
    let buyCandidateCount = 0;
    let buyConfirmedCount = 0;
    let nextCursor = null;
    let apiWorking = false;

    for (let page = 0; page < MAX_API_PAGES; page++) {
      const query = `?limit=${API_PAGE_SIZE}${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ''}`;
      const payload = await apiGet(`/explore/token-transfers${query}`);
      const rows = unwrapItems(payload).map(normalizeTransfer).filter(r => r.block > 0);
      if (!rows.length) break;
      apiWorking = true;

      let reachedCursor = false;
      for (const row of rows) {
        if (row.block <= Number(cursor)) {
          reachedCursor = true;
          continue;
        }
        if (row.block > latest) continue;
        if (row.standard && row.standard !== 'ERC-20') continue;
        if (row.kind && !['transfer', 'erc20', 'token'].some(k => row.kind.includes(k))) continue;
        const wallet = tracked.get(row.to);
        if (!wallet) continue;
        if (!row.token || row.token === ARC_NATIVE_USDC) continue;
        if (!row.txHash) continue;

        transferCount++;
        const eventId = `${row.txHash}:${row.logIndex ?? ''}:${wallet.id}:${row.token}`;
        if (seen[eventId]) continue;
        seen[eventId] = Date.now();
        buyCandidateCount++;

        const buyConfirmed = await hasBuyEvidence(row.txHash, wallet.address, row.token);
        if (!buyConfirmed) continue;
        buyConfirmedCount++;

        const entry = cycle[row.token] ||= { contract: row.token, hash: row.txHash, meta: null, wallets: {} };
        const w = entry.wallets[wallet.id] ||= { walletId: wallet.id, address: wallet.address, label: wallet.label, count: 0 };
        w.count += 1;
      }

      if (reachedCursor) break;
      const candidateNext = getNextCursor(payload);
      if (!candidateNext || candidateNext === nextCursor) break;
      nextCursor = candidateNext;
    }

    if (!apiWorking) {
      console.warn('[ARC TOKEN] ArcScan indexed transfer API unavailable; RPC log scanner not used for token detection');
      return {
        walletsScanned: wallets.length,
        tokenAlerts: 0,
        tokenTransfers: 0,
        error: 'ArcScan token-transfer API unavailable',
        baselineReady: true,
      };
    }

    const seenKeys = Object.keys(seen);
    if (seenKeys.length > 50000) {
      for (const key of seenKeys.slice(0, seenKeys.length - 50000)) delete seen[key];
    }

    store.set('arc_token_last_block', latest);
    store.set('arc_token_seen_v3', seen);

    let tokenAlerts = 0;
    for (const entry of Object.values(cycle)) {
      entry.meta = await tokenMeta(entry.contract);
      if (await sendArcTokenBatch(entry)) tokenAlerts++;
    }

    console.log(`[ARC TOKEN] scanned ${wallets.length} wallets, ${transferCount} incoming ERC20 transfers, ${buyCandidateCount} buy candidates, ${buyConfirmedCount} confirmed buys, ${tokenAlerts} token alerts, cursor=${latest}`);
    return {
      walletsScanned: wallets.length,
      tokenAlerts,
      tokenTransfers: transferCount,
      buyCandidates: buyCandidateCount,
      confirmedBuys: buyConfirmedCount,
      baselineReady: true,
    };
  } finally {
    running = false;
  }
}

module.exports = { runArcTokenScan };
