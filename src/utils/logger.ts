/**
 * Logger simple, coloré, avec niveaux et écriture fichier optionnelle.
 * Émet aussi les events vers le dashboard via un EventEmitter partagé.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

/** Bus d'événements global — le dashboard s'y abonne pour streamer les logs. */
export const logBus = new EventEmitter();

class Logger {
  private minLevel: number = LEVELS.info;
  private toFile = false;
  private filePath = 'data/bot.log';

  configure(opts: { level: LogLevel; logToFile: boolean; logFilePath: string }): void {
    this.minLevel = LEVELS[opts.level];
    this.toFile = opts.logToFile;
    this.filePath = opts.logFilePath;
    if (this.toFile) {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
      } catch {
        /* ignore */
      }
    }
  }

  private write(level: LogLevel, scope: string, msg: string, data?: unknown): void {
    if (LEVELS[level] < this.minLevel) return;
    const ts = new Date().toISOString();
    const line = `${ts} [${level.toUpperCase()}] (${scope}) ${msg}`;
    const dataStr = data !== undefined ? ' ' + safeStringify(data) : '';

    // eslint-disable-next-line no-console
    console.log(`${COLORS[level]}${line}${RESET}${dataStr}`);

    if (this.toFile) {
      try {
        appendFileSync(this.filePath, line + dataStr + '\n');
      } catch {
        /* ignore */
      }
    }

    logBus.emit('log', { ts, level, scope, msg, data });
  }

  debug(scope: string, msg: string, data?: unknown) {
    this.write('debug', scope, msg, data);
  }
  info(scope: string, msg: string, data?: unknown) {
    this.write('info', scope, msg, data);
  }
  warn(scope: string, msg: string, data?: unknown) {
    this.write('warn', scope, msg, data);
  }
  error(scope: string, msg: string, data?: unknown) {
    this.write('error', scope, msg, data);
  }
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const logger = new Logger();
