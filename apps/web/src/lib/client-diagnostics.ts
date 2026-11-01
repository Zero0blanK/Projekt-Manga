'use client';

import { onRequestFailure, type RequestFailure } from '@projekt-manga/api-client';

/**
 * What happened in this page before someone opened the diagnostic report.
 *
 * The server and desktop logs say what *they* saw; this is the renderer's side: which API
 * calls failed (and whether the API itself answered), uncaught errors and rejections,
 * failures the app showed as a toast, and the pages visited. Kept in memory only, bounded,
 * and lost on reload — nothing is written anywhere until the reader copies the report.
 *
 * Text recorded here is scrubbed by lib/diagnostics.ts when the report is built, the same
 * as the server logs.
 */

export interface ClientErrorEvent {
  at: string;
  kind: 'error' | 'rejection' | 'reported' | 'render';
  message: string;
  /** First frames of the stack, when there is one. */
  stack?: string;
  /** The page it happened on (pathname only). */
  page: string;
}

export interface PageVisit {
  at: string;
  page: string;
}

const MAX_REQUESTS = 60;
const MAX_ERRORS = 40;
const MAX_PAGES = 25;
const STACK_FRAMES = 6;

const requests: RequestFailure[] = [];
const errors: ClientErrorEvent[] = [];
const pages: PageVisit[] = [];
let installed = false;
let startedAt = Date.now();

function push<T>(list: T[], value: T, max: number): void {
  list.push(value);
  if (list.length > max) list.splice(0, list.length - max);
}

/** Pathname only: query strings carry search terms and filters, which the report does
 * not need. */
function currentPage(): string {
  return typeof location === 'undefined' ? 'unknown' : location.pathname;
}

function describe(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    const stack = value.stack
      ?.split('\n')
      .slice(1, STACK_FRAMES + 1)
      .join('\n');
    return { message: `${value.name}: ${value.message}`, ...(stack ? { stack } : {}) };
  }
  if (typeof value === 'string') return { message: value };
  try {
    return { message: JSON.stringify(value)?.slice(0, 300) ?? String(value) };
  } catch {
    return { message: String(value) };
  }
}

export function recordClientError(kind: ClientErrorEvent['kind'], value: unknown): void {
  push(
    errors,
    { at: new Date().toISOString(), kind, page: currentPage(), ...describe(value) },
    MAX_ERRORS,
  );
}

export function recordPageVisit(page: string): void {
  if (pages.at(-1)?.page === page) return;
  push(pages, { at: new Date().toISOString(), page }, MAX_PAGES);
}

/** Starts recording. Safe to call more than once; does nothing outside a browser. */
export function installClientDiagnostics(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  startedAt = Date.now();
  onRequestFailure((failure) => push(requests, failure, MAX_REQUESTS));
  window.addEventListener('error', (event) => {
    // Resource load failures (an <img> 404) arrive here too, without an error object;
    // covers have their own fallbacks, and recording each would bury real errors.
    if (!event.error && !event.message) return;
    recordClientError('error', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    recordClientError('rejection', event.reason);
  });
  recordPageVisit(currentPage());
}

export function readClientDiagnostics() {
  return {
    pageAgeSeconds: Math.round((Date.now() - startedAt) / 1000),
    requests: [...requests],
    errors: [...errors],
    pages: [...pages],
  };
}

export function resetClientDiagnosticsForTests(): void {
  requests.length = 0;
  errors.length = 0;
  pages.length = 0;
}
