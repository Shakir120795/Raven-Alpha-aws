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
        // Not a rate-limit, but not success either (e.g. deprecated endpoint,
        // bad params, unsupported action) — log it so it's visible instead
        // of silently returning an empty result forever.
        console.warn(`[${chain.id}] explorer API NOTOK:`, res.result);
      }
      return res;
    }
    last = res;
  }
  // all keys exhausted / rate-limited
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

async function fetchMarketData(contract) {
  if (!contract) return null;
  const data = await safeFetch(`https://api.dexscreener.com/latest/dex/tokens/${contract}`);
  const pairs = data?.pairs;
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const best = pairs.reduce((a, b) => (Number(b.liquidity?.usd || 0) > Number(a.liquidity?.usd || 0) ? b : a));
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
  const dsHook = process.env.DISCORD_WEBHOOK;
  const results = {};

  const chainObj = CHAINS.find(c => c.id === alert.chain) || {};
  const isNft = alert.type === "wallet_nft_mint";
  const verb = isNft ? "minted" : "bought";

  const minters = alert.minters || [];
  const minterCount = minters.length;
  const totalMints = alert.totalMints || minterCount;
  // Every OTHER tracked wallet (besides the one that triggered this alert)
  // that has also bought/minted this same contract — this is the cross-
  // wallet reference that was missing before.
  const otherMinters = minters.filter(m => m.walletId !== alert.walletId);
  const othersCount = otherMinters.length;
  const walletLabel = alert.walletLabel || shorten(alert.address);
  const othersSuffixHtml = othersCount ? ` <i>(+ ${othersCount} other tracked wallet${othersCount > 1 ? "s" : ""})</i>` : "";
  const othersSuffixPlain = othersCount ? ` (+${othersCount} other)` : "";
  // Full breakdown: every tracked wallet that has ever bought/minted this
  // contract, plus how many times each one did it.
  const minterBreakdown = minters.map(m => `${m.label || shorten(m.address)}${m.count > 1 ? ` (x${m.count})` : ""}`).join(", ");

  const links = explorerLinks(chainObj, { hash: alert.hash, contract: alert.contract, tokenId: alert.tokenId });
  // Best-effort extras from NFT tokenURI metadata (see fetchNftExternalLinks
  // below) — official project/mint site (`external_url`) and an X/Twitter
  // search link built from the collection name. Only populated for NFT
  // mints on chains where we could read tokenURI (robinhood, ink for now).
  if (alert.mintPage) links.mint = alert.mintPage;
  if (alert.twitterSearch) links.twitter = alert.twitterSearch;

  let text, embed;

  if (!isNft) {
    const md = alert.marketData;
    text =
      `🔥 <b>${alert.tokenName || "New Token"}</b>${alert.sym ? ` · <b>$${alert.sym}</b>` : ""} — New Token Buy\n\n` +
      `🏷 Type: <b>Token</b>\n` +
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
      title: `🔥 ${alert.tokenName || "New Token"}${alert.sym ? ` · $${alert.sym}` : ""}`,
      color: 0xF5C843,
      description: "New **Token** Buy detected on a tracked wallet",
      fields: [
        { name: "Chain", value: alert.chain.toUpperCase(), inline: true },
        md?.marketCap && { name: "Market Cap", value: fmtUsd(md.marketCap), inline: true },
        md?.liquidityUsd && { name: "Liquidity", value: fmtUsd(md.liquidityUsd), inline: true },
        md?.volume24h && { name: "Vol 24h", value: fmtUsd(md.volume24h), inline: true },
        md?.dex && { name: "DEX", value: md.dex, inline: true },
        { name: "Wallet", value: walletLabel + othersSuffixPlain, inline: true },
        minterCount > 0 && { name: `Tracked wallets that bought this (${minterCount})`, value: minterBreakdown.slice(0, 1000), inline: false },
        totalMints > minterCount && { name: "Total buys (tracked wallets)", value: String(totalMints), inline: true },
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
    results.discord = "not configured (set DISCORD_WEBHOOK)";
  }

  logAlert({ ...alert, result: results, links, itemTypeLabel: isNft ? "NFT Mint" : "Token" });
  return results;
}

// ── RPC-based scanning (eth_getLogs) for chains with `useRpcLogs: true` ──
// Instead of one Blockscout REST call per wallet (2 calls × N wallets — the
// thing that blows past free-tier limits), we send ONE batched eth_getLogs
// call (per address-chunk) covering ALL tracked wallets on that chain at
// once, filtered to just the new blocks since the last scan. Free public
// RPC, no account/key, no per-wallet multiplication.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ADDR_BATCH_SIZE = 100;   // wallets per getLogs call (topics OR-list)
const MAX_BLOCK_SPAN = 3000;   // chunk size if we fell behind (e.g. after downtime)

const addrToTopic = (a) => "0x" + "0".repeat(24) + a.replace(/^0x/, "").toLowerCase();
const topicToAddr = (t) => "0x" + t.slice(-40);

// ── On-chain metadata helpers (RPC-log chains only: robinhood, ink) ──
// Best-effort ERC20 name()/symbol() and ERC721 totalSupply() reads, so RPC-
// log alerts show real token/collection info instead of generic "New Token"
// / "New Collection" placeholders (ETH/Arc already get this from the
// Blockscout/Etherscan REST response directly — no change needed there).
// Failures are swallowed — worst case we fall back to the generic label,
// same behavior as before this change.
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

// Per-process cache — name/symbol never change for a given contract, so no
// need to re-fetch every scan once we've seen it once.
const tokenMetaCache = {};
async function fetchTokenMetaRpc(chain, contract) {
  const key = `${chain.id}:${contract.toLowerCase()}`;
  if (tokenMetaCache[key]) return tokenMetaCache[key];
  const [nameHex, symHex] = await Promise.all([
    ethCallRaw(chain, contract, "0x06fdde03"), // name()
    ethCallRaw(chain, contract, "0x95d89b41"), // symbol()
  ]);
  const meta = { name: decodeAbiString(nameHex), symbol: decodeAbiString(symHex) };
  tokenMetaCache[key] = meta;
  return meta;
}

// totalSupply() changes over time (more get minted), so this is NOT cached —
// fetched fresh each time so "collection-wide minted so far" stays accurate.
async function fetchTotalSupplyRpc(chain, contract) {
  const hex = await ethCallRaw(chain, contract, "0x18160ddd"); // totalSupply()
  return decodeAbiUint(hex);
}

// Explorer-side total supply (ETH/Arc), best-effort via Etherscan/Blockscout
// "stats" module. Failure just means we skip the supply line, same as before.
async function fetchTotalSupplyExplorer(chain, contract) {
  try {
    const res = await explorerFetch(chain, { module: "stats", action: "tokensupply", contractaddress: contract });
    const n = parseInt(res?.result, 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// ── NFT tokenURI metadata (official mint-site link + X search link) ──
// Reads ERC721 tokenURI(uint256) via eth_call — only possible on chains
// where we have a public RPC endpoint configured (`chain.rpc`: robinhood,
// ink). ETH/Arc go through the Explorer-REST path and have no `rpc` field
// set, so this returns {} immediately for them — same silent-skip pattern
// as fetchTotalSupplyExplorer failures, no crash, no extra noise.
//
// Resolves ipfs:// URIs via a public gateway and inline base64 data: URIs,
// fetches the JSON metadata, and pulls:
//   - `external_url` → official project/mint-page link (NOT guaranteed to
//     exist — many collections simply don't set it, in which case this is
//     silently omitted and the alert falls back to Explorer/Collection Page
//     links only, same as before this change)
//   - `name` → used to build a best-effort X/Twitter search link so the
//     user can manually find the project's account (NOT a guaranteed direct
//     handle — X has no reliable public "search by NFT contract" API)
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
function resolveUri(uri) {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) return IPFS_GATEWAY + uri.replace("ipfs://", "");
  return uri;
}

async function fetchNftExternalLinks(chain, contract, tokenId) {
  if (!chain.rpc || !contract || tokenId == null) return {};
  try {
    const idHex = BigInt(tokenId).toString(16).padStart(64, "0");
    const uriHex = await ethCallRaw(chain, contract, "0xc87b56dd" + idHex); // tokenURI(uint256)
    const uriStr = decodeAbiString(uriHex);
    if (!uriStr) return {};

    let json = null;
    if (uriStr.startsWith("data:application/json")) {
      const b64 = uriStr.split(",")[1] || "";
      json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    } else {
      const url = resolveUri(uriStr);
      const res = await fetch(url).catch(() => null);
      if (res?.ok) json = await res.json().catch(() => null);
    }
    if (!json) return {};

    const mintPage = json.external_url || null;
    const collectionName = json.name || null;
    const twitterSearch = collectionName
      ? `https://twitter.com/search?q=${encodeURIComponent(collectionName)}&f=live`
      : null;
    return { mintPage, twitterSearch };
  } catch {
    return {};
  }
}

// Best-effort maxSupply() read (selector 0xd5abeb01 — a common but NOT
// universal convention; plenty of contracts don't implement it, in which
// case this just returns null and the progress bar is omitted, same
// silent-fallback pattern as everything else here).
async function fetchMaxSupplyRpc(chain, contract) {
  if (!chain.rpc) return null;
  const hex = await ethCallRaw(chain, contract, "0xd5abeb01");
  return decodeAbiUint(hex);
}

// Renders a simple text progress bar. Returns null (omit entirely) if we
// don't have a max supply to compare against.
function renderProgressBar(minted, max, size = 12) {
  if (max == null || max <= 0 || minted == null) return null;
  const ratio = Math.min(minted / max, 1);
  const filled = Math.round(ratio * size);
  return "▓".repeat(filled) + "░".repeat(Math.max(size - filled, 0)) + ` ${Math.round(ratio * 100)}%`;
}

// ── Consolidated per-collection NFT alert (once per scan cycle) ──
// Replaces the old one-alert-per-mint approach. Fetches collection supply,
// max supply (best-effort), and mint-page/twitter links ONCE per contract
// (not once per mint — also cuts down on RPC calls), then sends a single
// message listing every tracked wallet that minted this cycle.
async function sendNftBatchAlert(chain, entry) {
  const tgToken = process.env.TELEGRAM_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  const dsHook = process.env.DISCORD_WEBHOOK;
  const results = {};

  const walletsArr = Object.values(entry.wallets);
  const mintedThisCycle = entry.tokenIds.length;
  const repTokenId = entry.tokenIds[entry.tokenIds.length - 1]; // most recent-ish, for links

  const [collectionSupply, maxSupply, extraLinks] = await Promise.all([
    chain.useRpcLogs ? fetchTotalSupplyRpc(chain, entry.contract) : fetchTotalSupplyExplorer(chain, entry.contract),
    fetchMaxSupplyRpc(chain, entry.contract),
    fetchNftExternalLinks(chain, entry.contract, repTokenId),
  ]);

  const links = explorerLinks(chain, { hash: entry.hash, contract: entry.contract, tokenId: repTokenId });
  if (extraLinks.mintPage) links.mint = extraLinks.mintPage;
  if (extraLinks.twitterSearch) links.twitter = extraLinks.twitterSearch;

  const bar = renderProgressBar(collectionSupply, maxSupply);
  const supplyLine = maxSupply != null
    ? `📦 Progress: <b>${collectionSupply}/${maxSupply}</b>${bar ? `  ${bar}` : ""}\n`
    : (collectionSupply != null ? `📦 Collection-wide minted so far: <b>${collectionSupply}</b>\n` : "");

  const walletsBreakdown = walletsArr.map(w => `${w.label || shorten(w.address)}${w.count > 1 ? ` (x${w.count})` : ""}`).join(", ");

  const linksLine =
    (links.tx ? `\n\n🔗 <a href="${links.tx}">Explorer</a>` : "") +
    (links.mint ? ` · <a href="${links.mint}">Mint Page</a>` : "") +
    (links.token ? ` · <a href="${links.token}">Collection Page</a>` : "") +
    (links.opensea ? ` · <a href="${links.opensea}">OpenSea</a>` : "") +
    (links.marketplace ? ` · <a href="${links.marketplace}">Marketplace</a>` : "") +
    (links.twitter ? ` · <a href="${links.twitter}">Search X</a>` : "");

  const text =
    `🟣 <b>NFT MINT UPDATE</b> · <b>${chain.id.toUpperCase()}</b>\n\n` +
    `${entry.nftName || "New Collection"}\n\n` +
    `🔢 Minted this cycle: <b>${mintedThisCycle}</b> (by <b>${walletsArr.length}</b> tracked wallet${walletsArr.length > 1 ? "s" : ""})\n` +
    `👥 Wallets: ${walletsBreakdown}\n` +
    supplyLine +
    `\n📄 Contract: <code>${entry.contract}</code>` +
    linksLine;

  const embed = {
    title: "🟣 NFT MINT UPDATE",
    color: 0x9945FF,
    description: `**${entry.nftName || "New Collection"}** · ${chain.id.toUpperCase()}`,
    fields: [
      { name: "Minted this cycle", value: String(mintedThisCycle), inline: true },
      maxSupply != null && { name: "Progress", value: `${collectionSupply}/${maxSupply}${bar ? ` (${bar})` : ""}`, inline: true },
      maxSupply == null && collectionSupply != null && { name: "Collection-wide Minted", value: String(collectionSupply), inline: true },
      { name: `Wallets (${walletsArr.length})`, value: walletsBreakdown.slice(0, 1000), inline: false },
      { name: "Contract", value: `\`${entry.contract}\``, inline: false },
    ].filter(Boolean),
    url: links.mint || links.tx || links.token || links.opensea || links.marketplace || undefined,
    footer: { text: "🦅 Raven Alpha" },
    timestamp: new Date().toISOString(),
  };

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
    results.discord = "not configured (set DISCORD_WEBHOOK)";
  }

  logAlert({ type: "wallet_nft_mint_batch", chain: chain.id, contract: entry.contract, nftName: entry.nftName, mintedThisCycle, wallets: walletsArr, collectionSupply, maxSupply, result: results, links, itemTypeLabel: "NFT Mint (batch)" });
  return results;
}

let rpcId = 1;
async function rpcCall(chain, method, params) {
  const res = await safeFetch(chain.rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  if (!res || res.error) {
    await notifyRpcFailure(chain, res?.error?.message || "no response / network error");
    return null;
  }
  return res.result ?? null;
}

// Same cooldown pattern as notifyAllKeysRateLimited, but for RPC-based chains
// (Robinhood, Ink) where failure means the public RPC errored, rate-limited,
// or timed out — not a key issue since these chains don't use keys.
async function notifyRpcFailure(chain, reason) {
  const cooldowns = store.get("rate_limit_cooldowns", {});
  const last = cooldowns[chain.id] || 0;
  if (Date.now() - last < RATE_LIMIT_COOLDOWN_MS) return;
  cooldowns[chain.id] = Date.now();
  store.set("rate_limit_cooldowns", cooldowns);

  const tgToken = process.env.TELEGRAM_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  const text =
    `⚠️ <b>RPC FAILURE</b> · <b>${chain.id.toUpperCase()}</b>\n\n` +
    `Public RPC (${chain.rpc}) ne error diya:\n<code>${reason}</code>\n\n` +
    `Is chain ka scan data miss ho sakta hai jab tak RPC theek na ho.`;

  if (tgToken && tgChat) {
    try {
      await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: tgChat, text, parse_mode: "HTML" }),
      });
    } catch {}
  }

  logSystemAlert({ kind: "rpc_failure", chain: chain.id, message: reason });
}

