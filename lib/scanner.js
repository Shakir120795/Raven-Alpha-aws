const store = require("./store");
const { getWallets } = require("./wallets");
const { CHAINS, ACTIVE_CHAIN_IDS } = require("./chains");

const ZERO = "0x0000000000000000000000000000000000000000";
const shorten = (a = "") => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

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

// ── Multi-RPC failover ──────────────────────────────────────────────
// Each chain's key(s) come from env var `${CHAIN_ID}_KEYS`, comma-separated.
// e.g. ETH_KEYS=key1,key2,key3 — if key1 hits a rate limit, key2 is tried
// automatically, then key3, and so on. Chains that don't need a key
// (Robinhood, Ink — both Blockscout explorers) just fetch directly.
async function explorerFetch(chain, params) {
  const raw = process.env[`${chain.id.toUpperCase()}_KEYS`] || "";
  const keys = raw.split(",").map(k => k.trim()).filter(Boolean);
  const qs = new URLSearchParams(params).toString();

  if (!keys.length) {
    if (!chain.noKeyRequired) return null; // no key configured and this chain needs one
    return safeFetch(`${chain.api}?${qs}`);
  }

  let last = null;
  for (const key of keys) {
    const res = await safeFetch(`${chain.api}?${qs}&apikey=${key}`);
    if (!isRateLimited(res)) return res;
    last = res; // keep trying the next key
  }
  return last;
}

// Tracks, per contract (token or NFT collection), which of our watched
// wallets have minted it. Returns the updated minters list for that contract.
function recordMinter(registry, chainId, contract, walletEntry) {
  const key = `${chainId}:${(contract || "").toLowerCase()}`;
  const list = registry[key] || [];
  if (!list.some(m => m.walletId === walletEntry.walletId)) {
    list.push(walletEntry);
    registry[key] = list;
    return { list, changed: true };
  }
  return { list, changed: false };
}

function logAlert(alert) {
  const log = store.get("alerts_log", []);
  log.unshift({ ...alert, sentAt: new Date().toISOString() });
  store.set("alerts_log", log.slice(0, 300));
}

