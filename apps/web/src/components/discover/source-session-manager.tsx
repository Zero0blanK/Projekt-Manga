'use client';

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardPaste, Pencil, Trash2 } from 'lucide-react';
import {
  clearSourceBrowserSession,
  getSourceBrowserSession,
  saveSourceBrowserSession,
} from '@projekt-manga/api-client';
import type { SourceBrowserSessionStatus } from '@projekt-manga/types';
import { toast } from '@/hooks/use-toast';
import { absoluteTime, relativeTime } from '@/lib/relative-time';
import { parsePastedCookies, parsePastedUserAgent, sourceSessionKey } from '@/lib/source-browser';
import { canCheckSources, startSourceCheck, useSourceCheck } from '@/lib/source-check';

const button =
  'inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 font-medium text-foreground transition hover:bg-accent disabled:opacity-60';

function expiry(expires: number | null): string {
  // A pasted cookie carries no expiry, and a session cookie has none either.
  if (expires === null) return 'expiry unknown';
  const when = expires * 1000;
  return when <= Date.now()
    ? 'expired'
    : `expires ${relativeTime(new Date(when)) ?? absoluteTime(new Date(when))}`;
}

/** How soon a clearance is worth refreshing before the site asks again. */
const CLEARANCE_WARNING_MS = 5 * 60_000;

/** A clearance this app run already tried to refresh, by source and expiry. A fresh
 * clearance has a new expiry, so it can be refreshed again when that one runs out. */
const autoRefreshAttempted = new Map<string, number>();

interface ClearanceWarning {
  message: string;
  expired: boolean;
  /** Unix milliseconds, so an automatic retry is keyed to this clearance. */
  expiresAt: number;
}

function clearanceWarning(cookies: SourceBrowserSessionStatus['cookies']): ClearanceWarning | null {
  const clearance = cookies.find((cookie) => cookie.name.toLowerCase() === 'cf_clearance');
  if (!clearance || clearance.expires === null) return null;
  const expiresAt = clearance.expires * 1000;
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    return {
      message: 'The saved browser check has expired. The app is opening the source to replace it.',
      expired: true,
      expiresAt,
    };
  }
  if (remaining <= CLEARANCE_WARNING_MS) {
    return {
      message:
        'The saved browser check expires in a few minutes. The app will open the source to refresh it when it expires.',
      expired: false,
      expiresAt,
    };
  }
  return null;
}

/**
 * The session the server holds for a source, earned in the reader's own browser: what is
 * saved (cookie names and expiry, never their values, and the User-Agent), with Edit and
 * Delete; or, when nothing is saved, a form to paste one. Cloudflare ties the clearance to
 * the browser's User-Agent and the IP, so it only helps when the server reaches the site
 * from the same network as that browser. Admin-only on the server: hidden when it refuses.
 */
