/**
 * Filtrage des nouveaux tokens selon des critères configurables.
 * Premier niveau de tri AVANT les checks de sécurité (plus coûteux).
 */
import type { DetectionFilters } from '../config/types.js';
import type { NewTokenEvent } from './types.js';
import { logger } from '../utils/logger.js';

const SCOPE = 'filter';

export interface FilterResult {
  passed: boolean;
  reasons: string[];
}

export function applyDetectionFilters(
  event: NewTokenEvent,
  filters: DetectionFilters,
): FilterResult {
  const reasons: string[] = [];

  if (event.initialLiquiditySol !== undefined) {
    if (event.initialLiquiditySol < filters.minInitialLiquiditySol) {
      reasons.push(
        `Liquidité initiale ${event.initialLiquiditySol} SOL < min ${filters.minInitialLiquiditySol}`,
      );
    }
    if (event.initialLiquiditySol > filters.maxInitialLiquiditySol) {
      reasons.push(
        `Liquidité initiale ${event.initialLiquiditySol} SOL > max ${filters.maxInitialLiquiditySol}`,
      );
    }
  }

  if (filters.requireSocials) {
    const s = event.socials;
    const hasSocial = !!(s?.twitter || s?.telegram || s?.website);
    if (!hasSocial) reasons.push('Aucun lien social requis manquant');
  }

  const passed = reasons.length === 0;
  if (!passed) {
    logger.debug(SCOPE, `Token ${event.mint} filtré`, { reasons });
  }
  return { passed, reasons };
}
