'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  cancelExtensionEngineDownload,
  checkExtensionEngineUpdates,
  getExtensionEngine,
  getExtensionEngineRepositories,
  getSuwayomiSettings,
  installExtensionEngine,
  removeExtensionEngine,
  saveExtensionEngineRepositories,
  saveExtensionEngineSettings,
  setSuwayomiMode,
  startExtensionEngine,
  stopExtensionEngine,
  updateExtensionEngine,
  type ExtensionEngineStatus,
  type SuwayomiMode,
} from '@projekt-manga/api-client';
import { ActionButton, LoadingBlock, ToggleSwitch } from '@/components/settings/field-controls';
import { SuwayomiServer } from '@/components/settings/suwayomi-server';
import { SelectMenu } from '@/components/ui/select-menu';
import { useConfirm } from '@/hooks/use-confirm';
import { describeLoadError } from '@/lib/load-error';
import { queryClient, queryKeys } from '@/lib/query-client';

/**
 * Settings › Extensions › Extension engine: where Suwayomi sources (Keiyoushi extensions,
 * for one) come from. The built-in engine is downloaded and run by this app's server, out
 * of sight; "My own Suwayomi server" connects one the user already runs.
 */

const SETTINGS_KEY = ['suwayomi', 'settings'] as const;
const ENGINE_KEY = ['suwayomi', 'engine'] as const;
const REPOSITORIES_KEY = ['suwayomi', 'engine', 'repositories'] as const;

const INPUT =
  'w-full rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary/60';

const MODES: Array<{ value: SuwayomiMode; label: string }> = [
  { value: 'built-in', label: 'Built-in engine' },
  { value: 'external', label: 'My own Suwayomi server' },
  { value: 'off', label: 'Off' },
];

const MEMORY_OPTIONS = [512, 768, 1024, 1536, 2048, 4096];

const STEP_LABELS: Record<string, string> = {
  runtime: 'Downloading the Java runtime',
  server: 'Downloading the engine',
  verifying: 'Checking the download',
  unpacking: 'Unpacking the Java runtime',
  finishing: 'Finishing',
};

const STATE_LABELS: Record<ExtensionEngineStatus['state'], string> = {
  'not-installed': 'Not installed',
  downloading: 'Downloading',
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  error: 'Not working',
};

const errorText = (error: unknown, fallback: string) =>
  describeLoadError(error) ?? (error instanceof Error && error.message ? error.message : fallback);

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Sources come from the engine: anything that lists them reads again. Not the engine's
 * own status and repositories, which the action that called this has just set. */
const refreshSources = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.sources }),
    queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] === 'suwayomi' && query.queryKey[1] !== 'engine',
    }),
  ]);

