require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const path = require("path");

const store = require("./lib/store");
const { getWallets, addWallet, removeWallet } = require("./lib/wallets");

// Arc RPC failover + optional eth_call revert suppression.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url || "";
  const method = (init?.method || "GET").toUpperCase();
  const bodyText = typeof init?.body === "string" ? init.body : null;
  let payload = null;
  try { if (bodyText) payload = JSON.parse(bodyText); } catch {}

  const isArcRpc = /^https:\/\/rpc\.arc-scan\.org\/?$/i.test(url);
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
        const body = await backup.clone().json().catch(() => null);
        const message = body?.error?.message || "";
        if (body?.error && payload.method === "eth_call" && /execution reverted|function does not exist/i.test(message)) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x" }), { status: 200, headers: { "content-type": "application/json" } });
        }
      }
      return backup;
    } catch (e) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? null, error: { code: -32001, message: `Arc RPC unavailable: ${e?.message || "backup RPC failed"}` } }), { status: 503, headers: { "content-type": "application/json" } });
    }
  }

  // Keep the existing global suppression for optional NFT metadata eth_call reverts.
  if (method === "POST" && bodyText && payload?.jsonrpc === "2.0" && payload?.method === "eth_call") {
    try {
      const response = await nativeFetch(input, init);
      if (response.ok) {
        const body = await response.clone().json().catch(() => null);
        const message = body?.error?.message || "";
        if (body?.error && /execution reverted|function does not exist/i.test(message)) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x" }), { status: 200, headers: { "content-type": "application/json" } });
        }
      }
      return response;
    } catch {}
  }
  return nativeFetch(input, init);
};

function shortenWallet(a = "") { return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a; }
function displayWallet(w) { return w?.label || shortenWallet(w?.address || "unknown"); }

// Persistent registry: collection/token -> unique tracked wallet IDs + cumulative count.
// We seed it once from retained alerts, then keep it independently of alerts_log's 300-item limit.
const REGISTRY_KEY = "tracked_wallet_activity_v1";
function walletRegistry() { return store.get(REGISTRY_KEY, {}); }
function walletIdentity(chain, w) {
  const chainId = String(chain || "").toLowerCase();
  const wallets = getWallets();
  const address = String(w?.address || "").toLowerCase();
  if (address) return `${chainId}:${address}`;
  const walletId = String(w?.walletId || "").toLowerCase();
  if (walletId) return `${chainId}:id:${walletId}`;
  const label = String(w?.label || "").trim().toLowerCase();
  return `${chainId}:label:${label}`;
}
function resolveTrackedWallet(chain, label) {
  const wanted = String(label || "").trim().toLowerCase();
  return getWallets().find(w => w.chain === String(chain).toLowerCase() && (String(w.label || "").trim().toLowerCase() === wanted || String(w.address || "").trim().toLowerCase() === wanted)) || null;
}

function seedRegistry(registry) {
  if (store.get("tracked_wallet_activity_seeded", false)) return;
  const logs = store.get("alerts_log", []);
  for (const alert of logs) {
    if (alert?.type === "wallet_nft_mint_batch") {
      const key = `${String(alert.chain || "").toLowerCase()}:${String(alert.contract || "").toLowerCase()}`;
      const entry = registry[key] ||= {};
      for (const w of alert.wallets || []) {
        const id = walletIdentity(alert.chain, w);
        const row = entry[id] ||= { address: w.address, label: w.label, count: 0 };
        row.address = w.address || row.address;
        row.label = w.label || row.label;
        row.count += Number(w.count || 0);
      }
    } else if (alert?.type === "wallet_new_token") {
      const key = `${String(alert.chain || "").toLowerCase()}:${String(alert.contract || "").toLowerCase()}`;
      const entry = registry[key] ||= {};
      for (const w of alert.minters || []) {
        const id = walletIdentity(alert.chain, w);
        const row = entry[id] ||= { address: w.address, label: w.label, count: 0 };
        row.address = w.address || row.address;
        row.label = w.label || row.label;
        row.count += Number(w.count || 1);
      }
    }
  }
  store.set(REGISTRY_KEY, registry);
  store.set("tracked_wallet_activity_seeded", true);
}

function updateWalletRegistry(chain, contract, wallets) {
  const registry = walletRegistry();
  seedRegistry(registry);
  const key = `${String(chain || "").toLowerCase()}:${String(contract || "").toLowerCase()}`;
  const entry = registry[key] ||= {};
  for (const w of wallets || []) {
    const tracked = w.address ? w : resolveTrackedWallet(chain, w.label);
    const normalized = tracked ? { ...w, address: tracked.address, walletId: tracked.id, label: tracked.label } : w;
    const id = walletIdentity(chain, normalized);
    const row = entry[id] ||= { address: normalized.address, label: normalized.label, count: 0 };
    row.address = normalized.address || row.address;
    row.label = normalized.label || row.label;
    row.count += Math.max(1, Number(w.count || 1));
  }
  store.set(REGISTRY_KEY, registry);
  const top = Object.values(entry).sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || displayWallet(a).localeCompare(displayWallet(b)));
  return { totalWallets: top.length, top };
}