export function SourceSessionManager({
  sourceId,
  sourceName,
  siteUrl,
  onSaved,
  hideWhenEmpty = false,
}: {
  sourceId: string;
  sourceName: string;
  siteUrl: string;
  onSaved?: () => void;
  /** Shows nothing until a session is saved (where no check is being asked for). */
  hideWhenEmpty?: boolean;
}) {
  const queryClient = useQueryClient();
  const { data, isError } = useQuery({
    queryKey: sourceSessionKey(sourceId),
    queryFn: ({ signal }) => getSourceBrowserSession(sourceId, signal),
    retry: false,
  });
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Read after mount: the bridge only exists in the desktop renderer, and the server
  // render must match the first client render.
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop(canCheckSources()), []);
  // The source's shared background check (lib/source-check.ts), so a refresh started here
  // joins one a list or the challenge notice already started instead of opening a second
  // window. A pass refreshes the saved session and retries what failed on the source.
  const check = useSourceCheck(sourceId);
  const opening = check.status === 'checking' || check.status === 'needs-you';
  const refreshFailed = check.status === 'failed';

  const refresh = useCallback(
    async (auto: boolean) => {
      const state = await startSourceCheck(sourceId, { auto });
      if (state?.status === 'passed' || state?.status === 'failed') {
        toast({ description: state.message });
      }
    },
    [sourceId],
  );

  const warning = data ? clearanceWarning(data.cookies) : null;

  // An expired clearance is refreshed without asking: the hidden window tries to pass the
  // check by itself and becomes visible only if it needs the reader.
  useEffect(() => {
    if (!desktop || !warning?.expired) return;
    if (autoRefreshAttempted.get(sourceId) === warning.expiresAt) return;
    autoRefreshAttempted.set(sourceId, warning.expiresAt);
    void refresh(true);
  }, [desktop, refresh, sourceId, warning?.expired, warning?.expiresAt]);

  let host = '';
  try {
    host = new URL(siteUrl).hostname;
  } catch {
    // No usable site address: nothing to scope the cookie to.
  }
  if (!host || isError || !data) return null;
  const saved = data.cookies.length > 0;
  if (!saved && hideWhenEmpty) return null;

  const stored = (status: SourceBrowserSessionStatus) =>
    queryClient.setQueryData(sourceSessionKey(sourceId), status);

  const remove = async () => {
    setDeleting(true);
    try {
      await clearSourceBrowserSession(sourceId);
      stored({ ...data, hosts: [], updatedAt: null, userAgent: null, cookies: [] });
      setConfirmDelete(false);
      toast({ description: `Deleted the session for ${sourceName}.` });
    } catch (reason) {
      toast({
        description:
          reason instanceof Error && reason.message
            ? reason.message
            : `Couldn't delete the session for ${sourceName}.`,
      });
    } finally {
      setDeleting(false);
    }
  };

  if (saved && !editing) {
    return (
      <section
        aria-label={`Saved session for ${sourceName}`}
        className="mt-3 rounded-lg border border-border/60 px-3 py-2 text-left text-xs"
      >
        <p className="font-medium text-foreground">Saved session</p>
        <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Cookies</dt>
          <dd>
            {data.cookies.map((cookie) => (
              <span key={`${cookie.domain}\0${cookie.name}`} className="block">
                <code>{cookie.name}</code>{' '}
                <span className="text-muted-foreground">· {expiry(cookie.expires)}</span>
              </span>
            ))}
          </dd>
          <dt className="text-muted-foreground">User-Agent</dt>
          <dd className="truncate font-mono text-xs" title={data.userAgent ?? undefined}>
            {data.userAgent}
          </dd>
          <dt className="text-muted-foreground">Saved</dt>
          <dd title={absoluteTime(data.updatedAt)}>{relativeTime(data.updatedAt) ?? 'Unknown'}</dd>
        </dl>
        {warning && (
          <p role="status" className="mt-2 text-amber-500">
            {warning.message}
          </p>
        )}
        {opening && (
          <p className="mt-2 text-muted-foreground">
            Opening the source in the browser to refresh the check…
          </p>
        )}
        {desktop && warning && refreshFailed && !opening && (
          <div className="mt-2">
            <button type="button" onClick={() => void refresh(false)} className={button}>
              Try refreshing in browser
            </button>
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {confirmDelete ? (
            <>
              <span className="text-muted-foreground">Delete this session?</span>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={deleting}
                className={`${button} text-destructive`}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className={button}>
                Keep it
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setEditing(true)} className={button}>
                <Pencil className="h-3.5 w-3.5" aria-hidden />
                Edit
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                aria-label={`Delete the session for ${sourceName}`}
                className={button}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Delete
              </button>
            </>
          )}
        </div>
      </section>
    );
  }

  const form = (
    <SessionForm
      sourceId={sourceId}
      sourceName={sourceName}
      siteUrl={siteUrl}
      host={host}
      saved={saved ? data : null}
      onCancel={saved ? () => setEditing(false) : undefined}
      onSaved={(status) => {
        stored(status);
        setEditing(false);
        onSaved?.();
      }}
    />
  );
  if (saved) {
    return (
      <section
        aria-label={`Edit the session for ${sourceName}`}
        className="mt-3 rounded-lg border border-border/60 px-3 py-2 text-left text-xs"
      >
        <p className="font-medium text-foreground">Edit saved session</p>
        {form}
      </section>
    );
  }
  return (
    <details className="mt-3 rounded-lg border border-border/60 px-3 py-2 text-left text-xs">
      <summary className="cursor-pointer font-medium text-foreground">
        Paste a session from your browser
      </summary>
      {form}
    </details>
  );
}

