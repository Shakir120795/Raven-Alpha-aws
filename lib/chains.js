// Only these 4 chains are supported now. Each chain's API key(s) come from an
// env var named `${id.toUpperCase()}_KEYS`, comma-separated for multi-RPC
// failover (e.g. ETH_KEYS=key1,key2,key3 — pehli rate-limit hone pe agli apne
// aap try hogi, scanner.js ke explorerFetch() mein).
const CHAINS = [
  { id: "eth", name: "Ethereum", api: "https://api.etherscan.io/api", noKeyRequired: false },
  { id: "robinhood", name: "Robinhood", api: "https://robinhoodchain.blockscout.com/api", noKeyRequired: true },
  {
    id: "arc",
    name: "Arc",
    api: "https://arcscan.app/api",
    noKeyRequired: false,
    comingSoon: new Date() < new Date("2026-09-16T00:00:00Z"),
    comingSoonNote: "Mainnet launches Sep 16, 2026 — auto-activates on that date",
  },
  { id: "ink", name: "Ink", api: "https://explorer.inkonchain.com/api", noKeyRequired: true },
];

const ACTIVE_CHAIN_IDS = CHAINS.filter(c => !c.comingSoon).map(c => c.id);

module.exports = { CHAINS, ACTIVE_CHAIN_IDS };
