'use client';

import { desktopBridge } from '@/lib/desktop-bridge';
import { useEffect, useState } from 'react';
import { SelectMenu } from '@/components/ui/select-menu';
import { ActionButton, Field, Group, ToggleSwitch } from '@/components/settings/field-controls';
import { toast } from '@/hooks/use-toast';

type Envelope<T> = { success: boolean; message?: string; data?: T };
type LockState = { enabled: boolean; idleMinutes: number; locked: boolean };
type DesktopPrivacyBridge = {
  lock: {
    getState: () => Promise<Envelope<LockState>>;
    set: (input: {
      currentPin?: string;
      newPin: string;
      idleMinutes: number;
    }) => Promise<Envelope<LockState>>;
    clear: (input: { currentPin: string }) => Promise<Envelope<LockState>>;
    lockNow: () => Promise<Envelope<LockState>>;
  };
  capture: {
    getHidden: () => Promise<Envelope<boolean>>;
    setHidden: (hidden: boolean) => Promise<Envelope<boolean>>;
  };
};

function bridge(): DesktopPrivacyBridge | null {
  const desktop = desktopBridge<DesktopPrivacyBridge>();
  return desktop?.lock && desktop.capture ? (desktop as DesktopPrivacyBridge) : null;
}

const IDLE_OPTIONS = [
  { value: 0, label: 'Only when the app starts' },
  { value: 1, label: 'After 1 minute idle' },
  { value: 5, label: 'After 5 minutes idle' },
  { value: 15, label: 'After 15 minutes idle' },
  { value: 30, label: 'After 30 minutes idle' },
  { value: 60, label: 'After 1 hour idle' },
];

const INPUT =
  'w-full rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary/60 sm:w-56';

/**
 * Settings › Privacy, desktop app only: the app lock and hiding the window from screen
 * capture. Renders nothing in a browser, which has neither.
 */
export function DesktopPrivacyControls() {
  const [desktop, setDesktop] = useState<DesktopPrivacyBridge | null>(null);
  const [lock, setLock] = useState<LockState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [mode, setMode] = useState<'idle' | 'set' | 'change' | 'clear'>('idle');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [idleMinutes, setIdleMinutes] = useState(5);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const found = bridge();
    if (!found) return;
    setDesktop(found);
    void found.lock.getState().then((result) => {
      if (result.data) {
        setLock(result.data);
        setIdleMinutes(result.data.enabled ? result.data.idleMinutes : 5);
      }
    });
    void found.capture.getHidden().then((result) => setHidden(result.data === true));
  }, []);

  if (!desktop) return null;

  const reset = () => {
    setMode('idle');
    setCurrentPin('');
    setNewPin('');
    setConfirmPin('');
    setMessage('');
  };

  const submit = async () => {
    if (mode !== 'clear' && newPin !== confirmPin) {
      setMessage("The two entries don't match.");
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const result =
        mode === 'clear'
          ? await desktop.lock.clear({ currentPin })
          : await desktop.lock.set({
              ...(lock?.enabled && { currentPin }),
              newPin,
              idleMinutes,
            });
      if (!result.success || !result.data) {
        setMessage(result.message ?? 'Not saved.');
        return;
      }
      setLock(result.data);
      reset();
      toast({ description: result.data.enabled ? 'App lock saved.' : 'App lock turned off.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Group label="Desktop app" />
      <Field
        label="Hide from screen capture"
        hint="Screenshots and screen sharing show the app's windows as blank, where the system allows"
      >
        <ToggleSwitch
          on={hidden}
          label="Hide Projekt Manga from screenshots and screen sharing"
          onToggle={() =>
            void desktop.capture
              .setHidden(!hidden)
              .then((result) => setHidden(result.data === true))
              .catch(() =>
                toast({ variant: 'destructive', description: "Couldn't change this setting." }),
              )
          }
        />
      </Field>
      <Field
        label="App lock"
        hint={
          lock?.enabled
            ? `On: asks for your PIN ${IDLE_OPTIONS.find((o) => o.value === lock.idleMinutes)?.label.toLowerCase() ?? 'on start'}`
            : "Asks for a PIN or password to open the app. It keeps people at this computer out of the app; it doesn't encrypt your library"
        }
      >
        <div className="flex flex-wrap justify-end gap-2">
          {!lock?.enabled && mode === 'idle' && (
            <ActionButton onClick={() => setMode('set')}>Set a PIN</ActionButton>
          )}
          {lock?.enabled && mode === 'idle' && (
            <>
              <ActionButton onClick={() => void desktop.lock.lockNow()}>Lock now</ActionButton>
              <ActionButton onClick={() => setMode('change')}>Change</ActionButton>
              <ActionButton onClick={() => setMode('clear')}>Turn off</ActionButton>
            </>
          )}
        </div>
      </Field>
      {mode !== 'idle' && (
        <form
          aria-label="App lock"
          className="space-y-2 rounded-xl border border-border/60 bg-background/40 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {lock?.enabled && (
            <label className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              Current PIN or password
              <input
                type="password"
                autoComplete="current-password"
                value={currentPin}
                onChange={(event) => setCurrentPin(event.target.value)}
                className={INPUT}
              />
            </label>
          )}
          {mode !== 'clear' && (
            <>
              <label className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                New PIN or password (6–64 characters)
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={6}
                  maxLength={64}
                  value={newPin}
                  onChange={(event) => setNewPin(event.target.value)}
                  className={INPUT}
                />
              </label>
              <label className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                Repeat it
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPin}
                  onChange={(event) => setConfirmPin(event.target.value)}
                  className={INPUT}
                />
              </label>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                Lock
                <SelectMenu
                  label="Lock"
                  value={String(idleMinutes)}
                  onChange={(minutes) => setIdleMinutes(Number(minutes))}
                  options={IDLE_OPTIONS.map((option) => ({
                    value: String(option.value),
                    label: option.label,
                  }))}
                  className="w-full sm:w-56"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                There is no way to recover a forgotten PIN from inside the app. The app also locks
                when the computer's screen locks.
              </p>
            </>
          )}
          {message && (
            <p role="alert" className="text-xs text-destructive">
              {message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <ActionButton onClick={reset}>Cancel</ActionButton>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {mode === 'clear' ? 'Turn off app lock' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
