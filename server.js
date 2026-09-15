require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const path = require("path");

const store = require("./lib/store");
const { getWallets, addWallet, removeWallet } = require("./lib/wallets");

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url || "";
  const isArcRpc = /^https:\/\/rpc\.arc-scan\.org\/?$/i.test(url);
  const method = (init?.method || "GET").toUpperCase();
  const bodyText = typeof init?.body === "string" ? init.body : null;
  let payload = null;
  try { if (bodyText) payload = JSON.parse(bodyText); } catch {}

  if (isArcRpc && method === "POST" && payload?.jsonrpc === "2.0") {
    try {
      const response = await nativeFetch(input, init);
      if (response.ok) {
        const body = await response.clone().json().catch(() => null);
        const message = body?.error?.message || "";
        if (body?.error && payload.method === "eth_call" && /execution reverted|function does not exist/i.test(message)) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (!body?.error) return response;
      }
    } catch {}
    try {
      const backup = await nativeFetch("https://niorfun.com/api/rpc", init);
      if (backup.ok) {
        const backupBody = await backup.clone().json().catch(() => null);
        const backupMessage = backupBody?.error?.message || "";
        if (backupBody?.error && payload.method === "eth_call" && /execution reverted|function does not exist/i.test(backupMessage)) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: backupBody.id, result: "0x" }), { status: 200, headers: { "content-type": "application/json" } });
        }
      }
      return backup;
    } catch (e) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? null, error: { code: -32001, message: `Arc RPC unavailable: ${e?.message || "backup RPC failed"}` } }), { status: 503, headers: { "content-type": "application/json" } });
    }
  }

  try {
    if (method === "POST" && bodyText && payload?.jsonrpc === "2.0" && payload?.method === "eth_call") {
      const response = await nativeFetch(input, init);
      if (response.ok) {
        const body = await response.clone().json().catch(() => null);
        const message = body?.error?.message || "";
        if (body?.error && /execution reverted|function does not exist/i.test(message)) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x" }), { status: 200, headers: { "content-type": "application/json" } });
        }
      }
      return response;
    }
  } catch {}
  return nativeFetch(input, init);
};

function shortenWallet(a = "") { return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a; }
function alertWalletDisplay(w) { return w?.label || shortenWallet(w?.address || "unknown"); }

function getCollectionWalletStats(chainId, contract, currentWallets) {
  const key = `${String(chainId || "").toLowerCase()}:${String(contract || "").toLowerCase()}`;
  const totals = new Map();
  const logs = store.get("alerts_log", []);
  const walletKey = w => alertWalletDisplay(w).trim().toLowerCase();

  for (const alert of logs) {
    if (alert?.type !== "wallet_nft_mint_batch") continue;
    const alertKey = `${String(alert.chain || "").toLowerCase()}:${String(alert.contract || "").toLowerCase()}`;
    if (alertKey !== key) continue;
    for (const w of alert.wallets || []) {
      const id = walletKey(w);
      const existing = totals.get(id) || { id, display: alertWalletDisplay(w), count: 0 };
      existing.display = alertWalletDisplay(w);
      existing.count += Number(w?.count || 0);
      totals.set(id, existing);
    }
  }

  const current = [];
  for (const w of currentWallets || []) {
    const id = walletKey(w);
    const display = alertWalletDisplay(w);
    current.push({ id, display, count: Number(w?.count || 0) });
    const existing = totals.get(id) || { id, display, count: 0 };
    existing.display = display;
    existing.count += Number(w?.count || 0);
    totals.set(id, existing);
  }

  const top = [...totals.values()].sort((a, b) => b.count - a.count || a.display.localeCompare(b.display));
  const newWallets = current.filter(w => !logs.some(alert => {
    if (alert?.type !== "wallet_nft_mint_batch") return false;
    const alertKey = `${String(alert.chain || "").toLowerCase()}:${String(alert.contract || "").toLowerCase()}`;
    if (alertKey !== key) return false;
    return (alert.wallets || []).some(prev => walletKey(prev) === w.id);
  })).sort((a, b) => b.count - a.count || a.display.localeCompare(b.display));

  return { totalWallets: totals.size, top, current, newWallets };
}

