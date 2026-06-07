/**
 * CascadeTracer — descend la cascade de financement depuis un HUB.
 *
 * Reproduit la traque manuelle : un HUB distribue de gros montants vers des
 * sous-hubs, qui finissent par financer des wallets de LAUNCH (~8-13 SOL,
 * souvent frais, qui créent un token). On descend en largeur sur quelques
 * niveaux et on remonte la liste des wallets de launch trouvés.
 */
import { PublicKey } from '@solana/web3.js';
import type { RpcManager } from '../utils/rpc.js';
import { logger } from '../utils/logger.js';
import { shortAddr } from '../utils/wallet.js';

const SCOPE = 'cascade';
const LAMPORTS = 1_000_000_000;
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

export interface LaunchWallet {
  wallet: string;
  receivedSol: number;
  txCount: number;
  fresh: boolean;
  createdToken: boolean;
  via: string;
}

export interface CascadeResult {
  hub: string;
  maxDepthExplored: number;
  launchWallets: LaunchWallet[];
  note: string;
}

export class CascadeTracer {
  constructor(
    private rpc: RpcManager,
    private opts: {
      launchMinSol: number;
      launchMaxSol: number;
      maxDepth: number;
      freshMaxTx: number;
    } = { launchMinSol: 8, launchMaxSol: 13, maxDepth: 3, freshMaxTx: 12 },
  ) {}

  async trace(hub: string): Promise<CascadeResult> {
    const seen = new Set<string>();
    const launches: LaunchWallet[] = [];
    logger.info(SCOPE, `Traçage cascade depuis ${shortAddr(hub)}`);
    await this.explore(hub, 1, seen, launches);
    return {
      hub,
      maxDepthExplored: this.opts.maxDepth,
      launchWallets: launches.slice(0, 12),
      note: launches.length
        ? `${launches.length} wallet(s) de launch potentiel(s) trouvé(s).`
        : 'Aucun wallet de launch dans la fourchette/profondeur explorée (peut-être plus profond ou via DEX/CEX).',
    };
  }

  private async explore(
    addr: string,
    depth: number,
    seen: Set<string>,
    out: LaunchWallet[],
  ): Promise<void> {
    if (depth > this.opts.maxDepth || seen.has(addr) || out.length >= 12) return;
    seen.add(addr);

    const txs = await this.getTxs(addr, 40);
    const agg = new Map<string, number>();
    const launchTargets = new Map<string, number>();
    for (const tx of txs) {
      for (const [to, amt] of debited(tx, addr)) {
        agg.set(to, (agg.get(to) ?? 0) + amt);
        if (amt >= this.opts.launchMinSol && amt <= this.opts.launchMaxSol) {
          launchTargets.set(to, amt);
        }
      }
    }

    // Wallets dans la fourchette de launch → on vérifie fresh + création token
    for (const [to, amt] of launchTargets) {
      if (out.length >= 12) break;
      const t = await this.getTxs(to, 20);
      const fresh = t.length <= this.opts.freshMaxTx;
      const createdToken = t.some(createsToken);
      out.push({
        wallet: to,
        receivedSol: Number(amt.toFixed(2)),
        txCount: t.length,
        fresh,
        createdToken,
        via: addr,
      });
      logger.info(SCOPE, `🎯 Launch wallet ${shortAddr(to)} ← ${amt.toFixed(2)} SOL via ${shortAddr(addr)}`, {
        fresh,
        createdToken,
      });
    }

    // Descend dans les plus grosses destinations (hors launch directes)
    const bigs = [...agg.entries()]
      .filter(([a, v]) => !launchTargets.has(a) && v >= 5)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    for (const [to] of bigs) {
      await this.explore(to, depth + 1, seen, out);
    }
  }

  private async getTxs(addr: string, limit: number): Promise<any[]> {
    try {
      const sigs = await this.rpc.execute(
        (conn) => conn.getSignaturesForAddress(new PublicKey(addr), { limit }),
        SCOPE,
      );
      const txs: any[] = [];
      for (const s of sigs) {
        const tx = await this.rpc.execute(
          (conn) =>
            conn.getTransaction(s.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            }),
          SCOPE,
        );
        if (tx) txs.push(tx);
      }
      return txs;
    } catch {
      return [];
    }
  }
}

function keysOf(tx: any): string[] {
  const m = tx.transaction.message;
  return (m.staticAccountKeys ?? m.accountKeys ?? []).map((k: any) =>
    typeof k === 'string' ? k : k.toBase58?.() ?? String(k),
  );
}

/** Bénéficiaires + montant (SOL) quand `addr` débite dans la tx. */
function debited(tx: any, addr: string): [string, number][] {
  const out: [string, number][] = [];
  try {
    const keys = keysOf(tx);
    const pre: number[] = tx.meta.preBalances;
    const post: number[] = tx.meta.postBalances;
    const i = keys.indexOf(addr);
    if (i < 0 || post[i] - pre[i] >= 0) return out;
    for (let j = 0; j < keys.length; j++) {
      if (j === i) continue;
      const d = (post[j] - pre[j]) / LAMPORTS;
      if (d > 0) out.push([keys[j], d]);
    }
  } catch {
    /* ignore */
  }
  return out;
}

function createsToken(tx: any): boolean {
  const logs: string = (tx.meta?.logMessages ?? []).join(' ');
  return (
    /InitializeMint|MintTo|Instruction: Create\b/.test(logs) || logs.includes(PUMP_PROGRAM)
  );
}