// Returns an array of pseudo-tx objects shaped like Blockscout's tokentx/
// tokennfttx rows, so the same downstream alerting logic can consume them.
async function rpcFetchTransfers(chain, wallets) {
  if (!wallets.length) return [];

  const latestHex = await rpcCall(chain, "eth_blockNumber", []);
  if (!latestHex) return [];
  const latest = parseInt(latestHex, 16);

  const lastBlocks = store.get("rpc_last_block", {});
  let from = lastBlocks[chain.id];
  if (from == null) {
    // First run for this chain: just set the baseline, don't backfill history.
    lastBlocks[chain.id] = latest;
    store.set("rpc_last_block", lastBlocks);
    return [];
  }
  from = from + 1;
  if (from > latest) return [];

  const results = [];
  const addrChunks = [];
  for (let i = 0; i < wallets.length; i += ADDR_BATCH_SIZE) addrChunks.push(wallets.slice(i, i + ADDR_BATCH_SIZE));

  for (let start = from; start <= latest; start += MAX_BLOCK_SPAN + 1) {
    const end = Math.min(start + MAX_BLOCK_SPAN, latest);
    for (const chunk of addrChunks) {
      const topics = [TRANSFER_TOPIC, null, chunk.map(w => addrToTopic(w.address))];
      const logs = await rpcCall(chain, "eth_getLogs", [{
        fromBlock: "0x" + start.toString(16),
        toBlock: "0x" + end.toString(16),
        topics,
      }]);
      if (!Array.isArray(logs)) continue;
      for (const log of logs) {
        if (!log.topics || log.topics.length < 3) continue;
        const isNFT = log.topics.length === 4; // tokenId indexed = ERC721
        results.push({
          hash: log.transactionHash,
          contractAddress: log.address,
          from: topicToAddr(log.topics[1]),
          to: topicToAddr(log.topics[2]),
          tokenID: isNFT ? String(parseInt(log.topics[3], 16)) : undefined,
          isNFT,
        });
      }
    }
  }

  lastBlocks[chain.id] = latest;
  store.set("rpc_last_block", lastBlocks);
  return results;
}

