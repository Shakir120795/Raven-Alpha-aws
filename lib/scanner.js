const store = require("./store");
const { getWallets } = require("./wallets");
const { CHAINS, ACTIVE_CHAIN_IDS } = require("./chains");

const ZERO = "0x0000000000000000000000000000000000000000";
const shorten = (a = "") => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

// Token (ERC20 "new buy") tracking is OFF by default — NFT mint tracking
// stays fully active. Turning tokens off skips: the Etherscan/Blockscout
// `tokentx` REST call per wallet (biggest quota consumer), the RPC
// name()/symbol() eth_call lookups, and the Dexscreener market-data calls.
// To re-enable later, just add TOKEN_TRACKING_ENABLED=true to .env and
// `pm2 restart raven-alpha` — no code changes needed.
const TOKEN_TRACKING_ENABLED = String(process.env.TOKEN_TRACKING_ENABLED || "false").toLowerCase() === "true";

const safeFetch = async (url, opts = {}) => {
  try {
    const r = await fetch(url, opts);
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
};

const isRateLimited = (res) => {
  if (!res) return true;
  const msg = `${res.message || ""} ${res.result || ""}`.toLowerCase();
  return res.status === "0" && (msg.includes("rate limit") || msg.includes("max calls") || msg.includes("too many requests"));
};

// ── Rate-limit alerting (with cooldown so we don't spam every scan) ──
const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min
async function notifyAllKeysRateLimited(chain, keyCount) {
  const cooldowns = store.get("rate_limit_cooldowns", {});
  const last = cooldowns[chain.id] || 0;
  if (Date.now() - last < RATE_LIMIT_COOLDOWN_MS) return; // still in cooldown
  cooldowns[chain.id] = Date.now();
  store.set("rate_limit_cooldowns", cooldowns);

  const tgToken = process.env.TELEGRAM_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  const text =
    `⚠️ <b>RATE LIMIT HIT</b> · <b>${chain.id.toUpperCase()}</b>\n\n` +
    `Saari ${keyCount} configured API key${keyCount > 1 ? "s" : ""} rate-limited hai is chain ke liye.\n` +
    `Scan data is chain ke liye miss ho sakta hai jab tak limit reset na ho.\n\n` +
    `👉 Naya key add karo ${chain.id.toUpperCase()}_KEYS env var mein, ya thoda wait karo.`;

  if (tgToken && tgChat) {
    try {
      await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: tgChat, text, parse_mode: "HTML" }),
      });
    } catch {}
  }

  logSystemAlert({ kind: "rate_limit", chain: chain.id, message: `Saari ${keyCount} API key(s) rate-limited` });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Auto-throttle ────────────────────────────────────────────────────
// Free-tier explorers cap requests/sec. Instead of firing as fast as
// possible and hoping keys absorb it, we self-pace: base interval assumes
// ~3 req/sec safe budget per key (conservative for Etherscan-style APIs),
// divided across however many keys are configured for that chain. Chains
// with no key (Blockscout: robinhood, ink) get one fixed gentle interval.
const BASE_INTERVAL_MS = 1000 / 3; // ~333ms = 3 req/sec per key
const NO_KEY_INTERVAL_MS = 300;    // gentle default for Blockscout chains
const lastCallAt = {};

async function throttle(chain, keyCount) {
  const interval = keyCount > 0 ? BASE_INTERVAL_MS / keyCount : NO_KEY_INTERVAL_MS;
  const last = lastCallAt[chain.id] || 0;
  const wait = interval - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastCallAt[chain.id] = Date.now();
}

