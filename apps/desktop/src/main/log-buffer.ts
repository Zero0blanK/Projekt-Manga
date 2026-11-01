/**
 * In-memory tail of what the supervised child processes printed.
 *
 * The installer has no operator watching a terminal, so the only way a user can tell us
 * why something failed is to paste it into an issue — see main/diagnostics.ts. Keeping a
 * bounded tail in memory (rather than writing a log file) means there is nothing on disk
 * to grow without limit, rotate, or accidentally ship a secret into.
 */
import { inspect } from 'node:util';

/** Per-channel cap. Deliberately small: a diagnostic report has to stay pasteable into a
 * GitHub comment, and the useful signal is almost always in the last few lines. */
const MAX_LINES = 500;

export type LogChannel = 'api' | 'web' | 'main';

const buffers: Record<LogChannel, string[]> = { api: [], web: [], main: [] };

/** Splits on newlines so one chunk from a child's stdout doesn't count as one "line" —
 * child output arrives in arbitrary chunk boundaries, not per line. */
export function appendLog(channel: LogChannel, chunk: string): void {
  const lines = chunk.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return;

  const buffer = buffers[channel];
  buffer.push(...lines);
  if (buffer.length > MAX_LINES) {
    buffer.splice(0, buffer.length - MAX_LINES);
  }
}

export function readLog(channel: LogChannel, lines = MAX_LINES): string[] {
  return buffers[channel].slice(-lines);
}

export function clearLogs(): void {
  for (const channel of Object.keys(buffers) as LogChannel[]) {
    buffers[channel].length = 0;
  }
}

function formatArg(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  return inspect(value, { depth: 3, breakLength: Infinity });
}

let consoleCaptured = false;

/**
 * Mirrors the main process's own warnings and errors into the 'main' channel.
 *
 * Without it, a main-process failure — a startup crash, an unhandled rejection, a renderer
 * that died — reaches only a console nobody sees in an installed build, and the diagnostic
 * report has nothing to show for it. The console still prints as before.
 */
export function captureConsole(): void {
  if (consoleCaptured) return;
  consoleCaptured = true;
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        appendLog('main', `${level.toUpperCase()} ${args.map(formatArg).join(' ')}`);
      } catch {
        // Logging must never throw into the caller.
      }
    };
  }
}
