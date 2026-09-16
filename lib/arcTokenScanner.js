const store = require('./store');
const { getWallets } = require('./wallets');
const { sendAlert } = require('./scanner');

const ARC = {
  id: 'arc',
  rpcEndpoints: [
    'https://rpc.arc-scan.org',
    'https://niorfun.com/api/rpc',
    'https://petal.exchange/api/rpc?chain=5042',
    'https://valencia.exchange/api/rpc',
  ],
  chainId: '0x13b2',
};

const ZERO = '0x0000000000000000000000000000000000000000';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ARC_NATIVE_USDC = '0x3600000000000000000000000000000000000000';
const RPC_TIMEOUT_MS = 8000;
const RPC_ROUNDS = 2;
const RPC_BACKOFF_MS = 500;
const ADDR_BATCH_SIZE = 100;
const BLOCK_SPAN = 250;
const ENDPOINT_COOLDOWN_MS = 10000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const topicAddr = a => '0x' + '0'.repeat(24) + a.replace(/^0x/, '').toLowerCase();

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
        if (method === 'eth_chainId' && String(j.result).toLowerCase() !== ARC.chainId) throw new Error(`wrong chain id ${j.result}`);
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
  const meta = {
    name: decodeAbiString(nameHex) || 'New Token',
    symbol: decodeAbiString(symHex) || '',
  };
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

async function sendArcTokenBatch(entry) {
  const wallets = Object.values(entry.wallets);
  const minters = wallets.map(w => ({ walletId: w.walletId, address: w.address, label: w.label, count: w.count }));
  const totalMints = minters.reduce((sum, w) => sum + w.count, 0);
  const meta = entry.meta || await tokenMeta(entry.contract);
  const marketData = await fetchMarketData(entry.contract);
  const marketLink = marketData?.url || `https://dexscreener.com/search?q=${encodeURIComponent(entry.contract)}`;
  return sendAlert({
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

    const from = Number(cursor) + 1;
    if (from > latest) return { walletsScanned: wallets.length, tokenAlerts: 0, tokenTransfers: 0, baselineReady: true };

    const walletByTopic = new Map(wallets.map(w => [topicAddr(w.address), w]));
    const topicBatches = [];
    const walletTopics = [...walletByTopic.keys()];
    for (let i = 0; i < walletTopics.length; i += ADDR_BATCH_SIZE) topicBatches.push(walletTopics.slice(i, i + ADDR_BATCH_SIZE));

    const seen = store.get('arc_token_seen_v2', {});
    const cycle = {};
    let transferCount = 0;

    for (let start = from; start <= latest; start += BLOCK_SPAN) {
      const end = Math.min(latest, start + BLOCK_SPAN - 1);
      for (const addrs of topicBatches) {
        const logs = await rpc('eth_getLogs', [{
          fromBlock: '0x' + start.toString(16),
          toBlock: '0x' + end.toString(16),
          topics: [TRANSFER_TOPIC, null, addrs],
        }]);
        if (!Array.isArray(logs)) {
          console.error(`[ARC TOKEN] eth_getLogs failed for blocks ${start}-${end}; cursor NOT advanced`);
          return { walletsScanned: wallets.length, tokenAlerts: 0, tokenTransfers: transferCount, error: 'eth_getLogs failed', baselineReady: true };
        }
        for (const log of logs) {
          const t = log.topics || [];
          if (t.length !== 3) continue;
          const wallet = walletByTopic.get((t[2] || '').toLowerCase());
          if (!wallet) continue;
          const contract = (log.address || '').toLowerCase();
          if (!contract || contract === ARC_NATIVE_USDC) continue;
          transferCount++;
          const eventId = `${log.transactionHash || ''}:${log.logIndex || ''}:${wallet.id}:${contract}`;
          if (seen[eventId]) continue;
          seen[eventId] = Date.now();
          const entry = cycle[contract] ||= { contract, hash: log.transactionHash, meta: null, wallets: {} };
          const w = entry.wallets[wallet.id] ||= { walletId: wallet.id, address: wallet.address, label: wallet.label, count: 0 };
          w.count += 1;
        }
      }
    }

    const seenKeys = Object.keys(seen);
    if (seenKeys.length > 50000) for (const key of seenKeys.slice(0, seenKeys.length - 50000)) delete seen[key];
    store.set('arc_token_last_block', latest);
    store.set('arc_token_seen_v2', seen);

    let tokenAlerts = 0;
    for (const entry of Object.values(cycle)) {
      entry.meta = await tokenMeta(entry.contract);
      await sendArcTokenBatch(entry);
      tokenAlerts++;
    }

    console.log(`[ARC TOKEN] scanned ${wallets.length} wallets, ${transferCount} incoming ERC20 transfers, ${tokenAlerts} token alerts, cursor=${latest}`);
    return { walletsScanned: wallets.length, tokenAlerts, tokenTransfers: transferCount, baselineReady: true };
  } finally {
    running = false;
  }
}

module.exports = { runArcTokenScan };
