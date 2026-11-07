'use client';

import { useState, type FormEvent } from 'react';
import { ApiError, changePassword } from '@projekt-manga/api-client';
import { Field } from '@/components/settings/field-controls';
import { toast } from '@/hooks/use-toast';

const INPUT =
  'rounded-lg border border-border/60 bg-surface/40 px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50';

/** Changing a password signs out every other device, which is usually why it's being done. */
export function ChangePasswordField() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setCurrent('');
    setNext('');
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await changePassword(current, next);
      close();
      toast({ description: 'Password changed. Other devices were signed out.' });
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status && cause.status < 500
          ? cause.message
          : "Couldn't change your password. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Field label="Password" hint="Changing it signs out your other devices">
      {open ? (
        <form onSubmit={(event) => void submit(event)} className="grid w-full max-w-xs gap-2">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Current password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              className={INPUT}
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            New password
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={next}
              onChange={(event) => setNext(event.target.value)}
              className={INPUT}
            />
          </label>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Change password'}
            </button>
            <button
              type="button"
              onClick={close}
              className="rounded-lg border border-border/60 px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
        >
          Change password
        </button>
      )}
    </Field>
  );
}
