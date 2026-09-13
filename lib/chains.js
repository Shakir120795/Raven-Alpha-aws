// Only these 4 chains are supported now. Each chain's API key(s) come from an
// env var named `${id.toUpperCase()}_KEYS`, comma-separated for multi-RPC
// failover (e.g. ETH_KEYS=key1,key2,key3 — pehli rate-limit hone pe agli apne
// aap try hogi, scanner.js ke explorerFetch() mein).
//
// robinhood + ink: `useRpcLogs: true` chains ke liye scanner.js Blockscout
// REST API (tokentx/tokennfttx, per-wallet) use nahi karta — instead ek hi
// eth_getLogs call (batched, saare wallets ek saath) `rpc` endpoint pe karta
// hai. Ye free public RPC hai, no key/account chahiye, aur per-wallet calls
// se bahut kam requests lagte hain.
//
// `rpc` field ka ek doosra use bhi hai (scanner.js ke fetchNftExternalLinks
// mein): jis bhi chain mein `rpc` set hai, uske liye NFT mint alerts mein
// tokenURI() se "Mint Page" (external_url) + "Search X" link nikalne ki
// koshish hoti hai — chahe wo chain useRpcLogs (robinhood/ink) ho ya
// Explorer-REST (eth) ho. ETH ke liye niche ek public RPC add kiya gaya hai
// sirf isi purpose ke liye — eth abhi bhi apna main scanning Etherscan V2
// REST API se hi karta hai, ye RPC sirf tokenURI() reads ke liye extra hai.
const CHAINS = [
  {
    id: "eth",
    name: "Ethereum",
    api: "https://api.etherscan.io/v2/api",
    explorer: "https://etherscan.io",
    noKeyRequired: false,
    openseaSlug: "ethereum",
    extraParams: { chainid: 1 },
    // Public RPC — only used for tokenURI() (Mint Page / Search X links) and
    // does NOT replace the Etherscan REST scanning path above. Free, no key.
    // NOTE: llamarpc.com was tried first but Cloudflare-blocks server/curl
    // requests with a JS challenge page (silent failure — no error, just an
    // HTML page instead of JSON). publicnode.com was tested directly from
    // the EC2 instance and confirmed to return real eth_call results.
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
    api: "https://arcscan.app/api",
    explorer: "https://arcscan.app",
    noKeyRequired: false,
    comingSoon: new Date() < new Date("2026-09-16T00:00:00Z"),
    comingSoonNote: "Mainnet launches Sep 16, 2026 — auto-activates on that date",
    // TODO: add `rpc` here once Arc mainnet is live and its public RPC URL
    // is known, so Mint Page / Search X links work for Arc too.
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