function SessionForm({
  sourceId,
  sourceName,
  siteUrl,
  host,
  saved,
  onCancel,
  onSaved,
}: {
  sourceId: string;
  sourceName: string;
  siteUrl: string;
  host: string;
  /** The session being edited; null for a new one. */
  saved: SourceBrowserSessionStatus | null;
  onCancel?: () => void;
  onSaved: (status: SourceBrowserSessionStatus) => void;
}) {
  const id = useId();
  const [cookie, setCookie] = useState('');
  const [userAgent, setUserAgent] = useState(saved?.userAgent ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    let body;
    try {
      const agent = parsePastedUserAgent(userAgent);
      // Editing with the cookie left empty keeps the saved cookies.
      body =
        saved && !cookie.trim()
          ? { userAgent: agent }
          : { userAgent: agent, cookies: parsePastedCookies(cookie, host) };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Check what you pasted.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const status = await saveSourceBrowserSession(sourceId, body);
      setCookie('');
      toast({ description: `Saved the session for ${sourceName}.` });
      onSaved(status);
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : `Couldn't save the session for ${sourceName}.`,
      );
    } finally {
      setSaving(false);
    }
  };

  const savedNames = saved?.cookies.map((entry) => entry.name).join(', ');
  return (
    <form onSubmit={(event) => void submit(event)} className="mt-2 space-y-2">
      <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
        <li>
          Open{' '}
          <a href={siteUrl} target="_blank" rel="noreferrer noopener" className="underline">
            {host}
          </a>{' '}
          in Chrome, Edge or Firefox and pass the check.
        </li>
        <li>
          Open the developer tools (F12) › Application (Storage in Firefox) › Cookies, and copy the
          value of <code>cf_clearance</code>.
        </li>
        <li>
          In the Console, run <code>navigator.userAgent</code> and copy the text it prints.
        </li>
      </ol>
      <label htmlFor={`${id}-cookie`} className="block font-medium text-foreground">
        Cookie
      </label>
      <textarea
        id={`${id}-cookie`}
        value={cookie}
        onChange={(event) => setCookie(event.target.value)}
        rows={2}
        spellCheck={false}
        autoComplete="off"
        placeholder={
          saved
            ? `Leave empty to keep the saved cookie (${savedNames})`
            : 'The cf_clearance value, or a whole Cookie header'
        }
        className="w-full resize-y rounded-md border border-border/60 bg-background px-2 py-1.5 font-mono text-[11px]"
      />
      <label htmlFor={`${id}-ua`} className="block font-medium text-foreground">
        User-Agent of that browser
      </label>
      <textarea
        id={`${id}-ua`}
        value={userAgent}
        onChange={(event) => setUserAgent(event.target.value)}
        rows={2}
        spellCheck={false}
        autoComplete="off"
        placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64) …"
        className="w-full resize-y rounded-md border border-border/60 bg-background px-2 py-1.5 font-mono text-[11px]"
      />
      <p className="text-muted-foreground">
        The check is tied to your browser and your internet connection, so this works when the
        server uses the same connection. It lasts until the site asks again.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={saving} className={button}>
          <ClipboardPaste className="h-3.5 w-3.5" aria-hidden />
          {saving ? 'Saving…' : 'Save session'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={button}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
