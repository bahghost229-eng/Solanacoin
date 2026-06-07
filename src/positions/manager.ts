/**
 * Gestion des positions ouvertes.
 *
 * Responsabilités :
 *  - Ouvrir une position après un achat réussi
 *  - Poller le prix courant (via quote Jupiter) à intervalle régulier
 *  - Appliquer les règles : take-profit (paliers), stop-loss, trailing stop,
 *    durée max de détention
 *  - Déclencher les ventes via l'Executor
 *  - Calculer le PnL réalisé / non réalisé
 *  - Persister positions + historique des trades sur disque
 *
 * Émet des events ('update', 'trade') pour alimenter le dashboard.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { BotConfig } from '../config/types.js';
import type { Executor, BuyResult } from '../execution/executor.js';
import { getJupiterQuote } from '../execution/jupiter.js';
import { WSOL_MINT } from '../detection/constants.js';
import { logger } from '../utils/logger.js';
import type { Position, TradeRecord, PnlSnapshot } from './types.js';

const SCOPE = 'positions';
const POS_FILE = 'data/positions.json';
const TRADES_FILE = 'data/trades.json';

/**
 * Fonction de récupération de prix (SOL par token raw) pour un mint.
 * Injectable pour les tests ; par défaut interroge Jupiter.
 */
export type PriceFetcher = (mint: string, amountRaw: number) => Promise<number>;

async function defaultPriceFetcher(mint: string, amountRaw: number): Promise<number> {
  const probe = Math.max(1, Math.floor(amountRaw * 0.01));
  const quote = await getJupiterQuote({
    inputMint: mint,
    outputMint: WSOL_MINT.toBase58(),
    amount: probe,
    slippageBps: 3000,
  });
  if (!quote || !quote.outAmount) return 0;
  const solOut = Number(quote.outAmount) / LAMPORTS_PER_SOL;
  return solOut / probe; // SOL par token (raw)
}

export class PositionManager extends EventEmitter {
  private positions = new Map<string, Position>();
  private trades: TradeRecord[] = [];
  private realizedPnlSol = 0;
  private timer: NodeJS.Timeout | null = null;

  private priceFetcher: PriceFetcher;

  constructor(
    private config: BotConfig,
    private executor: Executor,
    priceFetcher: PriceFetcher = defaultPriceFetcher,
  ) {
    super();
    this.priceFetcher = priceFetcher;
    this.load();
  }

