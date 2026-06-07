/**
 * Store persistant pour l'état modifiable à chaud (via Telegram) :
 *  - liste des wallets suivis (avec leurs paramètres)
 *  - overrides runtime (dryRun, montant d'achat, etc.)
 *
 * Persisté dans data/store.json. Permet d'ajouter/retirer des wallets et de
 * changer la config sans redémarrer le bot.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';

const STORE_FILE = 'data/store.json';
const SCOPE = 'store';

export interface TrackedWallet {
  address: string;
  label?: string;
  /** Suivre les achats de ce wallet pour copy-trade / snipe. */
  copyTrade: boolean;
  addedAt: number;
}

export interface RuntimeState {
  /** Override du dryRun de config.json (null = utilise config). */
  dryRunOverride: boolean | null;
  /** Override du montant d'achat (SOL). 0/null = config. */
  buyAmountOverride: number | null;
  /** Bot en pause (ne snipe pas, mais continue de détecter/alerter). */
  paused: boolean;
  trackedWallets: TrackedWallet[];
}

const DEFAULT: RuntimeState = {
  dryRunOverride: null,
  buyAmountOverride: null,
  paused: false,
  trackedWallets: [],
};

export class Store {
  private state: RuntimeState = { ...DEFAULT };

  constructor() {
    this.load();
  }

  /** Initialise les wallets suivis depuis config.json si le store est vide. */
  seedTrackedWallets(addresses: string[]): void {
    if (this.state.trackedWallets.length > 0) return;
    for (const a of addresses) {
      if (!a || a.startsWith('Example')) continue;
      this.addWallet(a);
    }
  }

  getState(): RuntimeState {
    return this.state;
  }

  // --- Wallets ---
  listWallets(): TrackedWallet[] {
    return this.state.trackedWallets;
  }

  hasWallet(address: string): boolean {
    return this.state.trackedWallets.some((w) => w.address === address);
  }

  addWallet(address: string, label?: string, copyTrade = true): boolean {
    if (this.hasWallet(address)) return false;
    this.state.trackedWallets.push({
      address,
      label,
      copyTrade,
      addedAt: Date.now(),
    });
    this.persist();
    logger.info(SCOPE, `Wallet ajouté: ${address}`, { label });
    return true;
  }

  removeWallet(address: string): boolean {
    const before = this.state.trackedWallets.length;
    this.state.trackedWallets = this.state.trackedWallets.filter(
      (w) => w.address !== address,
    );
    const removed = this.state.trackedWallets.length < before;
    if (removed) {
      this.persist();
      logger.info(SCOPE, `Wallet retiré: ${address}`);
    }
    return removed;
  }

  walletAddresses(): string[] {
    return this.state.trackedWallets.map((w) => w.address);
  }

  // --- Runtime ---
  setPaused(v: boolean): void {
    this.state.paused = v;
    this.persist();
  }
  setDryRun(v: boolean | null): void {
    this.state.dryRunOverride = v;
    this.persist();
  }
  setBuyAmount(v: number | null): void {
    this.state.buyAmountOverride = v;
    this.persist();
  }

  // --- Persistance ---
  private persist(): void {
    try {
      mkdirSync(dirname(STORE_FILE), { recursive: true });
      writeFileSync(STORE_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      logger.debug(SCOPE, 'Persistance store échouée', {
        error: (err as Error)?.message,
      });
    }
  }

  private load(): void {
    try {
      if (existsSync(STORE_FILE)) {
        this.state = { ...DEFAULT, ...JSON.parse(readFileSync(STORE_FILE, 'utf-8')) };
      }
    } catch {
      this.state = { ...DEFAULT };
    }
  }
}
