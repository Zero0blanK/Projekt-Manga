'use client';

import { useEffect, useState } from 'react';
import {
  getSuwayomiSettings,
  importSuwayomiLibrary,
  removeSuwayomiSettings,
  saveSuwayomiSettings,
  testSuwayomiConnection,
  type SuwayomiSettings,
} from '@projekt-manga/api-client';
import { ActionButton } from '@/components/settings/field-controls';
import { useConfirm } from '@/hooks/use-confirm';
import { queryClient, queryKeys } from '@/lib/query-client';

const DEFAULT_URL = 'http://127.0.0.1:4567';

const INPUT =
  'w-full rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary/60';

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** Discover lists the server's sources, so any change has to show up there. */
const refreshSources = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.sources }),
    queryClient.invalidateQueries({ queryKey: ['suwayomi'] }),
  ]);

/**
 * Settings › Extensions › Suwayomi server: use the Mihon sources installed on a Suwayomi
 * server as sources here.
 *
 * The password is write-only: the server stores it encrypted and only says one is saved,
 * so the field starts empty, is cleared after a save, and leaving it empty keeps it.
 */
export function SuwayomiServer() {
  const [saved, setSaved] = useState<SuwayomiSettings | null | undefined>(undefined);
  const [unavailable, setUnavailable] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [url, setUrl] = useState(DEFAULT_URL);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const { confirm, dialog } = useConfirm();
  const [message, setMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    getSuwayomiSettings(controller.signal)
      .then((settings) => {
        setSaved(settings);
        if (settings) {
          setEnabled(settings.enabled);
          setUrl(settings.url);
          setUsername(settings.username ?? '');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setUnavailable(true);
      });
    return () => controller.abort();
  }, []);

  if (unavailable)
    return (
      <p className="text-xs text-muted-foreground">
        Connecting a Suwayomi server needs administrator access to a server that supports it.
      </p>
    );
  if (saved === undefined) return null;

  const act = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (error) {
      setMessage(errorText(error, fallback));
    } finally {
      // The password never stays on screen, saved or not.
      setPassword('');
      setBusy(false);
    }
  };

  const save = (clearPassword = false) =>
    act(async () => {
      const next = await saveSuwayomiSettings({
        enabled,
        url: url.trim(),
        username: username.trim() || null,
        ...(password ? { password } : {}),
        ...(clearPassword ? { clear_password: true } : {}),
      });
      setSaved(next);
      await refreshSources();
      if (!next.enabled) {
        setMessage('Saved. Its sources are hidden while the connection is off.');
        return;
      }
      try {
        const found = await testSuwayomiConnection();
        setMessage(
          `Saved. Connected to ${found.name}${found.version ? ` ${found.version}` : ''}: ${found.sources} ${found.sources === 1 ? 'source' : 'sources'}.`,
        );
      } catch (error) {
        setMessage(`Saved, but the server didn't answer: ${errorText(error, 'unknown error')}`);
      }
    }, "Couldn't save the Suwayomi server.");

  const test = () =>
    act(async () => {
      setTesting(true);
      const found = await testSuwayomiConnection().finally(() => setTesting(false));
      setMessage(
        `Connected to ${found.name}${found.version ? ` ${found.version}` : ''}: ${found.sources} ${found.sources === 1 ? 'source' : 'sources'}.`,
      );
      await refreshSources();
    }, "Couldn't reach the Suwayomi server.");

  const importLibrary = () =>
    act(async () => {
      const { titles } = await importSuwayomiLibrary();
      setMessage(
        titles
          ? `Importing ${titles} ${titles === 1 ? 'title' : 'titles'}, with their read progress. They appear in your library shortly.`
          : 'Suwayomi has no library titles to import.',
      );
    }, "Couldn't import the Suwayomi library.");

  const remove = async () => {
    // Titles from this server use its own ids, so they stop opening without it.
    const removing = await confirm({
      title: 'Remove this Suwayomi server?',
      description:
        'Titles added from its sources stay in your library but can’t open until a server with the same data is connected. Reinstalling Suwayomi or wiping its data changes those ids too, so migrate them to another source first.',
      confirmLabel: 'Remove server',
    });
    if (!removing) return;
    await act(async () => {
      await removeSuwayomiSettings();
      setSaved(null);
      setEnabled(true);
      setUrl(DEFAULT_URL);
      setUsername('');
      setMessage('Removed.');
      await refreshSources();
    }, "Couldn't remove the Suwayomi server.");
  };

  const passwordSaved = Boolean(saved?.has_password);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Browse, search and read the Mihon sources installed on your Suwayomi server. They appear in
        Discover beside your extensions; install and update them in Suwayomi.
      </p>

      {saved?.has_password && !saved.password_readable && (
        <p role="alert" className="text-xs text-destructive">
          The saved password can no longer be read on this server. Enter it again.
        </p>
      )}

      <form
        aria-label="Suwayomi server"
        className="space-y-2 rounded-xl border border-border/60 bg-background/40 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Use this server&apos;s sources
        </label>
        <input
          aria-label="Server address"
          placeholder={DEFAULT_URL}
          type="url"
          required
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          className={INPUT}
        />
        <p className="text-[11px] text-muted-foreground">
          The address Suwayomi&apos;s web interface opens on. It can be this computer or one on your
          network.
        </p>
        <input
          aria-label="Username (optional)"
          placeholder="Username (only if Suwayomi uses basic authentication)"
          autoComplete="off"
          spellCheck={false}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className={INPUT}
        />
        {username.trim() && (
          <>
            <input
              aria-label="Password"
              aria-describedby="suwayomi-password-note"
              placeholder={
                passwordSaved ? 'A password is saved. Type a new one to replace it' : 'Password'
              }
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={INPUT}
            />
            <p id="suwayomi-password-note" className="text-[11px] text-muted-foreground">
              {passwordSaved
                ? 'Your password is stored encrypted and is never shown again. Leave this empty to keep it.'
                : 'The password is stored encrypted on the server and is never shown again after saving.'}
            </p>
          </>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {saved && (
            <ActionButton variant="destructive" disabled={busy} onClick={() => void remove()}>
              Remove server
            </ActionButton>
          )}
          {passwordSaved && (
            <ActionButton disabled={busy} onClick={() => void save(true)}>
              Remove password
            </ActionButton>
          )}
          {saved?.enabled && (
            <ActionButton disabled={busy} onClick={() => void importLibrary()}>
              Import library
            </ActionButton>
          )}
          {saved?.enabled && (
            <ActionButton disabled={busy} onClick={() => void test()}>
              {testing ? 'Testing…' : 'Test connection'}
            </ActionButton>
          )}
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy && !testing ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
      {dialog}
    </div>
  );
}
