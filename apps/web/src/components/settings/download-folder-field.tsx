'use client';

import { useEffect, useState } from 'react';
import { toast } from '@/hooks/use-toast';
import {
  getDownloadDirectory,
  setDownloadDirectory,
  resetDownloadDirectory,
} from '@projekt-manga/api-client';
import { Field, FieldInput } from '@/components/settings/field-controls';

/**
 * Where the server writes downloaded chapters. This is a *server-side* filesystem path,
 * so it's typed in rather than picked with a file dialog — the browser's folder picker
 * only yields a sandboxed handle, never a real path the server could write to.
 */
export function DownloadFolderField() {
  const [saved, setSaved] = useState<string>('');
  const [value, setValue] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(false);
    getDownloadDirectory(controller.signal)
      .then(({ path }) => {
        setSaved(path);
        setValue(path);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [loadAttempt]);

  const apply = (action: Promise<{ path: string }>, successMessage: string) => {
    setBusy(true);
    action
      .then(({ path }) => {
        setSaved(path);
        setValue(path);
        setLoadError(false);
        toast({ description: successMessage });
      })
      .catch(() =>
        toast({
          description:
            "Couldn't update the download folder — check the path exists and is writable.",
        }),
      )
      .finally(() => setBusy(false));
  };

  const dirty = value.trim() !== saved && value.trim().length > 0;

  return (
    <Field
      label="Download folder"
      hint={
        loading
          ? 'Loading…'
          : loadError
            ? "Couldn't load the configured folder. Retry before changing it."
            : `Chapters are saved to ${saved || 'the default folder'}`
      }
    >
      <div className="flex flex-col items-end gap-2">
        <FieldInput
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={loading || busy}
          spellCheck={false}
          placeholder="C:\Users\you\Downloads\ProjektManga"
          className="font-mono text-[11px]"
        />
        <div className="flex items-center gap-3 text-[11px]">
          {loadError && (
            <button
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              disabled={loading || busy}
              className="font-medium text-primary transition hover:opacity-80 disabled:pointer-events-none disabled:opacity-40 pointer-coarse:inline-flex pointer-coarse:min-h-6 pointer-coarse:items-center"
            >
              Retry
            </button>
          )}
          <button
            onClick={() => apply(setDownloadDirectory(value.trim()), 'Download folder updated')}
            disabled={!dirty || busy}
            className="font-medium text-primary transition hover:opacity-80 disabled:pointer-events-none disabled:opacity-40 pointer-coarse:inline-flex pointer-coarse:min-h-6 pointer-coarse:items-center"
          >
            Save
          </button>
          <button
            onClick={() => apply(resetDownloadDirectory(), 'Download folder reset to default')}
            disabled={busy}
            className="text-muted-foreground transition hover:text-foreground disabled:opacity-40 pointer-coarse:inline-flex pointer-coarse:min-h-6 pointer-coarse:items-center"
          >
            Reset to default
          </button>
        </div>
      </div>
    </Field>
  );
}
