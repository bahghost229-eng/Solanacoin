/**
 * Interface Telegram — pilotage complet du bot (Telegram-only, pas de dashboard web).
 *
 * Commandes :
 *   /start                  menu + clavier inline
 *   /status                 état du bot (mode, pause, wallets, positions)
 *   /wallets                liste des wallets suivis
 *   /add <addr> [label]     ajoute un wallet à suivre (copy-trade ON)
 *   /remove <addr>          retire un wallet
 *   /pause /resume          met en pause / reprend le sniping
 *   /dryrun on|off          bascule simulation / live
 *   /buyamount <sol>        montant d'achat par snipe (override)
 *   /positions              positions ouvertes
 *   /pnl                    PnL réalisé + latent
 *   /analyze <wallet>       analyse de pattern de dev (score de suspicion)
 *   /chain <wallet>         remonte la chaîne de financement
 *
 * Auth : si telegram.restrictToAdmins, seuls les chat IDs de
 * secrets.telegramAdminChatIds peuvent piloter le bot.
 */
import TelegramBot from 'node-telegram-bot-api';
import type { BotConfig, Secrets } from '../config/types.js';
import type { Store } from '../config/store.js';
import type { PositionManager } from '../positions/manager.js';
import type { WalletTracker } from '../detection/wallet-tracker.js';
import type { DevPatternAnalyzer } from '../chain/dev-pattern.js';
import type { ChainFollower } from '../chain/chain-follower.js';
import { Notifier } from './notifier.js';
import { logger } from '../utils/logger.js';
import { shortAddr } from '../utils/wallet.js';

const SCOPE = 'telegram';
const SOLSCAN = (a: string) => `https://solscan.io/account/${a}`;

export interface TelegramDeps {
  config: BotConfig;
  secrets: Secrets;
  store: Store;
  positions: PositionManager;
  walletTracker: WalletTracker | null;
  analyzer: DevPatternAnalyzer | null;
  chain: ChainFollower | null;
  /** Appelé quand la liste des wallets change (pour resync le tracker). */
  onWalletsChanged: () => void;
}

export class TelegramController {
  private bot: TelegramBot | null = null;
  private adminIds: Set<number>;

  constructor(private deps: TelegramDeps) {
    this.adminIds = new Set(deps.secrets.telegramAdminChatIds);
  }

  /** Fonction d'envoi pour le Notifier (broadcast vers tous les admins). */
  sendFn = (msg: string): void => {
    if (!this.bot) return;
    const targets = this.adminIds.size > 0 ? [...this.adminIds] : [];
    for (const id of targets) {
      this.bot.sendMessage(id, msg, { parse_mode: 'Markdown' }).catch(() => {});
    }
  };

  start(): void {
    const { config, secrets } = this.deps;
    if (!config.telegram.enabled) {
      logger.info(SCOPE, 'Telegram désactivé (config.telegram.enabled=false).');
      return;
    }
    if (!secrets.telegramBotToken) {
      logger.warn(SCOPE, 'TELEGRAM_BOT_TOKEN manquant — interface Telegram non démarrée.');
      return;
    }

    this.bot = new TelegramBot(secrets.telegramBotToken, { polling: true });
    this.registerCommands();
    this.bot.on('polling_error', (err) =>
      logger.debug(SCOPE, 'polling_error', { error: err.message }),
    );
    logger.info(SCOPE, '🤖 Interface Telegram démarrée (polling).');
    if (this.adminIds.size === 0) {
      logger.warn(
        SCOPE,
        'Aucun TELEGRAM_ADMIN_CHAT_IDS défini. Envoyez /start au bot puis ajoutez votre chat ID.',
      );
    }
  }

  stop(): void {
    this.bot?.stopPolling().catch(() => {});
    this.bot = null;
  }

  private authorized(chatId: number): boolean {
    if (!this.deps.config.telegram.restrictToAdmins) return true;
    if (this.adminIds.size === 0) return true; // bootstrap : pas encore d'admin
    return this.adminIds.has(chatId);
  }

