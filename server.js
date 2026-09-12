require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const path = require("path");

const store = require("./lib/store");
const { getWallets, addWallet, removeWallet } = require("./lib/wallets");
const { runScan } = require("./lib/scanner");
const { CHAINS, ACTIVE_CHAIN_IDS } = require("./lib/chains");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || "";

// Simple auth for anything that changes state (add/remove wallets, manual scan).
// Read-only GET endpoints stay open so the dashboard can load without a prompt.
function requireSecret(req, res, next) {
  if (!DASHBOARD_SECRET) return next(); // no secret set = open (fine for local/testing only)
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

// Manual trigger, useful for testing right after deploy.
app.post("/api/scan", requireSecret, async (req, res) => {
  try {
    const result = await runScan();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🍌 Raven Alpha server running on port ${PORT}`);
});

// ── The actual 24/7 engine ──────────────────────────────────────────
// Runs every 5 minutes, forever, as long as this process is alive.
// On EC2, pm2 keeps this process alive (auto-restart on crash) and
// restarts it automatically on server reboot (see README_AWS_SETUP.md) —
// so no external cron service is needed at all.
cron.schedule("*/5 * * * *", async () => {
  console.log(`[${new Date().toISOString()}] Running scan...`);
  try {
    const result = await runScan();
    console.log(`[${new Date().toISOString()}] Scan done:`, result.walletsScanned, "wallets,", result.alertsSent, "alerts sent");
  } catch (e) {
    console.error("Scan failed:", e.message);
  }
});

// Run one scan immediately on startup too, so you don't have to wait 5 min
// after deploying to see it working.
runScan().then(r => console.log("Initial scan:", r.walletsScanned, "wallets,", r.alertsSent, "alerts")).catch(e => console.error("Initial scan failed:", e.message));
