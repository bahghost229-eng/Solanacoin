/**
 * Constantes du programme Pump.fun et adresses utiles.
 */
import { PublicKey } from '@solana/web3.js';

/** Programme principal Pump.fun (bonding curve). */
export const PUMP_FUN_PROGRAM_ID = new PublicKey(
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
);

/** Mint wrapped SOL — utilisé comme entrée pour les swaps Jupiter. */
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * Discriminator (signature des logs) du programme Pump.fun pour la création d'un token.
 * Pump.fun émet un log "Program log: Instruction: Create" lors d'un nouveau mint.
 * On utilise cette signature textuelle car elle est stable et lisible dans les logs.
 */
export const PUMP_CREATE_LOG_MARKER = 'Instruction: Create';

/** Marqueur d'achat sur la bonding curve. */
export const PUMP_BUY_LOG_MARKER = 'Instruction: Buy';
