/**
 * Écoute en temps réel les créations de tokens sur Pump.fun.
 *
 * Approche : on ouvre un WebSocket vers Helius et on s'abonne à `logsSubscribe`
 * filtré sur le programme Pump.fun. À chaque log contenant le marqueur de création,
 * on récupère la transaction pour en extraire le mint + créateur, puis on émet
 * un NewTokenEvent.
 *
 * Robustesse : reconnexion auto avec backoff, ping/pong keepalive.
 */
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { PublicKey } from '@solana/web3.js';
import type { RpcManager } from '../utils/rpc.js';
import { logger } from '../utils/logger.js';
import {
  PUMP_FUN_PROGRAM_ID,
  PUMP_CREATE_LOG_MARKER,
} from './constants.js';
import type { NewTokenEvent } from './types.js';

const SCOPE = 'pumpfun';

export class PumpFunListener extends EventEmitter {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private rpc: RpcManager;
  private subId: number | null = null;
  private reconnectAttempts = 0;
  private stopped = false;
  private authFailed = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private seenSignatures = new Set<string>();

  constructor(rpc: RpcManager) {
    super();
    this.rpc = rpc;
    this.wsUrl = rpc.heliusWsUrl;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    logger.info(SCOPE, 'Connexion au WebSocket Helius…');
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      logger.info(SCOPE, 'WebSocket connecté. Abonnement aux logs Pump.fun.');
      this.subscribe();
      this.startKeepalive();
    });

    this.ws.on('message', (raw) => this.handleMessage(raw.toString()));

    this.ws.on('close', () => {
      logger.warn(SCOPE, 'WebSocket fermé.');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      const m = (err as Error)?.message || String(err);
      if (m.includes('401')) {
        // Clé Helius invalide/expirée : retry agressif inutile.
        this.authFailed = true;
        logger.error(
          SCOPE,
          'WebSocket Helius refusé (401) — HELIUS_API_KEY invalide ou expirée. Mets une clé valide dans les variables Railway.',
        );
      } else {
        logger.error(SCOPE, `Erreur WebSocket: ${m}`);
      }
      // 'close' suivra et déclenchera la reconnexion.
    });
  }

  private subscribe(): void {
    const req = {
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [PUMP_FUN_PROGRAM_ID.toBase58()] },
        { commitment: 'processed' },
      ],
    };
    this.ws?.send(JSON.stringify(req));
  }

  private startKeepalive(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
    }, 30_000);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectAttempts++;
    // Sur échec d'auth (401), on espace fortement les tentatives (clé morte) :
    // 5 min fixe au lieu du backoff exponentiel, pour ne pas marteler.
    const delay = this.authFailed
      ? 5 * 60_000
      : Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    logger.warn(SCOPE, `Reconnexion dans ${delay}ms (tentative ${this.reconnectAttempts})`);
    setTimeout(() => !this.stopped && this.connect(), delay);
  }

  private async handleMessage(data: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    // Confirmation d'abonnement
    if (msg.id === 1 && typeof msg.result === 'number') {
      this.subId = msg.result;
      logger.debug(SCOPE, `Abonnement actif (subId=${this.subId})`);
      return;
    }

    if (msg.method !== 'logsNotification') return;

    const value = msg.params?.result?.value;
    if (!value) return;

    const { signature, logs, err } = value;
    if (err) return; // transaction échouée
    if (!signature || this.seenSignatures.has(signature)) return;
    if (!Array.isArray(logs)) return;

    const isCreate = logs.some((l: string) => l.includes(PUMP_CREATE_LOG_MARKER));
    if (!isCreate) return;

    this.seenSignatures.add(signature);
    if (this.seenSignatures.size > 5000) {
      // borne mémoire : on vide périodiquement
      this.seenSignatures.clear();
      this.seenSignatures.add(signature);
    }

    logger.debug(SCOPE, `Création détectée dans tx ${signature.slice(0, 8)}…`);
    await this.resolveAndEmit(signature);
  }

  /**
   * Récupère la transaction complète pour en extraire le mint + créateur.
   * On parse les comptes de l'instruction Pump.fun "create".
   */
  private async resolveAndEmit(signature: string): Promise<void> {
    try {
      const tx = await this.rpc.execute(
        (conn) =>
          conn.getTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          }),
        SCOPE,
      );
      if (!tx) return;

      const parsed = parseCreateFromTx(tx, signature);
      if (!parsed) {
        logger.debug(SCOPE, 'Création non parsable, ignorée', { signature });
        return;
      }

      const event: NewTokenEvent = {
        ...parsed,
        source: 'pumpfun-ws',
        detectedAt: Date.now(),
      };
      logger.info(SCOPE, `🚀 Nouveau token: ${event.mint}`, {
        creator: event.creator,
      });
      this.emit('newToken', event);
    } catch (err) {
      logger.debug(SCOPE, 'Échec résolution tx', { error: (err as Error)?.message });
    }
  }
}

/**
 * Parse une transaction Pump.fun pour extraire le mint et le créateur.
 * Le layout des comptes de l'instruction `create` place le nouveau mint
 * en première position des comptes de l'instruction, et le créateur comme signataire.
 */
function parseCreateFromTx(
  tx: any,
  signature: string,
): Pick<NewTokenEvent, 'mint' | 'creator' | 'bondingCurve' | 'signature'> | null {
  try {
    const message = tx.transaction.message;
    const accountKeys: PublicKey[] = (
      message.staticAccountKeys ?? message.accountKeys ?? []
    ).map((k: any) => (k instanceof PublicKey ? k : new PublicKey(k)));

    // Le créateur (fee payer) est le premier compte signataire.
    const creator = accountKeys[0]?.toBase58();

    // Recherche de l'instruction adressée au programme Pump.fun.
    const instructions =
      message.compiledInstructions ?? message.instructions ?? [];

    for (const ix of instructions) {
      const programIdIndex = ix.programIdIndex;
      const programId = accountKeys[programIdIndex]?.toBase58();
      if (programId !== PUMP_FUN_PROGRAM_ID.toBase58()) continue;

      const accIdx: number[] = ix.accountKeyIndexes ?? ix.accounts ?? [];
      // Layout Pump.fun create : [mint, mintAuthority, bondingCurve, ...]
      const mint = accountKeys[accIdx[0]]?.toBase58();
      const bondingCurve = accountKeys[accIdx[2]]?.toBase58();
      if (mint) {
        return { mint, creator, bondingCurve, signature };
      }
    }
    return null;
  } catch {
    return null;
  }
}
