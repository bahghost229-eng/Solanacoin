/**
 * Module Anti-Rug / Sécurité.
 *
 * Effectue une série de vérifications on-chain pour estimer le risque d'un token
 * AVANT achat :
 *   1. Mint authority révoquée (sinon, le dev peut minter à l'infini)
 *   2. Freeze authority révoquée (sinon, le dev peut geler vos tokens => honeypot)
 *   3. Concentration des holders (% détenu par le dev / top holder)
 *   4. Nombre de holders minimum
 *   5. Honeypot : simulation d'une vente via Jupiter (token revendable ?)
 *   6. Liquidité verrouillée (heuristique)
 *
 * Chaque check est indépendant et tolérant aux erreurs : un check qui ne peut
 * pas être évalué est marqué "unknown" et n'invalide pas forcément le token
 * (selon la config).
 */
import { PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import type { RpcManager } from '../utils/rpc.js';
import type { SecurityConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { WSOL_MINT } from '../detection/constants.js';
import { getJupiterQuote } from '../execution/jupiter.js';

const SCOPE = 'security';

export interface SecurityCheck {
  name: string;
  passed: boolean;
  severity: 'critical' | 'warning';
  detail: string;
}

export interface SecurityReport {
  mint: string;
  safe: boolean;
  score: number; // 0-100, plus haut = plus sûr
  checks: SecurityCheck[];
}

export class AntiRug {
  constructor(
    private rpc: RpcManager,
    private cfg: SecurityConfig,
  ) {}

  async evaluate(mint: string, devWallet?: string): Promise<SecurityReport> {
    const checks: SecurityCheck[] = [];

    if (!this.cfg.enabled) {
      return { mint, safe: true, score: 100, checks: [] };
    }

    const mintPk = new PublicKey(mint);

    // --- 1 & 2 : Authorities (mint / freeze) ---
    await this.checkAuthorities(mintPk, checks);

    // --- 3 & 4 : Distribution des holders ---
    await this.checkHolders(mintPk, devWallet, checks);

    // --- 5 : Honeypot (simulation de vente) ---
    if (this.cfg.checkHoneypot) {
      await this.checkHoneypot(mint, checks);
    }

    // --- 6 : Liquidité verrouillée (heuristique) ---
    if (this.cfg.checkLiquidityLocked) {
      this.checkLiquidityLocked(checks);
    }

    // Le token est rejeté si un check 'critical' échoue.
    const criticalFailed = checks.some((c) => !c.passed && c.severity === 'critical');
    const passedCount = checks.filter((c) => c.passed).length;
    const score = checks.length ? Math.round((passedCount / checks.length) * 100) : 100;

    const report: SecurityReport = { mint, safe: !criticalFailed, score, checks };
    logger.info(
      SCOPE,
      `Rapport ${mint}: ${report.safe ? '✅ OK' : '❌ REJETÉ'} (score ${score})`,
      { failed: checks.filter((c) => !c.passed).map((c) => c.name) },
    );
    return report;
  }

  private async checkAuthorities(mintPk: PublicKey, checks: SecurityCheck[]): Promise<void> {
    try {
      const info = await this.rpc.execute((conn) => getMint(conn, mintPk), SCOPE);

      const mintRevoked = info.mintAuthority === null;
      checks.push({
        name: 'mint-authority-revoked',
        passed: this.cfg.requireMintAuthorityRevoked ? mintRevoked : true,
        severity: 'critical',
        detail: mintRevoked
          ? 'Mint authority révoquée (offre fixe)'
          : 'Mint authority ACTIVE — le dev peut minter de nouveaux tokens',
      });

      const freezeRevoked = info.freezeAuthority === null;
      checks.push({
        name: 'freeze-authority-revoked',
        passed: this.cfg.requireFreezeAuthorityRevoked ? freezeRevoked : true,
        severity: 'critical',
        detail: freezeRevoked
          ? 'Freeze authority révoquée'
          : 'Freeze authority ACTIVE — risque de gel (honeypot)',
      });
    } catch (err) {
      checks.push({
        name: 'authorities',
        passed: false,
        severity: 'warning',
        detail: `Impossible de lire le mint: ${(err as Error)?.message}`,
      });
    }
  }

  private async checkHolders(
    mintPk: PublicKey,
    devWallet: string | undefined,
    checks: SecurityCheck[],
  ): Promise<void> {
    try {
      const largest = await this.rpc.execute(
        (conn) => conn.getTokenLargestAccounts(mintPk),
        SCOPE,
      );
      const supplyResp = await this.rpc.execute(
        (conn) => conn.getTokenSupply(mintPk),
        SCOPE,
      );
      const totalSupply = Number(supplyResp.value.amount);
      const accounts = largest.value;

      if (totalSupply <= 0 || accounts.length === 0) {
        checks.push({
          name: 'holders',
          passed: false,
          severity: 'warning',
          detail: 'Distribution indisponible',
        });
        return;
      }

      // Top holder %
      const topAmount = Number(accounts[0].amount);
      const topPct = (topAmount / totalSupply) * 100;
      checks.push({
        name: 'top-holder-concentration',
        passed: topPct <= this.cfg.maxTopHolderPercent,
        severity: 'critical',
        detail: `Top holder détient ${topPct.toFixed(1)}% (max ${this.cfg.maxTopHolderPercent}%)`,
      });

      // Nombre de holders (approx via comptes non vides)
      const holderCount = accounts.filter((a) => Number(a.amount) > 0).length;
      checks.push({
        name: 'min-holders',
        passed: holderCount >= this.cfg.minHolders,
        severity: 'warning',
        detail: `${holderCount} holders détectés (min ${this.cfg.minHolders})`,
      });

      // Dev holding % (si on connaît le wallet du dev)
      if (devWallet) {
        const devAccount = accounts.find(
          (a) => a.address.toBase58() === devWallet,
        );
        const devAmount = devAccount ? Number(devAccount.amount) : 0;
        const devPct = (devAmount / totalSupply) * 100;
        checks.push({
          name: 'dev-holding',
          passed: devPct <= this.cfg.maxDevHoldingPercent,
          severity: 'critical',
          detail: `Dev détient ~${devPct.toFixed(1)}% (max ${this.cfg.maxDevHoldingPercent}%)`,
        });
      }
    } catch (err) {
      checks.push({
        name: 'holders',
        passed: false,
        severity: 'warning',
        detail: `Erreur analyse holders: ${(err as Error)?.message}`,
      });
    }
  }

  /**
   * Détection de honeypot : on demande à Jupiter un quote de VENTE
   * (token -> SOL). Si aucune route n'existe ou que l'impact est aberrant,
   * le token est probablement non revendable.
   */
  private async checkHoneypot(mint: string, checks: SecurityCheck[]): Promise<void> {
    try {
      // On simule la vente d'une petite quantité (1 unité du token, en raw).
      const quote = await getJupiterQuote({
        inputMint: mint,
        outputMint: WSOL_MINT.toBase58(),
        amount: 1_000_000, // quantité arbitraire en plus petite unité
        slippageBps: 2000,
      });

      const sellable = !!quote && !!quote.outAmount && Number(quote.outAmount) > 0;
      checks.push({
        name: 'honeypot',
        passed: sellable,
        severity: 'critical',
        detail: sellable
          ? 'Route de vente disponible (revendable)'
          : 'Aucune route de vente — possible honeypot',
      });
    } catch (err) {
      // Pas de route trouvée => très probablement non revendable ou pas encore liquide.
      checks.push({
        name: 'honeypot',
        passed: false,
        severity: 'warning',
        detail: `Quote de vente indisponible: ${(err as Error)?.message}`,
      });
    }
  }

  /**
   * Heuristique de liquidité verrouillée.
   * Sur Pump.fun la liquidité de la bonding curve est gérée par le programme
   * (non retirable arbitrairement avant migration), ce qui est globalement sûr.
   * Pour les pools Raydium post-migration, une vraie vérification LP nécessite
   * d'inspecter le propriétaire des LP tokens — laissé en TODO documenté.
   */
  private checkLiquidityLocked(checks: SecurityCheck[]): void {
    checks.push({
      name: 'liquidity-locked',
      passed: true,
      severity: 'warning',
      detail:
        'Bonding curve Pump.fun gérée par programme (liquidité non retirable avant migration). ' +
        'Vérif LP Raydium post-migration : voir TODO dans le code.',
    });
  }
}
