const store = require('./store');
const { getWallets } = require('./wallets');
const { CHAINS, ACTIVE_CHAIN_IDS } = require('./chains');

const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO_TOPIC = '0x' + '0'.repeat(64);
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ERC1155_TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const ERC1155_TRANSFER_BATCH = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';
const ERC165_ERC721 = '0x80ac58cd';
const ERC165_ERC1155 = '0xd9b67a26';

const shorten = (a = '') => a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
const topicAddr = a => '0x' + '0'.repeat(24) + a.replace(/^0x/, '').toLowerCase();
const cleanHex = x => (x || '').replace(/^0x/, '');

let rpcId = 1;
let running = false;
const metaCache = new Map();
const linkCache = new Map();
const maxSupplyCache = new Map();

async function jsonFetch(url, opts = {}) {
  try {
    const r = await fetch(url, opts);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function rpc(chain, method, params) {
  if (!chain.rpc) return null;
  const j = await jsonFetch(chain.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params })
  });
  if (!j || j.error) return null;
  return j.result ?? null;
}

function decodeString(hex) {
  if (!hex || hex === '0x') return null;
  try {
    const s = cleanHex(hex);
    const offset = Number(BigInt('0x' + s.slice(0, 64))) * 2;
    const len = Number(BigInt('0x' + s.slice(offset, offset + 64)));
    const body = s.slice(offset + 64, offset + 64 + len * 2);
    return Buffer.from(body, 'hex').toString('utf8').replace(/\0/g, '').trim() || null;
  } catch {
    try {
      return Buffer.from(cleanHex(hex).slice(0, 64), 'hex').toString('utf8').replace(/\0/g, '').trim() || null;
    } catch { return null; }
  }
}

function decodeUint(hex) {
  if (!hex || hex === '0x') return null;
  try { return Number(BigInt(hex)); } catch { return null; }
}

async function call(chain, contract, data) {
  return rpc(chain, 'eth_call', [{ to: contract, data }, 'latest']);
}

async function contractMeta(chain, contract) {
  const key = `${chain.id}:${contract.toLowerCase()}`;
  if (metaCache.has(key)) return metaCache.get(key);
  const [nameHex, e721, e1155] = await Promise.all([
    call(chain, contract, '0x06fdde03'),
    call(chain, contract, '0x01ffc9a7' + ERC165_ERC721.slice(2).padStart(64, '0')),
    call(chain, contract, '0x01ffc9a7' + ERC165_ERC1155.slice(2).padStart(64, '0'))
  ]);
  const meta = {
    name: decodeString(nameHex) || 'New Collection',
    is721: !!e721 && decodeUint(e721) === 1,
    is1155: !!e1155 && decodeUint(e1155) === 1
  };
  metaCache.set(key, meta);
  return meta;
}

async function supplyInfo(chain, contract, is1155 = false) {
  if (is1155) return { total: null, max: null };
  const key = `${chain.id}:${contract.toLowerCase()}`;
  const total = decodeUint(await call(chain, contract, '0x18160ddd'));
  let max = maxSupplyCache.get(key);
  if (max === undefined) {
    max = decodeUint(await call(chain, contract, '0xd5abeb01'));
    maxSupplyCache.set(key, max);
  }
  return { total, max };
}

function resolveUri(uri, tokenId) {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + uri.slice(7);
  if (uri.startsWith('ar://')) return 'https://arweave.net/' + uri.slice(5);
  if (uri.includes('{id}')) return uri.replace('{id}', BigInt(tokenId).toString(16).padStart(64, '0'));
  return uri;
}

