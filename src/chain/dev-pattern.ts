/**
 * Détection de patterns de devs AVANT lancement.
 *
 * Idée (cf. vidéo "How I Find Dev Wallets Before They Launch") : les devs de
 * memecoins réutilisent des schémas reconnaissables :
 *   - un wallet "financeur" (mère) qui alimente plusieurs wallets de lancement
 *   - des wallets "fresh" (peu/pas d'historique) financés juste avant un launch
 *   - des montants de financement réguliers (ex: toujours ~1-2 SOL)
 *   - une chaîne courte entre le financeur et le wallet qui mint
 *
 * Ce module calcule un "score de suspicion" (0-100) à partir de ces signaux,
 * en s'appuyant sur le ChainFollower et l'historique on-chain.
 */
import { PublicKey } from '@solana/web3.js';
import type { RpcManager } from '../utils/rpc.js';
import type { DevPatternConfig } from '../config/types.js';
import type { ChainFollower, ChainResult } from './chain-follower.js';
import { logger } from '../utils/logger.js';
import { shortAddr } from '../utils/wallet.js';

const SCOPE = 'dev-pattern';

export interface PatternSignal {
  name: string;
  hit: boolean;
  weight: number;
  detail: string;
}

export interface DevPatternReport {
  wallet: string;
  rootFunder?: string;
  chain: ChainResult;
  score: number; // 0-100
  suspicious: boolean;
  signals: PatternSignal[];
  /** Autres wallets financés par la même racine (siblings = autres launches potentiels). */
  siblings: string[];
  /** Hub distributeur direct (Wallet C) — le financeur le plus proche du dev. */
  hub?: string;
  /** Wallets financés par le hub dans la fourchette de launch (chacun = un launch probable). */
  launchSiblings: { wallet: string; amountSol: number }[];
}

export class DevPatternAnalyzer {
  constructor(
    private rpc: RpcManager,
    private chain: ChainFollower,
    private cfg: DevPatternConfig,
  ) {}

  /**
   * Analyse un wallet de dev et calcule son score de suspicion.
   */
  async analyze(wallet: string): Promise<DevPatternReport> {
    const chain = await this.chain.follow(wallet);
    const signals: PatternSignal[] = [];

    // 1. Wallet "fresh" : peu de transactions => probablement créé pour ce launch
    const txCount = await this.txCount(wallet);
    const isFresh = txCount <= this.cfg.freshWalletMaxTx;
    signals.push({
      name: 'fresh-wallet',
      hit: isFresh,
      weight: 30,
      detail: `${txCount} transactions (fresh si <= ${this.cfg.freshWalletMaxTx})`,
    });

    // 2. Chaîne de financement courte (financeur direct ou à 1-2 hops)
    const shortChain = chain.hops.length > 0 && chain.hops.length <= 2;
    signals.push({
      name: 'short-funding-chain',
      hit: shortChain,
      weight: 20,
      detail: `${chain.hops.length} hop(s) jusqu'au financeur`,
    });

    // 3. Financement par un wallet mère qui alimente plusieurs wallets (siblings)
    let siblings: string[] = [];
    let hub: string | undefined;
    let launchSiblings: { wallet: string; amountSol: number }[] = [];
    if (chain.rootFunder) {
      siblings = await this.findSiblings(chain.rootFunder, wallet);
      const hasSiblings = siblings.length >= 1;
      signals.push({
        name: 'mother-wallet-multi-fund',
        hit: hasSiblings,
        weight: 20,
        detail: hasSiblings
          ? `Financeur alimente ${siblings.length} autre(s) wallet(s) (launches potentiels)`
          : 'Financeur sans autres bénéficiaires détectés',
      });
    }

    // 4. Montant de financement dans la fourchette de LAUNCH (ex: 8-12 SOL)
    // C'est la signature décrite : le hub envoie un montant quasi-fixe au wallet
    // qui va créer le token.
    const { launchFundingMinSol: lo, launchFundingMaxSol: hi } = this.cfg;
    const launchFunding = chain.hops.find(
      (h) => h.amountSol >= lo && h.amountSol <= hi,
    );
    signals.push({
      name: 'launch-funding-amount',
      hit: !!launchFunding,
      weight: 20,
      detail: launchFunding
        ? `Financement ${launchFunding.amountSol.toFixed(2)} SOL dans la fourchette de launch (${lo}-${hi})`
        : `Aucun financement dans la fourchette de launch (${lo}-${hi} SOL)`,
    });

    // 5. HUB SÉRIAL : le financeur direct (Wallet C) distribue des montants
    // 8-12 SOL à PLUSIEURS wallets frais → machine à launch récurrente.
    // On prend le financeur le plus proche (hop 0) comme hub candidat.
    hub = chain.hops[0]?.from;
    if (hub) {
      launchSiblings = await this.findLaunchFunded(hub, lo, hi);
      const isSerialHub = launchSiblings.length >= this.cfg.serialHubMinLaunches;
      signals.push({
        name: 'serial-launch-hub',
        hit: isSerialHub,
        weight: 30,
        detail: isSerialHub
          ? `Hub ${shortAddr(hub)} a financé ${launchSiblings.length} wallets en ${lo}-${hi} SOL (sérial launcher)`
          : `Hub ${shortAddr(hub)} : ${launchSiblings.length} financement(s) de launch détecté(s)`,
      });
    }

    const score = Math.min(
      100,
      signals.reduce((acc, s) => acc + (s.hit ? s.weight : 0), 0),
    );
    const suspicious = score >= this.cfg.minSuspicionScore;

    logger.info(
      SCOPE,
      `Dev ${shortAddr(wallet)}: score ${score}/100 ${suspicious ? '⚠️ SUSPECT' : 'ok'}`,
      { signals: signals.filter((s) => s.hit).map((s) => s.name), siblings: siblings.length },
    );

    return {
      wallet,
      rootFunder: chain.rootFunder,
      chain,
      score,
      suspicious,
      signals,
      siblings,
      hub,
      launchSiblings,
    };
  }