// ── Multi-RPC failover ──────────────────────────────────────────────
async function explorerFetch(chain, params) {
  const raw = process.env[`${chain.id.toUpperCase()}_KEYS`] || "";
  const keys = raw.split(",").map(k => k.trim()).filter(Boolean);
  const qs = new URLSearchParams({ ...(chain.extraParams || {}), ...params }).toString();

  await throttle(chain, keys.length);

  if (!keys.length) {
    if (!chain.noKeyRequired) return null;
    return safeFetch(`${chain.api}?${qs}`);
  }

  let last = null;
  for (const key of keys) {
    const res = await safeFetch(`${chain.api}?${qs}&apikey=${key}`);
    if (!isRateLimited(res)) {
      if (res?.status === "0" && res.message === "NOTOK") {
        console.warn(`[${chain.id}] explorer API NOTOK:`, res.result);
      }
      return res;
    }
    last = res;
  }
  await notifyAllKeysRateLimited(chain, keys.length);
  return last;
}

const fmtUsd = (n) => {
  if (n == null || isNaN(n)) return null;
  n = Number(n);
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
};

function pickBestPair(pairs, contract) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const needle = String(contract || "").toLowerCase();
  const matching = pairs.filter(p => {
    const base = String(p?.baseToken?.address || "").toLowerCase();
    const quote = String(p?.quoteToken?.address || "").toLowerCase();
    return base === needle || quote === needle;
  });
  const candidates = matching.length ? matching : pairs;
  return candidates.reduce((a, b) =>
    Number(b?.liquidity?.usd || 0) > Number(a?.liquidity?.usd || 0) ? b : a
  );
}

// DexScreener can lag a newly-created pair by a few seconds. Try the direct
// token endpoint first, then its search endpoint, with short retries. This
// keeps fresh Arc token alerts useful without inventing market numbers when
// DexScreener has not indexed the token yet.
async function fetchMarketData(contract) {
  if (!contract) return null;

  const tokenUrl = `https://api.dexscreener.com/latest/dex/tokens/${contract}`;
  const searchUrl = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(contract)}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const tokenData = await safeFetch(tokenUrl);
    let best = pickBestPair(tokenData?.pairs, contract);

    if (!best) {
      const searchData = await safeFetch(searchUrl);
      best = pickBestPair(searchData?.pairs, contract);
    }

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

// NOTE: NFT marketplace listing (floor price / which marketplace) has no
// reliable free API across eth/robinhood/arc/ink, so this stays link-only.
// OpenSea link is added for eth. If you know a marketplace base-URL for
// robinhood/arc/ink (e.g. Blockscout-based markets), add a `marketplace`
// field to that chain in chains.js and it'll be picked up automatically.
function explorerLinks(chain, { hash, contract, tokenId } = {}) {
  const base = chain.explorer;
  const links = {};
  if (base && hash) links.tx = `${base}/tx/${hash}`;
  if (base && contract) links.token = `${base}/token/${contract}`;
  if (chain.openseaSlug && contract && tokenId != null) {
    links.opensea = `https://opensea.io/assets/${chain.openseaSlug}/${contract}/${tokenId}`;
  }
  if (chain.marketplace && contract) {
    links.marketplace = tokenId != null
      ? `${chain.marketplace}/${contract}/${tokenId}`
      : `${chain.marketplace}/${contract}`;
  }
  return links;
}

// Tracks, per contract (token or NFT collection), which tracked wallets have
// minted it, plus a running total-mints counter (so we can show "N items
// minted across M wallets" even when the same wallet mints multiple items).
function recordMinter(registry, chainId, contract, walletEntry) {
  const key = `${chainId}:${(contract || "").toLowerCase()}`;
  const entry = registry[key] || { minters: [], totalMints: 0 };
  entry.totalMints = (entry.totalMints || 0) + 1;
  const existing = entry.minters.find(m => m.walletId === walletEntry.walletId);
  if (existing) {
    existing.count = (existing.count || 1) + 1;
  } else {
    entry.minters.push({ ...walletEntry, count: 1 });
  }
  registry[key] = entry;
  return { minters: entry.minters, totalMints: entry.totalMints };
}

