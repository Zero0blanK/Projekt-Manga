'use client';

import { useEffect, useRef, useState } from 'react';
import { SettingsNav, SECTION_IDS, type SectionId } from '@/components/settings/settings-nav';
import { AccountPanel } from '@/components/settings/account-panel';
import { AppearancePanel } from '@/components/settings/appearance-panel';
import { ReaderPanel } from '@/components/settings/reader-panel';
import { ExtensionsPanel } from '@/components/settings/extensions-panel';
import { StatisticsPanel } from '@/components/settings/statistics-panel';
import { NotificationsPanel } from '@/components/settings/notifications-panel';
import { SyncPanel } from '@/components/settings/sync-panel';
import { ShortcutsPanel } from '@/components/settings/shortcuts-panel';
import { PrivacyPanel } from '@/components/settings/privacy-panel';
import { AboutPanel } from '@/components/settings/about-panel';
import { ChangelogPanel } from '@/components/settings/changelog-panel';

function sectionFromHash(): SectionId | null {
  const id = window.location.hash.replace(/^#/, '');
  return (SECTION_IDS as readonly string[]).includes(id) ? (id as SectionId) : null;
}

export function SettingsPageClient() {
  const [active, setActive] = useState<SectionId>('account');
  const panel = useRef<HTMLDivElement>(null);
  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  const [focusMessage, setFocusMessage] = useState('');
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    const openSetting = (event: Event) => {
      const detail = (event as CustomEvent<{ section?: unknown; label?: unknown }>).detail;
      if (
        !detail ||
        typeof detail.section !== 'string' ||
        typeof detail.label !== 'string' ||
        !(SECTION_IDS as readonly string[]).includes(detail.section)
      )
        return;
      setActive(detail.section as SectionId);
      window.history.replaceState(null, '', `#${detail.section}`);
      setFocusLabel(detail.label);
      setFocusMessage('');
      setFocusRequest((current) => current + 1);
    };
    window.addEventListener('projekt-manga:setting', openSetting);
    return () => window.removeEventListener('projekt-manga:setting', openSetting);
  }, []);
  useEffect(() => {
    if (!focusLabel || !panel.current) return;
    const container = panel.current;
    let focused = false;
    const focus = () => {
      if (focused) return;
      const target = Array.from(container.querySelectorAll<HTMLElement>('div, h2, h3, label')).find(
        (element) => element.textContent?.trim() === focusLabel && element.children.length === 0,
      );
      if (!target) return;
      let scope: HTMLElement | null = target.parentElement;
      let control: HTMLElement | null = null;
      if (!target.matches('h2, h3')) {
        while (scope && scope !== container) {
          control = scope.querySelector<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"], a[href]',
          );
          if (control || scope.matches('[aria-disabled="true"]')) break;
          scope = scope.parentElement;
        }
      }
      const disabled = Boolean(scope?.closest('[aria-disabled="true"]'));
      if (disabled || !control) {
        target.tabIndex = -1;
        control = target;
      }
      control.focus();
      target.scrollIntoView?.({ block: 'center', behavior: 'instant' });
      setFocusMessage(
        disabled
          ? `${focusLabel} is currently unavailable. Read the setting's explanation.`
          : `Opened ${focusLabel}.`,
      );
      focused = true;
    };
    const timer = window.setTimeout(focus, 0);
    const observer = new MutationObserver(focus);
    observer.observe(container, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => {
      if (!focused)
        setFocusMessage(`Opened ${active}. ${focusLabel} is not available for this session.`);
      observer.disconnect();
    }, 5000);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(timeout);
      observer.disconnect();
    };
  }, [active, focusLabel, focusRequest]);

  // The section lives in the URL hash so a panel can be linked to directly. Read after
  // mount rather than during render — the server has no hash, and reading it in render
  // would produce a hydration mismatch. The hash (rather than a query param) also avoids
  // forcing a Suspense boundary via useSearchParams.
  useEffect(() => {
    const sync = () => {
      const section = sectionFromHash();
      if (section) setActive(section);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const select = (id: SectionId) => {
    setActive(id);
    // replaceState rather than assigning location.hash: a settings panel isn't a
    // destination worth a back-button stop of its own.
    window.history.replaceState(null, '', `#${id}`);
  };

  return (
    <div className="mx-auto min-w-0 max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-primary">
        Preferences
      </div>
      <h1 className="mt-1 text-display text-3xl text-foreground sm:text-4xl lg:text-5xl">
        Settings
      </h1>
      {focusMessage && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {focusMessage}
        </p>
      )}

      <div className="mt-8 grid gap-8 md:grid-cols-[220px_1fr]">
        <SettingsNav active={active} onChange={select} />

        <div ref={panel} className="min-w-0">
          {active === 'account' && <AccountPanel />}
          {active === 'appearance' && <AppearancePanel />}
          {active === 'reader' && <ReaderPanel />}
          {active === 'extensions' && <ExtensionsPanel />}
          {active === 'statistics' && <StatisticsPanel />}
          {active === 'notifications' && <NotificationsPanel />}
          {active === 'sync' && <SyncPanel />}
          {active === 'shortcuts' && <ShortcutsPanel />}
          {active === 'privacy' && <PrivacyPanel />}
          {active === 'about' && <AboutPanel />}
          {active === 'changelog' && <ChangelogPanel />}
        </div>
      </div>
    </div>
  );
}
