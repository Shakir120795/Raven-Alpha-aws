const { createTokenScanner } = require('./tokenTradeScanner');

const runEthereumTokenScan = createTokenScanner({
  chain: 'eth',
  label: 'ETH',
  enabledEnv: 'ETH_TOKEN_TRACKING_ENABLED',
  rpcEnvVars: ['ETH_RPC_URL', 'ALCHEMY_ETH_RPC_URL'],
  fallbackRpc: 'https://ethereum-rpc.publicnode.com',
});

module.exports = { runEthereumTokenScan };
