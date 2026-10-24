import { z } from 'zod';
import { parseTrustedExtensionSigningKeys } from '../utils/extensionSignature.js';

/**
 * Startup validation for the environment this server needs.
 *
 * A bad config is reported at startup with its actual cause, rather than surfacing later
 * as a pool timeout from whichever query runs first.
 *
 * `DATABASE_URL` is the single source of truth for the database: the Prisma CLI reads it
 * for migrations (see prisma.config.ts) and the running server derives its connection from
 * the same value. The database is SQLite, so it is a `file:` URL. A stale `mysql://` URL
 * left over from an older setup is reported explicitly instead of failing later and less
 * clearly.
 */
/** The value CLIENT_URL takes when nothing sets it — this project's own dev origin.
 * Declared above the schema so the schema's own default can reference it rather than
 * repeating the literal. */
export const DEFAULT_CLIENT_URL = 'http://localhost:3000';

const envSchema = z.object({
  /** SQLite location, e.g. `file:./data/projektmanga.db`. Relative paths resolve against
   * the server's working directory; the desktop installer passes an absolute path inside
   * the user's app-data directory. */
  DATABASE_URL: z.string().min(1).optional(),

  SERVER_PORT: z.coerce.number().int().positive().default(4000),

  /** Interface to bind on. Left undefined the server listens on every interface, which is
   * what the hosted deployments want. The desktop installer sets `127.0.0.1`: there the
   * API is an implementation detail reached only through the web server's rewrite proxy,
   * so exposing it on the LAN would be a surface with no purpose. */
  SERVER_HOST: z.string().min(1).optional(),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CLIENT_URL: z.string().url().default(DEFAULT_CLIENT_URL),

  /**
   * How much of `X-Forwarded-For` to believe. See `resolveTrustProxy` for the values.
   *
   * Left unset it is `loopback`, which is deliberately *not* Express's `true`: whatever
   * this resolves to becomes `req.ip`, and `req.ip` is the key the auth rate limiter
   * counts against.
   */
  TRUST_PROXY: z.string().min(1).optional(),

  /** Lets a non-loopback client reach the host-level routes (download folder, extension
   * install, restore) by sending it as `X-Admin-Token`. Left unset, only loopback clients
   * are admitted; see `requireAdmin`. */
  ADMIN_TOKEN: z.string().min(16).optional(),

  /** JSON map of exact repository URLs to operator-trusted Ed25519 public keys. */
  EXTENSION_REPOSITORY_TRUST_KEYS: z.string().default('{}'),
});

export interface DatabaseConfig {
  /** The `file:`-prefixed URL handed to the libSQL driver adapter. */
  url: string;
  /** Filesystem path the URL points at, for the backup/restore around migrations. */
  file: string;
}

export type Env = z.infer<typeof envSchema>;

/** Used when DATABASE_URL is unset — keeps `npm run dev:server` working with no .env at
 * all, which is how the test suite and a fresh clone both start. */
export const DEFAULT_DATABASE_URL = 'file:./data/projektmanga.db';

/**
 * What Express should trust in `X-Forwarded-For`.
 *
 * This setting decides `req.ip`, and `req.ip` is what `express-rate-limit` counts against
 * on `/api/auth/login` and `/api/auth/register` — so getting it wrong doesn't degrade the
 * limiter, it removes it. An unconditional `trust proxy: 1` makes Express believe the
 * forwarded chain; a client talking to the server *directly* could then set the header
 * itself and present a different address on every request, so the per-IP counter never
 * reaches its limit and password attempts become unmetered against bcrypt.
 *
 * `loopback` is the default because it is right for the two deployments that exist. The
 * desktop installer reaches the API only through the web server's proxy on 127.0.0.1, so
 * the forwarded chain is trusted exactly where it is real; anything arriving from off-box
 * is keyed on its actual socket address. A hosted deployment behind nginx/Cloudflare sets
 * this explicitly to the number of proxies in front of it.
 *
 * Accepted values (Express's own vocabulary):
 * - unset      → `loopback`
 * - `false`    → trust nothing; always use the socket address
 * - a number   → trust that many hops closest to this server
 * - anything else (`loopback`, an IP, a CIDR, a comma-separated list) → passed through
 *
 * `true` is accepted but means "trust every proxy", which is the permissive setting above;
 * only set it where something upstream is guaranteed to overwrite the header.
 */
