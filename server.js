require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const path = require("path");
const store = require("./lib/store");
const { getWallets, addWallet, removeWallet } = require("./lib/wallets");

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
        if (body?.error && payload.method === "eth_call" && /execution reverted|function does not exist/i.test(message)) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x" }), { status: 200, headers: { "content-type": "application/json" } });
        if (!body?.error) return response;
      }
    } catch {}
    try { return await nativeFetch("https://niorfun.com/api/rpc", init); } catch (e) { return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? null, error: { code: -32001, message: `Arc RPC unavailable: ${e?.message || "backup RPC failed"}` } }), { status: 503, headers: { "content-type": "application/json" } }); }
  }
  if (method === "POST" && bodyText && payload?.jsonrpc === "2.0" && payload?.method === "eth_call") {
    try {
      const response = await nativeFetch(input, init);
      if (response.ok) {
        const body = await response.clone().json().catch(() => null);
        if (body?.error && /execution reverted|function does not exist/i.test(body?.error?.message || "")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return response;
    } catch {}
  }
  return nativeFetch(input, init);
};

function shortenWallet(a = "") { return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a; }
function displayWallet(w) { return w?.label || shortenWallet(w?.address || "unknown"); }
const REGISTRY_KEY = "tracked_wallet_activity_v1";
const EVENT_KEY_STORE = "tracked_wallet_activity_events_v1";
function walletRegistry() { return store.get(REGISTRY_KEY, {}); }
function walletIdentity(chain, w) {
  const c = String(chain || "").toLowerCase();
  const address = String(w?.address || "").toLowerCase();
  if (address) return `${c}:${address}`;
  const id = String(w?.walletId || "").toLowerCase();
  if (id) return `${c}:id:${id}`;
  return `${c}:label:${String(w?.label || "").trim().toLowerCase()}`;
}
function resolveTrackedWallet(chain, label) {
  const wanted = String(label || "").trim().toLowerCase();
  return getWallets().find(w => w.chain === String(chain).toLowerCase() && (String(w.label || "").trim().toLowerCase() === wanted || String(w.address || "").trim().toLowerCase() === wanted)) || null;
}
function seedRegistry(registry) {
  if (store.get("tracked_wallet_activity_seeded", false)) return;
  for (const alert of store.get("alerts_log", [])) {
    const isNft = alert?.type === "wallet_nft_mint_batch";
    const isToken = alert?.type === "wallet_new_token";
    if (!isNft && !isToken) continue;
    const key = `${String(alert.chain || "").toLowerCase()}:${String(alert.contract || "").toLowerCase()}`;
    const entry = registry[key] ||= {};
    const wallets = isNft ? (alert.wallets || []) : (alert.minters || []);
    for (const w of wallets) {
      const id = walletIdentity(alert.chain, w);
      const row = entry[id] ||= { address: w.address, label: w.label, count: 0 };
      row.address = w.address || row.address; row.label = w.label || row.label;
      row.count += Number(w.count || 1);
    }
  }
  store.set(REGISTRY_KEY, registry); store.set("tracked_wallet_activity_seeded", true);
}
function updateWalletRegistry(chain, contract, wallets, eventKey) {
  const registry = walletRegistry(); seedRegistry(registry);
  const events = store.get(EVENT_KEY_STORE, {});
  const key = `${String(chain || "").toLowerCase()}:${String(contract || "").toLowerCase()}`;
  const event = `${key}:${String(eventKey || "")}`;
  const already = Boolean(eventKey && events[event]);
  const entry = registry[key] ||= {};
  if (!already) {
    for (const w of wallets || []) {
      const tracked = w.address ? w : resolveTrackedWallet(chain, w.label);
      const normalized = tracked ? { ...w, address: tracked.address, walletId: tracked.id, label: tracked.label } : w;
      const id = walletIdentity(chain, normalized);
      const row = entry[id] ||= { address: normalized.address, label: normalized.label, count: 0 };
      row.address = normalized.address || row.address; row.label = normalized.label || row.label;
      row.count += Math.max(1, Number(w.count || 1));
    }
    if (eventKey) { events[event] = Date.now(); const keys = Object.keys(events); if (keys.length > 10000) delete events[keys[0]]; store.set(EVENT_KEY_STORE, events); }
    store.set(REGISTRY_KEY, registry);
  }
  const top = Object.values(entry).sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || displayWallet(a).localeCompare(displayWallet(b)));
  return { totalWallets: top.length, top };
}
function parseWalletLines(value) { return String(value || "").split("\n").map(s => s.trim()).filter(Boolean).map(line => { const m = line.match(/^(.+?)\s+×(\d+)$/); return m ? { label: m[1].trim(), count: Number(m[2]) } : null; }).filter(Boolean); }
function nftEventKey(text) { const m = String(text).match(/Sample Token ID:\s*<b>([^<]+)<\/b>/i); return m ? `token:${m[1]}` : `tx:${(String(text).match(/🧾 <code>([^<]+)/i) || [])[1] || Date.now()}`; }
function tokenEventKey(text) { return `tx:${(String(text).match(/🧾 <code>([^<]+)/i) || [])[1] || Date.now()}`; }

