import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import type { z } from 'zod';
import {
  dohUrlSchema,
  sourceUserAgentSchema,
  type UpdateSourceNetworkConfigBody,
} from '@projekt-manga/schemas';
import type { SourceNetworkConfig } from '@projekt-manga/types';

/**
 * The User-Agent and DNS over HTTPS resolver for sandboxed source requests.
 *
 * `SOURCE_USER_AGENT` and `SOURCE_DOH_URL` supply the defaults; the admin endpoint's
 * overrides are stored beside the database so they survive a restart without anyone
 * editing `.env`. A stored `null` turns a setting off even when the environment sets it.
 * The sandbox reads this on every proxied request, so it is kept in memory.
 */

type StoredOverrides = Partial<Record<keyof SourceNetworkConfig, string | null>>;

let overrideFile: string | null = null;
let cached: SourceNetworkConfig | null = null;

function configFile(): string {
  if (overrideFile) return overrideFile;
  const databaseUrl = process.env.DATABASE_URL?.trim() || 'file:./data/projektmanga.db';
  return path.join(
    path.dirname(path.resolve(databaseUrl.slice('file:'.length))),
    'source-network.json',
  );
}

const fromEnv = (raw: string | undefined, schema: z.ZodType<string>) => {
  if (!raw?.trim()) return null;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/** Keeps only fields that pass the same validation as the endpoint, so a hand-edited or
 * half-written file can never put an unchecked value into a request. */
function sanitizeOverrides(raw: unknown): StoredOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const out: StoredOverrides = {};
  for (const [key, schema] of [
    ['userAgent', sourceUserAgentSchema],
    ['dohUrl', dohUrlSchema],
  ] as const) {
    if (value[key] === null) out[key] = null;
    else if (typeof value[key] === 'string') {
      const parsed = schema.safeParse(value[key]);
      if (parsed.success) out[key] = parsed.data;
    }
  }
  return out;
}

function readOverrides(): StoredOverrides {
  try {
    return sanitizeOverrides(JSON.parse(fs.readFileSync(configFile(), 'utf8')));
  } catch (error) {
    // A missing file is the normal case; a corrupt one falls back to the env defaults.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[Source network] Ignoring unreadable settings file');
    }
    return {};
  }
}

function resolve(overrides: StoredOverrides): SourceNetworkConfig {
  return {
    userAgent:
      overrides.userAgent !== undefined
        ? overrides.userAgent
        : fromEnv(process.env.SOURCE_USER_AGENT, sourceUserAgentSchema),
    dohUrl:
      overrides.dohUrl !== undefined
        ? overrides.dohUrl
        : fromEnv(process.env.SOURCE_DOH_URL, dohUrlSchema),
  };
}

export function readSourceNetworkConfig(): SourceNetworkConfig {
  cached ??= resolve(readOverrides());
  return cached;
}

export async function updateSourceNetworkConfig(
  patch: UpdateSourceNetworkConfigBody,
): Promise<SourceNetworkConfig> {
  const overrides = { ...readOverrides() };
  if (patch.userAgent !== undefined) overrides.userAgent = patch.userAgent;
  if (patch.dohUrl !== undefined) overrides.dohUrl = patch.dohUrl;
  const file = configFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // Written whole and renamed into place, so a crash never leaves a half-written file.
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(overrides, null, 2), { mode: 0o600 });
  await fsp.rename(temporary, file);
  cached = resolve(overrides);
  return cached;
}

/** Test seam: points the store at a temp file and drops the in-memory copy. */
export function setSourceNetworkConfigFileForTests(file: string | null): void {
  overrideFile = file;
  cached = null;
}