// Batches NFT mints THIS SCAN CYCLE ONLY, grouped by contract, so we can
// send one consolidated alert per collection per scan instead of one alert
// per individual mint (which was flooding Telegram/Discord with dozens of
// near-identical messages every 5 minutes). Cleared fresh every runScan().
function addCycleMint(cycleMints, chainId, contract, nftName, tokenId, hash, walletEntry) {
  const key = `${chainId}:${(contract || "").toLowerCase()}`;
  const entry = cycleMints[key] || { chain: chainId, contract, nftName, hash, tokenIds: [], wallets: {} };
  if (nftName && nftName !== "New Collection") entry.nftName = nftName;
  entry.hash = hash;
  entry.tokenIds.push(tokenId);
  const existing = entry.wallets[walletEntry.walletId] || { ...walletEntry, count: 0 };
  existing.count += 1;
  entry.wallets[walletEntry.walletId] = existing;
  cycleMints[key] = entry;
}

function logAlert(alert) {
  const log = store.get("alerts_log", []);
  log.unshift({ ...alert, sentAt: new Date().toISOString() });
  store.set("alerts_log", log.slice(0, 300));
}

// System-level notices (rate limit hit, RPC failure) — kept separate from
// alerts_log so the dashboard can show them in their own section without
// mixing with actual token/NFT alerts.
function logSystemAlert(notice) {
  const log = store.get("system_alerts", []);
  log.unshift({ ...notice, at: new Date().toISOString() });
  store.set("system_alerts", log.slice(0, 100));
}

