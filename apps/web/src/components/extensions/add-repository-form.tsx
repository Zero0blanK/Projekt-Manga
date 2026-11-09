'use client';

import { useId, useState } from 'react';
import { ApiError } from '@projekt-manga/api-client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';
import { extensionActions } from '@/lib/extensions-store';
import { repositoryUrlProblem } from '@/lib/repository-url';

function addFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400 || error.status === 422)
      return "That address didn't return a repository. It should point at the repository's index.json.";
    if (error.status === 0)
      return "Couldn't reach that address. Check the connection and try again.";
    return error.message;
  }
  return "Couldn't add that repository.";
}

/**
 * The repository field shared by Settings and the empty source catalog, so a first
 * repository can be added in place. Problems are shown under the field rather than in a
 * toast.
 */
export function AddRepositoryForm({
  onAdded,
  compact = false,
}: {
  onAdded?: () => void;
  compact?: boolean;
}) {
  const inputId = useId();
  const errorId = useId();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const add = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    const invalid = repositoryUrlProblem(trimmed);
    if (invalid) {
      setProblem(invalid);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await extensionActions.addRepository(trimmed);
      // Cleared only on success, so a rejected URL stays in the box to be corrected.
      setUrl('');
      toast({ description: 'Repository added. Its sources are ready to install.' });
      onAdded?.();
    } catch (error) {
      setProblem(addFailure(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={compact ? 'mx-auto max-w-md text-left' : ''}>
      <label htmlFor={inputId} className="text-xs font-medium text-foreground">
        Repository address
      </label>
      <div className="mt-1.5 flex gap-2">
        <Input
          id={inputId}
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setProblem(null);
          }}
          placeholder="https://example.com/repo/index.json"
          inputMode="url"
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? errorId : undefined}
          className="h-9 min-w-0 flex-1 text-xs sm:w-72 sm:flex-none"
          onKeyDown={(event) => event.key === 'Enter' && void add(url)}
        />
        <Button size="sm" onClick={() => void add(url)} disabled={busy || !url.trim()}>
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>
      {problem && (
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