async function runScan() {
  const wallets = getWallets();
  const knownTokens = store.get("known_tokens", {});
  const seenMints = new Set(store.get("seen_mints", []));
  const mintRegistry = store.get("mint_registry", {});
  // Per-wallet baseline flag for NFT mints (Explorer-REST path: eth, arc).
  // Without this, a wallet's FIRST scan would treat its entire NFT history
  // (however old — even 3+ years) as "new mints" and alert on all of it,
  // since `seenMints` starts empty for a wallet never scanned before. This
  // mirrors the `isBaseline` check that token tracking already had.
  const nftMintBaseline = store.get("nft_mint_baseline", {});
  let knownTokensChanged = false, seenMintsChanged = false, mintRegistryChanged = false, nftMintBaselineChanged = false;
  // Collects this-cycle-only NFT mints, grouped by contract, so we can send
  // ONE consolidated alert per collection at the end of the scan instead of
  // one alert per individual mint. Always fresh — never carries over old data.
  const cycleMints = {};
  const alertsSent = [];
  const alertsByChain = {};

  const walletsByChain = {};
  for (const w of wallets) {
    const chain = CHAINS.find(c => c.id === w.chain);
    if (!chain || chain.comingSoon || !ACTIVE_CHAIN_IDS.includes(chain.id)) continue;
    (walletsByChain[chain.id] = walletsByChain[chain.id] || []).push(w);
  }

  for (const chain of CHAINS) {
    if (chain.comingSoon || !ACTIVE_CHAIN_IDS.includes(chain.id)) continue;
    const chainWallets = walletsByChain[chain.id] || [];
    if (!chainWallets.length) continue;

    if (chain.useRpcLogs) {
      // ── RPC-log based path (Robinhood, Ink) ──
      const walletByAddr = new Map(chainWallets.map(w => [w.address.toLowerCase(), w]));
      const transfers = await rpcFetchTransfers(chain, chainWallets);

      for (const tx of transfers) {
        const w = walletByAddr.get((tx.to || "").toLowerCase());
        if (!w) continue; // shouldn't happen, but stay safe
        const isMint = tx.from === ZERO;

        if (tx.isNFT) {
          if (!isMint) continue; // only alert on fresh mints for NFTs
          const id = `wnftmint_${w.id}_${tx.hash}_${tx.tokenID}`;
          if (seenMints.has(id)) continue;
          seenMints.add(id);
          seenMintsChanged = true;

          const { minters, totalMints } = recordMinter(mintRegistry, w.chain, tx.contractAddress, { walletId: w.id, address: w.address, label: w.label });
          mintRegistryChanged = true;

          const meta = await fetchTokenMetaRpc(chain, tx.contractAddress);
          addCycleMint(cycleMints, w.chain, tx.contractAddress, meta.name, tx.tokenID, tx.hash, { walletId: w.id, address: w.address, label: w.label });
        } else {
          if (!TOKEN_TRACKING_ENABLED) continue; // token tracking off — NFT-only mode
          const contract = (tx.contractAddress || "").toLowerCase();
          const seenTokens = new Set(knownTokens[w.id] || []);
          if (!contract || seenTokens.has(contract)) continue;
          seenTokens.add(contract);
          knownTokens[w.id] = [...seenTokens];
          knownTokensChanged = true;

          // Record EVERY tracked wallet that ever buys/mints this contract —
          // not just fresh mints — so alerts can cross-reference other
          // tracked wallets holding the same token, buy or mint alike.
          const { minters, totalMints } = recordMinter(mintRegistry, w.chain, tx.contractAddress, { walletId: w.id, address: w.address, label: w.label });
          mintRegistryChanged = true;

          const [meta, marketData] = await Promise.all([
            fetchTokenMetaRpc(chain, tx.contractAddress),
            fetchMarketData(tx.contractAddress),
          ]);
          const tokenName = meta.name || marketData?.baseTokenName || "New Token";
          const sym = meta.symbol || marketData?.baseTokenSymbol || "";

          const alert = { type: "wallet_new_token", walletId: w.id, walletLabel: w.label, chain: w.chain, address: w.address, hash: tx.hash, tokenName, sym, contract: tx.contractAddress, minters, totalMints, marketData };
          const result = await sendAlert(alert);
          alertsSent.push({ ...alert, result });
        }
      }
      continue;
    }

    // ── Explorer REST path (ETH via Etherscan, Arc when live) ──
    for (const w of chainWallets) {
      // ── New token detection (skipped entirely when token tracking is off —
      // this is what actually saves explorer API quota, since it removes
      // the tokentx REST call per wallet, not just the alert logic) ──
      if (TOKEN_TRACKING_ENABLED) {
        const tokRes = await explorerFetch(chain, { module: "account", action: "tokentx", address: w.address, sort: "desc", offset: 15 });
        const isBaseline = !knownTokens[w.id];
        const seenTokens = new Set(knownTokens[w.id] || []);
        for (const tx of (tokRes?.result || [])) {
          const contract = (tx.contractAddress || "").toLowerCase();
          if (!contract || seenTokens.has(contract)) continue;
          seenTokens.add(contract);
          knownTokensChanged = true;
          const isIncoming = tx.to?.toLowerCase() === w.address.toLowerCase();
          if (isBaseline || !isIncoming) continue;

          // Record EVERY tracked wallet that ever buys/mints this contract —
          // not just fresh mints — so alerts can cross-reference other
          // tracked wallets holding the same token, buy or mint alike.
          const { minters, totalMints } = recordMinter(mintRegistry, w.chain, tx.contractAddress, { walletId: w.id, address: w.address, label: w.label });
          mintRegistryChanged = true;

          const alert = { type: "wallet_new_token", walletId: w.id, walletLabel: w.label, chain: w.chain, address: w.address, hash: tx.hash, tokenName: tx.tokenName || tx.tokenSymbol || "New Token", sym: tx.tokenSymbol || "", contract: tx.contractAddress, minters, totalMints, marketData: await fetchMarketData(tx.contractAddress) };
          const result = await sendAlert(alert);
          alertsSent.push({ ...alert, result });
        }
        knownTokens[w.id] = [...seenTokens];
      }

      // ── NFT mint detection ──
      // `isNewWallet`: true only on the very first scan we ever do for this
      // wallet on this REST path. On that pass we still RECORD every mint id
      // into `seenMints` (so it's never re-alerted later), but we skip
      // actually SENDING the alert — otherwise a wallet's full NFT history
      // (Etherscan returns up to the last 10, however old) would flood out
      // as "new mint detected" the moment the wallet gets its first real scan.
      const isNewWallet = !nftMintBaseline[w.id];
      const nftRes = await explorerFetch(chain, { module: "account", action: "tokennfttx", address: w.address, sort: "desc", offset: 10 });
      for (const nft of (nftRes?.result || [])) {
        const isMint = nft.from?.toLowerCase() === ZERO && nft.to?.toLowerCase() === w.address.toLowerCase();
        if (!isMint) continue;
        const id = `wnftmint_${w.id}_${nft.hash}_${nft.tokenID}`;
        if (seenMints.has(id)) continue;
        seenMints.add(id);
        seenMintsChanged = true;
        if (isNewWallet) continue; // baseline pass — recorded, not alerted

        const { minters, totalMints } = recordMinter(mintRegistry, w.chain, nft.contractAddress, { walletId: w.id, address: w.address, label: w.label });
        mintRegistryChanged = true;

        addCycleMint(cycleMints, w.chain, nft.contractAddress, nft.tokenName, nft.tokenID, nft.hash, { walletId: w.id, address: w.address, label: w.label });
      }
      if (isNewWallet) {
        nftMintBaseline[w.id] = true;
        nftMintBaselineChanged = true;
      }
    }
  }

  // ── Send ONE consolidated alert per collection for this scan cycle ──
  // (replaces the old one-alert-per-mint approach that was flooding chat)
  for (const key of Object.keys(cycleMints)) {
    const entry = cycleMints[key];
    const chainObjForBatch = CHAINS.find(c => c.id === entry.chain);
    if (!chainObjForBatch) continue;
    const result = await sendNftBatchAlert(chainObjForBatch, entry);
    alertsSent.push({ type: "wallet_nft_mint_batch", chain: entry.chain, contract: entry.contract, mintedThisCycle: entry.tokenIds.length, result });
  }

  if (knownTokensChanged) store.set("known_tokens", knownTokens);
  if (seenMintsChanged) {
    const arr = [...seenMints];
    store.set("seen_mints", arr.length > 2000 ? arr.slice(-2000) : arr);
  }
  if (mintRegistryChanged) store.set("mint_registry", mintRegistry);
  if (nftMintBaselineChanged) store.set("nft_mint_baseline", nftMintBaseline);

  for (const a of alertsSent) alertsByChain[a.chain] = (alertsByChain[a.chain] || 0) + 1;
  const breakdown = Object.entries(alertsByChain).map(([c, n]) => `${c}:${n}`).join(", ") || "none";
  console.log(`[${new Date().toISOString()}] Alerts by chain — ${breakdown}`);

  store.set("last_scan", { at: new Date().toISOString(), walletsScanned: wallets.length, alertsSent: alertsSent.length, alertsByChain });
  return { walletsScanned: wallets.length, alertsSent: alertsSent.length, alerts: alertsSent, alertsByChain };
}

function getSystemAlerts() {
  return store.get("system_alerts", []);
}

module.exports = { runScan, fetchMarketData, sendAlert, getSystemAlerts };
