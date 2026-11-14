'use client';

import { useEffect, useState } from 'react';
import {
  downloadLocalTranslation,
  getLocalTranslationStatus,
  getTranslateSettings,
  getTranslateStatus,
  removeTranslateSettings,
  saveTranslateSettings,
  type LocalTranslationStatus,
  type TranslateSettings,
  type TranslateStatus,
} from '@projekt-manga/api-client';
import { ActionButton, LoadingBlock } from '@/components/settings/field-controls';
import { forgetTranslationStatus } from '@/lib/page-translation';

type Provider = TranslateSettings['provider'];

const PROVIDERS: Array<{ provider: Provider; label: string; help: string }> = [
  {
    provider: 'deepl',
    label: 'DeepL',
    help: 'Your DeepL API key (Account › API keys). Keys ending in :fx use the free API.',
  },
  {
    provider: 'libretranslate',
    label: 'LibreTranslate',
    help: 'The address of a LibreTranslate instance, e.g. http://localhost:5000, and its API key if it asks for one.',
  },
];

const INPUT =
  'w-full rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary/60';

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/**
 * Translation on this server: manga-ocr reads the bubbles and Opus-MT translates them to
 * English, with models downloaded once (about 230 MB). Shows whether they are in, and the
 * download while it runs.
 */
function LocalTranslation({ active }: { active: boolean }) {
  const [local, setLocal] = useState<LocalTranslationStatus | null | undefined>(undefined);
  const [failed, setFailed] = useState('');

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () =>
      getLocalTranslationStatus()
        .then((next) => {
          if (stopped) return;
          setLocal(next);
          if (next.enabled && next.state === 'downloading') timer = setTimeout(poll, 1500);
        })
        .catch(() => !stopped && setLocal(null));
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [local?.enabled && local.state === 'downloading']);

  // A server from before local translation, or one whose host turned it off.
  if (local === undefined || local === null || !local.enabled) return null;

  const download = () => {
    setFailed('');
    downloadLocalTranslation()
      .then(setLocal)
      .catch((error: unknown) => setFailed(errorText(error, "Couldn't start the download.")));
  };

  return (
    <section
      aria-label="Translate on this computer"
      className="space-y-2 rounded-xl border border-border/60 bg-background/40 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">Translate on this computer</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            manga-ocr reads the speech bubbles and Opus-MT translates them into English, on this
            server. No account or key, and nothing goes to another service.
            {active ? ' In use for English.' : ''}
          </p>
        </div>
        {(local.state === 'missing' || local.state === 'error') && (
          <ActionButton onClick={download}>Download ({megabytes(local.size)})</ActionButton>
        )}
      </div>
      {local.state === 'ready' && (
        <p className="text-xs text-muted-foreground">Models downloaded and ready.</p>
      )}
      {local.state === 'missing' && (
        <p className="text-xs text-muted-foreground">
          The models download once, the first time you translate a page, or now.
        </p>
      )}
      {local.state === 'downloading' && (
        <div role="status" className="space-y-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${Math.round((local.downloaded / local.total) * 100)}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Downloading the models: {megabytes(local.downloaded)} of {megabytes(local.total)}
          </p>
        </div>
      )}
      {(local.state === 'error' || failed) && (
        <p role="alert" className="text-xs text-destructive">
          {failed || (local.state === 'error' ? local.message : '')}
        </p>
      )}
    </section>
  );
}

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * Settings › Reader › Page translation: the reader's own machine-translation service.
 *
 * The API key is write-only. The server stores it encrypted and only ever says that one is
 * saved, so the field starts empty every time, is cleared after a save, and leaving it
 * empty keeps the saved key.
 */
