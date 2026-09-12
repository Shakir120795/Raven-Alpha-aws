# 🍌 Raven Alpha — AWS par 24/7 Setup

Ye ab Vercel pe nahi, seedha ek **AWS EC2 instance** pe chalega — ek single
Node.js process jo khud har 5 minute mein scan karta hai (`node-cron` se
andar hi built-in), aur `pm2` isse hamesha zinda rakhta hai (crash ho to
restart, server reboot ho to bhi auto-start). Isliye koi external
cron-job.org waghera ki bhi zaroorat nahi — sab kuch ek jagah, 24/7.

## 1. EC2 Instance banao

1. AWS Console → EC2 → **Launch Instance**
2. Name: `raven-alpha`
3. AMI: **Ubuntu Server 22.04 LTS** (free-tier eligible)
4. Instance type: **t2.micro** (free tier ke liye kaafi hai, ye halka kaam hai)
5. Key pair: naya bana lo (.pem file download hogi — sambhal ke rakho, SSH ke liye chahiye)
6. Network settings → Security group mein ye allow karo:
   - SSH (port 22) — sirf apna IP
   - Custom TCP (port 3000) — apna IP ya `0.0.0.0/0` agar dashboard kahin se bhi kholna hai
7. Launch karo

## 2. Instance se connect karo (SSH)

Apne computer ke terminal/Git Bash mein:
```bash
chmod 400 raven-alpha.pem
ssh -i raven-alpha.pem ubuntu@<EC2-Public-IP>
```

## 3. Node.js, pm2, aur project setup

EC2 ke andar (SSH session mein) ye sab chalao:
```bash
# Node.js 20 install karo
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# pm2 install karo — ye process ko hamesha zinda rakhega
sudo npm install -g pm2

# Project files upload karo (niche "Files kaise upload karein" section dekho),
# phir uske andar jao:
cd raven-alpha
npm install
```

## 4. Environment variables set karo

```bash
cp .env.example .env
nano .env
```
Isme apna `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK`, `ETH_KEYS`,
`ARC_KEYS`, aur `DASHBOARD_SECRET` (koi random string) daal do. Save karne ke
liye `Ctrl+O` phir `Enter`, exit ke liye `Ctrl+X`.

## 5. App ko pm2 se start karo (asli 24/7 wala step)

```bash
pm2 start server.js --name raven-alpha
pm2 save
pm2 startup
```
`pm2 startup` ek command print karega (kuch `sudo env PATH=... pm2 startup...`
jaisa) — usko copy karke waise hi run karo. Ye ensure karta hai ki agar EC2
instance kabhi reboot ho (AWS maintenance, ya tum khud restart karo), to app
apne aap wapas start ho jaye — bina tumhare kuch kiye.

Bas — ab ye process **hamesha chalta rahega**, chahe tum laptop band kar do,
SSH session close kar do, kuch bhi ho.

## 6. Dashboard kholo

Browser mein: `http://<EC2-Public-IP>:3000`

Yahan se wallets add/remove kar sakte ho, alert log dekh sakte ho, aur status
(Telegram/Discord configured hai ya nahi, last scan kab hua) dikhega.

## Useful pm2 commands

| Command | Kaam |
|---|---|
| `pm2 status` | App chal raha hai ya nahi, dekho |
| `pm2 logs raven-alpha` | Live logs dekho (scan results, errors) |
| `pm2 restart raven-alpha` | Manually restart karo (e.g. .env change ke baad) |
| `pm2 stop raven-alpha` | Rok do |

## Files update karni ho to (naya code deploy karna)

```bash
cd raven-alpha
git pull            # agar GitHub se clone kiya tha
npm install         # agar package.json change hua ho
pm2 restart raven-alpha
```

## Multi-RPC failover kaise kaam karta hai

`.env` mein ek chain ke liye comma se multiple keys de sakte ho:
```
ETH_KEYS=key1,key2,key3
```
Scanner pehli key try karega; agar wo rate-limit ho jaye, to automatically
agli key try hoga, phir agli — jab tak koi kaam na kar jaye. Isse ek single
free-tier API key ki limit khatam hone pe bhi scanning nahi rukti.

Robinhood aur Ink dono Blockscout explorers hain — inko koi key hi nahi
chahiye, wo already free/open hain.

## Ab kya alerts aayenge

Sirf ye 2 cheezein, jo bhi tracked wallet mein ho:
1. **Naya token mila** (wallet ne pehli baar koi token hold kiya)
2. **Naya NFT mint hua** (wallet ne zero-address se NFT receive kiya, matlab mint)

Dono alerts mein ye extra detail bhi hogi: **ye same contract/collection ab
tak kitni aur kin-kin tracked wallets se mint/receive ho chuki hai** — Telegram
aur Discord dono jagah.
