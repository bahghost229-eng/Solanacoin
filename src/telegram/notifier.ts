/**
 * Notifier Telegram — alertes temps réel.
 *
 * S'abonne :
 *  - au logBus (logs warn/error importants) — optionnel/filtré
 *  - aux events du PositionManager ('update' = PnL, 'trade' = achat/vente)
 *
 * Et expose une méthode `alert(msg)` que les autres modules (CopyTrader,
 * pipeline de détection) utilisent pour pousser des messages formatés.
 *
 * L'envoi réel passe par une fonction `send` injectée (fournie par le bot
 * Telegram, qui connaît le token + les chat IDs).
 */
import type { PositionManager } from '../positions/manager.js';
import type { TradeRecord, PnlSnapshot } from '../positions/types.js';
import { logBus } from '../utils/logger.js';
import { shortAddr } from '../utils/wallet.js';

export type SendFn = (msg: string) => void;

export interface NotifierOptions {
  /** Envoyer une alerte à chaque trade (achat/vente). */
  alertTrades: boolean;
  /** Envoyer les logs error. */
  alertErrors: boolean;
}

export class Notifier {
  private lastSnapshotTs = 0;

  constructor(
    private send: SendFn,
    private positions: PositionManager,
    private opts: NotifierOptions,
  ) {}

  start(): void {
    if (this.opts.alertTrades) {
      this.positions.on('trade', (t: TradeRecord) => this.onTrade(t));
    }
    if (this.opts.alertErrors) {
      logBus.on('log', (e: { level: string; scope: string; msg: string }) => {
        if (e.level === 'error') {
          this.alert(`🔴 *Erreur* (${e.scope})\n${e.msg}`);
        }
      });
    }
  }

  /** Alerte libre (utilisée par CopyTrader, détection, etc.). */
  alert(msg: string): void {
    try {
      this.send(msg);
    } catch {
      /* ne jamais crasher le bot à cause d'une notif */
    }
  }

  private onTrade(t: TradeRecord): void {
    const tag = t.dryRun ? '🧪 DRY-RUN ' : '';
    if (t.type === 'buy') {
      this.alert(
        `🟢 ${tag}*ACHAT*\nToken: \`${shortAddr(t.mint)}\`${t.symbol ? ` (${t.symbol})` : ''}\nMontant: ${t.sol.toFixed(4)} SOL`,
      );
    } else {
      const pnl = t.pnlSol ?? 0;
      const emoji = pnl >= 0 ? '🟩' : '🟥';
      this.alert(
        `🔵 ${tag}*VENTE*\nToken: \`${shortAddr(t.mint)}\`${t.symbol ? ` (${t.symbol})` : ''}\nReçu: ${t.sol.toFixed(4)} SOL\nPnL: ${emoji} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`,
      );
    }
  }

  /** Formate un snapshot PnL pour /pnl. */
  static formatPnl(s: PnlSnapshot): string {
    const r = s.realizedPnlSol;
    const u = s.unrealizedPnlSol;
    return [
      '📊 *PnL*',
      `Réalisé: ${r >= 0 ? '+' : ''}${r.toFixed(4)} SOL`,
      `Latent: ${u >= 0 ? '+' : ''}${u.toFixed(4)} SOL`,
      `Investi (ouvert): ${s.totalInvestedSol.toFixed(4)} SOL`,
      `Positions ouvertes: ${s.openPositions}`,
      `Trades clôturés: ${s.closedTrades}`,
      `Win rate: ${s.winRate.toFixed(1)}%`,
    ].join('\n');
  }
}
