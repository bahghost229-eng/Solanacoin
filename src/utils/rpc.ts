/**
 * Gestionnaire de connexions RPC avec fallback.
 * - Primaire : Helius (REST RPC + base pour WebSocket)
 * - Secondaire : FluxRPC
 *
 * Toute opération RPC passe par execute() qui bascule automatiquement
 * sur le fallback en cas d'échec du primaire.
 */
import { Connection, type Commitment } from '@solana/web3.js';
import type { Secrets } from '../config/types.js';
import { logger } from './logger.js';
import { withRetry } from './retry.js';

export class RpcManager {
  readonly primary: Connection;
  readonly fallback: Connection | null;
  readonly heliusHttpUrl: string;
  readonly heliusWsUrl: string;

  constructor(secrets: Secrets, commitment: Commitment = 'confirmed') {
    if (!secrets.heliusApiKey) {
      logger.warn('rpc', 'HELIUS_API_KEY manquante — la détection temps réel ne fonctionnera pas.');
    }

    this.heliusHttpUrl = `https://mainnet.helius-rpc.com/?api-key=${secrets.heliusApiKey}`;
    this.heliusWsUrl = `wss://mainnet.helius-rpc.com/?api-key=${secrets.heliusApiKey}`;

    this.primary = new Connection(this.heliusHttpUrl, { commitment });

    // Fallback FluxRPC : uniquement si une URL http(s) VALIDE est fournie.
    // On ignore les placeholders / valeurs invalides pour ne pas crasher au boot.
    const flux = (secrets.fluxRpcUrl ?? '').trim();
    const isValidHttpUrl =
      /^https?:\/\//i.test(flux) && !/your-fluxrpc-endpoint|example\.com/i.test(flux);
    this.fallback = isValidHttpUrl ? new Connection(flux, { commitment }) : null;

    if (flux && !isValidHttpUrl) {
      logger.warn('rpc', 'FLUXRPC_URL invalide ou placeholder — fallback désactivé.', { value: flux });
    }
  }

  /**
   * Exécute une opération sur le RPC primaire, avec retry, puis bascule
   * vers le fallback FluxRPC si le primaire échoue durablement.
   */
  async execute<T>(op: (conn: Connection) => Promise<T>, scope = 'rpc'): Promise<T> {
    try {
      return await withRetry(() => op(this.primary), { retries: 2, scope });
    } catch (primaryErr) {
      logger.warn(scope, 'RPC primaire (Helius) en échec, bascule sur FluxRPC', {
        error: (primaryErr as Error)?.message,
      });
      if (!this.fallback) throw primaryErr;
      return await withRetry(() => op(this.fallback!), { retries: 2, scope });
    }
  }
}
