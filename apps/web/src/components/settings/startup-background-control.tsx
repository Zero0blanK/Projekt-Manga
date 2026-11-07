'use client';

import { desktopBridge } from '@/lib/desktop-bridge';
import { useEffect, useState } from 'react';
import { Field, Group, ToggleSwitch } from '@/components/settings/field-controls';
import { toast } from '@/hooks/use-toast';

interface StartupState {
  supported: boolean;
  enabled: boolean;
}

interface Envelope {
  success: boolean;
  message?: string;
  data?: StartupState;
}

interface StartupBridge {
  getState: () => Promise<Envelope>;
  setEnabled: (enabled: boolean) => Promise<Envelope>;
}

/** Desktop on/off settings kept by the main process, each with the same get/set shape. */
type BridgeName = 'startupBackground' | 'closeToTray';

function startupBridge(name: BridgeName): StartupBridge | null {
  return desktopBridge<Record<BridgeName, StartupBridge>>()?.[name] ?? null;
}

export function StartupBackgroundControl() {
  return (
    <DesktopToggle
      bridgeName="startupBackground"
      group="Desktop startup"
      label="Run in background at sign-in"
      hint="Start hidden in the tray when you sign in"
      switchLabel="Run Projekt Manga in background at sign-in"
      failure="Couldn't change startup behavior. Try again."
      unavailable="Startup setting unavailable. Relaunch the app to retry."
    />
  );
}

/** Settings › About › Desktop window: closing hides to the tray, so scheduled library
 * updates keep running. */
export function CloseToTrayControl() {
  return (
    <DesktopToggle
      bridgeName="closeToTray"
      group="Desktop window"
      label="Close to tray"
      hint="Closing the window keeps the app running in the tray, so updates continue"
      switchLabel="Keep Projekt Manga running in the tray when the window closes"
      failure="Couldn't change what closing the window does. Try again."
      unavailable="Tray setting unavailable. Relaunch the app to retry."
    />
  );
}

function DesktopToggle({
  bridgeName,
  group,
  label,
  hint,
  switchLabel,
  failure,
  unavailable,
}: {
  bridgeName: BridgeName;
  group: string;
  label: string;
  hint: string;
  switchLabel: string;
  failure: string;
  unavailable: string;
}) {
  const [bridge, setBridge] = useState<StartupBridge | null>(null);
  const [state, setState] = useState<StartupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const desktop = startupBridge(bridgeName);
    if (!desktop) return;
    let active = true;
    setBridge(desktop);
    desktop
      .getState()
      .then((result) => {
        if (!result.success || !result.data) throw new Error(result.message ?? 'Unavailable');
        if (active) setState(result.data);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [bridgeName]);

  if (!bridge || (!state && !loadFailed) || (state && !state.supported)) return null;

  const toggle = async () => {
    if (!state) return;
    setBusy(true);
    try {
      const result = await bridge.setEnabled(!state.enabled);
      if (!result.success || !result.data)
        throw new Error(result.message ?? "Couldn't save setting");
      setState(result.data);
    } catch {
      toast({ variant: 'destructive', description: failure });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Group label={group} />
      <Field label={label} hint={hint}>
        {state ? (
          <ToggleSwitch
            on={state.enabled}
            disabled={busy}
            label={switchLabel}
            onToggle={() => void toggle()}
          />
        ) : (
          <span role="status" className="text-xs text-destructive">
            {unavailable}
          </span>
        )}
      </Field>
    </>
  );
}
