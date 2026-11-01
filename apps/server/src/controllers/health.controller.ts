import { Request, Response, NextFunction } from 'express';
import { HTTPErrorResponse, HTTPSuccessResponse } from '../utils/responseHandlers.js';
import { getRecentDiagnosticEvents } from '../utils/diagnosticLog.js';
import prisma from '../configs/prisma.config.js';
/**
 * Loaded on demand rather than imported at module scope.
 *
 * The package root pulls in the anti-detection stack, and with it puppeteer and playwright.
 * A static import would make those a hard startup requirement for the whole API — including
 * the desktop build, which deliberately ships neither: every source there is sandboxed, and
 * a sandboxed source has no child-process permission and no network of its own, so it could
 * never drive a browser. This route is the only thing in the server that wants that stack,
 * so it is the only thing that should pay for it.
 */
async function loadScraperStats() {
  return import('@projekt-manga/extensions');
}

// Proxy URLs configured via EXT_PROXY_LIST may carry basic-auth credentials
// (http://user:pass@host:port) — never return one as-is.
function redactProxyUrl(url: string | undefined): string | undefined {
  if (!url) {
    return url;
  }
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return '[invalid URL]';
  }
}

const getLiveness = (_req: Request, res: Response) => {
  return HTTPSuccessResponse(res, 200, 'OK', {
    status: 'ok',
    timestamp: new Date().toISOString(),
    endpoints: ['/api/health/ready', '/api/health/scraper'],
  });
};

/**
 * Readiness: can this process actually serve a request that touches data?
 *
 * Separate from liveness above, which only proves the event loop is up and queries nothing.
 * Liveness would answer 200 with a locked, missing or unmigrated SQLite file behind it, so
 * a reverse proxy or the desktop supervisor could route traffic to a server that fails
 * every real request.
 *
 * `SELECT 1` rather than a model query: it needs no table to exist, so this reports
 * "database reachable" instead of accidentally also asserting a particular schema, and it
 * cannot be slowed down by the size of the user's library.
 *
 * 503 on failure, not 500 — the distinction a load balancer reads as "take me out of
 * rotation, retry later" rather than "this request was malformed". The reason is logged
 * rather than returned: a driver error carries the database file's path.
 */
const getReadiness = async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
  } catch (error) {
    console.error('[health] Readiness check failed:', error);
    return HTTPErrorResponse(res, 503, 'Database is not reachable');
  }
  return HTTPSuccessResponse(res, 200, 'Ready', {
    status: 'ready',
    database: 'ok',
    timestamp: new Date().toISOString(),
  });
};

