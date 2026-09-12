// Tiny file-based JSON store. Replaces Vercel KV — no external database
// needed, data just lives on the EC2 instance's disk under ./data/*.json.
// Good enough for a single-instance 24/7 background worker.
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const fileFor = (key) => path.join(DATA_DIR, `${key}.json`);

function get(key, fallback = null) {
  try {
    const raw = fs.readFileSync(fileFor(key), "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function set(key, value) {
  try {
    fs.writeFileSync(fileFor(key), JSON.stringify(value, null, 2));
    return true;
  } catch (e) {
    console.error("store.set failed:", key, e.message);
    return false;
  }
}

module.exports = { get, set };
