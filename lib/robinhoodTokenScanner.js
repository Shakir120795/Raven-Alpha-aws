const { createTokenScanner } = require('./tokenTradeScanner');

const runRobinhoodTokenScan = createTokenScanner({
  chain: 'robinhood',
  label: 'RH',
  enabledEnv: 'ROBINHOOD_TOKEN_TRACKING_ENABLED',
  rpcEnvVars: ['ROBINHOOD_RPC_URL', 'ROBINHOOD_RPC_URL_2', 'ROBINHOOD_RPC_URL_3'],
  fallbackRpc: null,
  transferScanMode: 'logs',
  logWalletBatchSize: 500,
  logBlockSpan: 10,
});

module.exports = { runRobinhoodTokenScan };
