const { createTokenScanner } = require('./tokenTradeScanner');

const runRobinhoodTokenScan = createTokenScanner({
  chain: 'robinhood',
  label: 'RH',
  enabledEnv: 'ROBINHOOD_TOKEN_TRACKING_ENABLED',
  rpcEnvVars: ['ROBINHOOD_RPC_URL', 'ALCHEMY_ROBINHOOD_RPC_URL'],
  rpcKeyEnvConfigs: [{ env: 'ROBINHOOD_KEYS', baseUrl: 'https://robinhood-mainnet.g.alchemy.com/v2/' }],
  fallbackRpc: 'https://rpc.mainnet.chain.robinhood.com',
  blockscoutApi: 'https://robinhoodchain.blockscout.com/api/v2',
});

module.exports = { runRobinhoodTokenScan };
