/**
 * In-memory tail of what the supervised child processes printed.
 *
 * The installer has no operator watching a terminal, so the only way a user can tell us
 * why something failed is to paste it into an issue — see main/diagnostics.ts. Keeping a
 * bounded tail in memory (rather than writing a log file) means there is nothing on disk
 * to grow without limit, rotate, or accidentally ship a secret into.
 */

/** Per-channel cap. Deliberately small: a diagnostic report has to stay pasteable into a
 * GitHub comment, and the useful signal is almost always in the last few lines. */
const MAX_LINES = 200;

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
