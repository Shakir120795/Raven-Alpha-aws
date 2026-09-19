const { createTokenScanner } = require('./tokenTradeScanner');

const runEthereumTokenScan = createTokenScanner({
  chain: 'eth',
  label: 'ETH',
  enabledEnv: 'ETH_TOKEN_TRACKING_ENABLED',
  rpcEnvVars: ['ETH_RPC_URL', 'ALCHEMY_ETH_RPC_URL'],
  rpcKeyEnvConfigs: [{ env: 'ETH_KEYS', baseUrl: 'https://eth-mainnet.g.alchemy.com/v2/' }],
  fallbackRpc: 'https://ethereum-rpc.publicnode.com',
});

module.exports = { runEthereumTokenScan };