function parseWalletLines(value) {
  return String(value || "").split("\n").map(s => s.trim()).filter(Boolean).map(line => {
    const m = line.match(/^(.+?)\s+×(\d+)$/);
    return m ? { label: m[1].trim(), count: Number(m[2]) } : null;
  }).filter(Boolean);
}

function enrichTelegramNft(payload) {
  const text = String(payload?.text || "");
  if (!/NEW NFT MINT/i.test(text)) return payload;
  const chainMatch = text.match(/NEW NFT MINT<\/b>\s*·\s*<b>([^<]+)<\/b>/i);
  const contractMatch = text.match(/📄 Contract:\s*<code>(0x[a-fA-F0-9]+)<\/code>/i);
  const breakdownStart = text.indexOf("<b>Wallet Breakdown</b>");
  const supplyStart = text.indexOf("\n\n📊 Supply:", breakdownStart);
  if (!chainMatch || !contractMatch || breakdownStart < 0 || supplyStart < 0) return payload;

  const currentWallets = parseWalletLines(text.slice(breakdownStart + "<b>Wallet Breakdown</b>".length, supplyStart));
  const stats = updateWalletRegistry(chainMatch[1], contractMatch[1], currentWallets);
  const summary = [
    `<b>Wallet Summary</b>`,
    `👥 Total wallets involved: <b>${stats.totalWallets}</b>`,
    `🔥 Wallets this scan: <b>${currentWallets.length}</b>`,
    `\n🏆 <b>Top wallets · all tracked mints</b>`,
    stats.top.slice(0, 12).map((w, i) => `${i + 1}. ${displayWallet(w)} ×${w.count}`).join("\n") || "—"
  ].join("\n");
  payload.text = text.slice(0, breakdownStart) + summary + text.slice(supplyStart);
  return payload;
}

function enrichDiscordNft(payload) {
  const embed = payload?.embeds?.[0];
  if (!embed || !/NEW NFT MINT/i.test(String(embed.title || ""))) return payload;
  const chain = String(embed.description || "").split("·").pop()?.trim();
  const contractField = (embed.fields || []).find(f => f?.name === "Contract");
  const breakdownField = (embed.fields || []).find(f => f?.name === "Wallet Breakdown");
  const contract = String(contractField?.value || "").replace(/[`\\]/g, "").trim();
  if (!chain || !contract || !breakdownField) return payload;
  const currentWallets = parseWalletLines(String(breakdownField.value || "").replace(/\*\*/g, ""));
  const stats = updateWalletRegistry(chain, contract, currentWallets);
  embed.fields = (embed.fields || []).filter(f => !["Wallet Breakdown", "Wallets involved", "Total Wallets"].includes(f?.name));
  embed.fields.push({ name: "Total Wallets Involved", value: String(stats.totalWallets), inline: true });
  embed.fields.push({ name: "Top Wallets · all tracked mints", value: stats.top.slice(0, 10).map((w, i) => `${i + 1}. ${displayWallet(w)} ×${w.count}`).join("\n") || "—", inline: false });
  return payload;
}

function enrichTelegramToken(payload) {
  const text = String(payload?.text || "");
  if (!/New Token Buy/i.test(text)) return payload;
  const chainMatch = text.match(/⛓ Chain:\s*<b>([^<]+)<\/b>/i);
  const contractMatch = text.match(/📄 Contract:\s*<code>(0x[a-fA-F0-9]+)<\/code>/i);
  const trackedMatch = text.match(/👥 Tracked wallets that bought this:\s*(.+)/i);
  if (!chainMatch || !contractMatch || !trackedMatch) return payload;
  const currentWallets = trackedMatch[1].split(/,\s*/).map(label => ({ label: label.replace(/\s*\(x\d+\)$/i, "").trim(), count: Number((label.match(/\(x(\d+)\)/i) || [])[1] || 1) }));
  const stats = updateWalletRegistry(chainMatch[1], contractMatch[1], currentWallets);
  const lines = text.split("\n");
  const idx = lines.findIndex(line => /👥 Tracked wallets that bought this:/i.test(line));
  if (idx >= 0) {
    lines.splice(idx + 1, 0, `👥 Total wallets involved: <b>${stats.totalWallets}</b>`);
    lines.splice(idx + 2, 0, `🏆 Top wallets: ${stats.top.slice(0, 8).map((w, i) => `${i + 1}. ${displayWallet(w)} ×${w.count}`).join(" | ") || "—"}`);
  }
  payload.text = lines.join("\n");
  return payload;
}

function enrichDiscordToken(payload) {
  const embed = payload?.embeds?.[0];
  if (!embed || !/Token.*Buy|New .*Buy/i.test(String(embed.title || "") + " " + String(embed.description || ""))) return payload;
  const chainField = (embed.fields || []).find(f => f?.name === "Chain");
  const contractField = (embed.fields || []).find(f => f?.name === "Contract");
  const trackedField = (embed.fields || []).find(f => String(f?.name || "").startsWith("Tracked wallets that bought this"));
  const chain = String(chainField?.value || "").trim();
  const contract = String(contractField?.value || "").replace(/[`\\]/g, "").trim();
  if (!chain || !contract || !trackedField) return payload;
  const currentWallets = String(trackedField.value || "").split(/,\s*/).map(label => ({ label: label.replace(/\s*\(x\d+\)$/i, "").trim(), count: Number((label.match(/\(x(\d+)\)/i) || [])[1] || 1) }));
  const stats = updateWalletRegistry(chain, contract, currentWallets);
  embed.fields = (embed.fields || []).filter(f => !["Total Wallets Involved", "Top Wallets · all tracked buys"].includes(f?.name));
  embed.fields.push({ name: "Total Wallets Involved", value: String(stats.totalWallets), inline: true });
  embed.fields.push({ name: "Top Wallets · all tracked buys", value: stats.top.slice(0, 10).map((w, i) => `${i + 1}. ${displayWallet(w)} ×${w.count}`).join("\n") || "—", inline: false });
  return payload;
}

