/**
 * Exécution des achats / ventes.
 *
 * Deux modes :
 *  - dryRun = true  : SIMULATION. On récupère un vrai quote Jupiter pour estimer
 *                     le prix/montant, mais AUCUNE transaction n'est signée ni envoyée.
 *  - dryRun = false : LIVE. On construit la tx via Jupiter, on la signe avec le
 *                     wallet, puis on l'envoie via Jito (bundle + tip) ou via RPC
 *                     avec priority fee en fallback.
 *
 * ⚠️ Le mode LIVE engage de l'argent réel. Garde-fous dans config/assertLiveSafety.
 */
import {
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import type { RpcManager } from '../utils/rpc.js';
import type { BotConfig, Secrets } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { WSOL_MINT } from '../detection/constants.js';
import { getJupiterQuote, getJupiterSwapTx, type JupiterQuote } from './jupiter.js';
import { sendBundle } from './jito.js';

const SCOPE = 'exec';

export interface BuyResult {
  ok: boolean;
  dryRun: boolean;
  mint: string;
  /** SOL dépensé. */
  spentSol: number;
  /** Quantité de tokens reçus (raw, plus petite unité). */
  tokensReceivedRaw: number;
  /** Prix d'entrée approx en SOL par token (unité raw). */
  entryPriceSolPerToken: number;
  signature?: string;
  bundleId?: string;
  error?: string;
}

export interface SellResult {
  ok: boolean;
  dryRun: boolean;
  mint: string;
  tokensSoldRaw: number;
  receivedSol: number;
  signature?: string;
  bundleId?: string;
  error?: string;
}

export class Executor {
  constructor(
    private rpc: RpcManager,
    private config: BotConfig,
    private secrets: Secrets,
    private wallet: Keypair | null,
  ) {}

  private get dryRun(): boolean {
    return this.config.dryRun;
  }

  /** Montant d'achat (SOL) pour un mint, avec override par token. */
  private buyAmountFor(mint: string): number {
    const override = this.config.execution.perTokenBuyAmountSol?.[mint];
    return override ?? this.config.execution.buyAmountSol;
  }

  async buy(mint: string, amountOverride?: number): Promise<BuyResult> {
    const sol = amountOverride && amountOverride > 0 ? amountOverride : this.buyAmountFor(mint);
    const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
    const ex = this.config.execution;

    logger.info(SCOPE, `${this.dryRun ? '[DRY-RUN] ' : ''}Achat ${sol} SOL -> ${mint}`);

    // 1. Quote d'achat : WSOL -> token
    const quote = await getJupiterQuote({
      inputMint: WSOL_MINT.toBase58(),
      outputMint: mint,
      amount: lamports,
      slippageBps: ex.slippageBps,
    });

    if (!quote) {
      return this.failBuy(mint, sol, 'Aucune route Jupiter (token pas encore liquide ?)');
    }

    const tokensReceivedRaw = Number(quote.outAmount);
    const entryPrice = tokensReceivedRaw > 0 ? lamports / tokensReceivedRaw : 0;

    if (this.dryRun) {
      logger.info(SCOPE, `[DRY-RUN] Achat simulé OK`, {
        tokensReceivedRaw,
        priceImpactPct: quote.priceImpactPct,
      });
      return {
        ok: true,
        dryRun: true,
        mint,
        spentSol: sol,
        tokensReceivedRaw,
        entryPriceSolPerToken: entryPrice / LAMPORTS_PER_SOL,
      };
    }

    // --- MODE LIVE ---
    return this.executeLiveSwap(quote, mint, sol, tokensReceivedRaw, entryPrice, 'buy');
  }

  async sell(
    mint: string,
    tokenAmountRaw: number,
    entryPriceSolPerToken: number,
  ): Promise<SellResult> {
    const ex = this.config.execution;
    logger.info(
      SCOPE,
      `${this.dryRun ? '[DRY-RUN] ' : ''}Vente ${tokenAmountRaw} (raw) de ${mint}`,
    );

    const quote = await getJupiterQuote({
      inputMint: mint,
      outputMint: WSOL_MINT.toBase58(),
      amount: tokenAmountRaw,
      slippageBps: ex.slippageBps,
    });

    if (!quote) {
      return {
        ok: false,
        dryRun: this.dryRun,
        mint,
        tokensSoldRaw: 0,
        receivedSol: 0,
        error: 'Aucune route de vente',
      };
    }

    const receivedSol = Number(quote.outAmount) / LAMPORTS_PER_SOL;

    if (this.dryRun) {
      logger.info(SCOPE, `[DRY-RUN] Vente simulée OK`, { receivedSol });
      return {
        ok: true,
        dryRun: true,
        mint,
        tokensSoldRaw: tokenAmountRaw,
        receivedSol,
      };
    }

    // --- MODE LIVE ---
    const r = await this.executeLiveSwap(
      quote,
      mint,
      0,
      0,
      0,
      'sell',
    );
    return {
      ok: r.ok,
      dryRun: false,
      mint,
      tokensSoldRaw: r.ok ? tokenAmountRaw : 0,
      receivedSol: r.ok ? receivedSol : 0,
      signature: r.signature,
      bundleId: r.bundleId,
      error: r.error,
    };
  }

  /**
   * Construit, signe et envoie une vraie transaction de swap (mode LIVE).
   * Envoi prioritaire via Jito si activé, sinon RPC standard avec priority fee.
   */
  private async executeLiveSwap(
    quote: JupiterQuote,
    mint: string,
    spentSol: number,
    tokensReceivedRaw: number,
    entryPrice: number,
    kind: 'buy' | 'sell',
  ): Promise<BuyResult> {
    if (!this.wallet) {
      return this.failBuy(mint, spentSol, 'Wallet non chargé (clé privée manquante)');
    }
    const ex = this.config.execution;

    try {
      // 1. Jupiter construit la transaction sérialisée
      const swapB64 = await getJupiterSwapTx({
        quote,
        userPublicKey: this.wallet.publicKey.toBase58(),
        priorityFeeMicroLamports: ex.priorityFeeMicroLamports,
        computeUnitLimit: ex.computeUnitLimit,
        jitoTipLamports: ex.useJitoBundles ? ex.jitoTipLamports : undefined,
      });

      // 2. Désérialisation + signature
      const tx = VersionedTransaction.deserialize(Buffer.from(swapB64, 'base64'));
      tx.sign([this.wallet]);

      let signature: string | undefined;
      let bundleId: string | undefined;

      // 3a. Envoi via bundle Jito (prioritaire)
      if (ex.useJitoBundles) {
        const signedB64 = Buffer.from(tx.serialize()).toString('base64');
        bundleId = await sendBundle(this.secrets.jitoBlockEngineUrl, [signedB64]);
      } else {
        // 3b. Envoi RPC standard (priority fee déjà dans la tx via Jupiter)
        signature = await this.rpc.execute(
          (conn) =>
            conn.sendRawTransaction(tx.serialize(), {
              skipPreflight: true,
              maxRetries: ex.maxRetries,
            }),
          SCOPE,
        );
      }

      logger.info(SCOPE, `${kind.toUpperCase()} LIVE envoyé`, { signature, bundleId });
      return {
        ok: true,
        dryRun: false,
        mint,
        spentSol,
        tokensReceivedRaw,
        entryPriceSolPerToken: entryPrice / LAMPORTS_PER_SOL,
        signature,
        bundleId,
      };
    } catch (err) {
      return this.failBuy(mint, spentSol, (err as Error)?.message ?? 'erreur inconnue');
    }
  }

  private failBuy(mint: string, sol: number, error: string): BuyResult {
    logger.error(SCOPE, `Achat échoué pour ${mint}: ${error}`);
    return {
      ok: false,
      dryRun: this.dryRun,
      mint,
      spentSol: sol,
      tokensReceivedRaw: 0,
      entryPriceSolPerToken: 0,
      error,
    };
  }
}
