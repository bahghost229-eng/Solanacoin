/**
 * Envoi de bundles via le Block Engine Jito pour une exécution prioritaire.
 *
 * Un bundle est une liste de transactions signées (base64) exécutées
 * atomiquement et placées en tête de bloc, moyennant un "tip" versé à un
 * compte Jito. Ici on expose sendBundle() qui poste le bundle via JSON-RPC.
 *
 * ⚠️ En mode dry-run, l'executor n'appelle jamais cette fonction.
 */
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const SCOPE = 'jito';

/** Comptes de tip Jito (mainnet). On en choisit un au hasard pour répartir. */
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
];

export function pickTipAccount(): string {
  return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
}

/**
 * Envoie un bundle de transactions signées (base64) au Block Engine Jito.
 * @returns l'ID du bundle.
 */
export async function sendBundle(
  blockEngineUrl: string,
  signedTxsBase64: string[],
): Promise<string> {
  const url = `${blockEngineUrl}/api/v1/bundles`;
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendBundle',
    params: [signedTxsBase64],
  };

  return withRetry(
    async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Jito sendBundle HTTP ${res.status}`);
      const data = (await res.json()) as { result?: string; error?: unknown };
      if (data.error) throw new Error(`Jito error: ${JSON.stringify(data.error)}`);
      logger.info(SCOPE, `Bundle envoyé: ${data.result}`);
      return data.result as string;
    },
    { retries: 2, scope: SCOPE },
  );
}
