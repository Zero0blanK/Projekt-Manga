import fsp from 'node:fs/promises';
import path from 'node:path';
import { BASIC_AUTH_MODE, SERVER_CONF_FILE } from './constants.js';

/**
 * The engine's settings, written into its server.conf before every start.
 *
 * Suwayomi keeps its own settings in server.conf (an extension repository added through
 * its API is saved there too), so the file is not replaced: a block of settings this app
 * owns is appended, replacing the one from the last start. In HOCON a later definition
 * wins, so the block holds whatever else is in the file.
 *
 * Checked against Suwayomi-Server v2.4.2366's ServerConfig.
 */

const BEGIN = '# >>> Projekt Manga managed settings: rewritten before every start';
const END = '# <<< Projekt Manga managed settings';

export interface EngineConfig {
  port: number;
  username: string;
  password: string;
}

/** The managed settings, as `server.<key> = <value>` HOCON lines. */
export function managedSettings(config: EngineConfig): Record<string, string | number | boolean> {
  return {
    // Only this machine, on the port chosen for this start.
    ip: '127.0.0.1',
    port: config.port,
    // Its login, so nothing else on the machine can use it.
    authMode: BASIC_AUTH_MODE,
    authUsername: config.username,
    authPassword: config.password,
    // No user interface of its own: no web app, no browser window, no tray icon.
    webUIEnabled: false,
    initialOpenInBrowserEnabled: false,
    systemTrayEnabled: false,
    webUIUpdateCheckInterval: 0,
    // Projekt Manga keeps the library, progress and downloads; the engine only runs
    // extensions, so its own library updates, downloads and backups stay off.
    globalUpdateInterval: 0,
    updateMangas: false,
    autoDownloadNewChapters: false,
    backupInterval: 0,
    // Its embedded Chromium (for extensions that need a web view) is off: when on, the
    // engine downloads it from GitHub by itself on first start and runs it as a separate
    // browser process, and nothing here downloads or runs without the user asking.
    kcefEnabled: false,
  };
}

function hocon(value: string | number | boolean): string {
  // A JSON string is a valid HOCON quoted string.
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

export function renderManagedBlock(config: EngineConfig): string {
  const lines = Object.entries(managedSettings(config)).map(
    ([key, value]) => `server.${key} = ${hocon(value)}`,
  );
  return [BEGIN, ...lines, END].join('\n');
}

/** `existing` with the last start's managed block removed and this one appended. */
export function withManagedBlock(existing: string, config: EngineConfig): string {
  const pattern = new RegExp(`\\n?${escape(BEGIN)}[\\s\\S]*?${escape(END)}\\n?`, 'g');
  const rest = existing.replace(pattern, '\n').trimEnd();
  return `${rest ? `${rest}\n\n` : ''}${renderManagedBlock(config)}\n`;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Writes the managed block into `<dataDir>/server.conf`, private to this user. */
export async function writeEngineConfig(dataDir: string, config: EngineConfig): Promise<void> {
  const file = path.join(dataDir, SERVER_CONF_FILE);
  let existing = '';
  try {
    existing = await fsp.readFile(file, 'utf8');
  } catch {
    // First start: Suwayomi fills in its defaults around this block.
  }
  await fsp.mkdir(dataDir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, withManagedBlock(existing, config), { mode: 0o600 });
  await fsp.rename(temporary, file);
}
