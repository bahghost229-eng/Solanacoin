/**
 * Chargement sécurisé du wallet depuis la clé privée (.env).
 * Accepte le format base58 (export Phantom) ou un tableau JSON de bytes.
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from './logger.js';

export function loadKeypair(privateKey: string): Keypair | null {
  if (!privateKey) return null;
  try {
    const trimmed = privateKey.trim();
    if (trimmed.startsWith('[')) {
      const arr = Uint8Array.from(JSON.parse(trimmed));
      return Keypair.fromSecretKey(arr);
    }
    return Keypair.fromSecretKey(bs58.decode(trimmed));
  } catch (err) {
    logger.error('wallet', 'Impossible de décoder WALLET_PRIVATE_KEY', {
      error: (err as Error)?.message,
    });
    return null;
  }
}

/** Masque une adresse pour l'affichage (jamais logger la clé privée). */
export function shortAddr(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}