function formatWalletRows(stats, maxRows = 12) {
  const rows = stats.top.slice(0, maxRows).map((w, i) => `${i + 1}. ${w.display} ×${w.count}`);
  const remaining = stats.top.length - maxRows;
  if (remaining > 0) rows.push(`… +${remaining} more wallets`);
  return rows.join("\n") || "—";
}

function formatNewWalletRows(stats, maxRows = 12) {
  const rows = stats.newWallets.slice(0, maxRows).map(w => `🆕 ${w.display} ×${w.count}`);
  const remaining = stats.newWallets.length - maxRows;
  if (remaining > 0) rows.push(`… +${remaining} more new wallets`);
  return rows.join("\n") || "None";
}

function enrichTelegramNft(payload) {
  const text = String(payload?.text || "");
  if (!/NEW NFT MINT/i.test(text)) return payload;
  const chainMatch = text.match(/NEW NFT MINT<\/b>\s*·\s*<b>([^<]+)<\/b>/i);
  const contractMatch = text.match(/📄 Contract:\s*<code>(0x[a-fA-F0-9]+)<\/code>/i);
  const breakdownStart = text.indexOf("<b>Wallet Breakdown</b>");
  const supplyStart = text.indexOf("\n\n📊 Supply:", breakdownStart);
  if (!chainMatch || !contractMatch || breakdownStart < 0 || supplyStart < 0) return payload;

  const currentBlock = text.slice(breakdownStart + "<b>Wallet Breakdown</b>".length, supplyStart).trim();
  const currentWallets = currentBlock.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const m = line.match(/^(.+?)\s+×(\d+)$/);
    return m ? { label: m[1], count: Number(m[2]) } : null;
  }).filter(Boolean);

  const stats = getCollectionWalletStats(chainMatch[1], contractMatch[1], currentWallets);
  const summary = [
    `<b>Wallet Summary</b>`,
    `👥 Total collection wallets: <b>${stats.totalWallets}</b>`,
    `🔥 Wallets this scan: <b>${currentWallets.length}</b>`,
    `\n🏆 <b>Top wallets · all tracked mints</b>`,
    formatWalletRows(stats),
    `\n🆕 <b>New wallets this scan</b>`,
    formatNewWalletRows(stats)
  ].join("\n");

  payload.text = text.slice(0, breakdownStart) + summary + text.slice(supplyStart);
  return payload;
}

