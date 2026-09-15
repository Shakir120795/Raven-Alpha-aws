// Only these 4 chains are supported now. Each chain's API key(s) come from an
env var named `${id.toUpperCase()}_KEYS`, comma-separated for multi-RPC
// failover (e.g. ETH_KEYS=key1,key2,key3 — pehli rate-limit hone pe agli apne
// aap try hogi, scanner.js ke explorerFetch() mein).
//
// robinhood + ink + arc: `useRpcLogs: true` chains use batched public RPC
// eth_getLogs instead of one explorer REST call per wallet. This keeps request
// volume low and avoids per-wallet explorer quota multiplication.
//
// `rpc` is also used for NFT/token metadata reads and link enrichment.
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
    useRpcLogs: true,
    baselineOnFirstScan: true,
    // Arc mainnet chain id 5042. Public Arcscan RPC is read-only and rate
    // limited per caller; the scanner uses batched eth_getLogs windows.
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
    openseaSlug: "ink",
  },
];

const ACTIVE_CHAIN_IDS = CHAINS.filter(c => !c.comingSoon).map(c => c.id);

module.exports = { CHAINS, ACTIVE_CHAIN_IDS };