// Enrich outgoing Telegram/Discord alert payloads immediately before delivery.
const alertFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url || "";
  const method = (init?.method || "GET").toUpperCase();
  if (method === "POST" && typeof init?.body === "string") {
    try {
      const payload = JSON.parse(init.body);
      if (/api\.telegram\.org\/bot/i.test(url)) init = { ...init, body: JSON.stringify(enrichTelegramToken(enrichTelegramNft(payload))) };
      else if (payload?.embeds?.[0]) init = { ...init, body: JSON.stringify(enrichDiscordToken(enrichDiscordNft(payload))) };
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
function requireSecret(req, res, next) { if (!DASHBOARD_SECRET) return next(); const provided = req.headers["x-dashboard-secret"] || req.query.secret; if (provided !== DASHBOARD_SECRET) return res.status(401).json({ error: "Unauthorized — wrong or missing dashboard secret." }); next(); }

app.get("/api/chains", (req, res) => res.json(CHAINS.map(c => ({ id: c.id, name: c.name, comingSoon: !!c.comingSoon, comingSoonNote: c.comingSoonNote, active: ACTIVE_CHAIN_IDS.includes(c.id) }))));
app.get("/api/wallets", (req, res) => res.json(getWallets()));
app.post("/api/wallets", requireSecret, (req, res) => { const { address, chain, label } = req.body || {}; if (!address || !chain) return res.status(400).json({ error: "address aur chain zaroori hain" }); if (!CHAINS.some(c => c.id === chain)) return res.status(400).json({ error: `Unknown chain: ${chain}` }); res.json(addWallet({ address, chain, label })); });
app.delete("/api/wallets/:id", requireSecret, (req, res) => res.json(removeWallet(req.params.id)));
app.get("/api/alerts", (req, res) => res.json(store.get("alerts_log", [])));
app.get("/api/status", (req, res) => res.json({ lastScan: store.get("last_scan", null), walletsCount: getWallets().length, telegramConfigured: Boolean(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID), discordConfigured: Boolean(process.env.DISCORD_WEBHOOK) }));
app.post("/api/scan", requireSecret, async (req, res) => { try { const nft = await runNftScan(); const arcToken = await runArcTokenScan(); res.json({ ok: true, nft, arcToken }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });

app.listen(PORT, () => console.log(`🍌 Raven Alpha server running on port ${PORT}`));

async function runScheduledScan() {
  const nft = await runNftScan();
  const arcToken = await runArcTokenScan();
  if (nft.skipped) console.log(`[${new Date().toISOString()}] NFT scan skipped:`, nft.reason);
  else console.log(`[${new Date().toISOString()}] NFT scan done:`, nft.walletsScanned || 0, "wallets,", nft.nftMints || 0, "new mints,", nft.alertsSent || 0, "collection alerts");
  if (arcToken?.skipped) console.log(`[${new Date().toISOString()}] Arc token scan skipped:`, arcToken.reason);
  else console.log(`[${new Date().toISOString()}] Arc token scan:`, arcToken?.walletsScanned || 0, "wallets,", arcToken?.tokenTransfers || 0, "incoming ERC20 transfers,", arcToken?.tokenAlerts || 0, "new-token alerts");
}

cron.schedule("*/5 * * * *", async () => { console.log(`[${new Date().toISOString()}] Running NFT + Arc token scan...`); try { await runScheduledScan(); } catch (e) { console.error("NFT/Arc token scan failed:", e.message); } });
runScheduledScan().catch(e => console.error("Initial NFT/Arc token scan failed:", e.message));
