const store = require("./store");
const { randomUUID } = require("crypto");

function getWallets() {
  return store.get("wallets", []);
}

function addWallet({ address, chain, label }) {
  const wallets = getWallets();
  const wallet = {
    id: randomUUID(),
    address: address.trim(),
    chain,
    label: label?.trim() || `${address.slice(0, 6)}…${address.slice(-4)}`,
  };
  wallets.push(wallet);
  store.set("wallets", wallets);
  return wallet;
}

function removeWallet(id) {
  const wallets = getWallets().filter(w => w.id !== id);
  store.set("wallets", wallets);
  return wallets;
}

module.exports = { getWallets, addWallet, removeWallet };
