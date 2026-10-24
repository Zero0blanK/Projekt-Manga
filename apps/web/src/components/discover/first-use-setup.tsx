'use client';
import { useEffect, useRef, useState } from 'react';
import { EMPTY_IDS, useProfilePreference } from '@/lib/profile-preferences';
import { extensionActions, useExtensionRepositories } from '@/lib/extensions-store';
import { toast } from '@/hooks/use-toast';
type Setup = { step: number; languages: string[]; dismissed: boolean };
const defaults: Setup = { step: 0, languages: [], dismissed: false };
function parseSetup(value: unknown): Setup {
  if (!value || typeof value !== 'object') return defaults;
  const data = value as Partial<Setup>;
  return {
    step:
      typeof data.step === 'number' &&
      Number.isInteger(data.step) &&
      data.step >= 0 &&
      data.step <= 3
        ? data.step
        : 0,
    languages: Array.isArray(data.languages)
      ? data.languages.filter((entry): entry is string => typeof entry === 'string').slice(0, 20)
      : [],
    dismissed: data.dismissed === true,
  };
}
export function FirstUseSetup({
  installedCount,
  onLanguages,
}: {
  installedCount: number;
  onLanguages: (languages: string[]) => void;
}) {
  const [setup, setSetup] = useProfilePreference('sourceSetup', parseSetup, defaults);
  const { repositories } = useExtensionRepositories();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const committedLanguages = setup.step > 0 ? setup.languages : EMPTY_IDS;
  useEffect(() => {
    onLanguages(committedLanguages);
  }, [committedLanguages, onLanguages]);
  const addRepository = async () => {
    const nextUrl = url.trim();
    if (!nextUrl || submitting.current) return;
    if (repositories.some((repository) => repository.url === nextUrl)) {
      setSetup((current) => ({ ...current, step: 2 }));
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      await extensionActions.addRepository(nextUrl);
      setSetup((current) => ({ ...current, step: 2 }));
    } catch {
      toast({ description: 'Could not add that repository. Check its URL and try again.' });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  if (setup.dismissed)
    return (
      <button
        type="button"
        className="mt-3 text-xs text-primary"
        onClick={() => setSetup((current) => ({ ...current, dismissed: false }))}
      >
        Resume source setup
      </button>
    );
  return (
    <section className="mt-5 rounded-xl border border-border p-4" aria-label="Source setup">
      <div className="flex justify-between gap-3">
        <h2 className="font-semibold">Set up your reading sources</h2>
        <button
          type="button"
          className="text-xs text-primary"
          onClick={() => setSetup((current) => ({ ...current, dismissed: true }))}
        >
          Skip setup
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Step {setup.step + 1} of 4 · No account required. You can leave and resume later.
      </p>
      {setup.step === 0 && (
        <>
          <p className="mt-3 text-sm">Choose your reading languages.</p>
          <div className="mt-2 flex flex-wrap gap-3">
            {[
              ['en', 'English'],
              ['es', 'Spanish'],
              ['pt-br', 'Brazilian Portuguese'],
              ['fr', 'French'],
              ['id', 'Indonesian'],
              ['ru', 'Russian'],
            ].map(([code, label]) => (
              <label key={code} className="text-sm">
                <input
                  type="checkbox"
                  checked={setup.languages.includes(code)}
                  onChange={() =>
                    setSetup((current) => ({
                      ...current,
                      languages: current.languages.includes(code)
                        ? current.languages.filter((lang) => lang !== code)
                        : [...current.languages, code],
                    }))
                  }
                />{' '}
                {label}
              </label>
            ))}
          </div>
          <button
            type="button"
            className="mt-3 text-sm text-primary"
            onClick={() => {
              setSetup((current) => ({ ...current, step: 1 }));
            }}
          >
            Continue
          </button>
        </>
      )}
      {setup.step === 1 && (
        <>
          <p className="mt-3 text-sm">
            Add the index URL of a repository whose maintainer you trust.
          </p>
          <label className="mt-2 block text-xs">
            Repository index URL
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/index.json"
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
          <div className="mt-3 flex gap-4">
            <button
              type="button"
              disabled={busy || !url.trim()}
              className="text-sm text-primary disabled:opacity-50"
              onClick={() => void addRepository()}
            >
              {busy ? 'Adding…' : 'Add repository'}
            </button>
            {repositories.length > 0 && (
              <button
                type="button"
                className="text-sm text-primary"
                onClick={() => setSetup((current) => ({ ...current, step: 2 }))}
              >
                Use existing repositories
              </button>
            )}
          </div>
        </>
      )}
      {setup.step === 2 && (
        <>
          <p className="mt-3 text-sm">
            Install sources from the catalogue below. Choose a source matching your preferred
            languages; failed installs can be retried there.
          </p>
          <a href="#source-catalog" className="mt-2 inline-block text-sm text-primary">
            Choose sources
          </a>
          <button
            type="button"
            disabled={installedCount === 0}
            className="ml-4 text-sm text-primary disabled:opacity-50"
            onClick={() => setSetup((current) => ({ ...current, step: 3 }))}
          >
            Continue with {installedCount} installed
          </button>
        </>
      )}
      {setup.step === 3 && (
        <>
          <p className="mt-3 text-sm">
            Open Popular or Latest on a source below, or select sources for a search. Add your first
            title from its preview.
          </p>
          <button
            type="button"
            className="mt-2 text-sm text-primary"
            onClick={() => setSetup((current) => ({ ...current, dismissed: true }))}
          >
            Finish setup
          </button>
        </>
      )}
      {setup.step > 0 && (
        <button
          type="button"
          className="mt-3 block text-xs text-muted-foreground"
          onClick={() => setSetup((current) => ({ ...current, step: current.step - 1 }))}
        >
          Back
        </button>
      )}
    </section>
  );
}