export function resolveTrustProxy(raw: string | undefined): boolean | number | string {
  const value = raw?.trim();
  if (!value) return 'loopback';
  if (value === 'false') return false;
  if (value === 'true') return true;

  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 0) return hops;

  // A named setting, address, CIDR or list — Express parses these itself, and duplicating
  // that parsing here would only add a way to reject something Express accepts.
  return value;
}

/**
 * Resolves the SQLite location from DATABASE_URL.
 *
 * Rejects a `mysql://` URL explicitly rather than letting it through: an .env left over
 * from before the SQLite migration is the single most likely misconfiguration here, and
 * the driver's own error for it is unrecognisable.
 */
export function resolveDatabaseConfig(env: Env): DatabaseConfig {
  const raw = env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;

  if (/^(mysql|mariadb|postgres|postgresql):/i.test(raw)) {
    throw new Error(
      `DATABASE_URL points at a ${raw.split(':')[0]} server, but this app now uses SQLite. ` +
        `Set DATABASE_URL to a file URL (e.g. ${DEFAULT_DATABASE_URL}) and import your old ` +
        'data with apps/server/scripts/import-sqlite-snapshot.mjs.',
    );
  }

  if (!raw.startsWith('file:')) {
    throw new Error(
      `DATABASE_URL must be a SQLite file URL starting with "file:" (got "${raw}"). ` +
        `Example: ${DEFAULT_DATABASE_URL}`,
    );
  }

  return { url: raw, file: raw.slice('file:'.length) };
}

let cached: Env | null = null;

/**
 * Parses and caches process.env. Called explicitly from server.ts rather than at module
 * import time so importing `app.ts` — which the test suite does, with no .env present —
 * never depends on a complete environment.
 */
export function loadEnv(): Env {
  if (cached) {
    return cached;
  }
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Warns about production settings that are *valid* but almost certainly not intended.
 *
 * Deliberately a warning and not a refusal to start. The one configuration that looks
 * wrong here is also the one the desktop installer deliberately uses: it serves the web
 * app from a loopback port and the renderer reaches the API through that server's own
 * proxy, so no browser ever sends an Origin header the API has to match and CLIENT_URL is
 * correctly left alone. Failing closed would break the shipped installer to protect a
 * hosted deployment.
 *
 * It is worth saying *something*, though, because of how this fails when it is wrong: the
 * session cookie is SameSite=Lax and CORS accepts exactly one origin, so a hosted
 * deployment that forgot CLIENT_URL does not get an error — the browser silently drops
 * the cookie on every request and login appears to do nothing. One line at startup is the
 * only place that is cheap to notice.
 */
function warnAboutSuspectProductionConfig(env: Env): void {
  if (env.NODE_ENV !== 'production') return;

  if (env.CLIENT_URL === DEFAULT_CLIENT_URL && !process.env.CLIENT_URL) {
    console.warn(
      `[config] NODE_ENV=production but CLIENT_URL is unset, so CORS will accept only ${DEFAULT_CLIENT_URL}. ` +
        'A browser on any other origin will be refused, and the SameSite=Lax session cookie will be dropped — ' +
        'login will appear to succeed and then do nothing. Set CLIENT_URL to the exact origin the web app is ' +
        'served from. (Expected and harmless in the desktop installer, which reaches the API through its own proxy.)',
    );
  }
}

/** Validates everything the server needs before it starts listening, so a misconfigured
 * deployment fails immediately and says why. */
export function assertValidEnv(): void {
  const env = loadEnv();
  resolveDatabaseConfig(env);
  parseTrustedExtensionSigningKeys(env.EXTENSION_REPOSITORY_TRUST_KEYS);
  warnAboutSuspectProductionConfig(env);
}

/** Test seam: loadEnv caches, and these settings are process-wide. */
export function resetEnvCacheForTests(): void {
  cached = null;
}
