# ⚡ Solana Chain Sniper (Telegram)

Bot **Telegram** de sniping sur Solana écrit en **TypeScript / Node.js**.
Inspiré du *Packet/Paca Tracker* : détection temps réel des lancements Pump.fun,
**suivi de wallets de devs**, **remontée de la chaîne de financement**, **détection de
patterns de devs**, **copy-trade automatique**, checks anti-rug, exécution prioritaire
(Jupiter + Jito) et gestion automatique des positions (TP/SL/trailing).

**Tout se pilote depuis Telegram** — pas de dashboard web.

> **Mode `dry-run` activé par défaut** : le bot simule les achats/ventes avec de vrais
> prix on-chain mais n'envoie **aucune transaction réelle** tant que vous ne passez pas
> explicitement en mode LIVE (`/dryrun off`).

---

## ⚠️⚠️ AVERTISSEMENTS DE SÉCURITÉ — À LIRE ⚠️⚠️

- **RISQUE FINANCIER EXTRÊME.** Les memecoins sont parmi les actifs les plus risqués.
  La majorité finissent à zéro (rug pulls, honeypots, abandon). **Vous pouvez perdre la
  totalité de votre capital.** N'investissez que ce que vous êtes prêt à perdre.
- **CLÉ PRIVÉE = CONTRÔLE TOTAL.** La clé dans `.env` donne un accès complet au wallet.
  - Utilisez un **wallet dédié** au bot, jamais votre wallet principal.
  - N'y laissez qu'un **montant limité**.
  - Ne committez **jamais** `.env` (déjà dans `.gitignore`).
- **PILOTAGE TELEGRAM RESTREINT.** Activez `telegram.restrictToAdmins` et renseignez
  `TELEGRAM_ADMIN_CHAT_IDS` pour que seul vous puissiez contrôler le bot.
- **AUCUNE GARANTIE.** Logiciel fourni "tel quel", à but **éducatif**.
- **Commencez TOUJOURS en `dry-run`.**

---

## 🏗️ Architecture

```
src/
├── config/         Config + secrets (.env) + Store persistant (wallets/overrides à chaud)
├── utils/          Logger, retry/backoff, RPC manager (Helius + FluxRPC fallback), wallet
├── detection/      Écoute WS Pump.fun, filtres, wallet tracking (webhooks Helius)
├── chain/          ChainFollower (chaîne de financement) + DevPatternAnalyzer (score dev)
├── copytrade/      Copy-trade auto des wallets suivis
├── security/       Anti-rug : mint/freeze authority, holders, honeypot, liquidité
├── execution/      Jupiter (quote/swap), Jito (bundles), executor dry-run/live
├── positions/      Gestion positions : TP/SL/trailing, PnL, historique, persistance
├── telegram/       Interface (commandes) + Notifier (alertes temps réel)
└── index.ts        Orchestrateur (pipeline complet)
```

**Pipeline :** Détection (Pump.fun + wallets suivis) → Filtres → Anti-Rug → Achat
→ Position (TP/SL/trailing) → Alertes Telegram. Le copy-trade réplique les achats des
wallets suivis. `/analyze` et `/chain` exposent la chaîne de financement et le score dev.

---

## 🚀 Installation

Prérequis : **Node.js 20+** (testé Node 22/24). `npm` ou `bun`.

```bash
npm install                      # ou: bun install
cp config.example.json config.json
cp .env.example .env
# éditez .env (secrets) et config.json (paramètres)
```

---

## 🤖 Setup Telegram (obligatoire)

