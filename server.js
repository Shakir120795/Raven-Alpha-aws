require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const path = require("path");

const store = require("./lib/store");
const { getWallets, addWallet, removeWallet } = require("./lib/wallets");

// Optional NFT metadata/supply calls often revert on contracts that do not
// implement the requested selector. Treat those as "unsupported" instead of
// making the RPC helper retry three times and flooding the logs.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url || "";
  const isArcRpc = /^https:\/\/rpc\.arc-scan\.org\/?$/i.test(url);
  const method = (init?.method || "GET").toUpperCase();
  const bodyText = typeof init?.body === "string" ? init.body : null;
  let payload = null;
  try { if (bodyText) payload = JSON.parse(bodyText); } catch {}

  // Arc primary RPC failover. The official Arcscan gateway remains first;
  // backup is used only when the primary request fails or returns a JSON-RPC
  // error. This is intentionally limited to Arc so other chains are untouched.
  if (isArcRpc && method === "POST" && payload?.jsonrpc === "2.0") {
    try {
      const response = await nativeFetch(input, init);
      if (response.ok) {
        const body = await response.clone().json().catch(() => null);
        const message = body?.error?.message || "";

        // Preserve the existing optional eth_call-revert suppression.
        if (body?.error && payload.method === "eth_call" && /execution reverted|function does not exist/i.test(message)) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        // A healthy JSON-RPC result from the primary is returned directly.
        if (!body?.error) return response;
      }
    } catch {}

    try {
      const backup = await nativeFetch("https://niorfun.com/api/rpc", init);
      if (backup.ok) {
        const backupBody = await backup.clone().json().catch(() => null);
        const backupMessage = backupBody?.error?.message || "";
        if (backupBody?.error && payload.method === "eth_call" && /execution reverted|function does not exist/i.test(backupMessage)) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: backupBody.id, result: "0x" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      }
      return backup;
    } catch (e) {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id ?? null,
        error: { code: -32001, message: `Arc RPC unavailable: ${e?.message || "backup RPC failed"}` }
      }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    }
  }

  // Existing generic eth_call-revert handling for all other RPCs.
  try {
    if (method === "POST" && bodyText && payload?.jsonrpc === "2.0" && payload?.method === "eth_call") {
      const response = await nativeFetch(input, init);
      if (response.ok) {
        const body = await response.clone().json().catch(() => null);
        const message = body?.error?.message || "";
        if (body?.error && /execution reverted|function does not exist/i.test(message)) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      }
      return response;
    }
  } catch {}
  return nativeFetch(input, init);
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
  res.json({
    lastScan: store.get("last_scan", null),
    walletsCount: getWallets().length,
    telegramConfigured: Boolean(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID),
    discordConfigured: Boolean(process.env.DISCORD_WEBHOOK),
  });
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

app.listen(PORT, () => {
  console.log(`🍌 Raven Alpha server running on port ${PORT}`);
});

async function runScheduledScan() {
  const nft = await runNftScan();
  const arcToken = await runArcTokenScan();

  if (nft.skipped) {
    console.log(`[${new Date().toISOString()}] NFT scan skipped:`, nft.reason);
  } else {
    console.log(`[${new Date().toISOString()}] NFT scan done:`, nft.walletsScanned || 0, "wallets,", nft.nftMints || 0, "new mints,", nft.alertsSent || 0, "collection alerts");
  }

  if (arcToken?.skipped) {
    console.log(`[${new Date().toISOString()}] Arc token scan skipped:`, arcToken.reason);
  } else {
    console.log(`[${new Date().toISOString()}] Arc token scan:`, arcToken?.walletsScanned || 0, "wallets,", arcToken?.tokenTransfers || 0, "incoming ERC20 transfers,", arcToken?.tokenAlerts || 0, "new-token alerts");
  }
}

// NFT + Arc-token 24/7 engine. Arc token tracking is isolated to Arc only;
// ETH/Robinhood/Ink token tracking remains OFF.
cron.schedule("*/5 * * * *", async () => {
  console.log(`[${new Date().toISOString()}] Running NFT + Arc token scan...`);
  try {
    await runScheduledScan();
  } catch (e) {
    console.error("NFT/Arc token scan failed:", e.message);
  }
});

runScheduledScan()
  .catch(e => console.error("Initial NFT/Arc token scan failed:", e.message));