  /** Démarre la boucle de surveillance des positions. */
  start(): void {
    const interval = this.config.positions.priceCheckIntervalMs;
    this.timer = setInterval(() => this.tick().catch(() => {}), interval);
    logger.info(SCOPE, `Surveillance des positions toutes les ${interval}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get openCount(): number {
    return [...this.positions.values()].filter((p) => p.status === 'open').length;
  }

  hasPosition(mint: string): boolean {
    return [...this.positions.values()].some(
      (p) => p.mint === mint && p.status === 'open',
    );
  }

  /** Ouvre une position à partir d'un achat réussi. */
  openFromBuy(buy: BuyResult, symbol: string | undefined, source: string): Position {
    const pos: Position = {
      id: randomUUID(),
      mint: buy.mint,
      symbol,
      investedSol: buy.spentSol,
      amountRaw: buy.tokensReceivedRaw,
      entryPrice: buy.entryPriceSolPerToken,
      highestPrice: buy.entryPriceSolPerToken,
      currentPrice: buy.entryPriceSolPerToken,
      tpHit: [],
      openedAt: Date.now(),
      status: 'open',
      source,
    };
    this.positions.set(pos.id, pos);

    this.recordTrade({
      ts: Date.now(),
      type: 'buy',
      mint: buy.mint,
      symbol,
      sol: buy.spentSol,
      amountRaw: buy.tokensReceivedRaw,
      price: buy.entryPriceSolPerToken,
      dryRun: buy.dryRun,
      signature: buy.signature,
      bundleId: buy.bundleId,
    });

    this.persist();
    this.emit('update', this.snapshot());
    logger.info(SCOPE, `Position ouverte: ${buy.mint}`, {
      investedSol: buy.spentSol,
      tokens: buy.tokensReceivedRaw,
    });
    return pos;
  }

  /** Boucle de surveillance : maj prix + application des règles. */
  private async tick(): Promise<void> {
    const open = [...this.positions.values()].filter((p) => p.status === 'open');
    if (open.length === 0) return;

    for (const pos of open) {
      try {
        const price = await this.fetchPrice(pos);
        if (price <= 0) continue;
        pos.currentPrice = price;
        if (price > pos.highestPrice) pos.highestPrice = price;

        await this.applyRules(pos);
      } catch (err) {
        logger.debug(SCOPE, `Erreur tick ${pos.mint}`, {
          error: (err as Error)?.message,
        });
      }
    }
    this.persist();
    this.emit('update', this.snapshot());
  }

  /** Récupère le prix courant en vendant virtuellement 1% de la position. */
  private async fetchPrice(pos: Position): Promise<number> {
    return this.priceFetcher(pos.mint, pos.amountRaw);
  }

  private gainPercent(pos: Position): number {
    if (pos.entryPrice <= 0) return 0;
    return ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
  }

  /** Applique take-profit, stop-loss, trailing stop, durée max. */
  private async applyRules(pos: Position): Promise<void> {
    const cfg = this.config.positions;
    const gain = this.gainPercent(pos);

    // 1. Stop-loss
    if (gain <= -cfg.stopLossPercent) {
      await this.closePosition(pos, 100, `stop-loss (${gain.toFixed(1)}%)`);
      return;
    }

    // 2. Durée max
    if (cfg.maxHoldTimeMinutes > 0) {
      const heldMin = (Date.now() - pos.openedAt) / 60000;
      if (heldMin >= cfg.maxHoldTimeMinutes) {
        await this.closePosition(pos, 100, `durée max (${heldMin.toFixed(0)}min)`);
        return;
      }
    }

    // 3. Trailing stop (après activation)
    if (cfg.trailingStop.enabled) {
      const peakGain = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
      if (peakGain >= cfg.trailingStop.activationGainPercent) {
        const dropFromPeak =
          ((pos.highestPrice - pos.currentPrice) / pos.highestPrice) * 100;
        if (dropFromPeak >= cfg.trailingStop.trailPercent) {
          await this.closePosition(
            pos,
            100,
            `trailing stop (-${dropFromPeak.toFixed(1)}% du pic)`,
          );
          return;
        }
      }
    }

    // 4. Take-profit par paliers
    for (let i = 0; i < cfg.takeProfit.length; i++) {
      const tp = cfg.takeProfit[i];
      if (pos.tpHit.includes(i)) continue;
      if (gain >= tp.gainPercent) {
        pos.tpHit.push(i);
        await this.sellPartial(pos, tp.sellPercent, `TP +${tp.gainPercent}%`);
        // si tout est vendu, on s'arrête
        if (pos.amountRaw <= 0) {
          pos.status = 'closed';
          break;
        }
      }
    }
  }

  private async sellPartial(
    pos: Position,
    sellPercent: number,
    reason: string,
  ): Promise<void> {
    const amount = Math.floor((pos.amountRaw * sellPercent) / 100);
    if (amount <= 0) return;
    const res = await this.executor.sell(pos.mint, amount, pos.entryPrice);
    if (!res.ok) {
      logger.warn(SCOPE, `Vente partielle échouée ${pos.mint}: ${res.error}`);
      return;
    }

    // Coût d'acquisition de la portion vendue (proportionnel au capital restant).
    const costBasis = (amount / pos.amountRaw) * pos.investedSol;
    const pnl = res.receivedSol - costBasis;
    this.realizedPnlSol += pnl;
    // On retire la portion vendue ET son coût pour garder le ratio cohérent.
    pos.amountRaw -= amount;
    pos.investedSol = Math.max(0, pos.investedSol - costBasis);

    this.recordTrade({
      ts: Date.now(),
      type: 'sell',
      mint: pos.mint,
      symbol: pos.symbol,
      sol: res.receivedSol,
      amountRaw: amount,
      price: pos.currentPrice,
      reason,
      dryRun: res.dryRun,
      signature: res.signature,
      bundleId: res.bundleId,
      pnlSol: pnl,
    });

    logger.info(
      SCOPE,
      `💰 Vente ${sellPercent}% ${pos.mint} (${reason}) PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`,
    );
  }

  private async closePosition(
    pos: Position,
    sellPercent: number,
    reason: string,
  ): Promise<void> {
    await this.sellPartial(pos, sellPercent, reason);
    if (pos.amountRaw <= 0 || sellPercent >= 100) {
      pos.status = 'closed';
      pos.amountRaw = 0;
    }
    this.emit('update', this.snapshot());
  }

  private recordTrade(t: TradeRecord): void {
    this.trades.push(t);
    this.emit('trade', t);
    this.persist();
  }

  /** Calcule un instantané PnL réalisé + non réalisé. */
  snapshot(): PnlSnapshot {
    let unrealized = 0;
    let invested = 0;
    for (const p of this.positions.values()) {
      if (p.status !== 'open') continue;
      const value = p.currentPrice * p.amountRaw;
      const cost = p.investedSol;
      unrealized += value - cost;
      invested += cost;
    }
    const sells = this.trades.filter((t) => t.type === 'sell' && t.pnlSol !== undefined);
    const wins = sells.filter((t) => (t.pnlSol ?? 0) > 0).length;
    return {
      realizedPnlSol: this.realizedPnlSol,
      unrealizedPnlSol: unrealized,
      totalInvestedSol: invested,
      openPositions: this.openCount,
      closedTrades: sells.length,
      winRate: sells.length ? (wins / sells.length) * 100 : 0,
    };
  }

  getPositions(): Position[] {
    return [...this.positions.values()];
  }
  getTrades(): TradeRecord[] {
    return this.trades;
  }

  // --- Persistance ---
  private persist(): void {
    try {
      mkdirSync(dirname(POS_FILE), { recursive: true });
      writeFileSync(
        POS_FILE,
        JSON.stringify(
          { positions: [...this.positions.values()], realizedPnlSol: this.realizedPnlSol },
          null,
          2,
        ),
      );
      writeFileSync(TRADES_FILE, JSON.stringify(this.trades, null, 2));
    } catch (err) {
      logger.debug(SCOPE, 'Persistance échouée', { error: (err as Error)?.message });
    }
  }

  private load(): void {
    try {
      if (existsSync(POS_FILE)) {
        const data = JSON.parse(readFileSync(POS_FILE, 'utf-8'));
        this.realizedPnlSol = data.realizedPnlSol ?? 0;
        for (const p of data.positions ?? []) this.positions.set(p.id, p);
      }
      if (existsSync(TRADES_FILE)) {
        this.trades = JSON.parse(readFileSync(TRADES_FILE, 'utf-8'));
      }
    } catch {
      /* démarrage propre si fichiers corrompus */
    }
  }
}
