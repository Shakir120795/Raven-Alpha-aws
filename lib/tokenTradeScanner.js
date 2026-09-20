const store = require('./store');
const { getWallets } = require('./wallets');
const { sendAlert } = require('./scanner');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const RPC_TIMEOUT_MS = 10000;
const RPC_RETRIES = 2;
const RPC_BACKOFF_MS = 500;
const TOPIC_BATCH_SIZE = 80;
const BLOCK_SPAN = 250;
const MAX_TX_LOOKUPS = 200;

function createTokenScanner({ chain, enabledEnv, rpcEnvVars = [], fallbackRpc, label }) {
  const seenKey = `${chain}_token_seen_v4`;
  const cursorKey = `${chain}_token_last_block_v4`;
  const baselineKey = `${chain}_token_wallet_baselines_v1`;
  let running = false;
  let rpcId = 1;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function blockscoutGet(path, params = {}) {
    if (!blockscoutApi) return null;
    try {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
      const url = blockscoutApi.replace(/\/$/, '') + '/' + String(path).replace(/^\//, '') + (qs ? '?' + qs : '');
      const headers = { 'user-agent': 'Raven-Alpha/1.0' };
      const key = blockscoutKeyEnv ? String(process.env[blockscoutKeyEnv] || '').trim() : '';
      if (key) headers.authorization = 'Bearer ' + key;
      const requestUrl = url + (key && !url.includes('apikey=') ? (qs ? '&' : '?') + 'apikey=' + encodeURIComponent(key) : '');
      const r = await fetch(requestUrl, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS), headers });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      console.error('[' + label + ' TOKEN BLOCKSCOUT FAILED]', e?.message || e);
      return null;
    }
  }

  async function blockscoutPages(path, params, stopBlock = 0, maxPages = 20) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < maxPages; page++) {
      const data = await blockscoutGet(path, { ...params, ...(cursor || {}) });
      if (!data || !Array.isArray(data.items)) break;
      items.push(...data.items);
      const oldest = data.items.reduce((m, x) => {
        const b = Number(x?.block_number || 0);
        return b && (!m || b < m) ? b : m;
      }, 0);
      if (stopBlock && oldest && oldest <= stopBlock) break;
      if (!data.next_page_params) break;
      cursor = data.next_page_params;
    }
    return items;
  }

  async function getCurrentBlock() {
    return parseHexBlock(await rpc('eth_blockNumber', []));
  }

  function envEnabled() {
    return String(process.env[enabledEnv] || 'false').toLowerCase() === 'true';
  }

  const endpoints = () => [...rpcEnvVars.map(k => process.env[k]).filter(Boolean), fallbackRpc].filter(Boolean);


  async function rpc(method, params) {
    let lastError = 'unknown error';
    for (let round = 1; round <= RPC_RETRIES; round++) {
      for (const endpoint of endpoints()) {
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
    console.error(`[${label} TOKEN RPC FAILED] ${method}: ${lastError}`);
    return null;
  }

  const topicAddress = address => `0x${String(address).toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  const parseHexBlock = value => value ? Number.parseInt(String(value), 16) : 0;
  const parseWordAddress = topic => topic ? `0x${String(topic).slice(-40)}`.toLowerCase() : '';
  const parseUint256 = topic => { try { return BigInt(topic || '0x0'); } catch { return 0n; } };

  function decodeAbiString(hex) {
    if (!hex || hex === '0x') return null;
    try {
      const s = hex.slice(2);
      const offset = Number(BigInt(`0x${s.slice(0, 64)}`)) * 2;
      const len = Number(BigInt(`0x${s.slice(offset, offset + 64)}`));
      return Buffer.from(s.slice(offset + 64, offset + 64 + len * 2), 'hex').toString('utf8').replace(/\0/g, '').trim() || null;
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

  async function marketData(contract) {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contract}`, { signal: AbortSignal.timeout(6000) });
      const j = r.ok ? await r.json().catch(() => null) : null;
      const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
      const needle = contract.toLowerCase();
      const matching = pairs.filter(p => String(p?.baseToken?.address || '').toLowerCase() === needle || String(p?.quoteToken?.address || '').toLowerCase() === needle);
      const best = (matching.length ? matching : pairs).reduce((a, b) => Number(b?.liquidity?.usd || 0) > Number(a?.liquidity?.usd || 0) ? b : a, null);
      return best ? { marketCap: best.fdv || best.marketCap || null, liquidityUsd: best.liquidity?.usd || null, volume24h: best.volume?.h24 || null, dex: best.dexId || null, priceUsd: best.priceUsd || null, url: best.url || null } : null;
    } catch { return null; }
  }

  async function getBalance(address, block) {
    const value = await rpc('eth_getBalance', [address, `0x${Math.max(0, block).toString(16)}`]);
    try { return value == null ? null : BigInt(value); } catch { return null; }
  }

  async function nativeGainCoversGas(tx, receipt, wallet, block) {
    if (!tx || !receipt || block <= 0) return false;
    const [before, after] = await Promise.all([getBalance(wallet, block - 1), getBalance(wallet, block)]);
    if (before == null || after == null) return false;
    let gasCost = 0n;
    try { gasCost = BigInt(receipt.gasUsed || '0x0') * BigInt(receipt.effectiveGasPrice || tx.gasPrice || '0x0'); } catch {}
    return after - before > gasCost;
  }

  function receiptTransfers(receipt, walletAddress) {
    const wallet = walletAddress.toLowerCase();
    const out = [];
    for (const log of Array.isArray(receipt?.logs) ? receipt.logs : []) {
      const topics = Array.isArray(log?.topics) ? log.topics : [];
      if (String(topics[0] || '').toLowerCase() !== TRANSFER_TOPIC || topics.length < 3) continue;
      const from = parseWordAddress(topics[1]);
      const to = parseWordAddress(topics[2]);
      const token = String(log.address || '').toLowerCase();
      const amount = parseUint256(topics[3]);
      if (!amount || (from !== wallet && to !== wallet)) continue;
      out.push({ from, to, token, amount });
    }
    return out;
  }

  async function classify(tx, receipt, walletAddress, targetToken, block) {
    if (!tx || !receipt || String(receipt.status || '0x1') === '0x0') return null;
    const wallet = walletAddress.toLowerCase();
    const target = targetToken.toLowerCase();
    const transfers = receiptTransfers(receipt, wallet);
    const targetIn = transfers.some(x => x.to === wallet && x.from !== ZERO && x.token === target);
    const targetOut = transfers.some(x => x.from === wallet && x.to !== ZERO && x.token === target);
    if (!targetIn && !targetOut) return null;

    const otherIn = transfers.some(x => x.to === wallet && x.from !== ZERO && x.token !== target);
    const otherOut = transfers.some(x => x.from === wallet && x.to !== ZERO && x.token !== target);
    let nativeOut = false;
    try { nativeOut = String(tx.from || '').toLowerCase() === wallet && BigInt(String(tx.value || '0x0')) > 0n; } catch {}

    if (targetIn && !targetOut) {
      if (otherOut || nativeOut) return 'buy';
      return null;
    }

    if (targetOut && !targetIn) {
      if (otherIn || await nativeGainCoversGas(tx, receipt, wallet, block)) return 'sell';
      return null;
    }

    if (targetIn && targetOut) {
      if (otherOut || nativeOut) return 'buy';
      if (otherIn || await nativeGainCoversGas(tx, receipt, wallet, block)) return 'sell';
    }
    return null;
  }

  async function sendTradeAlert(row, action) {
    const [meta, md] = await Promise.all([tokenMeta(row.contract), marketData(row.contract)]);
    return sendAlert({
      type: 'wallet_token_trade',
      action,
      walletId: row.wallet.id,
      walletLabel: row.wallet.label,
      chain,
      address: row.wallet.address,
      hash: row.txHash,
      tokenName: meta.name,
      sym: meta.symbol,
      contract: row.contract,
      marketData: { ...(md || {}), dex: md?.dex || 'DexScreener', url: md?.url || `https://dexscreener.com/search?q=${encodeURIComponent(row.contract)}` },
    });
  }

  async function mapLimit(items, limit, worker) {
    const out = new Array(items.length); let next = 0;
    async function runner() {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        try { out[i] = await worker(items[i], i); } catch (e) { out[i] = { error: e?.message || String(e) }; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
    return out;
  }

  function receiptCandidates(receipt, tracked) {
    const out = [];
    for (const log of Array.isArray(receipt?.logs) ? receipt.logs : []) {
      const topics = Array.isArray(log?.topics) ? log.topics : [];
      if (String(topics[0] || '').toLowerCase() !== TRANSFER_TOPIC || topics.length < 3) continue;
      const from = parseWordAddress(topics[1]);
      const to = parseWordAddress(topics[2]);
      const token = String(log.address || '').toLowerCase();
      if (!token || token === ZERO) continue;
      const logIndex = log?.logIndex ?? log?.log_index ?? '0';
      const fromWallet = tracked.get(from);
      const toWallet = tracked.get(to);
      if (fromWallet) out.push({ wallet: fromWallet, token, logIndex });
      if (toWallet && (!fromWallet || toWallet.id !== fromWallet.id)) out.push({ wallet: toWallet, token, logIndex });
    }
    return out;
  }
  async function run() {
    if (!envEnabled()) return { disabled: true, reason: `${enabledEnv}=false` };
    if (running) return { skipped: true, reason: `${label} token scan already running` };
    running = true;
    try {
      const wallets = getWallets().filter(w => w.chain === chain && w.address);
      if (!wallets.length) return { walletsScanned: 0, tokenAlerts: 0, tokenTransfers: 0, baselineReady: true };

      const currentBlock = await getCurrentBlock();
      if (!currentBlock) return { walletsScanned: wallets.length, tokenAlerts: 0, tokenTransfers: 0, baselineReady: false, error: `${label} RPC unavailable` };

      const baselines = store.get(baselineKey, {});
      let baselineChanged = false;
      for (const wallet of wallets) {
        const id = wallet.id || wallet.address.toLowerCase();
        if (baselines[id] == null) {
          baselines[id] = currentBlock;
          baselineChanged = true;
        }
      }
      if (baselineChanged) store.set(baselineKey, baselines);

      const cursor = Number(store.get(cursorKey, 0) || 0);
      const seen = store.get(seenKey, {});
      const tracked = new Map(wallets.map(w => [w.address.toLowerCase(), w]));

      if (!cursor) {
        store.set(cursorKey, currentBlock);
        store.set(seenKey, seen);
        console.log(`[${label} TOKEN] baseline initialized at block ${currentBlock}; historical trades ignored`);
        return { walletsScanned: wallets.length, tokenAlerts: 0, tokenTransfers: 0, baselineReady: true, cursor: currentBlock };
      }

      const fromBlock = cursor + 1;
      if (fromBlock > currentBlock) return { walletsScanned: wallets.length, tokenAlerts: 0, tokenTransfers: 0, baselineReady: true, cursor: currentBlock };

      const blocks = [];
      for (let block = fromBlock; block <= currentBlock; block++) blocks.push(block);

      const receiptResults = await mapLimit(blocks, 3, async block => {
        const receipts = await rpc('eth_getBlockReceipts', [`0x${block.toString(16)}`]);
        return { block, receipts: Array.isArray(receipts) ? receipts : [] };
      });

      const candidates = [];
      let rawTransfers = 0;
      for (const batch of receiptResults) {
        for (const receipt of batch.receipts) {
          for (const hit of receiptCandidates(receipt, tracked)) {
            rawTransfers++;
            const txHash = receipt.transactionHash;
            if (!txHash) continue;
            const key = `${txHash}:${hit.logIndex}:${hit.wallet.id}:${hit.token}`;
            if (seen[key]) continue;
            candidates.push({ key, txHash, block: batch.block, contract: hit.token, wallet: hit.wallet, receipt });
          }
        }
      }

      const fresh = [...new Map(candidates.map(row => [row.key, row])).values()];
      let confirmedTrades = 0;
      let tokenAlerts = 0;
      let lookups = 0;

      for (const row of fresh) {
        seen[row.key] = Date.now();
        if (lookups >= MAX_TX_LOOKUPS) continue;
        lookups++;
        const tx = await rpc('eth_getTransactionByHash', [row.txHash]);
        const action = await classify(tx, row.receipt, row.wallet.address, row.contract, row.block);
        if (!action) continue;
        confirmedTrades++;
        if (await sendTradeAlert(row, action)) tokenAlerts++;
      }

      store.set(cursorKey, currentBlock);
      const keys = Object.keys(seen);
      if (keys.length > 50000) for (const key of keys.slice(0, keys.length - 50000)) delete seen[key];
      store.set(seenKey, seen);
      console.log(`[${label} TOKEN] scanned ${wallets.length} wallets, ${rawTransfers} transfer events, ${fresh.length} candidates, ${confirmedTrades} confirmed trades, ${tokenAlerts} alerts, cursor=${currentBlock}`);
      return { walletsScanned: wallets.length, tokenTransfers: rawTransfers, tradeCandidates: fresh.length, confirmedTrades, tokenAlerts, baselineReady: true, cursor: currentBlock };
    } finally {
      running = false;
    }
  }

  return run;
}

module.exports = { createTokenScanner };