async function sendAlert(alert) {
  const tgToken = process.env.TELEGRAM_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  const results = {};

  const chainObj = CHAINS.find(c => c.id === alert.chain) || {};
  const isNft = alert.type === "wallet_nft_mint" || alert.type === "wallet_nft_mint_batch";
  const dsHook = isNft ? process.env.DISCORD_NFT_WEBHOOK : process.env.DISCORD_TOKEN_WEBHOOK;
  const action = String(alert.action || "buy").toLowerCase();
  const verb = isNft ? "minted" : action === "sell" ? "sold" : "bought";

  const minters = alert.minters || [];
  const minterCount = minters.length;
  const totalMints = alert.totalMints || minterCount;
  const otherMinters = minters.filter(m => m.walletId !== alert.walletId);
  const othersCount = otherMinters.length;
  const walletLabel = alert.walletLabel || shorten(alert.address);
  const othersSuffixHtml = othersCount ? ` <i>(+ ${othersCount} other tracked wallet${othersCount > 1 ? "s" : ""})</i>` : "";
  const othersSuffixPlain = othersCount ? ` (+${othersCount} other)` : "";
  const minterBreakdown = minters.map(m => `${m.label || shorten(m.address)}${m.count > 1 ? ` (x${m.count})` : ""}`).join(", ");

  const links = explorerLinks(chainObj, { hash: alert.hash, contract: alert.contract, tokenId: alert.tokenId });
  if (alert.mintPage) links.mint = alert.mintPage;
  if (alert.twitterSearch) links.twitter = alert.twitterSearch;

  let text, embed;

  if (!isNft) {
    const md = alert.marketData;
    text =
      `${action === "sell" ? "🔴" : "🟢"} <b>${alert.tokenName || "Token"}</b>${alert.sym ? ` · <b>${alert.sym}</b>` : ""} — Token ${action === "sell" ? "Sell" : "Buy"}\n\n` +
      `🏷 Type: <b>Token ${action === "sell" ? "Sell" : "Buy"}</b>\n` +
      `⛓ Chain: <b>${alert.chain.toUpperCase()}</b>\n` +
      (md?.marketCap ? `💰 Market Cap: <b>${fmtUsd(md.marketCap)}</b>\n` : "") +
      (md?.liquidityUsd ? `💧 Liquidity: <b>${fmtUsd(md.liquidityUsd)}</b>\n` : "") +
      (md?.volume24h ? `📊 Vol 24h: <b>${fmtUsd(md.volume24h)}</b>\n` : "") +
      (md?.dex ? `🧩 DEX: <b>${md.dex}</b>\n` : "") +
      `\n👛 Wallet: <b>${walletLabel}</b>${othersSuffixHtml}\n` +
      (minterCount ? `👥 Tracked wallets that ${verb} this: ${minterBreakdown}\n` : "") +
      (totalMints > minterCount ? `🧮 Total buys by tracked wallets: <b>${totalMints}</b>\n` : "") +
      `\n📄 Contract: <code>${alert.contract}</code>\n` +
      `🧾 <code>${(alert.hash || "").slice(0, 16)}…</code>` +
      (md?.url ? `\n\n🔗 <a href="${md.url}">Chart</a>` : "") +
      (links.tx ? ` · <a href="${links.tx}">Tx</a>` : "") +
      (links.token ? ` · <a href="${links.token}">Token Page</a>` : "") +
      `\n\n⚠️ dyor, nfa`;

    embed = {
      title: `${action === "sell" ? "🔴" : "🟢"} ${alert.tokenName || "Token"}${alert.sym ? ` · ${alert.sym}` : ""}`,
      color: action === "sell" ? 0xE74C3C : 0x2ECC71,
      description: `Token **${action === "sell" ? "Sell" : "Buy"}** detected on a tracked wallet`,
      fields: [
        { name: "Chain", value: alert.chain.toUpperCase(), inline: true },
        md?.marketCap && { name: "Market Cap", value: fmtUsd(md.marketCap), inline: true },
        md?.liquidityUsd && { name: "Liquidity", value: fmtUsd(md.liquidityUsd), inline: true },
        md?.volume24h && { name: "Vol 24h", value: fmtUsd(md.volume24h), inline: true },
        md?.dex && { name: "DEX", value: md.dex, inline: true },
        { name: "Wallet", value: walletLabel + othersSuffixPlain, inline: true },
        minterCount > 0 && { name: `Tracked wallets that ${action === "sell" ? "sold" : "bought"} this (${minterCount})`, value: minterBreakdown.slice(0, 1000), inline: false },
        totalMints > minterCount && { name: `Total ${action === "sell" ? "sells" : "buys"} (tracked wallets)`, value: String(totalMints), inline: true },
        { name: "Contract", value: `\`${alert.contract}\``, inline: false },
        { name: "Tx", value: `\`${(alert.hash || "").slice(0, 16)}…\``, inline: false },
      ].filter(Boolean),
      url: md?.url || links.tx || links.token || undefined,
      footer: { text: "🦅 Raven Alpha · dyor, nfa" },
      timestamp: new Date().toISOString(),
    };
  } else {
    const supplyLine = alert.collectionSupply != null ? `📦 Collection-wide minted so far: <b>${alert.collectionSupply}</b>\n` : "";
    const supplyEmbedField = alert.collectionSupply != null && { name: "Collection-wide Minted", value: String(alert.collectionSupply), inline: true };
    text =
      `🟣 <b>NEW MINT DETECTED</b> · <b>${alert.chain.toUpperCase()}</b>\n\n` +
      `${alert.nftName || "New Collection"}\n\n` +
      `🏷 Type: <b>NFT Mint</b>\n` +
      `🔢 Token ID: <b>${alert.tokenId}</b>\n` +
      supplyLine +
      `👛 Wallet: <b>${walletLabel}</b>${othersSuffixHtml}\n` +
      (minterCount ? `👥 Tracked wallets that ${verb} this: ${minterBreakdown}\n` : "") +
      (totalMints > minterCount ? `🧮 Total items minted by tracked wallets: <b>${totalMints}</b>\n` : "") +
      `\n📄 Contract: <code>${alert.contract}</code>\n` +
      `🧾 <code>${(alert.hash || "").slice(0, 16)}…</code>` +
      (links.tx ? `\n\n🔗 <a href="${links.tx}">Explorer</a>` : "") +
      (links.mint ? ` · <a href="${links.mint}">Mint Page</a>` : "") +
      (links.token ? ` · <a href="${links.token}">Collection Page</a>` : "") +
      (links.opensea ? ` · <a href="${links.opensea}">OpenSea</a>` : "") +
      (links.marketplace ? ` · <a href="${links.marketplace}">Marketplace</a>` : "") +
      (links.twitter ? ` · <a href="${links.twitter}">Search X</a>` : "");

    embed = {
      title: "🟣 NEW MINT DETECTED",
      color: 0x9945FF,
      description: `**${alert.nftName || "New Collection"}** · ${alert.chain.toUpperCase()} · NFT Mint`,
      fields: [
        { name: "Token ID", value: String(alert.tokenId), inline: true },
        supplyEmbedField,
        { name: "Wallet", value: walletLabel + othersSuffixPlain, inline: true },
        minterCount > 0 && { name: `Tracked wallets that minted this (${minterCount})`, value: minterBreakdown.slice(0, 1000), inline: false },
        totalMints > minterCount && { name: "Total items minted (tracked wallets)", value: String(totalMints), inline: true },
        { name: "Contract", value: `\`${alert.contract}\``, inline: false },
        { name: "Tx", value: `\`${(alert.hash || "").slice(0, 16)}…\``, inline: false },
      ].filter(Boolean),
      url: links.mint || links.tx || links.token || links.opensea || links.marketplace || undefined,
      footer: { text: "🦅 Raven Alpha" },
      timestamp: new Date().toISOString(),
    };
  }

  if (tgToken && tgChat) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: tgChat, text, parse_mode: "HTML" }),
      });
      const j = await r.json();
      results.telegram = j.ok ? "sent" : j.description;
    } catch (e) { results.telegram = e.message; }
  } else {
    results.telegram = "not configured (set TELEGRAM_TOKEN + TELEGRAM_CHAT_ID)";
  }

  if (dsHook) {
    try {
      const r = await fetch(dsHook, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "🍌 Raven Alpha", embeds: [embed] }),
      });
      results.discord = r.ok ? "sent" : `error ${r.status}`;
    } catch (e) { results.discord = e.message; }
  } else {
    results.discord = isNft ? "not configured (set DISCORD_NFT_WEBHOOK)" : "not configured (set DISCORD_TOKEN_WEBHOOK)";
  }

  logAlert({ ...alert, result: results, links, itemTypeLabel: isNft ? "NFT Mint" : `Token ${action === "sell" ? "Sell" : "Buy"}` });
  return results;
}

