# Fusion → Solana Chain Sniper (Telegram-only)

## Décisions
- Base = solana-sniper-bot (TS). Interface = TELEGRAM ONLY (retirer dashboard web).
- Exécution = Jupiter + Jito, dry-run par défaut.
- Héberger sur Railway.

## Features de la vidéo à ajouter
- [ ] Wallet chain following (wallet -> wallet -> financeur, max hops)
- [ ] Détection devs avant lancement (patterns de financement: funder commun, fresh wallets)
- [ ] Copy-trade auto sur wallets suivis
- [ ] Commandes Telegram (add/remove wallets, config, stats, start/stop, mode)
- [ ] Alertes Telegram temps réel (token, achat, vente, PnL)

## Tâches — TERMINÉ ✅
- [x] node-telegram-bot-api + types
- [x] src/telegram/bot.ts — commandes + auth admin chat id
- [x] src/telegram/notifier.ts — alertes (logBus + events positions)
- [x] src/chain/chain-follower.ts — chaîne de financement Helius
- [x] src/chain/dev-pattern.ts — patterns de devs (fresh, funder, siblings)
- [x] src/copytrade/copy-trader.ts — copy-trade auto
- [x] dashboard/ retiré (Telegram only)
- [x] Store persistant (data/store.json) — wallets + overrides à chaud
- [x] index.ts câblé (Store/chain/copytrade/telegram/notifier)
- [x] executor.buy(mint, amountOverride?) + wallet-tracker.setWallets()
- [x] config.example.json / .env.example / package.json nettoyés
- [x] Railway: Dockerfile + railway.json + Procfile + README déploiement
- [x] typecheck 0 erreur + boot test dry-run OK (pipeline complet fonctionne)
- [x] README réécrit (Telegram setup + commandes + Railway)

## Reste optionnel
- [ ] Test Telegram réel (nécessite TELEGRAM_BOT_TOKEN du user)
- [ ] copySells (copyTrade.copySells) pas encore implémenté (achats seulement)
