/**
 * Wallet Chain Following.
 *
 * Remonte la "chaîne de financement" d'un wallet : qui l'a financé en SOL,
 * puis qui a financé ce financeur, etc. jusqu'à `maxHops`.
 *
 * Objectif (cf. vidéo) : à partir d'un wallet de dev, retrouver le wallet
 * "mère" / financeur qui prépare plusieurs lancements. On utilise l'historique
 * des transactions via Helius (getSignaturesForAddress + getTransaction).
 *
 * Sortie : un graphe de hops [ { from, to, amountSol, signature } ].
 */
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { RpcManager } from '../utils/rpc.js';
import type { ChainFollowingConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { shortAddr } from '../utils/wallet.js';

const SCOPE = 'chain';

export interface ChainHop {
  hop: number;
  from: string;
  to: string;
  amountSol: number;
  signature: string;
}

export interface ChainResult {
  origin: string;
  hops: ChainHop[];
  /** Le financeur racine identifié (dernier maillon remonté). */
  rootFunder?: string;
  /** Wallets uniques rencontrés dans la chaîne. */
  wallets: string[];
}

export class ChainFollower {
  constructor(
    private rpc: RpcManager,
    private cfg: ChainFollowingConfig,
  ) {}

  /**
   * Remonte la chaîne de financement depuis `origin`.
   * À chaque hop, on cherche le plus gros transfert SOL ENTRANT (le financement).
   */
  async follow(origin: string): Promise<ChainResult> {
    const hops: ChainHop[] = [];
    const wallets = new Set<string>([origin]);
    let current = origin;

    for (let hop = 0; hop < this.cfg.maxHops; hop++) {
      const funder = await this.findMainFunder(current);
      if (!funder) {
        logger.debug(SCOPE, `Pas de financeur trouvé pour ${shortAddr(current)} (hop ${hop})`);
        break;
      }
      hops.push({ hop, from: funder.from, to: current, amountSol: funder.amountSol, signature: funder.signature });
      wallets.add(funder.from);

      // Évite les boucles
      if (funder.from === current) break;
      current = funder.from;
    }

    const result: ChainResult = {
      origin,
      hops,
      rootFunder: hops.length ? hops[hops.length - 1].from : undefined,
      wallets: [...wallets],
    };
    logger.info(
      SCOPE,
      `Chaîne de ${shortAddr(origin)}: ${hops.length} hop(s), racine ${result.rootFunder ? shortAddr(result.rootFunder) : 'n/a'}`,
    );
    return result;
  }

  /**
   * Trouve le principal financeur SOL d'un wallet en inspectant ses dernières
   * transactions. Retourne le plus gros transfert ENTRANT au-dessus du seuil.
   */
  private async findMainFunder(
    wallet: string,
  ): Promise<{ from: string; amountSol: number; signature: string } | null> {
    const pubkey = new PublicKey(wallet);

    const sigs = await this.rpc.execute(
      (conn) => conn.getSignaturesForAddress(pubkey, { limit: this.cfg.maxTxPerWallet }),
      SCOPE,
    );
    if (!sigs.length) return null;

    let best: { from: string; amountSol: number; signature: string } | null = null;

    // On inspecte des transactions de la plus ancienne à la plus récente
    // (le financement initial est souvent parmi les premières).
    const ordered = [...sigs].reverse();

    for (const s of ordered) {
      try {
        const tx = await this.rpc.execute(
          (conn) =>
            conn.getTransaction(s.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            }),
          SCOPE,
        );
        if (!tx || !tx.meta) continue;

        const transfer = extractIncomingSolTransfer(tx, wallet);
        if (!transfer) continue;
        if (transfer.amountSol < this.cfg.minTransferSol) continue;

        if (!best || transfer.amountSol > best.amountSol) {
          best = { from: transfer.from, amountSol: transfer.amountSol, signature: s.signature };
        }
      } catch {
        /* tx illisible, on continue */
      }
    }
    return best;
  }
}

/**
 * Extrait un transfert SOL entrant vers `wallet` à partir des balances pre/post.
 * Retourne l'expéditeur principal (compte dont le solde a le plus baissé).
 */
function extractIncomingSolTransfer(
  tx: any,
  wallet: string,
): { from: string; amountSol: number } | null {
  try {
    const keys: string[] = (
      tx.transaction.message.staticAccountKeys ??
      tx.transaction.message.accountKeys ??
      []
    ).map((k: any) => (typeof k === 'string' ? k : k.toBase58?.() ?? String(k)));

    const pre: number[] = tx.meta.preBalances;
    const post: number[] = tx.meta.postBalances;
    const idx = keys.indexOf(wallet);
    if (idx < 0) return null;

    const delta = (post[idx] - pre[idx]) / LAMPORTS_PER_SOL;
    if (delta <= 0) return null; // pas un crédit

    // Expéditeur = compte avec la plus forte baisse de solde
    let from = '';
    let maxDrop = 0;
    for (let i = 0; i < keys.length; i++) {
      if (i === idx) continue;
      const drop = (pre[i] - post[i]) / LAMPORTS_PER_SOL;
      if (drop > maxDrop) {
        maxDrop = drop;
        from = keys[i];
      }
    }
    if (!from) return null;
    return { from, amountSol: delta };
  } catch {
    return null;
  }
}
