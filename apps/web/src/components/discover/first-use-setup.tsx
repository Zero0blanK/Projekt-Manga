'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { EMPTY_IDS, useProfilePreference } from '@/lib/profile-preferences';
import { extensionActions, useExtensionRepositories } from '@/lib/extensions-store';
import { toast } from '@/hooks/use-toast';
import { useMangaLibrary } from '@/lib/library-store';
const LANGUAGES = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['pt-br', 'Brazilian Portuguese'],
  ['fr', 'French'],
  ['id', 'Indonesian'],
  ['ru', 'Russian'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
] as const;
type Setup = { step: number; languages: string[]; dismissed: boolean };
const defaults: Setup = { step: 0, languages: [], dismissed: false };
const STEPS = ['Languages', 'Repository', 'Sources', 'First title'];
const NEXT_BUTTON =
  'rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50';
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
  const { manga: library } = useMangaLibrary();
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
      toast({ description: "Couldn't add that repository. Check its URL and try again." });
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
      <ol className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
        {STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={index === setup.step ? 'step' : undefined}
            className={`border-t-2 pt-1 text-xs ${
              index <= setup.step
                ? 'border-primary text-foreground'
                : 'border-border text-muted-foreground'
            }`}
          >
            {label}
          </li>
        ))}
      </ol>
      {setup.step === 0 && (
        <>
          <fieldset className="mt-3">
            <legend className="text-sm">Choose your reading languages.</legend>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              {LANGUAGES.map(([code, label]) => (
                <label
                  key={code}
                  className="flex items-center gap-2 text-sm pointer-coarse:min-h-9"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={setup.languages.includes(code)}
                    onChange={() =>
                      setSetup((current) => ({
                        ...current,
                        languages: current.languages.includes(code)
                          ? current.languages.filter((lang) => lang !== code)
                          : [...current.languages, code],
                      }))
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <button
            type="button"
            className={`mt-3 ${NEXT_BUTTON}`}
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
            Sources come from repositories. Paste the index URL of one whose maintainer you trust,
            or skip this and add one later.
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
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <button
              type="button"
              disabled={busy || !url.trim()}
              className={NEXT_BUTTON}
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
            <button
              type="button"
              className="text-sm text-muted-foreground hover:text-foreground"
              onClick={() => setSetup((current) => ({ ...current, step: 2 }))}
            >
              Skip for now
            </button>
          </div>
        </>
      )}
      {setup.step === 2 && (
        <>
          <p className="mt-3 text-sm">
            Install sources from the catalog below. Choose one matching your languages; a failed
            install can be retried there.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <a href="#source-catalog" className="text-sm text-primary">
              Choose sources
            </a>
            <button
              type="button"
              className={NEXT_BUTTON}
              onClick={() => setSetup((current) => ({ ...current, step: 3 }))}
            >
              {installedCount > 0 ? `Continue with ${installedCount} installed` : 'Skip for now'}
            </button>
          </div>
        </>
      )}
      {setup.step === 3 && (
        <>
          <p className="mt-3 text-sm">
            {library.length > 0
              ? `You're set: ${library.length} ${library.length === 1 ? 'title is' : 'titles are'} in your library.`
              : installedCount > 0
                ? 'Open Popular or Latest on an installed source, then add your first title from its preview.'
                : 'Once a source is installed, add your first title from its preview.'}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <Link href="/discover?tab=installed" className={NEXT_BUTTON}>
              Browse installed sources
            </Link>
            <button
              type="button"
              className="text-sm text-primary"
              onClick={() => setSetup((current) => ({ ...current, dismissed: true }))}
            >
              Finish setup
            </button>
          </div>
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