async function metadataLinks(chain, contract, tokenId, is1155) {
  const key = `${chain.id}:${contract.toLowerCase()}:${tokenId}:${is1155}`;
  if (linkCache.has(key)) return linkCache.get(key);
  const selector = is1155 ? '0x0e89341c' : '0xc87b56dd';
  const uriHex = await call(chain, contract, selector + BigInt(tokenId).toString(16).padStart(64, '0'));
  const uri = decodeString(uriHex);
  if (!uri) { const empty = {}; linkCache.set(key, empty); return empty; }
  const url = resolveUri(uri, tokenId);
  let j = null;
  try {
    if (url?.startsWith('data:application/json')) j = JSON.parse(Buffer.from(url.split(',')[1] || '', 'base64').toString('utf8'));
    else { const r = await fetch(url); if (r.ok) j = await r.json(); }
  } catch {}
  if (!j) { const empty = {}; linkCache.set(key, empty); return empty; }
  const external = j.external_url || j.externalUrl || j.website || null;
  const x = j.twitter_url || j.twitter || j.x_url || j.x || j.social?.twitter || j.social?.x || null;
  const collection = j.collection || j.project || j.name || null;
  const result = {
    mintPage: external && /^https?:\/\//i.test(external) ? external : null,
    x: x && /^https?:\/\//i.test(x) ? x : (collection ? `https://x.com/search?q=${encodeURIComponent(collection)}&f=live` : null)
  };
  linkCache.set(key, result);
  return result;
}

function parseBatchData(data) {
  const s = cleanHex(data);
  try {
    const offIds = Number(BigInt('0x' + s.slice(0, 64))) * 2;
    const offVals = Number(BigInt('0x' + s.slice(64, 128))) * 2;
    const n = Number(BigInt('0x' + s.slice(offIds, offIds + 64)));
    const ids = [];
    for (let i = 0; i < n; i++) {
      const id = BigInt('0x' + s.slice(offIds + 64 + i * 64, offIds + 128 + i * 64));
      const value = BigInt('0x' + s.slice(offVals + 64 + i * 64, offVals + 128 + i * 64));
      if (value > 0n) ids.push({ id: id.toString(), amount: Number(value) });
    }
    return ids;
  } catch { return []; }
}

function parseLogs(logs, walletsByTopic, kind) {
  const out = [];
  for (const log of logs || []) {
    const t = log.topics || [];
    if (kind === 'erc721') {
      if (t.length !== 4 || (t[1] || '').toLowerCase() !== ZERO_TOPIC) continue;
      const wallet = walletsByTopic.get((t[2] || '').toLowerCase());
      if (!wallet) continue;
      out.push({ wallet, contract: log.address, tokenId: BigInt(t[3]).toString(), amount: 1, hash: log.transactionHash, block: parseInt(log.blockNumber, 16), is1155: false });
    } else if (kind === 'single') {
      if (t.length < 4 || (t[2] || '').toLowerCase() !== ZERO_TOPIC) continue;
      const wallet = walletsByTopic.get((t[3] || '').toLowerCase());
      if (!wallet) continue;
      const s = cleanHex(log.data);
      if (s.length < 128) continue;
      const tokenId = BigInt('0x' + s.slice(0, 64)).toString();
      const amount = Number(BigInt('0x' + s.slice(64, 128)));
      if (amount > 0) out.push({ wallet, contract: log.address, tokenId, amount, hash: log.transactionHash, block: parseInt(log.blockNumber, 16), is1155: true });
    } else if (kind === 'batch') {
      if (t.length < 4 || (t[2] || '').toLowerCase() !== ZERO_TOPIC) continue;
      const wallet = walletsByTopic.get((t[3] || '').toLowerCase());
      if (!wallet) continue;
      for (const item of parseBatchData(log.data)) out.push({ wallet, contract: log.address, tokenId: item.id, amount: item.amount, hash: log.transactionHash, block: parseInt(log.blockNumber, 16), is1155: true });
    }
  }
  return out;
}

async function getLatest(chain) {
  const hex = await rpc(chain, 'eth_blockNumber', []);
  return hex ? parseInt(hex, 16) : null;
}

async function getLogs(chain, fromBlock, toBlock, topics) {
  return rpc(chain, 'eth_getLogs', [{ fromBlock: '0x' + fromBlock.toString(16), toBlock: '0x' + toBlock.toString(16), topics }]) || [];
}

