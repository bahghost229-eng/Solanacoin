/**
 * Chargement et validation de la configuration.
 * - Les paramètres NON sensibles viennent de config.json (config.example.json par défaut).
 * - Les SECRETS viennent uniquement de .env.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import type { BotConfig, Secrets } from './types.js';

dotenv.config();

const ROOT = process.cwd();

/** Lit un fichier JSON en supprimant les clés de commentaire (préfixées par "//"). */
function readJsonStripComments<T>(path: string): T {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  return stripCommentKeys(parsed) as T;
}

function stripCommentKeys(obj: any): any {
  if (Array.isArray(obj)) return obj.map(stripCommentKeys);
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === '//' || k.startsWith('//')) continue;
      out[k] = stripCommentKeys(v);
    }
    return out;
  }
  return obj;
}

export function loadConfig(): BotConfig {
  const customPath = resolve(ROOT, 'config.json');
  const examplePath = resolve(ROOT, 'config.example.json');
  const path = existsSync(customPath) ? customPath : examplePath;

  if (!existsSync(customPath)) {
    console.warn(
      '[config] config.json introuvable — utilisation de config.example.json. ' +
        'Copiez-le en config.json pour personnaliser.',
    );
  }

  const config = readJsonStripComments<BotConfig>(path);
  validateConfig(config);
  return config;
}

export function loadSecrets(): Secrets {
  const adminIds = (process.env.TELEGRAM_ADMIN_CHAT_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n !== 0);

  const secrets: Secrets = {
    heliusApiKey: process.env.HELIUS_API_KEY ?? '',
    fluxRpcUrl: process.env.FLUXRPC_URL ?? '',
    jitoBlockEngineUrl:
      process.env.JITO_BLOCK_ENGINE_URL ?? 'https://mainnet.block-engine.jito.wtf',
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY ?? '',
    webhookPort: Number(process.env.WEBHOOK_PORT ?? 4000),
    webhookAuthHeader: process.env.WEBHOOK_AUTH_HEADER ?? '',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    telegramAdminChatIds: adminIds,
    openRouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
    openRouterModel:
      process.env.OPENROUTER_MODEL ?? 'z-ai/glm-4.5-air:free',
  };
  return secrets;
}

/** Validation basique mais stricte pour éviter des configs dangereuses. */
function validateConfig(c: BotConfig): void {
  const errs: string[] = [];

  if (typeof c.dryRun !== 'boolean') errs.push('dryRun doit être un booléen');
  if (c.execution.buyAmountSol <= 0) errs.push('execution.buyAmountSol doit être > 0');
  if (c.execution.slippageBps < 0 || c.execution.slippageBps > 10000)
    errs.push('execution.slippageBps doit être entre 0 et 10000');
  if (c.execution.maxConcurrentPositions < 1)
    errs.push('execution.maxConcurrentPositions doit être >= 1');
  if (c.positions.stopLossPercent <= 0 || c.positions.stopLossPercent >= 100)
    errs.push('positions.stopLossPercent doit être entre 1 et 99');

  for (const tp of c.positions.takeProfit) {
    if (tp.gainPercent <= 0) errs.push('takeProfit.gainPercent doit être > 0');
    if (tp.sellPercent <= 0 || tp.sellPercent > 100)
      errs.push('takeProfit.sellPercent doit être entre 1 et 100');
  }

  if (errs.length > 0) {
    throw new Error('Configuration invalide:\n - ' + errs.join('\n - '));
  }
}

/**
 * Garde-fou de sécurité au démarrage.
 * Si dryRun=false (mode LIVE), on exige une confirmation explicite via variable d'env
 * pour éviter d'envoyer de vraies transactions par accident.
 */
export function assertLiveSafety(config: BotConfig, secrets: Secrets): void {
  if (config.dryRun) return;

  if (!secrets.walletPrivateKey) {
    throw new Error(
      'Mode LIVE activé (dryRun=false) mais WALLET_PRIVATE_KEY est vide. Abandon.',
    );
  }
  if (process.env.I_UNDERSTAND_THE_RISKS !== 'yes') {
    throw new Error(
      'Mode LIVE activé. Pour confirmer que vous comprenez les risques de perte ' +
        'financière, lancez avec I_UNDERSTAND_THE_RISKS=yes',
    );
  }
}
