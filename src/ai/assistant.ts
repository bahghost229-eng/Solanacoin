/**
 * Assistant IA via OpenRouter — commande /ask.
 *
 * L'IA peut appeler des OUTILS pour analyser réellement la chaîne Solana :
 *   - analyze_wallet : score de pattern de dev (DevPatternAnalyzer)
 *   - follow_chain   : remonte la chaîne de financement (ChainFollower)
 *   - trace_cascade  : descend la cascade HUB → sous-hub → wallet de launch
 *   - bot_status     : état du bot, wallets suivis, positions, PnL
 *
 * Boucle agentique : l'IA propose un tool_call → on l'exécute → on renvoie le
 * résultat → l'IA répond en français. Max 4 tours d'outils.
 */
import type { Secrets } from '../config/types.js';
import type { DevPatternAnalyzer } from '../chain/dev-pattern.js';
import type { ChainFollower } from '../chain/chain-follower.js';
import type { CascadeTracer } from '../chain/cascade-tracer.js';
import type { Store } from '../config/store.js';
import type { PositionManager } from '../positions/manager.js';
import type { BotConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';

const SCOPE = 'ai';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_TOOL_TURNS = 4;

export interface AssistantDeps {
  secrets: Secrets;
  config: BotConfig;
  store: Store;
  positions: PositionManager;
  analyzer: DevPatternAnalyzer | null;
  chain: ChainFollower | null;
  cascade: CascadeTracer | null;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

const SYSTEM_PROMPT = `Tu es l'assistant IA de "Solana Chain Sniper", un bot de détection de devs memecoin sur Solana.
Tu réponds TOUJOURS en français, de façon concise et technique (style trader/dev crypto).
Tu peux analyser des wallets, remonter/descendre des chaînes de financement, et expliquer l'état du bot grâce à tes outils.
Quand on te donne une adresse Solana à analyser, UTILISE les outils — n'invente jamais de données on-chain.
Pour une adresse de dev suspect : commence par analyze_wallet, puis trace_cascade si l'utilisateur veut remonter au wallet de launch.
Format Telegram : Markdown léger (*gras*, \`code\`), pas de tableaux. Sois direct.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'analyze_wallet',
      description:
        "Analyse un wallet de dev Solana : score de suspicion, fresh wallet, financeur racine, hub distributeur, wallets financés en montant de launch (pattern sérial launcher).",
      parameters: {
        type: 'object',
        properties: { address: { type: 'string', description: 'Adresse Solana (base58)' } },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'follow_chain',
      description:
        "Remonte la chaîne de financement d'un wallet (qui l'a financé, jusqu'au financeur racine), hop par hop.",
      parameters: {
        type: 'object',
        properties: { address: { type: 'string', description: 'Adresse Solana (base58)' } },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'trace_cascade',
      description:
        "Descend la cascade de financement depuis un HUB : suit les gros transferts vers les sous-hubs et trouve les wallets de launch (financés ~8-13 SOL, souvent frais, qui créent un token).",
      parameters: {
        type: 'object',
        properties: { address: { type: 'string', description: 'Adresse du hub/distributeur (base58)' } },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bot_status',
      description:
        "Retourne l'état du bot : mode (dry-run/live), pause, wallets suivis, positions ouvertes, PnL réalisé/latent.",
      parameters: { type: 'object', properties: {} },
    },
  },
];

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class AiAssistant {
  constructor(private deps: AssistantDeps) {}

  get enabled(): boolean {
    return !!this.deps.secrets.openRouterApiKey;
  }

  /** Répond à une question utilisateur, en utilisant les outils si besoin. */
  async ask(question: string): Promise<string> {
    if (!this.enabled) {
      return '🤖 IA non configurée. Ajoute `OPENROUTER_API_KEY` dans les variables (openrouter.ai/keys).';
    }
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: question },
    ];

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const res = await this.call(messages);
      const choice = res?.choices?.[0]?.message;
      if (!choice) return '🤖 Pas de réponse du modèle.';

      const toolCalls = choice.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        return (choice.content || '🤖 (réponse vide)').trim();
      }

      // L'IA veut appeler des outils
      messages.push({ role: 'assistant', content: choice.content ?? null, tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const name = tc.function?.name;
        let args: any = {};
        try {
          args = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          /* ignore */
        }
        logger.info(SCOPE, `Outil appelé: ${name}`, { args });
        const result = await this.runTool(name, args);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name,
          content: result,
        });
      }
    }
    // Dernier appel sans outils pour forcer une réponse texte
    const final = await this.call(messages, false);
    return (final?.choices?.[0]?.message?.content || '🤖 Analyse trop longue, réessaie plus précisément.').trim();
  }

  private async call(messages: ChatMessage[], withTools = true, retriesLeft = 1): Promise<any> {
    const { openRouterApiKey, openRouterModel } = this.deps.secrets;
    const body: any = {
      model: openRouterModel,
      messages,
      temperature: 0.4,
      max_tokens: 1200,
    };
    if (withTools) {
      body.tools = TOOLS;
      body.tool_choice = 'auto';
    }
    try {
      const r = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openRouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/bahghost229-eng/Solanacoin',
          'X-Title': 'Solana Chain Sniper',
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const txt = await r.text();
        logger.warn(SCOPE, `OpenRouter ${r.status}`, { txt: txt.slice(0, 200) });
        // certains modèles gratuits ne supportent pas tools → retry sans
        if (withTools && (r.status === 404 || r.status === 400)) {
          return this.call(messages, false);
        }
        // rate-limit modèle free → backoff court puis 1 retry
        if (r.status === 429 && retriesLeft > 0) {
          let waitMs = 3000;
          try {
            const meta = JSON.parse(txt);
            const ra = meta?.error?.metadata?.retry_after_seconds;
            if (typeof ra === 'number') waitMs = Math.min(Math.ceil(ra) * 1000 + 500, 30000);
          } catch {}
          await new Promise((res) => setTimeout(res, waitMs));
          return this.call(messages, withTools, retriesLeft - 1);
        }
        if (r.status === 429) {
          return {
            choices: [
              {
                message: {
                  content:
                    '🤖 Modèle IA gratuit saturé à l’instant (rate-limit). Réessaie dans ~30s, ou change `OPENROUTER_MODEL`.',
                },
              },
            ],
          };
        }
        return { choices: [{ message: { content: `🤖 Erreur OpenRouter ${r.status}.` } }] };
      }
      return await r.json();
    } catch (e) {
      logger.warn(SCOPE, 'OpenRouter fetch échec', { error: (e as Error)?.message });
      return { choices: [{ message: { content: '🤖 Erreur réseau vers OpenRouter.' } }] };
    }
  }

  private async runTool(name: string, args: any): Promise<string> {
    try {
      switch (name) {
        case 'analyze_wallet':
          return await this.toolAnalyze(args.address);
        case 'follow_chain':
          return await this.toolChain(args.address);
        case 'trace_cascade':
          return await this.toolCascade(args.address);
        case 'bot_status':
          return this.toolStatus();
        default:
          return `Outil inconnu: ${name}`;
      }
    } catch (e) {
      return `Erreur outil ${name}: ${(e as Error)?.message}`;
    }
  }

  private async toolAnalyze(address: string): Promise<string> {
    if (!ADDR_RE.test(address || '')) return 'Adresse invalide.';
    if (!this.deps.analyzer) return 'DevPatternAnalyzer désactivé (devPattern.enabled=false).';
    const r = await this.deps.analyzer.analyze(address);
    return JSON.stringify({
      wallet: address,
      score: r.score,
      suspicious: r.suspicious,
      rootFunder: r.rootFunder ?? null,
      hub: r.hub ?? null,
      launchSiblings: r.launchSiblings.map((s) => ({ wallet: s.wallet, sol: Number(s.amountSol.toFixed(2)) })),
      siblingsCount: r.siblings.length,
      signals: r.signals.map((s) => ({ name: s.name, hit: s.hit, detail: s.detail })),
      fundingChain: r.chain.hops.map((h) => ({ hop: h.hop, from: h.from, to: h.to, sol: Number(h.amountSol.toFixed(2)) })),
    });
  }

  private async toolChain(address: string): Promise<string> {
    if (!ADDR_RE.test(address || '')) return 'Adresse invalide.';
    if (!this.deps.chain) return 'ChainFollower désactivé (chainFollowing.enabled=false).';
    const r = await this.deps.chain.follow(address);
    return JSON.stringify({
      origin: address,
      rootFunder: r.rootFunder ?? null,
      hops: r.hops.map((h) => ({ hop: h.hop, from: h.from, to: h.to, sol: Number(h.amountSol.toFixed(3)) })),
    });
  }

  private async toolCascade(address: string): Promise<string> {
    if (!ADDR_RE.test(address || '')) return 'Adresse invalide.';
    if (!this.deps.cascade) return 'CascadeTracer indisponible.';
    const r = await this.deps.cascade.trace(address);
    return JSON.stringify(r);
  }

  private toolStatus(): string {
    const { store, positions, config } = this.deps;
    const st = store.getState();
    const snap = positions.snapshot();
    return JSON.stringify({
      mode: (st.dryRunOverride ?? config.dryRun) ? 'dry-run' : 'live',
      paused: st.paused,
      trackedWallets: store.listWallets().map((w) => ({ address: w.address, label: w.label ?? null })),
      buyAmountSol: st.buyAmountOverride ?? config.execution.buyAmountSol,
      openPositions: positions.openCount,
      pnl: snap,
    });
  }
}