function enrichDiscordNft(payload) {
  const embed = payload?.embeds?.[0];
  if (!embed || !/NEW NFT MINT/i.test(String(embed.title || ""))) return payload;
  const chainMatch = String(embed.description || "").match(/·\s*([A-Z0-9_-]+)$/);
  const contractField = (embed.fields || []).find(f => f?.name === "Contract");
  const breakdownField = (embed.fields || []).find(f => f?.name === "Wallet Breakdown");
  const contract = String(contractField?.value || "").replace(/[`\\]/g, "").trim();
  if (!chainMatch || !contract || !breakdownField) return payload;

  const currentWallets = String(breakdownField.value || "").split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const m = line.match(/^(.+?)\s+×(\d+)$/);
    return m ? { label: m[1].replace(/^\*\*/, "").replace(/\*\*$/, ""), count: Number(m[2]) } : null;
  }).filter(Boolean);
  const stats = getCollectionWalletStats(chainMatch[1], contract, currentWallets);

  const fields = (embed.fields || []).filter(f => !["Wallet Breakdown", "Total Wallets", "New Wallets"].includes(f?.name));
  fields.push({ name: "Total Wallets", value: String(stats.totalWallets), inline: true });
  fields.push({ name: "Top Wallets · all tracked mints", value: formatWalletRows(stats, 10), inline: false });
  fields.push({ name: "New Wallets This Scan", value: formatNewWalletRows(stats, 10), inline: false });
  embed.fields = fields;
  return payload;
}

const alertFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url || "";
  const method = (init?.method || "GET").toUpperCase();
  if (method === "POST" && typeof init?.body === "string") {
    try {
      const payload = JSON.parse(init.body);
      if (/api\.telegram\.org\/bot/i.test(url)) {
        init = { ...init, body: JSON.stringify(enrichTelegramNft(payload)) };
      } else if (payload?.embeds?.[0]) {
        init = { ...init, body: JSON.stringify(enrichDiscordNft(payload)) };
      }
    } catch {}
  }
  return alertFetch(input, init);
};

const { runNftScan } = require("./lib/nftScanner");
const { runArcTokenScan } = require("./lib/arcTokenScanner");
const { CHAINS, ACTIVE_CHAIN_IDS } = require("./lib/chains");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || "";

function requireSecret(req, res, next) {
  if (!DASHBOARD_SECRET) return next();
  const provided = req.headers["x-dashboard-secret"] || req.query.secret;
  if (provided !== DASHBOARD_SECRET) return res.status(401).json({ error: "Unauthorized — wrong or missing dashboard secret." });
  next();
}

app.get("/api/chains", (req, res) => {
  res.json(CHAINS.map(c => ({ id: c.id, name: c.name, comingSoon: !!c.comingSoon, comingSoonNote: c.comingSoonNote, active: ACTIVE_CHAIN_IDS.includes(c.id) })));
});

app.get("/api/wallets", (req, res) => res.json(getWallets()));

app.post("/api/wallets", requireSecret, (req, res) => {
  const { address, chain, label } = req.body || {};
  if (!address || !chain) return res.status(400).json({ error: "address aur chain zaroori hain" });
  if (!CHAINS.some(c => c.id === chain)) return res.status(400).json({ error: `Unknown chain: ${chain}` });
  res.json(addWallet({ address, chain, label }));
});

app.delete("/api/wallets/:id", requireSecret, (req, res) => {
  res.json(removeWallet(req.params.id));
});

app.get("/api/alerts", (req, res) => res.json(store.get("alerts_log", [])));

app.get("/api/status", (req, res) => {
  res.json({ lastScan: store.get("last_scan", null), walletsCount: getWallets().length, telegramConfigured: Boolean(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID), discordConfigured: Boolean(process.env.DISCORD_WEBHOOK) });
});

app.post("/api/scan", requireSecret, async (req, res) => {
  try {
    const nft = await runNftScan();
    const arcToken = await runArcTokenScan();
    res.json({ ok: true, nft, arcToken });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`🍌 Raven Alpha server running on port ${PORT}`));

async function runScheduledScan() {
  const nft = await runNftScan();
  const arcToken = await runArcTokenScan();
  if (nft.skipped) console.log(`[${new Date().toISOString()}] NFT scan skipped:`, nft.reason);
  else console.log(`[${new Date().toISOString()}] NFT scan done:`, nft.walletsScanned || 0, "wallets,", nft.nftMints || 0, "new mints,", nft.alertsSent || 0, "collection alerts");
  if (arcToken?.skipped) console.log(`[${new Date().toISOString()}] Arc token scan skipped:`, arcToken.reason);
  else console.log(`[${new Date().toISOString()}] Arc token scan:`, arcToken?.walletsScanned || 0, "wallets,", arcToken?.tokenTransfers || 0, "incoming ERC20 transfers,", arcToken?.tokenAlerts || 0, "new-token alerts");
}

cron.schedule("*/5 * * * *", async () => {
  console.log(`[${new Date().toISOString()}] Running NFT + Arc token scan...`);
  try { await runScheduledScan(); } catch (e) { console.error("NFT/Arc token scan failed:", e.message); }
});

runScheduledScan().catch(e => console.error("Initial NFT/Arc token scan failed:", e.message));
