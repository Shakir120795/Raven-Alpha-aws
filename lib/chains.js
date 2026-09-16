// Only these 4 chains are supported now. Each chain's API key(s) come from an
// env var named `${id.toUpperCase()}_KEYS`, comma-separated for multi-RPC
// failover (e.g. ETH_KEYS=key1,key2,key3 — pehli rate-limit hone pe agli apne
// aap try hogi, scanner.js ke explorerFetch() mein).
//
// robinhood + ink + arc: `useRpcLogs: true` chains use batched public RPC
// eth_getLogs instead of one explorer REST call per wallet. This keeps request
// volume low and avoids per-wallet explorer quota multiplication.
//
// `rpcBackup` is used by server.js as an Arc-only JSON-RPC failover when the
// official Arcscan gateway is unreachable. Other chains are unchanged.
const CHAINS = [
  {
    id: "eth",
    name: "Ethereum",
    api: "https://api.etherscan.io/v2/api",
    explorer: "https://etherscan.io",
    noKeyRequired: false,
    openseaSlug: "ethereum",
    extraParams: { chainid: 1 },
    rpc: "https://ethereum-rpc.publicnode.com",
  },
  {
    id: "robinhood",
    name: "Robinhood",
    api: "https://robinhoodchain.blockscout.com/api",
    explorer: "https://robinhoodchain.blockscout.com",
    noKeyRequired: true,
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    useRpcLogs: true,
    openseaSlug: "robinhood",
  },
  {
    id: "arc",
    name: "Arc",
    api: "https://api.arc-scan.org/api",
    explorer: "https://arc-scan.org",
    noKeyRequired: true,
    rpc: "https://rpc.arc-scan.org",
    rpcBackup: "https://niorfun.com/api/rpc",
    useRpcLogs: true,
    baselineOnFirstScan: true,
    // Arc mainnet chain id 5042. Primary is the official Arcscan gateway;
    // server.js automatically falls back to rpcBackup when the primary fails.
    openseaSlug: null,
  },
  {
    id: "ink",
    name: "Ink",
    api: "https://explorer.inkonchain.com/api",
    explorer: "https://explorer.inkonchain.com",
    noKeyRequired: true,
    rpc: "https://rpc-gel.inkonchain.com",
    useRpcLogs: true,
    nftEnabled: false,
    openseaSlug: "ink",
  },
];

// Ink is intentionally excluded from active alert scanning.
// Arc remains active for NFT + token tracking.
const ACTIVE_CHAIN_IDS = CHAINS.filter(c => !c.comingSoon && c.id !== "ink").map(c => c.id);

module.exports = { CHAINS, ACTIVE_CHAIN_IDS };
