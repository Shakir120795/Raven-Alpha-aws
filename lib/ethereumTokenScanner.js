const store = require('./store');
const { getWallets } = require('./wallets');
const { sendAlert } = require('./scanner');

const CHAIN = 'eth';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const RPC_TIMEOUT_MS = 10000;
const RPC_RETRIES = 2;
const RPC_BACKOFF_MS = 500;
const TOPIC_BATCH_SIZE = 80;
const BLOCK_SPAN = 250;
const MAX_TX_LOOKUPS = 200;
const seenKey = 'ethereum_token_seen_v1';
const cursorKey = 'ethereum_token_last_block_v1';

const RPC_ENDPOINTS = [
  process.env.ETH_RPC_URL,
  process.env.ALCHEMY_ETH_RPC_URL,
  'https://ethereum-rpc.publicnode.com',
].filter(Boolean);

let running = false;
let rpcId = 1;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function envEnabled() {
  return String(process.env.ETH_TOKEN_TRACKING_ENABLED || 'false').toLowerCase() === 'true';
}

async function rpc(method, params) {
  let lastError = 'unknown error';
  for (let round = 1; round <= RPC_RETRIES; round++) {
    for (const endpoint of RPC_ENDPOINTS) {
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
        return j.result;
      } catch (e) {
        lastError = `${endpoint}: ${e?.message || e}`;
      }
    }
    if (round < RPC_RETRIES) await sleep(RPC_BACKOFF_MS * round);
  }
  console.error(`[ETH TOKEN RPC FAILED] ${method}: ${lastError}`);
  return null;
}

function topicAddress(address) {
  return `0x${String(address).toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}
function parseHexBlock(value) { return value ? Number.parseInt(String(value), 16) : 0; }
function parseWordAddress(topic) { return topic ? `0x${String(topic).slice(-40)}`.toLowerCase() : ''; }
function parseUint256(topic) { try { return BigInt(topic || '0x0'); } catch { return 0n; } }

function decodeAbiString(hex) {
  if (!hex || hex === '0x') return null;
  try {
    const s = hex.slice(2);
    const offset = Number(BigInt(`0x${s.slice(0, 64)}`)) * 2;
    const len = Number(BigInt(`0x${s.slice(offset, offset + 64)}`));
    const body = s.slice(offset + 64, offset + 64 + len * 2);
    return Buffer.from(body, 'hex').toString('utf8').replace(/\0/g, '').trim() || null;
  } catch { return null; }
}

const metaCache = new Map();
async function tokenMeta(contract) {
  const key = contract.toLowerCase();
  if (metaCache.has(key)) return metaCache.get(key);
  const [nameHex, symbolHex] = await Promise.all([
    rpc('eth_call', [{ to: contract, data: '0x06fdde03' }, 'latest']),
    rpc('eth_call', [{ to: contract, data: '0x95d89b41' }, 'latest']),
  ]);
  const meta = { name: decodeAbiString(nameHex) || 'New Token', symbol: decodeAbiString(symbolHex) || '' };
  metaCache.set(key, meta);
  return meta;
}

async function fetchMarketData(contract) {
  if (!contract) return null;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contract}`, { signal: AbortSignal.timeout(6000) });
    const j = r.ok ? await r.json().catch(() => null) : null;
    const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
    const needle = contract.toLowerCase();
    const matching = pairs.filter(p => String(p?.baseToken?.address || '').toLowerCase() === needle || String(p?.quoteToken?.address || '').toLowerCase() === needle);
    const best = (matching.length ? matching : pairs).reduce((a, b) => Number(b?.liquidity?.usd || 0) > Number(a?.liquidity?.usd || 0) ? b : a, null);
    if (!best) return null;
    return { marketCap: best.fdv || best.marketCap || null, liquidityUsd: best.liquidity?.usd || null, volume24h: best.volume?.h24 || null, dex: best.dexId || null, priceUsd: best.priceUsd || null, url: best.url || null };
  } catch { return null; }
}

