/** Position ouverte sur un token. */
export interface Position {
  id: string;
  mint: string;
  symbol?: string;
  /** SOL investi à l'achat. */
  investedSol: number;
  /** Quantité de tokens détenue (raw). */
  amountRaw: number;
  /** Prix d'entrée en SOL par token (unité raw). */
  entryPrice: number;
  /** Plus haut prix observé (pour le trailing stop). */
  highestPrice: number;
  /** Prix courant (SOL par token raw). */
  currentPrice: number;
  /** Quels paliers de take-profit ont déjà été exécutés (index). */
  tpHit: number[];
  openedAt: number;
  status: 'open' | 'closed';
  /** Source de détection. */
  source: string;
}

/** Trade historisé (achat ou vente). */
export interface TradeRecord {
  ts: number;
  type: 'buy' | 'sell';
  mint: string;
  symbol?: string;
  sol: number; // SOL dépensé (buy) ou reçu (sell)
  amountRaw: number;
  price: number;
  reason?: string;
  dryRun: boolean;
  signature?: string;
  bundleId?: string;
  pnlSol?: number;
}

export interface PnlSnapshot {
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  totalInvestedSol: number;
  openPositions: number;
  closedTrades: number;
  winRate: number;
}