async function sendAlert(alert) {
  const tgToken = process.env.TELEGRAM_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  const dsHook = process.env.DISCORD_WEBHOOK;
  const results = {};

  const minterLabels = (alert.minters || []).map(m => m.label || shorten(m.address));
  const minterLine = minterLabels.length
    ? `\n👥 Minted by <b>${minterLabels.length}</b> tracked wallet${minterLabels.length > 1 ? "s" : ""}: ${minterLabels.join(", ")}`
    : "";
  const minterField = minterLabels.length
    ? [{ name: `Minted by ${minterLabels.length} tracked wallet${minterLabels.length > 1 ? "s" : ""}`, value: minterLabels.join(", ").slice(0, 1000), inline: false }]
    : [];

  let text, embed;
  if (alert.type === "wallet_new_token") {
    text = `🍌 <b>Raven Alpha</b>\n\n🆕 <b>Wallet New Token Alert</b>\n\n👛 Wallet: <b>${alert.walletLabel || shorten(alert.address)}</b>\n⛓ Chain: <b>${alert.chain.toUpperCase()}</b>\n🪙 Token: <b>${alert.tokenName || "Unknown"}${alert.sym ? ` (${alert.sym})` : ""}</b>\n📄 Contract: <code>${alert.contract}</code>\n🧾 <code>${(alert.hash || "").slice(0, 16)}…</code>${minterLine}`;
    embed = {
      title: "🆕 Wallet New Token", color: 0xF5C843, description: `**${alert.walletLabel || shorten(alert.address)}**`,
      fields: [
        { name: "Chain", value: alert.chain.toUpperCase(), inline: true },
        { name: "Token", value: `${alert.tokenName || "Unknown"}${alert.sym ? ` (${alert.sym})` : ""}`, inline: true },
        { name: "Tx", value: `\`${(alert.hash || "").slice(0, 16)}…\``, inline: false },
        ...minterField,
      ],
      footer: { text: "🦅 Raven Alpha" }, timestamp: new Date().toISOString(),
    };
  } else {
    text = `🍌 <b>Raven Alpha</b>\n\n🖼️ <b>Wallet NFT Mint Alert</b>\n\n👛 Wallet: <b>${alert.walletLabel || shorten(alert.address)}</b>\n⛓ Chain: <b>${alert.chain.toUpperCase()}</b>\n🖼️ Collection: <b>${alert.nftName || "Unknown"}</b>\n🔢 Token ID: <b>${alert.tokenId}</b>\n📄 Contract: <code>${alert.contract}</code>\n🧾 <code>${(alert.hash || "").slice(0, 16)}…</code>${minterLine}`;
    embed = {
      title: "🖼️ Wallet NFT Mint", color: 0x9945FF, description: `**${alert.walletLabel || shorten(alert.address)}**`,
      fields: [
        { name: "Chain", value: alert.chain.toUpperCase(), inline: true },
        { name: "Collection", value: alert.nftName || "Unknown", inline: true },
        { name: "Token ID", value: String(alert.tokenId), inline: true },
        { name: "Tx", value: `\`${(alert.hash || "").slice(0, 16)}…\``, inline: false },
        ...minterField,
      ],
      footer: { text: "🦅 Raven Alpha" }, timestamp: new Date().toISOString(),
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

  logAlert({ ...alert, result: results });
  return results;
}

async function runScan() {
  const wallets = getWallets();
  const knownTokens = store.get("known_tokens", {});
  const seenMints = new Set(store.get("seen_mints", []));
  const mintRegistry = store.get("mint_registry", {});
  let knownTokensChanged = false, seenMintsChanged = false, mintRegistryChanged = false;
  const alertsSent = [];

  for (const w of wallets) {
    const chain = CHAINS.find(c => c.id === w.chain);
    if (!chain || chain.comingSoon || !ACTIVE_CHAIN_IDS.includes(chain.id)) continue;

    // ── New token detection (alerts only from the 2nd scan onward per wallet;
    // the very first scan just builds the baseline of tokens already held) ──
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

      let minters = [];
      if (tx.from?.toLowerCase() === ZERO) {
        const { list, changed } = recordMinter(mintRegistry, w.chain, tx.contractAddress, { walletId: w.id, address: w.address, label: w.label });
        minters = list;
        if (changed) mintRegistryChanged = true;
      }

      const alert = { type: "wallet_new_token", walletLabel: w.label, chain: w.chain, address: w.address, hash: tx.hash, tokenName: tx.tokenName || tx.tokenSymbol || "New Token", sym: tx.tokenSymbol || "", contract: tx.contractAddress, minters };
      const result = await sendAlert(alert);
      alertsSent.push({ ...alert, result });
    }
    knownTokens[w.id] = [...seenTokens];

    // ── NFT mint detection ──
    const nftRes = await explorerFetch(chain, { module: "account", action: "tokennfttx", address: w.address, sort: "desc", offset: 10 });
    for (const nft of (nftRes?.result || [])) {
      const isMint = nft.from?.toLowerCase() === ZERO && nft.to?.toLowerCase() === w.address.toLowerCase();
      if (!isMint) continue;
      const id = `wnftmint_${w.id}_${nft.hash}_${nft.tokenID}`;
      if (seenMints.has(id)) continue;
      seenMints.add(id);
      seenMintsChanged = true;

      const { list, changed } = recordMinter(mintRegistry, w.chain, nft.contractAddress, { walletId: w.id, address: w.address, label: w.label });
      if (changed) mintRegistryChanged = true;

      const alert = { type: "wallet_nft_mint", walletLabel: w.label, chain: w.chain, address: w.address, hash: nft.hash, nftName: nft.tokenName || "New Collection", tokenId: nft.tokenID, contract: nft.contractAddress, minters: list };
      const result = await sendAlert(alert);
      alertsSent.push({ ...alert, result });
    }
  }

  if (knownTokensChanged) store.set("known_tokens", knownTokens);
  if (seenMintsChanged) {
    const arr = [...seenMints];
    store.set("seen_mints", arr.length > 2000 ? arr.slice(-2000) : arr);
  }
  if (mintRegistryChanged) store.set("mint_registry", mintRegistry);

  store.set("last_scan", { at: new Date().toISOString(), walletsScanned: wallets.length, alertsSent: alertsSent.length });
  return { walletsScanned: wallets.length, alertsSent: alertsSent.length, alerts: alertsSent };
}

module.exports = { runScan };