function buildLogFilter(fromBlock, toBlock, walletTopics) {
  return { fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}`, topics: [TRANSFER_TOPIC, null, walletTopics] };
}
async function getTransferLogs(fromBlock, toBlock, walletTopics) { return rpc('eth_getLogs', [buildLogFilter(fromBlock, toBlock, walletTopics)]); }
async function getTx(txHash) { return rpc('eth_getTransactionByHash', [txHash]); }
async function getReceipt(txHash) { return rpc('eth_getTransactionReceipt', [txHash]); }

function hasBuyEvidence(tx, receipt, walletAddress, boughtToken) {
  if (!tx || !receipt) return false;
  const wallet = walletAddress.toLowerCase();
  const target = boughtToken.toLowerCase();
  let targetIn = false;
  let paymentOut = false;
  for (const log of Array.isArray(receipt.logs) ? receipt.logs : []) {
    const topics = Array.isArray(log?.topics) ? log.topics : [];
    if (String(topics[0] || '').toLowerCase() !== TRANSFER_TOPIC || topics.length < 3) continue;
    const from = parseWordAddress(topics[1]);
    const to = parseWordAddress(topics[2]);
    const token = String(log.address || '').toLowerCase();
    const amount = parseUint256(topics[3]);
    if (amount === 0n) continue;
    if (to === wallet && token === target) targetIn = true;
    if (from === wallet && to !== ZERO && token !== target && token !== target) paymentOut = true;
  }
  try {
    if (String(tx?.from || '').toLowerCase() === wallet && BigInt(String(tx?.value || '0x0')) > 0n) paymentOut = true;
  } catch {}
  return targetIn && paymentOut;
}

async function sendTokenAlert(row, wallet) {
  const [meta, marketData] = await Promise.all([tokenMeta(row.contract), fetchMarketData(row.contract)]);
  return sendAlert({
    type: 'wallet_new_token', walletId: wallet.id, walletLabel: wallet.label, chain: CHAIN,
    address: wallet.address, hash: row.txHash, tokenName: meta.name, sym: meta.symbol, contract: row.contract,
    minters: [{ walletId: wallet.id, address: wallet.address, label: wallet.label, count: 1 }], totalMints: 1,
    marketData: { ...(marketData || {}), dex: marketData?.dex || 'DexScreener', url: marketData?.url || `https://dexscreener.com/search?q=${encodeURIComponent(row.contract)}` },
  });
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length); let next = 0;
  async function runner() {
    while (true) {
      const i = next++; if (i >= items.length) return;
      try { out[i] = await worker(items[i], i); } catch (e) { out[i] = { error: e?.message || String(e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return out;
}

async function runRobinhoodTokenScan() {
  if (!envEnabled()) return { disabled: true, reason: 'ETH_TOKEN_TRACKING_ENABLED=false' };
  if (running) return { skipped: true, reason: 'Ethereum token scan already running' };
  running = true;
  try {
    const wallets = getWallets().filter(w => w.chain === CHAIN && w.address);
    if (!wallets.length) return { walletsScanned: 0, tokenAlerts: 0, tokenTransfers: 0, baselineReady: true };
    const currentBlock = parseHexBlock(await rpc('eth_blockNumber', []));
    if (!currentBlock) return { walletsScanned: wallets.length, tokenAlerts: 0, tokenTransfers: 0, baselineReady: false, error: 'Robinhood RPC unavailable' };

    const cursor = Number(store.get(cursorKey, 0) || 0);
    const seen = store.get(seenKey, {});
    const tracked = new Map(wallets.map(w => [w.address.toLowerCase(), w]));
    const walletAddresses = wallets.map(w => w.address.toLowerCase());
    const topicBatches = [];
    for (let i = 0; i < walletAddresses.length; i += TOPIC_BATCH_SIZE) topicBatches.push(walletAddresses.slice(i, i + TOPIC_BATCH_SIZE));

    if (!cursor) {
      store.set(cursorKey, currentBlock);
      store.set(seenKey, seen);
      console.log(`[ETH TOKEN] RPC baseline initialized at block ${currentBlock}; ${wallets.length} tracked wallets, historical buys ignored`);
      return { walletsScanned: wallets.length, tokenAlerts: 0, tokenTransfers: 0, baselineReady: true, cursor: currentBlock };
    }

    const fromBlock = cursor + 1;
    if (fromBlock > currentBlock) return { walletsScanned: wallets.length, tokenAlerts: 0, tokenTransfers: 0, baselineReady: true, cursor: currentBlock };
    const blockRanges = [];
    for (let start = fromBlock; start <= currentBlock; start += BLOCK_SPAN) blockRanges.push([start, Math.min(currentBlock, start + BLOCK_SPAN - 1)]);
    const queries = [];
    for (const [start, end] of blockRanges) for (const batch of topicBatches) queries.push({ start, end, batch });
    const results = await mapLimit(queries, 4, async q => getTransferLogs(q.start, q.end, q.batch.map(topicAddress)));

    const candidates = []; let rawTransfers = 0;
    for (const logs of results) {
      if (!Array.isArray(logs)) continue;
      for (const log of logs) {
        const topics = Array.isArray(log?.topics) ? log.topics : [];
        if (String(topics[0] || '').toLowerCase() !== TRANSFER_TOPIC || topics.length < 3) continue;
        const to = parseWordAddress(topics[2]);
        const wallet = tracked.get(to);
        if (!wallet) continue;
        const contract = String(log.address || '').toLowerCase();
        if (!contract || contract === NATIVE_ROH) continue;
        if (parseUint256(topics[3]) === 0n) continue;
        rawTransfers++;
        const key = `${log.transactionHash}:${log.logIndex || '0'}:${wallet.id}:${contract}`;
        if (seen[key]) continue;
        candidates.push({ key, txHash: log.transactionHash, block: parseHexBlock(log.blockNumber), contract, wallet });
      }
    }

    const fresh = [...new Map(candidates.map(row => [row.key, row])).values()];
    let confirmedBuys = 0; let tokenAlerts = 0; let lookups = 0;
    for (const row of fresh) {
      seen[row.key] = Date.now();
      if (lookups >= MAX_TX_LOOKUPS) continue;
      lookups++;
      const [tx, receipt] = await Promise.all([getTx(row.txHash), getReceipt(row.txHash)]);
      if (!hasBuyEvidence(tx, receipt, row.wallet.address, row.contract)) continue;
      confirmedBuys++;
      if (await sendTokenAlert(row, row.wallet)) tokenAlerts++;
    }

    store.set(cursorKey, currentBlock);
    const seenKeys = Object.keys(seen);
    if (seenKeys.length > 50000) for (const key of seenKeys.slice(0, seenKeys.length - 50000)) delete seen[key];
    store.set(seenKey, seen);
    console.log(`[ETH TOKEN] RPC scanned ${wallets.length} tracked wallets, ${rawTransfers} incoming ERC20 transfers, ${fresh.length} candidates, ${confirmedBuys} confirmed buys, ${tokenAlerts} token alerts, cursor=${currentBlock}`);
    return { walletsScanned: wallets.length, walletsWithRpc: wallets.length, tokenAlerts, tokenTransfers: rawTransfers, buyCandidates: fresh.length, confirmedBuys, baselineReady: true, cursor: currentBlock };
  } finally { running = false; }
}

module.exports = { runRobinhoodTokenScan };