async function sendBatch(chain, entry) {
  const tgToken = process.env.TELEGRAM_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  const dsHook = process.env.DISCORD_WEBHOOK;
  const supply = await supplyInfo(chain, entry.contract, entry.is1155);
  const sample = entry.items[entry.items.length - 1];
  const extra = await metadataLinks(chain, entry.contract, sample.tokenId, entry.is1155);
  const max = supply.max;
  const total = supply.total;
  const remaining = max != null && total != null ? Math.max(max - total, 0) : null;
  const pct = max != null && total != null && max > 0 ? Math.min(100, (total / max) * 100) : null;
  const filled = pct == null ? 0 : Math.round(pct / 10);
  const bar = pct == null ? '' : '█'.repeat(filled) + '░'.repeat(10 - filled);
  const wallets = Object.values(entry.wallets);
  const breakdown = wallets.map(w => `${w.label || shorten(w.address)} ×${w.count}`).join('\n');
  const openSea = chain.openseaSlug ? `https://opensea.io/assets/${chain.openseaSlug}/${entry.contract}/${sample.tokenId}` : null;
  const explorer = chain.explorer ? `${chain.explorer}/tx/${entry.hash}` : null;
  const collectionPage = chain.explorer ? `${chain.explorer}/token/${entry.contract}` : null;
  const links = [
    explorer && `<a href="${explorer}">Explorer</a>`,
    extra.mintPage && `<a href="${extra.mintPage}">Mint Page</a>`,
    extra.x && `<a href="${extra.x}">X</a>`,
    openSea && `<a href="${openSea}">OpenSea</a>`,
    collectionPage && `<a href="${collectionPage}">Collection</a>`
  ].filter(Boolean).join(' · ');
  const supplyLine = max != null && total != null
    ? `📊 Supply: <b>${total.toLocaleString()}/${max.toLocaleString()}</b>\n📈 ${bar} ${pct.toFixed(1)}%\n🟢 Remaining: <b>${remaining.toLocaleString()}</b>`
    : total != null ? `📊 Current supply: <b>${total.toLocaleString()}</b>\n⚠️ Max supply is not exposed by this contract` : '📊 Supply data unavailable for this contract';
  const text = `🟣 <b>NEW NFT MINT</b> · <b>${chain.id.toUpperCase()}</b>\n\n<b>${entry.name}</b>\n\n🔥 Minted this cycle: <b>${entry.minted}</b>\n👥 Wallets involved: <b>${wallets.length}</b>\n\n<b>Wallet Breakdown</b>\n${breakdown}\n\n${supplyLine}\n\n📄 Contract: <code>${entry.contract}</code>\n🔢 Sample Token ID: <b>${sample.tokenId}</b>\n\n${links}`;
  const embed = {
    title: '🟣 NEW NFT MINT',
    description: `**${entry.name}** · ${chain.id.toUpperCase()}`,
    fields: [
      { name: 'Minted this cycle', value: String(entry.minted), inline: true },
      { name: 'Wallets involved', value: String(wallets.length), inline: true },
      max != null && total != null ? { name: 'Mint Progress', value: `${total}/${max} (${pct.toFixed(1)}%) · remaining ${remaining}`, inline: false } : total != null ? { name: 'Current Supply', value: String(total), inline: true } : null,
      { name: 'Wallet Breakdown', value: breakdown.slice(0, 1000) || '—', inline: false },
      { name: 'Contract', value: `\`${entry.contract}\``, inline: false }
    ].filter(Boolean),
    url: extra.mintPage || openSea || explorer || collectionPage,
    footer: { text: '🦅 Raven Alpha · NFT Mint' },
    timestamp: new Date().toISOString()
  };
  const results = {};
  if (tgToken && tgChat) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: tgChat, text, parse_mode: 'HTML', disable_web_page_preview: false }) });
      const j = await r.json();
      results.telegram = j.ok ? 'sent' : j.description;
    } catch (e) { results.telegram = e.message; }
  }
  if (dsHook) {
    try {
      const r = await fetch(dsHook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: '🍌 Raven Alpha', embeds: [embed] }) });
      results.discord = r.ok ? 'sent' : `error ${r.status}`;
    } catch (e) { results.discord = e.message; }
  }
  const alert = {
    type: 'wallet_nft_mint_batch', chain: chain.id, contract: entry.contract, nftName: entry.name,
    mintedThisCycle: entry.minted, wallets, collectionSupply: total, maxSupply: max,
    remainingSupply: remaining,
    links: { explorer, mintPage: extra.mintPage || null, x: extra.x || null, openSea, collection: collectionPage },
    result: results, at: new Date().toISOString()
  };
  const log = store.get('alerts_log', []);
  log.unshift(alert);
  store.set('alerts_log', log.slice(0, 300));
  return alert;
}

