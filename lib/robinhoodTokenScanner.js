const store = require('./store');
const { getWallets } = require('./wallets');
const { sendAlert } = require('./scanner');

const API_BASE = 'https://robinhoodchain.blockscout.com/api/v2';
const CHAIN = 'robinhood';
const PAGE_LIMIT = 50;
const CONCURRENCY = 15;
const API_TIMEOUT_MS = 8000;
const MAX_TX_LOOKUPS = 80;
const NATIVE_ZERO = '0x0000000000000000000000000000000000000000';
const seenKey = 'robinhood_token_seen_v1';
const cursorKey = 'robinhood_token_last_block_v1';

let running = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getJson(path, quiet = false) {
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      headers: { accept: 'application/json', 'user-agent': 'Raven-Alpha/1.0' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const raw = await r.text();
    if (!r.ok) {
      if (!quiet) console.error(`[RH TOKEN API] ${path} failed: HTTP ${r.status}`);
      return null;
    }
    return JSON.parse(raw);
  } catch (e) {
    if (!quiet) console.error(`[RH TOKEN API] ${path} failed: ${e?.message || e}`);
    return null;
  }
}

async function mapLimit(items, concurrency, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        out[index] = await worker(items[index], index);
      } catch (e) {
        out[index] = { error: e?.message || String(e) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
  return out;
}

function normalizeTransfer(row, wallet) {
  const token = row?.token || {};
  return {
    wallet,
    txHash: row?.transaction_hash || row?.tx_hash || row?.transactionHash || null,
    block: Number(row?.block_number || row?.blockNumber || 0),
    logIndex: row?.log_index ?? row?.index ?? null,
    from: String(row?.from?.hash || row?.from_address || '').toLowerCase(),
    to: String(row?.to?.hash || row?.to_address || '').toLowerCase(),
    token: String(token?.address_hash || row?.token_address || '').toLowerCase(),
    tokenName: token?.name || 'New Token',
    symbol: token?.symbol || '',
    tokenType: String(token?.type || row?.type || '').toUpperCase(),
    value: row?.total?.value ?? row?.value ?? null,
    decimals: Number(row?.total?.decimals ?? token?.decimals ?? 18),
  };
}

async function fetchWalletTransfers(wallet) {
  const address = String(wallet.address || '').toLowerCase();
  const params = new URLSearchParams({
    type: 'ERC-20',
    filter: 'to',
    limit: String(PAGE_LIMIT),
  });
  const payload = await getJson(`/addresses/${address}/token-transfers?${params.toString()}`, true);
  if (!payload) return { ok: false, items: [] };
  return { ok: true, items: Array.isArray(payload.items) ? payload.items : [] };
}

async function getTransaction(txHash) {
  return getJson(`/transactions/${encodeURIComponent(txHash)}`, true);
}

function hasBuyEvidence(tx, walletAddress, boughtToken) {
  if (!tx || tx.status === 'error' || tx.status === 'failed') return false;
  const wallet = walletAddress.toLowerCase();
  const target = boughtToken.toLowerCase();
  let targetIn = false;
  let paymentOut = false;

  for (const transfer of Array.isArray(tx.token_transfers) ? tx.token_transfers : []) {
    const from = String(transfer?.from?.hash || '').toLowerCase();
    const to = String(transfer?.to?.hash || '').toLowerCase();
    const token = String(transfer?.token?.address_hash || '').toLowerCase();
    const amount = String(transfer?.total?.value ?? '0');
    if (to === wallet && token === target && amount !== '0') targetIn = true;
    if (from === wallet && to !== NATIVE_ZERO && token && token !== target && amount !== '0') paymentOut = true;
  }

  const nativeValue = String(tx?.value ?? '0');
  const sentNative = tx?.from?.hash && String(tx.from.hash).toLowerCase() === wallet && nativeValue !== '0';
  if (sentNative) paymentOut = true;

  return targetIn && paymentOut;
}

function marketDataFromTransfer(row) {
  const contract = row.token;
  return fetchMarketData(contract);
}

async function fetchMarketData(contract) {
  if (!contract) return null;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contract}`, { signal: AbortSignal.timeout(6000) });
    const j = r.ok ? await r.json().catch(() => null) : null;
    const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
    const matches = pairs.filter(p => {
      const b = String(p?.baseToken?.address || '').toLowerCase();
      const q = String(p?.quoteToken?.address || '').toLowerCase();
      return b === contract || q === contract;
    });
    const best = (matches.length ? matches : pairs).reduce((a, b) => Number(b?.liquidity?.usd || 0) > Number(a?.liquidity?.usd || 0) ? b : a, null);
    if (!best) return null;
    return {
      marketCap: best.fdv || best.marketCap || null,
      liquidityUsd: best.liquidity?.usd || null,
      volume24h: best.volume?.h24 || null,
      dex: best.dexId || null,
      priceUsd: best.priceUsd || null,
      url: best.url || null,
    };
  } catch {
    return null;
  }
}

async function sendBatch(row, wallet) {
  const md = await marketDataFromTransfer(row);
  return sendAlert({
    type: 'wallet_new_token',
    walletId: wallet.id,
    walletLabel: wallet.label,
    chain: CHAIN,
    address: wallet.address,
    hash: row.txHash,
    tokenName: row.tokenName,
    sym: row.symbol,
    contract: row.token,
    minters: [{ walletId: wallet.id, address: wallet.address, label: wallet.label, count: 1 }],
    totalMints: 1,
    marketData: { ...(md || {}), dex: md?.dex || 'DexScreener', url: md?.url || `https://dexscreener.com/search?q=${encodeURIComponent(row.token)}` },
  });
}