1. **Créer le bot** : sur Telegram, parlez à [@BotFather](https://t.me/BotFather)
   → `/newbot` → récupérez le **token**. Mettez-le dans `.env` (`TELEGRAM_BOT_TOKEN`).
2. **Récupérer votre chat ID** : lancez le bot (`npm run bot`), envoyez `/start` à votre
   bot. Il répond avec votre `chat ID`.
3. **Autoriser** : ajoutez ce chat ID dans `.env` →
   `TELEGRAM_ADMIN_CHAT_IDS=123456789` (plusieurs séparés par des virgules).
   Tant qu'aucun admin n'est défini, le bot accepte tout le monde (bootstrap).

### Commandes Telegram

| Commande | Effet |
|---|---|
| `/start` | Menu + votre chat ID |
| `/status` | Mode, pause, wallets, positions, montant |
| `/wallets` | Liste des wallets suivis |
| `/add <addr> [label]` | Suivre un wallet (copy-trade ON) |
| `/remove <addr>` | Retirer un wallet |
| `/pause` `/resume` | Couper / reprendre le sniping |
| `/dryrun on\|off` | Simulation / LIVE (à chaud) |
| `/buyamount <sol>` | Montant d'achat par snipe |
| `/positions` | Positions ouvertes + gain % |
| `/pnl` | PnL réalisé + latent + win rate |
| `/analyze <wallet>` | Score de suspicion du dev (fresh, funder, siblings) |
| `/chain <wallet>` | Remonte la chaîne de financement |

Les wallets ajoutés via `/add` sont **persistés** (`data/store.json`) et survivent aux
redémarrages. Idem pour les overrides (pause, dryRun, montant).

---

## 🔧 Configuration

### `.env` — secrets

| Variable | Description |
|---|---|
| `HELIUS_API_KEY` | Clé API Helius — WebSocket + REST |
| `FLUXRPC_URL` | Endpoint RPC secondaire / fallback |
| `JITO_BLOCK_ENGINE_URL` | URL Block Engine Jito (défaut mainnet) |
| `WALLET_PRIVATE_KEY` | Clé privée base58 — **vide en dry-run** |
| `WEBHOOK_PORT` | Port du serveur de webhooks (wallet tracking) |
| `WEBHOOK_AUTH_HEADER` | Secret partagé pour authentifier les webhooks Helius |
| `TELEGRAM_BOT_TOKEN` | Token du bot (BotFather) |
| `TELEGRAM_ADMIN_CHAT_IDS` | Chat IDs admin autorisés (CSV) |

### `config.json` — blocs clés

- `dryRun` : simulation vs LIVE.
- `detection.filters` : liquidité min/max, socials.
- `walletTracking.trackedWallets` : seed initial des wallets (puis géré via `/add`).
- `telegram` : `enabled`, `restrictToAdmins`, `alerts`.
- `chainFollowing` : `maxHops`, `minTransferSol`, `maxTxPerWallet`.
- `devPattern` : `freshWalletMaxTx`, `minSuspicionScore`.
- `copyTrade` : `enabled`, `copySells`, `fixedBuyAmountSol`, `maxDelayMs`.
- `security`, `execution`, `positions` : seuils anti-rug, achat/slippage, TP/SL/trailing.

---

## ▶️ Utilisation

```bash
npm run bot          # lancer (dry-run par défaut)  = tsx src/index.ts
npm run build && npm start   # build TS -> dist puis run
npm run typecheck    # vérifier les types
```

### Passer en LIVE (⚠️ argent réel)

1. Renseignez `WALLET_PRIVATE_KEY` (wallet dédié, fonds limités).
2. `/dryrun off` dans Telegram **ou** `"dryRun": false` dans `config.json`.
3. Au démarrage en LIVE via config, confirmez les risques :

```bash
I_UNDERSTAND_THE_RISKS=yes npm run bot
```

---

## 📡 Wallet tracking (webhooks Helius)

Le tracking utilise les **webhooks Helius**. Lancez le bot (serveur webhook sur
`WEBHOOK_PORT`), exposez ce port (ex: `ngrok http 4000`), puis créez le webhook :

```bash
curl -X POST 'https://api.helius.xyz/v0/webhooks?api-key=VOTRE_CLE_HELIUS' \
  -H 'Content-Type: application/json' \
  -d '{
    "webhookURL": "https://VOTRE-URL-PUBLIQUE/helius",
    "transactionTypes": ["ANY"],
    "accountAddresses": ["WalletDev1...", "WalletDev2..."],
    "webhookType": "enhanced",
    "authHeader": "LE_MEME_QUE_WEBHOOK_AUTH_HEADER"
  }'
```

Le bot vérifie l'`authHeader` et déclenche le copy-trade + le pipeline de snipe.

---

## ☁️ Déploiement Railway

Le bot tourne en **worker** (polling Telegram) — pas besoin de port web public.

1. **Créer le projet** : Railway → *New Project* → *Deploy from GitHub repo* (ou
   `railway up` via CLI). Le `Dockerfile` et `railway.json` sont déjà fournis.
2. **Variables d'environnement** : dans l'onglet *Variables*, ajoutez toutes les clés
   de `.env` :
   - `HELIUS_API_KEY`, `FLUXRPC_URL`, `JITO_BLOCK_ENGINE_URL`
   - `WALLET_PRIVATE_KEY` (vide pour dry-run)
   - `WEBHOOK_PORT`, `WEBHOOK_AUTH_HEADER`
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_IDS`
   - (LIVE seulement) `I_UNDERSTAND_THE_RISKS=yes`
3. **Volume persistant** (recommandé) : ajoutez un volume monté sur `/app/data` pour
   conserver `store.json`, `positions.json`, `trades.json` entre les redéploiements.
4. **Webhook tracking** : si vous voulez le wallet tracking en prod, exposez le port
   `WEBHOOK_PORT` (générez un domaine Railway sur le service) et pointez le webhook
   Helius vers `https://<votre-domaine-railway>/helius`. Sinon, désactivez
   `walletTracking.enabled` et utilisez seulement la détection Pump.fun + copy-trade.

> ⚠️ Lockfile : si Railway échoue sur un lockfile désynchronisé, lancez `npm install`
> en local et committez le `package-lock.json` à jour (déjà inclus).

---

## 🛡️ Checks anti-rug

| Check | Sévérité | Détail |
|---|---|---|
| Mint authority révoquée | critique | Sinon mint illimité possible |
| Freeze authority révoquée | critique | Sinon gel possible (honeypot) |
| Concentration top holder | critique | % max d'un seul holder |
| Holding du dev | critique | % max du wallet créateur |
| Nombre de holders | warning | Minimum requis |
| Honeypot | critique | Simule une vente via Jupiter |
| Liquidité verrouillée | warning | Bonding curve gérée par programme |

---

## 📁 Données générées

- `data/store.json` — wallets suivis + overrides (pause/dryRun/montant)
- `data/positions.json` — positions persistées
- `data/trades.json` — historique des trades
- `data/bot.log` — logs (si `logging.logToFile`)

---

## Licence

MIT — usage éducatif. **Aucune garantie. Tradez à vos risques.**
