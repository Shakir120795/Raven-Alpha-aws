const store = require('./store');
const { getWallets } = require('./wallets');
const { fetchMarketData, sendAlert } = require('./scanner');

const ARC = {
  id: 'arc',
  rpc: 'https://rpc.arc-scan.org',
};

const ZERO = '0x0000000000000000000000000000000000000000';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const RPC_TIMEOUT_MS = 10000;
const RPC_RETRIES = 3;
const RPC_BACKOFF_MS = 750;
const ADDR_BATCH_SIZE = 500;
const BLOCK_SPAN = 500;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const topicAddr = a => '0x' + '0'.repeat(24) + a.replace(/^0x/, '').toLowerCase();
const topicToAddr = t => '0x' + String(t || '').slice(-40);

let rpcId = 1;
let running = false;
const metaCache = new Map();

async function rpc(method, params) {
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= RPC_RETRIES; attempt++) {
    try {
      const r = await fetch(ARC.rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j?.error) throw new Error(`${j.error.code || 'RPC'} ${j.error.message || 'error'}`);
      if (j?.result === undefined) throw new Error('missing JSON-RPC result');
      return j.result;
    } catch (e) {
      lastError = e?.message || lastError;
      if (attempt < RPC_RETRIES) await sleep(RPC_BACKOFF_MS * attempt);
    }
  }
  console.error(`[ARC TOKEN RPC FAILED] ${lastError}`);
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

async function sendArcTokenBatch(entry) {
  const wallets = Object.values(entry.wallets);
  const minters = wallets.map(w => ({ walletId: w.walletId, address: w.address, label: w.label, count: w.count }));
  const totalMints = minters.reduce((sum, w) => sum + w.count, 0);
  const meta = entry.meta || await tokenMeta(entry.contract);
  const marketData = await fetchMarketData(entry.contract);
  const result = await sendAlert({
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
    marketData,
  });
  return result;
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

    const seen = store.get('arc_token_seen', {});
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
          // ERC20 Transfer(address,address,uint256) has exactly 3 indexed topics.
          // ERC721 Transfer has 4 (tokenId) and is handled by the NFT scanner.
          if (t.length !== 3) continue;
          const to = (t[2] || '').toLowerCase();
          const wallet = walletByTopic.get(to);
          if (!wallet) continue;

          const contract = (log.address || '').toLowerCase();
          if (!contract) continue;
          transferCount++;

          const walletSeen = new Set(seen[wallet.id] || []);
          if (walletSeen.has(contract)) continue;
          walletSeen.add(contract);
          seen[wallet.id] = [...walletSeen].slice(-1000);

          const entry = cycle[contract] ||= {
            contract,
            hash: log.transactionHash,
            meta: null,
            wallets: {},
          };
          const w = entry.wallets[wallet.id] ||= {
            walletId: wallet.id,
            address: wallet.address,
            label: wallet.label,
            count: 0,
          };
          w.count += 1;
        }
      }
    }

    store.set('arc_token_last_block', latest);
    store.set('arc_token_seen', seen);

    let tokenAlerts = 0;
    for (const entry of Object.values(cycle)) {
      entry.meta = await tokenMeta(entry.contract);
      await sendArcTokenBatch(entry);
      tokenAlerts++;
    }

    console.log(`[ARC TOKEN] scanned ${wallets.length} wallets, ${transferCount} incoming ERC20 transfers, ${tokenAlerts} new-token alerts, cursor=${latest}`);
    return { walletsScanned: wallets.length, tokenAlerts, tokenTransfers: transferCount, baselineReady: true };
  } finally {
    running = false;
  }
}

module.exports = { runArcTokenScan };