// ── RPC-based scanning (eth_getLogs) for chains with `useRpcLogs: true` ──
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ADDR_BATCH_SIZE = 100;
const MAX_BLOCK_SPAN = 3000;

const addrToTopic = (a) => "0x" + "0".repeat(24) + a.replace(/^0x/, "").toLowerCase();
const topicToAddr = (t) => "0x" + t.slice(-40);

function decodeAbiString(hex) {
  if (!hex || hex === "0x") return null;
  try {
    const clean = hex.slice(2);
    const offset = parseInt(clean.slice(0, 64), 16) * 2;
    const length = parseInt(clean.slice(offset, offset + 64), 16) * 2;
    const strHex = clean.slice(offset + 64, offset + 64 + length);
    const bytes = strHex.match(/.{1,2}/g) || [];
    const str = Buffer.from(bytes.join(""), "hex").toString("utf8").replace(/\0/g, "").trim();
    return str || null;
  } catch { return null; }
}

function decodeAbiUint(hex) {
  if (!hex || hex === "0x") return null;
  try {
    const n = parseInt(hex, 16);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

async function ethCallRaw(chain, contract, selector) {
  return rpcCall(chain, "eth_call", [{ to: contract, data: selector }, "latest"]);
}

const tokenMetaCache = {};
async function fetchTokenMetaRpc(chain, contract) {
  const key = `${chain.id}:${contract.toLowerCase()}`;
  if (tokenMetaCache[key]) return tokenMetaCache[key];
  const [nameHex, symHex] = await Promise.all([
    ethCallRaw(chain, contract, "0x06fdde03"),
    ethCallRaw(chain, contract, "0x95d89b41"),
  ]);
  const meta = { name: decodeAbiString(nameHex), symbol: decodeAbiString(symHex) };
  tokenMetaCache[key] = meta;
  return meta;
}

async function fetchTotalSupplyRpc(chain, contract) {
  const hex = await ethCallRaw(chain, contract, "0x18160ddd");
  return decodeAbiUint(hex);
}
