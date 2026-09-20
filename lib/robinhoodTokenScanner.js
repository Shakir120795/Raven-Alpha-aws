const { createTokenScanner } = require('./tokenTradeScanner');

const runRobinhoodTokenScan = createTokenScanner({
  chain: 'robinhood',
  label: 'RH',
  enabledEnv: 'ROBINHOOD_TOKEN_TRACKING_ENABLED',
  rpcEnvVars: ['ROBINHOOD_RPC_URL'],
  fallbackRpc: 'https://rpc.mainnet.chain.robinhood.com',
  transferScanMode: 'logs',
  logWalletBatchSize: 500,
  logBlockSpan: 500,
});

module.exports = { runRobinhoodTokenScan };