  /**
   * Trouve les wallets financés par `hub` avec un montant dans la fourchette
   * de launch [lo, hi] SOL. Chacun est un candidat "wallet qui va créer un token".
   * C'est le cœur de la détection du hub sérial (Wallet C de la cascade).
   */
  private async findLaunchFunded(
    hub: string,
    lo: number,
    hi: number,
  ): Promise<{ wallet: string; amountSol: number }[]> {
    const found = new Map<string, number>();
    try {
      const sigs = await this.rpc.execute(
        (conn) => conn.getSignaturesForAddress(new PublicKey(hub), { limit: 80 }),
        SCOPE,
      );
      for (const s of sigs) {
        const tx = await this.rpc.execute(
          (conn) =>
            conn.getTransaction(s.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            }),
          SCOPE,
        );
        if (!tx || !tx.meta) continue;
        for (const [addr, amt] of debitedTransfers(tx, hub)) {
          if (amt >= lo && amt <= hi && !found.has(addr)) found.set(addr, amt);
        }
        if (found.size >= 15) break;
      }
    } catch {
      /* ignore */
    }
    return [...found.entries()].map(([wallet, amountSol]) => ({ wallet, amountSol }));
  }

  private async txCount(wallet: string): Promise<number> {
    try {
      const sigs = await this.rpc.execute(
        (conn) =>
          conn.getSignaturesForAddress(new PublicKey(wallet), { limit: 100 }),
        SCOPE,
      );
      return sigs.length;
    } catch {
      return 999;
    }
  }

  /**
   * Trouve les autres wallets financés par le même wallet mère.
   * On inspecte les transactions sortantes du financeur et on liste les
   * bénéficiaires (hors le wallet d'origine).
   */
  private async findSiblings(funder: string, exclude: string): Promise<string[]> {
    const siblings = new Set<string>();
    try {
      const sigs = await this.rpc.execute(
        (conn) =>
          conn.getSignaturesForAddress(new PublicKey(funder), { limit: 50 }),
        SCOPE,
      );
      for (const s of sigs) {
        const tx = await this.rpc.execute(
          (conn) =>
            conn.getTransaction(s.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            }),
          SCOPE,
        );
        if (!tx || !tx.meta) continue;
        for (const b of beneficiaries(tx, funder)) {
          if (b !== exclude && b !== funder) siblings.add(b);
        }
        if (siblings.size >= 10) break;
      }
    } catch {
      /* ignore */
    }
    return [...siblings];
  }
}

const LAMPORTS = 1_000_000_000;

/** Bénéficiaires + montant (SOL) reçu, quand `funder` débite dans la tx. */
function debitedTransfers(tx: any, funder: string): [string, number][] {
  const out: [string, number][] = [];
  try {
    const keys: string[] = (
      tx.transaction.message.staticAccountKeys ??
      tx.transaction.message.accountKeys ??
      []
    ).map((k: any) => (typeof k === 'string' ? k : k.toBase58?.() ?? String(k)));
    const pre: number[] = tx.meta.preBalances;
    const post: number[] = tx.meta.postBalances;
    const fIdx = keys.indexOf(funder);
    if (fIdx < 0 || post[fIdx] - pre[fIdx] >= 0) return out; // le funder doit débiter
    for (let i = 0; i < keys.length; i++) {
      if (i === fIdx) continue;
      const delta = (post[i] - pre[i]) / LAMPORTS;
      if (delta > 0) out.push([keys[i], delta]);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** Comptes qui ont REÇU du SOL du `funder` dans une transaction. */
function beneficiaries(tx: any, funder: string): string[] {
  const out: string[] = [];
  try {
    const keys: string[] = (
      tx.transaction.message.staticAccountKeys ??
      tx.transaction.message.accountKeys ??
      []
    ).map((k: any) => (typeof k === 'string' ? k : k.toBase58?.() ?? String(k)));
    const pre: number[] = tx.meta.preBalances;
    const post: number[] = tx.meta.postBalances;
    const fIdx = keys.indexOf(funder);
    if (fIdx < 0 || post[fIdx] - pre[fIdx] >= 0) return out; // le funder doit débiter

    for (let i = 0; i < keys.length; i++) {
      if (i === fIdx) continue;
      if (post[i] - pre[i] > 0) out.push(keys[i]);
    }
  } catch {
    /* ignore */
  }
  return out;
}
