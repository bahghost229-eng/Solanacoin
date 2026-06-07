/** Événement émis quand un nouveau token est détecté. */
export interface NewTokenEvent {
  mint: string;
  /** Adresse du créateur (dev) si identifiable. */
  creator?: string;
  /** Signature de la transaction de création. */
  signature: string;
  /** Bonding curve / pool associé si parsable. */
  bondingCurve?: string;
  /** Liquidité initiale estimée en SOL (si dérivable). */
  initialLiquiditySol?: number;
  /** Métadonnées (nom, symbole, socials) si disponibles. */
  name?: string;
  symbol?: string;
  uri?: string;
  socials?: { twitter?: string; telegram?: string; website?: string };
  /** Source de la détection. */
  source: 'pumpfun-ws' | 'wallet-tracker';
  detectedAt: number;
}
