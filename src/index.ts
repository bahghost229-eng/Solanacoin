/**
 * Point d'entrée — orchestrateur du bot (interface Telegram uniquement).
 *
 * Pipeline :
 *   Détection (Pump.fun WS + wallet tracker via webhooks Helius)
 *        ↓ NewTokenEvent
 *   Filtres de détection (liquidité, socials…)
 *        ↓
 *   Anti-Rug (mint authority, holders, honeypot…)
 *        ↓ safe
 *   Executor.buy() (dry-run par défaut)
 *        ↓ BuyResult
 *   PositionManager (surveillance TP/SL/trailing + ventes)
 *        ↓
 *   Telegram (alertes temps réel + pilotage)
 *
 * Modules vidéo (CryptMe) :
 *   - ChainFollower : remonte la chaîne de financement d'un dev
 *   - DevPatternAnalyzer : score de suspicion (fresh wallet, funder commun…)
 *   - CopyTrader : copie auto les achats des wallets suivis
 *
 * ⚠️ AVERTISSEMENT : trader des memecoins est extrêmement risqué.
 *    Le mode dry-run est activé par défaut. Voir README.
 */
import { loadConfig, loadSecrets, assertLiveSafety } from './config/index.js';
import { logger } from './utils/logger.js';
import { RpcManager } from './utils/rpc.js';
import { loadKeypair, shortAddr } from './utils/wallet.js';
import { Store } from './config/store.js';
import { PumpFunListener } from './detection/pumpfun-listener.js';
import { WalletTracker } from './detection/wallet-tracker.js';
import { applyDetectionFilters } from './detection/filters.js';
import type { NewTokenEvent } from './detection/types.js';
import { AntiRug } from './security/anti-rug.js';
import { Executor } from './execution/executor.js';
import { PositionManager } from './positions/manager.js';
import { ChainFollower } from './chain/chain-follower.js';
import { DevPatternAnalyzer } from './chain/dev-pattern.js';
import { CascadeTracer } from './chain/cascade-tracer.js';
import { AiAssistant } from './ai/assistant.js';
import { CopyTrader } from './copytrade/copy-trader.js';
import { TelegramController } from './telegram/bot.js';
import { Notifier } from './telegram/notifier.js';

const SCOPE = 'main';