function enrichTelegramNft(payload) {
  const text = String(payload?.text || ""); if (!/NEW NFT MINT/i.test(text)) return payload;
  const chain = (text.match(/NEW NFT MINT<\/b>\s*·\s*<b>([^<]+)<\/b>/i) || [])[1];
  const contract = (text.match(/📄 Contract:\s*<code>(0x[a-fA-F0-9]+)<\/code>/i) || [])[1];
  const bs = text.indexOf("<b>Wallet Breakdown</b>"), ss = text.indexOf("\n\n📊 Supply:", bs);
  if (!chain || !contract || bs < 0 || ss < 0) return payload;
  const wallets = parseWalletLines(text.slice(bs + 25, ss));
  const stats = updateWalletRegistry(chain, contract, wallets, nftEventKey(text));
  const summary = `<b>Wallet Summary</b>\n👥 Total wallets involved: <b>${stats.totalWallets}</b>\n🔥 Wallets this scan: <b>${wallets.length}</b>\n\n🏆 <b>Top wallets · all tracked mints</b>\n${stats.top.slice(0, 12).map((w, i) => `${i + 1}. ${displayWallet(w)} ×${w.count}`).join("\n") || "—"}`;
  payload.text = text.slice(0, bs) + summary + text.slice(ss); return payload;
}
function enrichDiscordNft(payload) {
  const embed = payload?.embeds?.[0]; if (!embed || !/NEW NFT MINT/i.test(String(embed.title || ""))) return payload;
  const chain = String(embed.description || "").split("·").pop()?.trim();
  const contract = String((embed.fields || []).find(f => f?.name === "Contract")?.value || "").replace(/[`\\]/g, "").trim();
  const field = (embed.fields || []).find(f => f?.name === "Wallet Breakdown"); if (!chain || !contract || !field) return payload;
  const wallets = parseWalletLines(String(field.value || "").replace(/\*\*/g, ""));
  const stats = updateWalletRegistry(chain, contract, wallets, `token:${String((embed.fields || []).find(f => f?.name === "Token ID")?.value || "")}`);
  embed.fields = (embed.fields || []).filter(f => !["Wallet Breakdown", "Wallets involved", "Total Wallets"].includes(f?.name));
  embed.fields.push({ name: "Total Wallets Involved", value: String(stats.totalWallets), inline: true });
  embed.fields.push({ name: "Top Wallets · all tracked mints", value: stats.top.slice(0, 10).map((w, i) => `${i + 1}. ${displayWallet(w)} ×${w.count}`).join("\n") || "—", inline: false }); return payload;
}
function enrichTelegramToken(payload) {
  const text = String(payload?.text || ""); if (!/New Token Buy/i.test(text)) return payload;
  const chain = (text.match(/⛓ Chain:\s*<b>([^<]+)<\/b>/i) || [])[1];
  const contract = (text.match(/📄 Contract:\s*<code>(0x[a-fA-F0-9]+)<\/code>/i) || [])[1];
  const tracked = (text.match(/👥 Tracked wallets that bought this:\s*(.+)/i) || [])[1]; if (!chain || !contract || !tracked) return payload;
  const wallets = tracked.split(/,\s*/).map(label => ({ label: label.replace(/\s*\(x\d+\)$/i, "").trim(), count: Number((label.match(/\(x(\d+)\)/i) || [])[1] || 1) }));
  const stats = updateWalletRegistry(chain, contract, wallets, tokenEventKey(text));
  const lines = text.split("\n"), idx = lines.findIndex(line => /👥 Tracked wallets that bought this:/i.test(line));
  if (idx >= 0) { lines.splice(idx + 1, 0, `👥 Total wallets involved: <b>${stats.totalWallets}</b>`); lines.splice(idx + 2, 0, `🏆 Top wallets: ${stats.top.slice(0, 8).map((w, i) => `${i + 1}. ${displayWallet(w)} ×${w.count}`).join(" | ") || "—"}`); }
  payload.text = lines.join("\n"); return payload;
}
function enrichDiscordToken(payload) {
  const embed = payload?.embeds?.[0]; if (!embed || !/Token.*Buy|New .*Buy/i.test(String(embed.title || "") + " " + String(embed.description || ""))) return payload;
  const chain = String((embed.fields || []).find(f => f?.name === "Chain")?.value || "").trim();
  const contract = String((embed.fields || []).find(f => f?.name === "Contract")?.value || "").replace(/[`\\]/g, "").trim();
  const field = (embed.fields || []).find(f => String(f?.name || "").startsWith("Tracked wallets that bought this")); if (!chain || !contract || !field) return payload;
  const wallets = String(field.value || "").split(/,\s*/).map(label => ({ label: label.replace(/\s*\(x\d+\)$/i, "").trim(), count: Number((label.match(/\(x(\d+)\)/i) || [])[1] || 1) }));
  const tx = String((embed.fields || []).find(f => f?.name === "Tx")?.value || "");
  const stats = updateWalletRegistry(chain, contract, wallets, `tx:${tx}`);
  embed.fields = (embed.fields || []).filter(f => !["Total Wallets Involved", "Top Wallets · all tracked buys"].includes(f?.name));
  embed.fields.push({ name: "Total Wallets Involved", value: String(stats.totalWallets), inline: true });
  embed.fields.push({ name: "Top Wallets · all tracked buys", value: stats.top.slice(0, 10).map((w, i) => `${i + 1}. ${displayWallet(w)} ×${w.count}`).join("\n") || "—", inline: false }); return payload;
}