export function ExtensionEngine() {
  const settings = useQuery(
    {
      queryKey: SETTINGS_KEY,
      queryFn: ({ signal }) => getSuwayomiSettings(signal),
      retry: false,
    },
    queryClient,
  );
  // "My own server" shows its form before anything is saved; the choice is saved with it.
  const [shown, setShown] = useState<SuwayomiMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  if (settings.isError) {
    return (
      <p className="text-xs text-muted-foreground">
        The extension engine needs administrator access to a server that supports it.
      </p>
    );
  }
  if (settings.isPending) return <LoadingBlock label="Loading the extension engine settings" />;

  const saved = settings.data?.mode ?? 'off';
  const mode = shown ?? saved;

  const choose = async (next: SuwayomiMode) => {
    setMessage('');
    setShown(next);
    // The external server is chosen by saving its address, unless one is already saved.
    if (next === 'external' && !settings.data?.url) return;
    setBusy(true);
    try {
      await setSuwayomiMode(next);
      await refreshSources();
    } catch (error) {
      setShown(null);
      setMessage(errorText(error, "Couldn't change where sources come from."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Suwayomi extensions, such as Keiyoushi&apos;s, appear in Discover beside your other sources.
        They run in an extension engine: the built-in one, which this app downloads and runs for
        you, or a Suwayomi server you run yourself.
      </p>
      <div role="radiogroup" aria-label="Extension engine" className="flex flex-wrap gap-1.5">
        {MODES.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={mode === option.value}
            disabled={busy}
            onClick={() => void choose(option.value)}
            className={`rounded-full border px-3 py-1.5 text-xs transition disabled:opacity-50 ${
              mode === option.value
                ? 'border-primary/50 bg-primary/10 text-primary'
                : 'border-border/60 text-muted-foreground hover:text-foreground'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {message && (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
      )}
      {mode === 'built-in' && <BuiltInEngine chosen={saved === 'built-in'} />}
      {mode === 'external' && <SuwayomiServer />}
      {mode === 'off' && (
        <p className="text-xs text-muted-foreground">No Suwayomi sources are shown.</p>
      )}
    </div>
  );
}

function BuiltInEngine({ chosen }: { chosen: boolean }) {
  const engine = useQuery(
    {
      queryKey: ENGINE_KEY,
      queryFn: ({ signal }) => getExtensionEngine(signal),
      retry: false,
      // The library stream says when it changes; while something is under way this also
      // reads it every second, in case that stream is down.
      refetchInterval: (query) =>
        query.state.data?.state === 'downloading' || query.state.data?.state === 'starting'
          ? 1000
          : false,
    },
    queryClient,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [removeData, setRemoveData] = useState(false);
  const { confirm, dialog } = useConfirm();

  if (engine.isError) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {errorText(engine.error, "Couldn't read the extension engine's status.")}
      </p>
    );
  }
  if (!engine.data) return <LoadingBlock label="Loading the extension engine" />;
  const status = engine.data;

  const act = async (
    work: () => Promise<ExtensionEngineStatus>,
    fallback: string,
    done?: string | ((next: ExtensionEngineStatus) => string | undefined),
  ) => {
    setBusy(true);
    setMessage('');
    try {
      const next = await work();
      queryClient.setQueryData(ENGINE_KEY, next);
      const text = typeof done === 'function' ? done(next) : done;
      if (text) setMessage(text);
      await refreshSources();
    } catch (error) {
      setMessage(errorText(error, fallback));
      await queryClient.invalidateQueries({ queryKey: ENGINE_KEY });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const removing = await confirm({
      title: 'Remove the extension engine?',
      description: removeData
        ? 'Its Java runtime, the engine, and its extensions with their settings are deleted. Titles added from its sources stay in your library but can’t open until the engine and those extensions are back.'
        : 'Its Java runtime and the engine are deleted. Its extensions and their settings are kept, for when you download it again.',
      confirmLabel: 'Remove engine',
    });
    if (!removing) return;
    await act(() => removeExtensionEngine(!removeData), "Couldn't remove the extension engine.");
  };

  if (!status.supported) {
    return (
      <p className="text-xs text-muted-foreground">
        No Java runtime is published for this computer, so the built-in engine can&apos;t run here.
        You can still connect your own Suwayomi server.
      </p>
    );
  }

  const download = status.download;
  const percent =
    download?.total && download.total > 0
      ? Math.min(100, Math.round((download.received / download.total) * 100))
      : null;

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-background/40 p-4">
      {status.state === 'not-installed' && (
        <div className="space-y-2">
          <p className="text-sm">
            The built-in engine runs Suwayomi extensions on this computer, out of sight: no separate
            app, window or tray icon.
          </p>
          <p className="text-xs text-muted-foreground">
            It downloads a Java runtime and the engine, about 235 MB, and needs about 350 MB of disk
            space, more as you add extensions. Both come unmodified from their publishers, and
            nothing updates on its own: you choose when to check for updates.
          </p>
          <p className="text-xs text-muted-foreground">
            Licenses:{' '}
            {status.licenses.map((item, index) => (
              <span key={item.name}>
                {index > 0 && ', '}
                <a href={item.url} target="_blank" rel="noreferrer" className="underline">
                  {item.name}
                </a>{' '}
                ({item.license})
              </span>
            ))}
          </p>
          {status.error && (
            <p role="alert" className="text-xs text-destructive">
              The download didn&apos;t finish: {status.error}
            </p>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(installExtensionEngine, "Couldn't start the extension engine download.")
              }
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              Download
            </button>
          </div>
        </div>
      )}

      {status.state === 'downloading' && (
        <div className="space-y-2">
          <p className="text-sm" role="status">
            {STEP_LABELS[download?.step ?? 'runtime'] ?? 'Downloading'}
            {percent !== null ? `: ${percent}%` : '…'}
          </p>
          <div
            role="progressbar"
            aria-label="Extension engine download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={`h-full bg-primary transition-all ${percent === null ? 'w-1/3 animate-pulse' : ''}`}
              style={percent !== null ? { width: `${percent}%` } : undefined}
            />
          </div>
          <div className="flex justify-end">
            <ActionButton
              disabled={busy}
              onClick={() =>
                void act(cancelExtensionEngineDownload, "Couldn't cancel the download.")
              }
            >
              Cancel
            </ActionButton>
          </div>
        </div>
      )}

      {status.installed && status.state !== 'downloading' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm">
              <span className="font-medium">{STATE_LABELS[status.state]}</span>
              <span className="text-xs text-muted-foreground">
                {' '}
                · engine {status.installed.server} · Java {status.installed.runtime} ·{' '}
                {megabytes(status.diskBytes)} on disk
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              {status.state === 'running' || status.state === 'starting' ? (
                <ActionButton
                  disabled={busy}
                  onClick={() => void act(stopExtensionEngine, "Couldn't stop the engine.")}
                >
                  Stop
                </ActionButton>
              ) : (
                <ActionButton
                  disabled={busy}
                  onClick={() => void act(startExtensionEngine, "Couldn't start the engine.")}
                >
                  Start
                </ActionButton>
              )}
              {status.update ? (
                <ActionButton
                  disabled={busy}
                  onClick={() => void act(updateExtensionEngine, "Couldn't start the update.")}
                >
                  Update to {status.update.server}
                </ActionButton>
              ) : (
                <ActionButton
                  disabled={busy}
                  onClick={() =>
                    void act(checkExtensionEngineUpdates, "Couldn't check for updates.", (next) =>
                      next.update ? undefined : 'You have the latest versions.',
                    )
                  }
                >
                  Check for updates
                </ActionButton>
              )}
            </div>
          </div>
          {!chosen && (
            <p className="text-xs text-muted-foreground">
              Installed, but another choice above is in use.
            </p>
          )}
          {status.state === 'error' && (
            <div role="alert" className="space-y-1">
              <p className="text-xs text-destructive">{status.error ?? 'The engine stopped.'}</p>
              {status.lastLines.length > 0 && (
                <pre className="max-h-40 overflow-auto rounded-lg bg-muted/40 p-2 text-[11px] leading-snug text-muted-foreground">
                  {status.lastLines.join('\n')}
                </pre>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-3">
            <label className="flex items-center gap-2 text-xs">
              <ToggleSwitch
                label="Start with the app"
                on={status.startWithServer !== false}
                disabled={busy}
                onToggle={() =>
                  void act(
                    () =>
                      saveExtensionEngineSettings({
                        start_with_server: status.startWithServer === false,
                      }),
                    "Couldn't save the setting.",
                  )
                }
              />
              Start with the app
            </label>
            <div className="flex items-center gap-2 text-xs">
              Memory limit
              <SelectMenu
                label="Memory limit"
                value={String(status.memoryMb ?? 512)}
                options={MEMORY_OPTIONS.map((mb) => ({ value: String(mb), label: `${mb} MB` }))}
                onChange={(value) =>
                  void act(
                    () => saveExtensionEngineSettings({ memory_mb: Number(value) }),
                    "Couldn't save the memory limit.",
                    'Saved. It applies the next time the engine starts.',
                  )
                }
                className="min-w-28"
              />
            </div>
          </div>

          {status.state === 'running' && <EngineRepositories />}

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border/40 pt-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={removeData}
                onChange={(event) => setRemoveData(event.target.checked)}
              />
              Also remove its extensions and their settings
            </label>
            <ActionButton variant="destructive" disabled={busy} onClick={() => void remove()}>
              Remove engine
            </ActionButton>
          </div>
        </div>
      )}

      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
      {dialog}
    </div>
  );
}

/** The engine's extension repositories. None is built in: the user adds index URLs. */
function EngineRepositories() {
  const repositories = useQuery(
    {
      queryKey: REPOSITORIES_KEY,
      queryFn: ({ signal }) => getExtensionEngineRepositories(signal),
      retry: false,
    },
    queryClient,
  );
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const save = async (next: string[], done: string) => {
    setBusy(true);
    setMessage('');
    try {
      const saved = await saveExtensionEngineRepositories(next);
      queryClient.setQueryData(REPOSITORIES_KEY, saved);
      setMessage(done);
      setUrl('');
      await refreshSources();
    } catch (error) {
      setMessage(errorText(error, "Couldn't save the repositories."));
    } finally {
      setBusy(false);
    }
  };

  const current = repositories.data ?? [];
  return (
    <div className="space-y-2 border-t border-border/40 pt-3">
      <p className="text-xs font-medium">Extension repositories</p>
      <p className="text-xs text-muted-foreground">
        The engine lists extensions from these. Add a repository&apos;s index URL; its extensions
        then appear in Discover › Add sources.
      </p>
      {repositories.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {errorText(repositories.error, "Couldn't read the repositories.")}
        </p>
      ) : repositories.isPending ? (
        <LoadingBlock label="Loading the repositories" rows={1} />
      ) : current.length === 0 ? (
        <p className="text-xs text-muted-foreground">No repositories yet.</p>
      ) : (
        <ul className="space-y-1">
          {current.map((repository) => (
            <li key={repository.url} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0">
                <span className="font-medium">{repository.name}</span>
                <span className="block truncate text-muted-foreground">{repository.url}</span>
              </span>
              <ActionButton
                disabled={busy}
                onClick={() =>
                  void save(
                    current.filter((item) => item.url !== repository.url).map((item) => item.url),
                    `Removed ${repository.name}.`,
                  )
                }
              >
                Remove
              </ActionButton>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const next = url.trim();
          if (!next) return;
          void save([...current.map((item) => item.url), next], 'Repository added.');
        }}
      >
        <input
          aria-label="Repository URL"
          placeholder="https://…/index.min.json"
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          className={INPUT}
        />
        <button
          type="submit"
          disabled={busy || !url.trim()}
          className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
      </form>
      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
}
