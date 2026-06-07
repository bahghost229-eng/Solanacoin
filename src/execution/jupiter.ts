/**
 * Client minimal de l'API Jupiter (lite-api.jup.ag / quote-api).
 * - getJupiterQuote : récupère le meilleur quote de swap
 * - getJupiterSwapTx : construit la transaction de swap (base64) à signer
 *
 * On reste sur l'API HTTP publique (pas besoin de SDK lourd).
 */
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const SCOPE = 'jupiter';
const QUOTE_BASE = 'https://quote-api.jup.ag/v6';

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  amount: number; // en plus petite unité du inputMint
  slippageBps: number;
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
  [k: string]: unknown;
}

export async function getJupiterQuote(p: QuoteParams): Promise<JupiterQuote | null> {
  const url =
    `${QUOTE_BASE}/quote?inputMint=${p.inputMint}` +
    `&outputMint=${p.outputMint}` +
    `&amount=${p.amount}` +
    `&slippageBps=${p.slippageBps}` +
    `&onlyDirectRoutes=false`;

  return withRetry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 400) return null; // pas de route
        throw new Error(`Jupiter quote HTTP ${res.status}`);
      }
      const data = (await res.json()) as JupiterQuote;
      if (!data || !data.outAmount) return null;
      return data;
    },
    { retries: 2, scope: SCOPE },
  );
}

export interface SwapTxParams {
  quote: JupiterQuote;
  userPublicKey: string;
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  /** Pourboire Jito ajouté côté Jupiter si supporté. */
  jitoTipLamports?: number;
}

/**
 * Demande à Jupiter de construire la transaction de swap sérialisée (base64).
 * Cette transaction devra ensuite être signée par le wallet puis envoyée
 * (directement ou dans un bundle Jito).
 */
export async function getJupiterSwapTx(p: SwapTxParams): Promise<string> {
  const body: Record<string, unknown> = {
    quoteResponse: p.quote,
    userPublicKey: p.userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        priorityLevel: 'high',
        maxLamports: Math.max(p.priorityFeeMicroLamports, 100_000),
      },
    },
  };

  const res = await fetch(`${QUOTE_BASE}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Jupiter swap HTTP ${res.status}: ${txt}`);
  }
  const data = (await res.json()) as { swapTransaction: string };
  if (!data.swapTransaction) throw new Error('Jupiter: swapTransaction manquante');
  logger.debug(SCOPE, 'Transaction de swap construite');
  return data.swapTransaction;
}