function isSoldOutNftTelegram(payload) {
  const text = String(payload?.text || "");
  return /NEW NFT MINT/i.test(text) && /🟢 Remaining:\s*<b>0<\/b>/i.test(text);
}
function isSoldOutNftDiscord(payload) {
  const embed = payload?.embeds?.[0];
  if (!embed || !/NEW NFT MINT/i.test(String(embed.title || ""))) return false;
  return (embed.fields || []).some(f => f?.name === "Mint Progress" && /remaining\s+0\b/i.test(String(f.value || "")));
}

const alertFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url || "";
  const method = (init?.method || "GET").toUpperCase();
  if (method === "POST" && typeof init?.body === "string") {
    try {
      const payload = JSON.parse(init.body);
      if (/api\.telegram\.org\/bot/i.test(url)) {
        if (isSoldOutNftTelegram(payload)) return new Response(JSON.stringify({ ok: true, result: { message_id: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
        init = { ...init, body: JSON.stringify(enrichTelegramToken(enrichTelegramNft(payload))) };
      } else if (payload?.embeds?.[0]) {
        if (isSoldOutNftDiscord(payload)) return new Response("", { status: 204 });
        init = { ...init, body: JSON.stringify(enrichDiscordToken(enrichDiscordNft(payload))) };
      }
    } catch {}
  }
  return alertFetch(input, init);
};

const { runNftScan } = require("./lib/nftScanner");
const { runRobinhoodTokenScan } = require("./lib/robinhoodTokenScanner");
const { CHAINS, ACTIVE_CHAIN_IDS } = require("./lib/chains");
const app = express(); app.use(express.json()); app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000; const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || "";
function requireSecret(req, res, next) { if (!DASHBOARD_SECRET) return next(); const provided = req.headers["x-dashboard-secret"] || req.query.secret; if (provided !== DASHBOARD_SECRET) return res.status(401).json({ error: "Unauthorized — wrong or missing dashboard secret." }); next(); }
app.get("/api/chains", (req, res) => res.json(CHAINS.map(c => ({ id: c.id, name: c.name, comingSoon: !!c.comingSoon, comingSoonNote: c.comingSoonNote, active: ACTIVE_CHAIN_IDS.includes(c.id) }))));
app.get("/api/wallets", (req, res) => res.json(getWallets()));
app.post("/api/wallets", requireSecret, (req, res) => { const { address, chain, label } = req.body || {}; if (!address || !chain) return res.status(400).json({ error: "address aur chain zaroori hain" }); if (!CHAINS.some(c => c.id === chain)) return res.status(400).json({ error: `Unknown chain: ${chain}` }); res.json(addWallet({ address, chain, label })); });
app.delete("/api/wallets/:id", requireSecret, (req, res) => res.json(removeWallet(req.params.id)));
app.get("/api/alerts", (req, res) => res.json(store.get("alerts_log", [])));
app.get("/api/status", (req, res) => res.json({ lastScan: store.get("last_scan", null), walletsCount: getWallets().length, telegramConfigured: Boolean(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID), discordConfigured: Boolean(process.env.DISCORD_WEBHOOK) }));
app.post("/api/scan", requireSecret, async (req, res) => { try { const nft = await runNftScan(); const robinhoodToken = await runRobinhoodTokenScan(); res.json({ ok: true, nft, robinhoodToken }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
app.listen(PORT, () => console.log(`🍌 Raven Alpha server running on port ${PORT}`));
async function runScheduledScan() { const nft = await runNftScan(); const robinhoodToken = await runRobinhoodTokenScan(); if (nft.skipped) console.log(`[${new Date().toISOString()}] NFT scan skipped:`, nft.reason); else console.log(`[${new Date().toISOString()}] NFT scan done:`, nft.walletsScanned || 0, "wallets,", nft.nftMints || 0, "new mints,", nft.alertsSent || 0, "collection alerts"); if (robinhoodToken?.skipped) console.log(`[${new Date().toISOString()}] Robinhood token scan skipped:`, robinhoodToken.reason); else console.log(`[${new Date().toISOString()}] Robinhood token scan:`, robinhoodToken?.walletsScanned || 0, "wallets,", robinhoodToken?.tokenTransfers || 0, "incoming ERC20 transfers,", robinhoodToken?.tokenAlerts || 0, "token alerts"); }
cron.schedule("*/5 * * * *", async () => { console.log(`[${new Date().toISOString()}] Running NFT + Robinhood token scan...`); try { await runScheduledScan(); } catch (e) { console.error("NFT/Arc/Robinhood token scan failed:", e.message); } });
runScheduledScan().catch(e => console.error("Initial NFT/Arc/Robinhood token scan failed:", e.message));