async function main(): Promise<void> {
  const config = loadConfig();
  const secrets = loadSecrets();

  logger.configure(config.logging);

  // --- État persistant à chaud (wallets suivis, overrides Telegram) ---
  const store = new Store();
  store.seedTrackedWallets(config.walletTracking.trackedWallets);

  // Applique les overrides persistés (dryRun) avant les garde-fous.
  if (store.getState().dryRunOverride !== null) {
    config.dryRun = store.getState().dryRunOverride as boolean;
  }

  printBanner(config.dryRun);
  assertLiveSafety(config, secrets);

  // --- Infra ---
  const rpc = new RpcManager(secrets);
  const wallet = loadKeypair(secrets.walletPrivateKey);
  if (wallet) {
    logger.info(SCOPE, `Wallet chargé: ${shortAddr(wallet.publicKey.toBase58())}`);
  } else if (!config.dryRun) {
    logger.error(SCOPE, 'Mode LIVE sans wallet — abandon.');
    process.exit(1);
  } else {
    logger.warn(SCOPE, 'Aucun wallet chargé (OK en dry-run : achats simulés).');
  }

  // --- Modules cœur ---
  const antiRug = new AntiRug(rpc, config.security);
  const executor = new Executor(rpc, config, secrets, wallet);
  const positions = new PositionManager(config, executor);

  // --- Modules "vidéo" : chaîne de financement + pattern dev + copy-trade ---
  const chain = config.chainFollowing.enabled
    ? new ChainFollower(rpc, config.chainFollowing)
    : null;
  const analyzer =
    config.devPattern.enabled && chain
      ? new DevPatternAnalyzer(rpc, chain, config.devPattern)
      : null;

  const cascade = new CascadeTracer(rpc);
  const assistant = new AiAssistant({
    secrets,
    config,
    store,
    positions,
    analyzer,
    chain,
    cascade,
  });

  positions.start();

  // --- Wallet tracking (webhooks Helius), wallets dynamiques via Store ---
  let walletTracker: WalletTracker | null = null;
  if (config.walletTracking.enabled) {
    walletTracker = new WalletTracker(config.walletTracking, secrets);
    walletTracker.setWallets(store.walletAddresses());
  }

  // --- Telegram (interface + notifier) ---
  const telegram = new TelegramController({
    config,
    secrets,
    store,
    positions,
    walletTracker,
    analyzer,
    chain,
    assistant,
    onWalletsChanged: () => walletTracker?.setWallets(store.walletAddresses()),
  });

  const notifier = new Notifier(telegram.sendFn, positions, {
    alertTrades: config.telegram.alerts,
    alertErrors: config.telegram.alerts,
  });

  // --- Copy-trade ---
  const copyTrader = new CopyTrader(
    config,
    store,
    executor,
    positions,
    antiRug,
    (msg) => notifier.alert(msg),
  );

  /** Montant d'achat effectif (override Store). */
  const buyAmount = (): number | undefined => {
    const o = store.getState().buyAmountOverride;
    return o && o > 0 ? o : undefined;
  };

  // --- Handler central de détection (snipe direct) ---
  const handleNewToken = async (event: NewTokenEvent): Promise<void> => {
    const { mint } = event;
    try {
      if (store.getState().paused) {
        logger.debug(SCOPE, `Bot en pause, ${mint} ignoré`);
        return;
      }
      if (positions.hasPosition(mint)) return;
      if (positions.openCount >= config.execution.maxConcurrentPositions) {
        logger.debug(SCOPE, `Limite positions atteinte (${positions.openCount}), ${mint} ignoré`);
        return;
      }

      const filter = applyDetectionFilters(event, config.detection.filters);
      if (!filter.passed) {
        logger.debug(SCOPE, `${mint} filtré`, { reasons: filter.reasons });
        return;
      }

      const report = await antiRug.evaluate(mint, event.creator);
      if (!report.safe) {
        logger.warn(SCOPE, `❌ ${mint} rejeté par sécurité (score ${report.score})`);
        return;
      }

      const buy = await executor.buy(mint, buyAmount());
      if (!buy.ok) {
        logger.warn(SCOPE, `Achat non exécuté pour ${mint}: ${buy.error}`);
        return;
      }
      positions.openFromBuy(buy, event.symbol, event.source);
    } catch (err) {
      const e = err as Error;
      // Erreur par-token = souvent bénigne (mint illisible, token déjà migré,
      // RPC ponctuel). On log en warn pour NE PAS spammer les alertes Telegram.
      logger.warn(SCOPE, `Token ${mint} ignoré (traitement échoué)`, {
        error: e?.message || String(err),
        stack: e?.stack?.split('\n').slice(0, 3).join(' | '),
      });
    }
  };

  // --- Détection Pump.fun (snipe direct des nouveaux launches) ---
  let pumpListener: PumpFunListener | null = null;
  if (config.detection.enabled) {
    pumpListener = new PumpFunListener(rpc);
    pumpListener.on('newToken', handleNewToken);
    pumpListener.start();
  }

  // --- Wallet tracking → copy-trade + snipe ---
  if (walletTracker) {
    walletTracker.on('newToken', (event: NewTokenEvent) => {
      // Copy-trade prioritaire (wallets suivis), puis pipeline standard.
      void copyTrader.handleTrackedActivity(event);
      void handleNewToken(event);
    });
    walletTracker.start();
  }

  // --- Telegram + alertes ---
  notifier.start();
  telegram.start();

  logger.info(SCOPE, '🟢 Bot démarré. En attente de nouveaux tokens…');
  notifier.alert('🟢 *Solana Chain Sniper* démarré.');

  // --- Arrêt propre ---
  const shutdown = () => {
    logger.info(SCOPE, 'Arrêt en cours…');
    pumpListener?.stop();
    walletTracker?.stop();
    positions.stop();
    telegram.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function printBanner(dryRun: boolean): void {
  const line = '═'.repeat(58);
  logger.info(SCOPE, `\n╔${line}╗`);
  logger.info(SCOPE, '   ⚡ SOLANA CHAIN SNIPER (Telegram)');
  logger.info(
    SCOPE,
    `   Mode : ${dryRun ? '🟦 DRY-RUN (simulation, aucune tx réelle)' : '🟥 LIVE (ARGENT RÉEL ENGAGÉ)'}`,
  );
  if (!dryRun) {
    logger.warn(SCOPE, '   ⚠️  ATTENTION : transactions réelles. Risque de perte totale.');
  }
  logger.info(SCOPE, `╚${line}╝\n`);
}

main().catch((err) => {
  logger.error(SCOPE, 'Erreur fatale au démarrage', { error: (err as Error)?.message });
  console.error(err);
  process.exit(1);
});
