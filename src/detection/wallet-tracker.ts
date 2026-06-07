/**
 * Wallet tracking via webhooks Helius.
 *
 * Helius pousse les transactions des wallets suivis vers un endpoint HTTP.
 * Ce module lance un petit serveur Express qui reçoit ces webhooks, vérifie
 * l'en-tête d'authentification, identifie le mint concerné, et émet un
 * NewTokenEvent (source: wallet-tracker).
 *
 * Setup Helius (à faire une fois) :
 *  - Créer un webhook "enhanced" pointant vers http://<votre-ip>:<WEBHOOK_PORT>/helius
 *  - Type : "SWAP" + "TOKEN_MINT" / "ANY", addresses = trackedWallets
 *  - Auth header = WEBHOOK_AUTH_HEADER
 * Voir README pour la commande curl de création du webhook.
 */
import express from 'express';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { WalletTrackingConfig, Secrets } from '../config/types.js';
import type { NewTokenEvent } from './types.js';
import { logger } from '../utils/logger.js';
import { shortAddr } from '../utils/wallet.js';

const SCOPE = 'wallet-track';

export class WalletTracker extends EventEmitter {
  private app = express();
  private server: Server | null = null;
  private cfg: WalletTrackingConfig;
  private secrets: Secrets;
  private trackedSet: Set<string>;

  constructor(cfg: WalletTrackingConfig, secrets: Secrets) {
    super();
    this.cfg = cfg;
    this.secrets = secrets;
    this.trackedSet = new Set(cfg.trackedWallets.map((w) => w.trim()));
    this.app.use(express.json({ limit: '2mb' }));
    this.registerRoutes();
  }

  start(): void {
    if (!this.cfg.enabled) {
      logger.info(SCOPE, 'Wallet tracking désactivé.');
      return;
    }
    if (this.trackedSet.size === 0) {
      logger.warn(SCOPE, 'Aucun wallet à suivre dans la config.');
    }
    this.server = this.app.listen(this.secrets.webhookPort, () => {
      logger.info(
        SCOPE,
        `Serveur webhook à l'écoute sur :${this.secrets.webhookPort}/helius`,
      );
      logger.info(SCOPE, `Wallets suivis: ${[...this.trackedSet].map(shortAddr).join(', ')}`);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  /** Remplace la liste des wallets suivis à chaud (pilotage Telegram/Store). */
  setWallets(addresses: string[]): void {
    this.trackedSet = new Set(addresses.map((w) => w.trim()).filter(Boolean));
    logger.info(SCOPE, `Wallets suivis mis à jour (${this.trackedSet.size})`);
  }

  trackedCount(): number {
    return this.trackedSet.size;
  }

  private registerRoutes(): void {
    this.app.get('/health', (_req, res) => res.json({ ok: true }));

    this.app.post('/helius', (req, res) => {
      // Vérification de l'en-tête d'authentification (défini côté Helius)
      const auth = req.header('Authorization') ?? req.header('authorization');
      if (this.secrets.webhookAuthHeader && auth !== this.secrets.webhookAuthHeader) {
        logger.warn(SCOPE, 'Webhook rejeté: auth invalide');
        return res.status(401).json({ error: 'unauthorized' });
      }

      const payload = req.body;
      try {
        this.processPayload(payload);
      } catch (err) {
        logger.warn(SCOPE, 'Erreur traitement webhook', {
          error: (err as Error)?.message,
        });
      }
      // Toujours répondre 200 rapidement pour ne pas bloquer Helius.
      res.json({ ok: true });
    });
  }

  /**
   * Parse le payload enhanced de Helius. Pour chaque transaction impliquant
   * un wallet suivi, on extrait le mint des transferts de tokens.
   */
  private processPayload(payload: unknown): void {
    const txs = Array.isArray(payload) ? payload : [payload];

    for (const tx of txs) {
      const signature: string = tx?.signature ?? 'unknown';
      const feePayer: string = tx?.feePayer ?? '';
      const involvedTracked = this.findTrackedWallet(tx);
      if (!involvedTracked) continue;

      // Cherche le mint dans les transferts de tokens.
      const tokenTransfers: any[] = tx?.tokenTransfers ?? [];
      const mints = new Set<string>();
      for (const t of tokenTransfers) {
        if (t?.mint && t.mint !== 'So11111111111111111111111111111111111111112') {
          mints.add(t.mint);
        }
      }

      for (const mint of mints) {
        logger.info(
          SCOPE,
          `👁️  Wallet suivi ${shortAddr(involvedTracked)} actif sur ${mint}`,
          { signature: signature.slice(0, 8), feePayer: shortAddr(feePayer) },
        );

        if (this.cfg.action === 'alert') continue;

        const event: NewTokenEvent = {
          mint,
          creator: involvedTracked,
          signature,
          source: 'wallet-tracker',
          detectedAt: Date.now(),
        };
        this.emit('newToken', event);
      }
    }
  }

  private findTrackedWallet(tx: any): string | null {
    const candidates: string[] = [];
    if (tx?.feePayer) candidates.push(tx.feePayer);
    for (const t of tx?.tokenTransfers ?? []) {
      if (t?.fromUserAccount) candidates.push(t.fromUserAccount);
      if (t?.toUserAccount) candidates.push(t.toUserAccount);
    }
    for (const t of tx?.nativeTransfers ?? []) {
      if (t?.fromUserAccount) candidates.push(t.fromUserAccount);
      if (t?.toUserAccount) candidates.push(t.toUserAccount);
    }
    for (const c of candidates) {
      if (this.trackedSet.has(c)) return c;
    }
    return null;
  }
}
