/**
 * Copy-trade automatique.
 *
 * Quand un wallet suivi (flag copyTrade=true) achète un token, le bot réplique
 * l'achat (après passage par les filtres de sécurité). Optionnellement, copie
 * aussi les ventes.
 *
 * Réutilise l'Executor (dry-run/live) et le PositionManager existants.
 * Le déclenchement vient du WalletTracker (webhooks Helius).
 */
import type { BotConfig } from '../config/types.js';
import type { Store } from '../config/store.js';
import type { Executor } from '../execution/executor.js';
import type { PositionManager } from '../positions/manager.js';
import type { AntiRug } from '../security/anti-rug.js';
import type { NewTokenEvent } from '../detection/types.js';
import { logger } from '../utils/logger.js';
import { shortAddr } from '../utils/wallet.js';

const SCOPE = 'copytrade';

export class CopyTrader {
  constructor(
    private config: BotConfig,
    private store: Store,
    private executor: Executor,
    private positions: PositionManager,
    private antiRug: AntiRug,
    private onAlert?: (msg: string) => void,
  ) {}

  /**
   * Traite un événement issu du wallet tracking. Si le wallet est en copyTrade,
   * réplique l'achat du token.
   */
  async handleTrackedActivity(event: NewTokenEvent): Promise<void> {
    if (!this.config.copyTrade.enabled) return;
    if (this.store.getState().paused) return;

    const dev = event.creator;
    if (!dev) return;

    const tracked = this.store.listWallets().find((w) => w.address === dev);
    if (!tracked || !tracked.copyTrade) return;

    const { mint } = event;
    if (this.positions.hasPosition(mint)) return;
    if (this.positions.openCount >= this.config.execution.maxConcurrentPositions) {
      logger.debug(SCOPE, `Limite positions atteinte, copy ${mint} ignoré`);
      return;
    }

    logger.info(
      SCOPE,
      `🔁 Copy-trade: ${shortAddr(dev)} → achat de ${mint}`,
    );
    this.onAlert?.(`🔁 *Copy-trade* depuis \`${shortAddr(dev)}\`\nToken: \`${mint}\``);

    // 1. Sécurité avant de copier
    const report = await this.antiRug.evaluate(mint, dev);
    if (!report.safe) {
      logger.warn(SCOPE, `Copy-trade annulé ${mint}: échec sécurité (score ${report.score})`);
      this.onAlert?.(`❌ Copy-trade annulé pour \`${shortAddr(mint)}\` (sécurité, score ${report.score})`);
      return;
    }

    // 2. Achat (montant copy-trade dédié si configuré)
    const amountOverride =
      this.config.copyTrade.fixedBuyAmountSol > 0
        ? this.config.copyTrade.fixedBuyAmountSol
        : undefined;

    const buy = await this.executor.buy(mint, amountOverride);
    if (!buy.ok) {
      this.onAlert?.(`⚠️ Copy-buy échoué \`${shortAddr(mint)}\`: ${buy.error}`);
      return;
    }

    this.positions.openFromBuy(buy, event.symbol, `copytrade:${shortAddr(dev)}`);
    this.onAlert?.(
      `✅ Copy-buy ${buy.dryRun ? '(DRY-RUN) ' : ''}${buy.spentSol} SOL → \`${shortAddr(mint)}\``,
    );
  }
}
