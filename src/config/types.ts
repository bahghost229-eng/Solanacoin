/**
 * Types partagés de configuration du bot.
 * Tous les modules importent depuis ici pour rester cohérents.
 */

export interface DetectionFilters {
  minInitialLiquiditySol: number;
  maxInitialLiquiditySol: number;
  requireSocials: boolean;
  ignoreMintsWithUpdateAuthority: boolean;
}

export interface DetectionConfig {
  enabled: boolean;
  source: 'pumpfun';
  filters: DetectionFilters;
}

export interface WalletTrackingConfig {
  enabled: boolean;
  trackedWallets: string[];
  action: 'snipe' | 'alert';
}

export interface SecurityConfig {
  enabled: boolean;
  requireMintAuthorityRevoked: boolean;
  requireFreezeAuthorityRevoked: boolean;
  maxDevHoldingPercent: number;
  maxTopHolderPercent: number;
  minHolders: number;
  checkHoneypot: boolean;
  checkLiquidityLocked: boolean;
}

export interface ExecutionConfig {
  swapProvider: 'jupiter';
  useJitoBundles: boolean;
  jitoTipLamports: number;
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  buyAmountSol: number;
  perTokenBuyAmountSol: Record<string, number>;
  slippageBps: number;
  maxConcurrentPositions: number;
  buyTimeoutMs: number;
  maxRetries: number;
}

export interface TakeProfitRule {
  gainPercent: number;
  sellPercent: number;
}

export interface TrailingStopConfig {
  enabled: boolean;
  activationGainPercent: number;
  trailPercent: number;
}

export interface PositionsConfig {
  takeProfit: TakeProfitRule[];
  stopLossPercent: number;
  trailingStop: TrailingStopConfig;
  priceCheckIntervalMs: number;
  maxHoldTimeMinutes: number;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  logToFile: boolean;
  logFilePath: string;
}

export interface TelegramConfig {
  enabled: boolean;
  /** Si true, seuls les adminChatIds peuvent piloter le bot. */
  restrictToAdmins: boolean;
  /** Envoyer les alertes temps réel (token détecté, achat, vente, PnL). */
  alerts: boolean;
}

export interface ChainFollowingConfig {
  enabled: boolean;
  /** Profondeur max de remontée de la chaîne de financement. */
  maxHops: number;
  /** Montant min (SOL) d'un transfert pour être considéré comme financement. */
  minTransferSol: number;
  /** Nb max de transactions inspectées par wallet (perf/limites RPC). */
  maxTxPerWallet: number;
}

export interface DevPatternConfig {
  enabled: boolean;
  /** Un wallet est "fresh" s'il a moins de N transactions au moment du financement. */
  freshWalletMaxTx: number;
  /** Score minimum (0-100) pour considérer un dev comme "suspect/à sniper". */
  minSuspicionScore: number;
  /** Fourchette (SOL) typique d'un financement de création de token (ex: 8-12). */
  launchFundingMinSol: number;
  launchFundingMaxSol: number;
  /** Nb min de wallets financés dans la fourchette pour qualifier un "hub sérial launcher". */
  serialHubMinLaunches: number;
}

export interface CopyTradeConfig {
  enabled: boolean;
  /** Copie aussi les ventes des wallets suivis (sinon achats seulement). */
  copySells: boolean;
  /** Montant fixe (SOL) par copy-buy. 0 = utilise execution.buyAmountSol. */
  fixedBuyAmountSol: number;
  /** Délai max (ms) après détection pour exécuter la copie. */
  maxDelayMs: number;
}

export interface BotConfig {
  dryRun: boolean;
  network: string;
  detection: DetectionConfig;
  walletTracking: WalletTrackingConfig;
  security: SecurityConfig;
  execution: ExecutionConfig;
  positions: PositionsConfig;
  logging: LoggingConfig;
  telegram: TelegramConfig;
  chainFollowing: ChainFollowingConfig;
  devPattern: DevPatternConfig;
  copyTrade: CopyTradeConfig;
}

/** Secrets chargés depuis .env (jamais loggés en clair). */
export interface Secrets {
  heliusApiKey: string;
  fluxRpcUrl: string;
  jitoBlockEngineUrl: string;
  walletPrivateKey: string;
  webhookPort: number;
  webhookAuthHeader: string;
  /** Token du bot Telegram (BotFather). */
  telegramBotToken: string;
  /** Chat IDs admin autorisés à piloter le bot (séparés par des virgules dans .env). */
  telegramAdminChatIds: number[];
  /** Clé API OpenRouter pour l'assistant IA (/ask). */
  openRouterApiKey: string;
  /** Modèle OpenRouter (défaut: un modèle gratuit). */
  openRouterModel: string;
}