export function TranslationService() {
  const [saved, setSaved] = useState<TranslateSettings | null | undefined>(undefined);
  const [status, setStatus] = useState<TranslateStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [provider, setProvider] = useState<Provider>('deepl');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refreshStatus = () => {
    forgetTranslationStatus();
    getTranslateStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  };

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([getTranslateSettings(controller.signal), getTranslateStatus(controller.signal)])
      .then(([settings, current]) => {
        setSaved(settings);
        setStatus(current);
        if (settings) {
          setProvider(settings.provider);
          setUrl(settings.url ?? '');
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
        Saving a translation service needs a server that supports it.
      </p>
    );
  if (saved === undefined) return <LoadingBlock label="Loading the translation service" rows={3} />;

  const act = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (error) {
      setMessage(errorText(error, fallback));
    } finally {
      // The key never stays on screen, saved or not.
      setApiKey('');
      setBusy(false);
    }
  };

  const save = (clearKey = false) =>
    act(async () => {
      const next = await saveTranslateSettings({
        provider,
        ...(url.trim() ? { url: url.trim() } : {}),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        ...(clearKey ? { clear_api_key: true } : {}),
      });
      setSaved(next);
      setMessage(clearKey ? 'API key removed.' : 'Saved.');
      refreshStatus();
    }, "Couldn't save the translation service.");

  const remove = () =>
    act(async () => {
      await removeTranslateSettings();
      setSaved(null);
      setUrl('');
      setMessage('Removed.');
      refreshStatus();
    }, "Couldn't remove the translation service.");

  const keySaved = saved?.provider === provider && saved.has_key;
  const current = PROVIDERS.find((p) => p.provider === provider)!;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {saved
          ? `Pages are translated with your ${PROVIDERS.find((p) => p.provider === saved.provider)?.label} service.`
          : status?.server_configured
            ? 'Pages are translated with the service this server provides. Add your own to use it instead.'
            : status?.provider === 'local'
              ? 'Pages are translated into English on this server. For other languages, add DeepL or LibreTranslate below.'
              : 'No translation service yet. Add one to use Translate page in the reader.'}{' '}
        A DeepL or LibreTranslate service only ever gets the text read off a page, never the image.
      </p>

      <LocalTranslation active={status?.provider === 'local'} />

      {saved?.has_key && !saved.key_readable && (
        <p role="alert" className="text-xs text-destructive">
          The saved API key can no longer be read on this server. Enter it again.
        </p>
      )}

      <form
        aria-label="Translation service"
        className="space-y-2 rounded-xl border border-border/60 bg-background/40 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Service">
          {PROVIDERS.map((option) => (
            <button
              key={option.provider}
              type="button"
              role="radio"
              aria-checked={provider === option.provider}
              onClick={() => setProvider(option.provider)}
              className={`rounded-full border px-3 py-1 text-xs ${
                provider === option.provider
                  ? 'border-primary/60 bg-primary/10 text-primary'
                  : 'border-border/60 text-muted-foreground'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{current.help}</p>
        <input
          aria-label={provider === 'deepl' ? 'Service address (optional)' : 'Service address'}
          placeholder={
            provider === 'deepl' ? 'Chosen from the key (optional)' : 'http://localhost:5000'
          }
          type="url"
          required={provider === 'libretranslate'}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          className={INPUT}
        />
        <input
          aria-label={provider === 'deepl' ? 'API key' : 'API key (optional)'}
          aria-describedby="translation-key-note"
          placeholder={
            keySaved
              ? 'A key is saved. Type a new one to replace it'
              : provider === 'deepl'
                ? 'API key'
                : 'API key (optional)'
          }
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          required={provider === 'deepl' && !keySaved}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          className={INPUT}
        />
        <p id="translation-key-note" className="text-xs text-muted-foreground">
          {keySaved
            ? 'Your key is stored encrypted and is never shown again. Leave this empty to keep it.'
            : 'The key is stored encrypted on the server and is never shown again after saving.'}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          {saved && (
            <ActionButton variant="destructive" disabled={busy} onClick={() => void remove()}>
              Remove service
            </ActionButton>
          )}
          {keySaved && provider === 'libretranslate' && (
            <ActionButton disabled={busy} onClick={() => void save(true)}>
              Remove key
            </ActionButton>
          )}
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
}