async function scanRpcChain(chain, wallets) {
  const latest = await getLatest(chain);
  if (latest == null) return [];
  const last = store.get(`nft_last_block_${chain.id}`, null);
  const from = last == null ? Math.max(0, latest - 20) : Math.max(0, Number(last) + 1);
  if (from > latest) return [];
  const walletsByTopic = new Map(wallets.map(w => [topicAddr(w.address), w]));
  const walletTopics = [...walletsByTopic.keys()];
  const found = [];
  const walletBatchSize = 500;
  const blockSpan = 500;
  for (let start = from; start <= latest; start += blockSpan) {
    const end = Math.min(latest, start + blockSpan - 1);
    for (let i = 0; i < walletTopics.length; i += walletBatchSize) {
      const addrs = walletTopics.slice(i, i + walletBatchSize);
      const [erc721, single, batch] = await Promise.all([
        getLogs(chain, start, end, [TRANSFER_TOPIC, ZERO_TOPIC, addrs]),
        getLogs(chain, start, end, [ERC1155_TRANSFER_SINGLE, null, ZERO_TOPIC, addrs]),
        getLogs(chain, start, end, [ERC1155_TRANSFER_BATCH, null, ZERO_TOPIC, addrs])
      ]);
      found.push(...parseLogs(erc721, walletsByTopic, 'erc721'));
      found.push(...parseLogs(single, walletsByTopic, 'single'));
      found.push(...parseLogs(batch, walletsByTopic, 'batch'));
    }
  }
  store.set(`nft_last_block_${chain.id}`, latest);
  return found;
}

async function scanExplorerChain(chain, wallets) {
  const found = [];
  for (const w of wallets) {
    const qs = new URLSearchParams({ module: 'account', action: 'tokennfttx', address: w.address, sort: 'desc', offset: '100', ...(chain.extraParams || {}) });
    const res = await jsonFetch(`${chain.api}?${qs}`);
    for (const tx of res?.result || []) {
      if ((tx.from || '').toLowerCase() !== ZERO || (tx.to || '').toLowerCase() !== w.address.toLowerCase()) continue;
      found.push({ wallet: w, contract: tx.contractAddress, tokenId: String(tx.tokenID), amount: 1, hash: tx.hash, block: Number(tx.blockNumber || 0), is1155: false, name: tx.tokenName });
    }
  }
  return found;
}

async function runNftScan() {
  if (running) return { skipped: true, reason: 'scan already running' };
  running = true;
  try {
    const wallets = getWallets();
    const byChain = {};
    for (const w of wallets) if (ACTIVE_CHAIN_IDS.includes(w.chain)) (byChain[w.chain] ||= []).push(w);
    const seen = new Set(store.get('nft_seen_mints_v2', []));
    const cycle = {};
    let discovered = 0;
    for (const chain of CHAINS) {
      if (chain.comingSoon) continue;
      const ws = byChain[chain.id] || [];
      if (!ws.length) continue;
      const items = chain.rpc ? await scanRpcChain(chain, ws) : await scanExplorerChain(chain, ws);
      for (const item of items) {
        const id = `${chain.id}:${item.contract.toLowerCase()}:${item.tokenId}:${item.hash}:${item.wallet.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        discovered += item.amount || 1;
        const key = `${chain.id}:${item.contract.toLowerCase()}`;
        const entry = cycle[key] ||= { chain, contract: item.contract, name: item.name || null, minted: 0, wallets: {}, items: [], hash: item.hash, is1155: item.is1155 };
        if (!entry.name || entry.name === 'New Collection') entry.name = (await contractMeta(chain, item.contract)).name;
        entry.minted += item.amount || 1;
        entry.items.push(item);
        const w = entry.wallets[item.wallet.id] ||= { walletId: item.wallet.id, address: item.wallet.address, label: item.wallet.label, count: 0 };
        w.count += item.amount || 1;
      }
    }
    const alerts = [];
    for (const entry of Object.values(cycle)) alerts.push(await sendBatch(entry.chain, entry));
    store.set('nft_seen_mints_v2', [...seen].slice(-20000));
    store.set('last_scan', { at: new Date().toISOString(), walletsScanned: wallets.length, alertsSent: alerts.length, nftOnly: true });
    return { walletsScanned: wallets.length, alertsSent: alerts.length, nftMints: discovered, alerts };
  } finally { running = false; }
}

module.exports = { runNftScan };