async function runRobinhoodTokenScan() {
  if (running) return { skipped: true, reason: 'Robinhood token scan already running' };
  running = true;
  try {
    const wallets = getWallets().filter(w => w.chain === CHAIN && w.address);
    if (!wallets.length) return { walletsScanned: 0, tokenAlerts: 0, tokenTransfers: 0, baselineReady: true };

    const cursor = Number(store.get(cursorKey, 0) || 0);
    const seen = store.get(seenKey, {});
    const results = await mapLimit(wallets, CONCURRENCY, fetchWalletTransfers);
    const candidates = [];
    let walletsWithApi = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const wallet = wallets[i];
      if (!result?.ok) continue;
      walletsWithApi++;
      for (const item of result.items) {
        const row = normalizeTransfer(item, wallet);
        if (!row.txHash || !row.token || row.tokenType !== 'ERC-20') continue;
        if (row.to !== wallet.address.toLowerCase()) continue;
        if (row.block && cursor && row.block <= cursor) continue;
        candidates.push(row);
      }
    }

    if (!cursor) {
      const newest = candidates.reduce((m, r) => Math.max(m, r.block || 0), 0);
      // No candidate means use current transfer timestamps only on next scan;
      // this remains a safe baseline because we never alert on this first run.
      if (newest > 0) store.set(cursorKey, newest);
      store.set(seenKey, seen);
      console.log(`[RH TOKEN] baseline initialized from ${walletsWithApi}/${wallets.length} address feeds; ${candidates.length} historical ERC20 rows ignored`);
      return { walletsScanned: wallets.length, walletsWithApi, tokenAlerts: 0, tokenTransfers: 0, baselineReady: true, cursor: newest };
    }

    const unique = new Map();
    for (const row of candidates) {
      const key = `${row.txHash}:${row.logIndex ?? ''}:${row.wallet.id}:${row.token}`;
      if (!unique.has(key)) unique.set(key, row);
    }

    const fresh = [...unique.entries()].filter(([key]) => !seen[key]).map(([key, row]) => ({ key, row }));
    let buyCandidates = 0;
    let confirmedBuys = 0;
    let lookups = 0;
    let tokenAlerts = 0;
    const maxBlock = Math.max(cursor, ...candidates.map(r => Number(r.block || 0)));

    for (const { key, row } of fresh) {
      seen[key] = Date.now();
      buyCandidates++;
      if (lookups >= MAX_TX_LOOKUPS) continue;
      lookups++;
      const tx = await getTransaction(row.txHash);
      if (!hasBuyEvidence(tx, row.wallet.address, row.token)) continue;
      confirmedBuys++;
      const result = await sendBatch(row, row.wallet);
      if (result) tokenAlerts++;
    }

    store.set(cursorKey, maxBlock);
    const keys = Object.keys(seen);
    if (keys.length > 50000) for (const key of keys.slice(0, keys.length - 50000)) delete seen[key];
    store.set(seenKey, seen);

    console.log(`[RH TOKEN] scanned ${wallets.length} wallets, ${walletsWithApi} API-ok, ${candidates.length} incoming ERC20 rows, ${buyCandidates} buy candidates, ${confirmedBuys} confirmed buys, ${tokenAlerts} token alerts, cursor=${maxBlock}`);
    return { walletsScanned: wallets.length, walletsWithApi, tokenAlerts, tokenTransfers: unique.size, buyCandidates, confirmedBuys, baselineReady: true, cursor: maxBlock };
  } finally {
    running = false;
  }
}

module.exports = { runRobinhoodTokenScan };