const getScraperHealth = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let getOrchestrator, getCacheStats, getSourceCircuitBreaker;
    try {
      ({ getOrchestrator, getCacheStats, getSourceCircuitBreaker } = await loadScraperStats());
    } catch {
      // Builds that ship no anti-detection stack (the desktop installer) answer honestly
      // rather than 500ing: there is nothing wrong, there is simply nothing to report.
      return HTTPSuccessResponse(res, 200, 'Scraper health unavailable', {
        available: false,
        reason:
          'This build does not include the anti-detection stack. Sources here run sandboxed, which cannot use it.',
      });
    }

    const orchestrator = getOrchestrator();
    const proxyStats = orchestrator.getProxyManager().getStats();
    const detectionStats = orchestrator.getLogger().getStats();
    const recentBans = orchestrator
      .getLogger()
      .getRecentBans(30)
      .map((entry) => ({
        isoTime: entry.isoTime,
        source: entry.source,
        url: (() => {
          try {
            return entry.url ? new URL(entry.url).origin : '[missing URL]';
          } catch {
            return '[invalid URL]';
          }
        })(),
        proxy: redactProxyUrl(entry.proxy),
      }));
    const userAgentManager = orchestrator.getUserAgentManager();

    return HTTPSuccessResponse(res, 200, 'Scraper health retrieved', {
      available: true,
      enabled: orchestrator.isEnabled(),
      proxy: proxyStats,
      detection: detectionStats,
      recentBans,
      htmlCache: getCacheStats(),
      circuitBreakers: getSourceCircuitBreaker().getStats(),
      userAgent: {
        usingRemoteProfile: userAgentManager.isUsingRemoteProfile(),
        profileCount: userAgentManager.getProfileCount(),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const getRecentDiagnostics = (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  return HTTPSuccessResponse(
    res,
    200,
    'Recent server diagnostics retrieved',
    getRecentDiagnosticEvents(),
  );
};

/** One count for the runtime report, or null when the table can't be read — itself a
 * signal when the schema is the problem. Fixed SQL only; nothing here takes input. */
async function countRows(sql: string): Promise<number | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(sql);
    return Number(rows[0]?.n ?? 0);
  } catch {
    return null;
  }
}

/**
 * Process and database facts for the diagnostic report, behind requireAdmin like the
 * other host-level routes. Every field is chosen explicitly: no paths, no environment
 * values beyond NODE_ENV and which optional features are configured (as booleans).
 */
const getRuntimeDiagnostics = async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  const memory = process.memoryUsage();
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

  let migrations: { applied: number; latest: string | null; failed: number } | null = null;
  try {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: unknown; rolled_back_at: unknown }>
    >(
      'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at',
    );
    const applied = rows.filter((row) => row.finished_at && !row.rolled_back_at);
    migrations = {
      applied: applied.length,
      latest: applied.at(-1)?.migration_name ?? null,
      failed: rows.filter((row) => !row.finished_at && !row.rolled_back_at).length,
    };
  } catch {
    // Reported as null: a missing migrations table is the interesting fact.
  }

  let downloads: Record<string, number> | null = null;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ status: string; n: bigint | number }>>(
      'SELECT status, COUNT(*) AS n FROM downloads GROUP BY status',
    );
    downloads = Object.fromEntries(
      rows
        .filter((row) => /^[A-Z_]{1,32}$/.test(row.status))
        .map((row) => [row.status, Number(row.n)]),
    );
  } catch {
    // Same: null says the table could not be read.
  }

  const [titles, libraryEntries, chapters, categories, users, extensions, repositories] =
    await Promise.all([
      countRows('SELECT COUNT(*) AS n FROM mangas'),
      countRows('SELECT COUNT(*) AS n FROM manga_library'),
      countRows('SELECT COUNT(*) AS n FROM chapters'),
      countRows('SELECT COUNT(*) AS n FROM categories'),
      countRows('SELECT COUNT(*) AS n FROM users'),
      countRows('SELECT COUNT(*) AS n FROM installed_extensions'),
      countRows('SELECT COUNT(*) AS n FROM extension_repositories'),
    ]);

  return HTTPSuccessResponse(res, 200, 'Runtime diagnostics retrieved', {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    nodeEnv: process.env.NODE_ENV ?? null,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: {
      rss: mb(memory.rss),
      heapUsed: mb(memory.heapUsed),
      heapTotal: mb(memory.heapTotal),
    },
    features: {
      adminToken: Boolean(process.env.ADMIN_TOKEN),
      tokenEncryptionKey: Boolean(process.env.TOKEN_ENCRYPTION_KEY),
      clientUrl: Boolean(process.env.CLIENT_URL),
      trustProxy: Boolean(process.env.TRUST_PROXY),
      // A provider name, not a URL or key; anything else is reported as "other".
      translate: process.env.TRANSLATE_PROVIDER
        ? /^[a-z]{1,20}$/i.test(process.env.TRANSLATE_PROVIDER)
          ? process.env.TRANSLATE_PROVIDER
          : 'other'
        : null,
    },
    migrations,
    counts: { titles, libraryEntries, chapters, categories, users, extensions, repositories },
    downloads,
  });
};

const healthController = {
  getLiveness,
  getReadiness,
  getScraperHealth,
  getRecentDiagnostics,
  getRuntimeDiagnostics,
};

export default healthController;