  private reply(chatId: number, msg: string, keyboard?: TelegramBot.InlineKeyboardMarkup): void {
    this.bot?.sendMessage(chatId, msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    }).catch((e) => logger.debug(SCOPE, 'sendMessage échec', { error: e?.message }));
  }

  /** Clavier principal — boutons d'action rapide. */
  private mainKeyboard(): TelegramBot.InlineKeyboardMarkup {
    const st = this.deps.store.getState();
    const dryRun = st.dryRunOverride ?? this.deps.config.dryRun;
    const paused = st.paused;
    return {
      inline_keyboard: [
        [
          { text: '📟 Statut', callback_data: 'status' },
          { text: '👛 Wallets', callback_data: 'wallets' },
        ],
        [
          { text: '📈 Positions', callback_data: 'positions' },
          { text: '📊 PnL', callback_data: 'pnl' },
        ],
        [
          { text: paused ? '▶️ Reprendre' : '⏸️ Pause', callback_data: paused ? 'resume' : 'pause' },
          { text: dryRun ? '🔴 Passer LIVE' : '🧪 Passer DRY-RUN', callback_data: dryRun ? 'dryrun_off' : 'dryrun_on' },
        ],
        [
          { text: '➕ Aide /add', callback_data: 'help_add' },
          { text: '🔄 Rafraîchir', callback_data: 'status' },
        ],
      ],
    };
  }

  private statusText(): string {
    const { store, positions } = this.deps;
    const st = store.getState();
    const dryRun = st.dryRunOverride ?? this.deps.config.dryRun;
    const amount = st.buyAmountOverride ?? this.deps.config.execution.buyAmountSol;
    return [
      '📟 *Statut*',
      `Mode : ${dryRun ? '🧪 DRY-RUN' : '🔴 LIVE'}`,
      `Sniping : ${st.paused ? '⏸️ EN PAUSE' : '▶️ ACTIF'}`,
      `Wallets suivis : ${store.listWallets().length}`,
      `Montant/achat : ${amount} SOL`,
      `Positions ouvertes : ${positions.openCount}`,
    ].join('\n');
  }

  private walletsText(): string {
    const ws = this.deps.store.listWallets();
    if (!ws.length) return 'Aucun wallet suivi. Ajoute-en avec /add <addr> [label].';
    const lines = ws.map(
      (w, i) =>
        `${i + 1}. \`${shortAddr(w.address)}\`${w.label ? ` — ${w.label}` : ''}${w.copyTrade ? ' 🔁' : ''}\n   ${SOLSCAN(w.address)}`,
    );
    return `👛 *Wallets suivis (${ws.length})*\n\n${lines.join('\n')}`;
  }

  private positionsText(): string {
    const open = this.deps.positions.getPositions().filter((p) => p.status === 'open');
    if (!open.length) return 'Aucune position ouverte.';
    const lines = open.map((p) => {
      const gain = p.entryPrice > 0 ? ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
      return `• \`${shortAddr(p.mint)}\`${p.symbol ? ` (${p.symbol})` : ''} — ${p.investedSol.toFixed(3)} SOL — ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}%`;
    });
    return `📈 *Positions ouvertes (${open.length})*\n${lines.join('\n')}`;
  }

  private registerCommands(): void {
    const bot = this.bot!;
    const { store, positions } = this.deps;

    const guard = (chatId: number): boolean => {
      if (this.authorized(chatId)) return true;
      this.reply(chatId, '⛔ Non autorisé. Ton chat ID n\'est pas dans la liste admin.');
      return false;
    };

    bot.onText(/^\/start\b/, (m) => {
      const chatId = m.chat.id;
      this.reply(
        chatId,
        [
          '⚡ *Solana Chain Sniper*',
          '',
          `Ton chat ID : \`${chatId}\``,
          '(ajoute-le à `TELEGRAM_ADMIN_CHAT_IDS` pour piloter le bot)',
          '',
          'Utilise les *boutons* ci-dessous, ou tape une commande :',
          '/add <addr> [label] — suivre un wallet',
          '/remove <addr> — retirer',
          '/buyamount <sol> — montant par achat',
          '/analyze <wallet> — pattern de dev',
          '/chain <wallet> — chaîne de financement',
        ].join('\n'),
        this.mainKeyboard(),
      );
    });

    bot.onText(/^\/menu\b/, (m) => {
      const chatId = m.chat.id;
      if (!guard(chatId)) return;
      this.reply(chatId, '⚡ *Menu* — choisis une action :', this.mainKeyboard());
    });

    bot.onText(/^\/status\b/, (m) => {
      const chatId = m.chat.id;
      if (!guard(chatId)) return;
      this.reply(chatId, this.statusText(), this.mainKeyboard());
    });

    bot.onText(/^\/wallets\b/, (m) => {
      const chatId = m.chat.id;
      if (!guard(chatId)) return;
      this.reply(chatId, this.walletsText(), this.mainKeyboard());
    });

    bot.onText(/^\/add\s+(\S+)(?:\s+(.+))?$/, (m, match) => {
      const chatId = m.chat.id;
      if (!guard(chatId)) return;
      const addr = (match?.[1] ?? '').trim();
      const label = match?.[2]?.trim();
      if (!this.isValidAddr(addr)) {
        this.reply(chatId, '❌ Adresse invalide.');
        return;
      }
      const ok = store.addWallet(addr, label, true);
      if (ok) {
        this.deps.onWalletsChanged();
        this.reply(chatId, `✅ Wallet ajouté : \`${shortAddr(addr)}\`${label ? ` (${label})` : ''}`, this.mainKeyboard());
      } else {
        this.reply(chatId, 'ℹ️ Ce wallet est déjà suivi.');
      }
    });

    bot.onText(/^\/remove\s+(\S+)/, (m, match) => {
      const chatId = m.chat.id;
      if (!guard(chatId)) return;
      const addr = (match?.[1] ?? '').trim();
      const ok = store.removeWallet(addr);
      if (ok) {
        this.deps.onWalletsChanged();
        this.reply(chatId, `🗑️ Wallet retiré : \`${shortAddr(addr)}\``);
      } else {
        this.reply(chatId, 'ℹ️ Wallet introuvable dans la liste.');
      }
    });

    bot.onText(/^\/pause\b/, (m) => {
      const chatId = m.chat.id;
      if (!guard(chatId)) return;
      store.setPaused(true);
      this.reply(chatId, '⏸️ Sniping en pause. (détection/alertes continuent)');
    });

    bot.onText(/^\/resume\b/, (m) => {
      const chatId = m.chat.id;
      if (!guard(chatId)) return;
      store.setPaused(false);
      this.reply(chatId, '▶️ Sniping réactivé.');
    });

    bot.onText(/^\/dryrun\s+(on|off)\b/i, (m, match) => {
      const chatId = m.chat.id;
      if (!guard(chatId)) return;
      const on = (match?.[1] ?? '').toLowerCase() === 'on';
      store.setDryRun(on);
      // Applique à chaud : l'Executor lit config.dryRun par référence.
      this.deps.config.dryRun = on;
      if (!on && !this.deps.secrets.walletPrivateKey) {
        this.reply(chatId, '⚠️ WALLET_PRIVATE_KEY manquant — LIVE ne pourra pas signer de tx.');
      }
      this.reply(
        chatId,
        on
          ? '🧪 DRY-RUN activé (simulation, aucune tx réelle).'
          : '🔴 LIVE activé. ⚠️ Argent réel engagé. Assure-toi que WALLET_PRIVATE_KEY est défini.',
      );
    });

    bot.onText(/^\/buyamount\s+([\d.]+)/, (m, match) => {
      const chatId = m.chat.id;
      if (!guard(chatId)) return;
      const v = Number(match?.[1]);
      if (!Number.isFinite(v) || v <= 0) {
        this.reply(chatId, '❌ Montant invalide. Ex: /buyamount 0.1');
        return;
      }
      store.setBuyAmount(v);
      this.reply(chatId, `💰 Montant par achat réglé à ${v} SOL.`);
    });

    bot.onText(/^\/positions\b/, (m) => {
      const chatId = m.chat.id;
      if (!guard(chatId)) return;
      this.reply(chatId, this.positionsText(), this.mainKeyboard());
    });

    bot.onText(/^\/pnl\b/, (m) => {
      const chatId = m.chat.id;
      if (!guard(chatId)) return;
      this.reply(chatId, Notifier.formatPnl(positions.snapshot()), this.mainKeyboard());
    });

    bot.onText(/^\/analyze\s+(\S+)/, async (m, match) => {
      const chatId = m.chat.id;
      if (!guard(chatId)) return;
      const wallet = (match?.[1] ?? '').trim();
      if (!this.isValidAddr(wallet)) {
        this.reply(chatId, '❌ Adresse invalide.');
        return;
      }
      if (!this.deps.analyzer) {
        this.reply(chatId, 'ℹ️ Détection de pattern désactivée (devPattern.enabled=false).');
        return;
      }
      this.reply(chatId, `🔬 Analyse de \`${shortAddr(wallet)}\`…`);
      try {
        const r = await this.deps.analyzer.analyze(wallet);
        const sig = r.signals
          .map((s) => `${s.hit ? '✅' : '⬜'} ${s.name} (${s.weight}) — ${s.detail}`)
          .join('\n');
        this.reply(
          chatId,
          [
            `🔬 *Pattern dev* \`${shortAddr(wallet)}\``,
            `Score : *${r.score}/100* ${r.suspicious ? '⚠️ SUSPECT' : '✅ ok'}`,
            r.rootFunder ? `Financeur racine : \`${shortAddr(r.rootFunder)}\`` : 'Financeur racine : n/a',
            `Siblings (autres launches potentiels) : ${r.siblings.length}`,
            '',
            sig,
          ].join('\n'),
        );
      } catch (e) {
        this.reply(chatId, `❌ Erreur analyse : ${(e as Error)?.message}`);
      }
    });

    bot.onText(/^\/chain\s+(\S+)/, async (m, match) => {
      const chatId = m.chat.id;
      if (!guard(chatId)) return;
      const wallet = (match?.[1] ?? '').trim();
      if (!this.isValidAddr(wallet)) {
        this.reply(chatId, '❌ Adresse invalide.');
        return;
      }
      if (!this.deps.chain) {
        this.reply(chatId, 'ℹ️ Chain following désactivé (chainFollowing.enabled=false).');
        return;
      }
      this.reply(chatId, `🔗 Remontée de la chaîne de \`${shortAddr(wallet)}\`…`);
      try {
        const r = await this.deps.chain.follow(wallet);
        if (!r.hops.length) {
          this.reply(chatId, 'Aucun financeur trouvé (wallet sans transfert SOL entrant notable).');
          return;
        }
        const lines = r.hops.map(
          (h) =>
            `Hop ${h.hop}: \`${shortAddr(h.from)}\` → \`${shortAddr(h.to)}\` (${h.amountSol.toFixed(3)} SOL)`,
        );
        this.reply(
          chatId,
          [
            `🔗 *Chaîne* \`${shortAddr(wallet)}\` (${r.hops.length} hop(s))`,
            r.rootFunder ? `Racine : \`${shortAddr(r.rootFunder)}\`\n${SOLSCAN(r.rootFunder)}` : '',
            '',
            ...lines,
          ].filter(Boolean).join('\n'),
        );
      } catch (e) {
        this.reply(chatId, `❌ Erreur chaîne : ${(e as Error)?.message}`);
      }
    });

    // --- Boutons inline (callback_query) ---
    bot.on('callback_query', async (q) => {
      const chatId = q.message?.chat.id;
      const data = q.data ?? '';
      if (!chatId) return;
      // ack pour retirer le "chargement" sur le bouton
      bot.answerCallbackQuery(q.id).catch(() => {});

      if (!this.authorized(chatId)) {
        this.reply(chatId, '⛔ Non autorisé.');
        return;
      }

      switch (data) {
        case 'status':
          this.reply(chatId, this.statusText(), this.mainKeyboard());
          break;
        case 'wallets':
          this.reply(chatId, this.walletsText(), this.mainKeyboard());
          break;
        case 'positions':
          this.reply(chatId, this.positionsText(), this.mainKeyboard());
          break;
        case 'pnl':
          this.reply(chatId, Notifier.formatPnl(positions.snapshot()), this.mainKeyboard());
          break;
        case 'pause':
          store.setPaused(true);
          this.reply(chatId, '⏸️ Sniping en pause. (détection/alertes continuent)', this.mainKeyboard());
          break;
        case 'resume':
          store.setPaused(false);
          this.reply(chatId, '▶️ Sniping réactivé.', this.mainKeyboard());
          break;
        case 'dryrun_on':
          store.setDryRun(true);
          this.deps.config.dryRun = true;
          this.reply(chatId, '🧪 DRY-RUN activé (simulation, aucune tx réelle).', this.mainKeyboard());
          break;
        case 'dryrun_off':
          store.setDryRun(false);
          this.deps.config.dryRun = false;
          this.reply(
            chatId,
            this.deps.secrets.walletPrivateKey
              ? '🔴 LIVE activé. ⚠️ Argent réel engagé.'
              : '🔴 LIVE activé.\n⚠️ WALLET_PRIVATE_KEY manquant — LIVE ne pourra pas signer de tx.',
            this.mainKeyboard(),
          );
          break;
        case 'help_add':
          this.reply(
            chatId,
            [
              '➕ *Ajouter un wallet à suivre*',
              '',
              'Tape :',
              '`/add <adresse> [label]`',
              '',
              'Exemple :',
              '`/add 89oEJM4xL9Cqsmvd1o1imbyKTBa2BmPLbgbisTS9Hocy DevWallet`',
              '',
              'Le copy-trade est activé automatiquement sur ce wallet.',
              'Pour retirer : `/remove <adresse>`',
            ].join('\n'),
          );
          break;
        default:
          break;
      }
    });
  }

  private isValidAddr(addr: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
  }
}
