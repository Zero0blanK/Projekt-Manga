import { NextResponse, type NextRequest } from 'next/server';

/**
 * Routes `/api/*` to the API process, at request time.
 *
 * ## Why this is not a `rewrites()` entry in next.config.ts
 *
 * `rewrites()` is evaluated during `next build`, and the resolved destination is baked
 * into `.next/routes-manifest.json` — `next start` reads the manifest and never calls the
 * function again. So a `process.env` lookup inside `rewrites()` captures the *build
 * machine's* value, exactly like the `NEXT_PUBLIC_*` inlining the runtime port avoids.
 * A packaged installer whose API runs on a free port would proxy every call to the
 * baked-in fallback `127.0.0.1:4000`.
 *
 * Proxy (`middleware` before Next 16) runs per request and defaults to the Node.js runtime,
 * so `process.env.PROJEKT_MANGA_API_PORT` is read when the request arrives, from the
 * environment the supervisor actually spawned this server with.
 *
 * ## When it applies
 *
 * Only in single-origin mode, where the client's API base URL is the relative `/api`. The
 * hosted deployments give the client an absolute URL, so nothing ever requests `/api` from
 * the web origin and this is inert. The matcher keeps it off every other route.
 */
export function proxy(request: NextRequest) {
  const apiPort = process.env.PROJEKT_MANGA_API_PORT ?? '4000';

  // `pathname + search` rather than passing `request.url` as the base: the incoming URL's
  // origin is projektmanga.localhost:<webPort>, and only the path and query should carry
  // over to the API's own origin.
  const target = new URL(
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
    `http://127.0.0.1:${apiPort}`,
  );

  return NextResponse.rewrite(target);
}

export const config = {
  matcher: '/api/:path*',
};
