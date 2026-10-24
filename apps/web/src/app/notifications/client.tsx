'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChapterUpdates } from '@/components/notifications/chapter-updates';
import { UpdateLog } from '@/components/notifications/update-log';
import { PageShell, PageHeader } from '@/components/page-shell';
import { Bell, Settings2, ScrollText } from 'lucide-react';

export function NotificationsPageClient() {
  const [tab, setTab] = useState<'chapters' | 'log'>('chapters');
  const tabs = ['chapters', 'log'] as const;

  const tabButton = (id: typeof tab, label: string, Icon: typeof Bell) => (
    <button
      id={`notifications-tab-${id}`}
      role="tab"
      type="button"
      aria-selected={tab === id}
      aria-controls={`notifications-panel-${id}`}
      tabIndex={tab === id ? 0 : -1}
      onClick={() => setTab(id)}
      onKeyDown={(event) => {
        const current = tabs.indexOf(id);
        const next =
          event.key === 'ArrowRight'
            ? tabs[(current + 1) % tabs.length]
            : event.key === 'ArrowLeft'
              ? tabs[(current + tabs.length - 1) % tabs.length]
              : event.key === 'Home'
                ? tabs[0]
                : event.key === 'End'
                  ? tabs[tabs.length - 1]
                  : null;
        if (!next) return;
        event.preventDefault();
        setTab(next);
        document.getElementById(`notifications-tab-${next}`)?.focus();
      }}
      className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition ${
        tab === id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );

  return (
    <PageShell>
      <PageHeader
        icon={Bell}
        eyebrow="Notifications"
        title="Stay in the loop"
        description="New chapters as your sources publish them, grouped by when they were fetched."
        actions={
          <Link
            href="/settings#notifications"
            className="grid h-9 w-9 place-items-center rounded-lg border border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Notification settings"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </Link>
        }
      />

      <div
        role="tablist"
        aria-label="Notification views"
        className="mt-8 flex w-fit gap-1 rounded-lg border border-border/60 bg-surface/40 p-1"
      >
        {tabButton('chapters', 'New chapters', Bell)}
        {tabButton('log', 'Update log', ScrollText)}
      </div>

      <div
        id="notifications-panel-chapters"
        role="tabpanel"
        aria-labelledby="notifications-tab-chapters"
        tabIndex={0}
        hidden={tab !== 'chapters'}
        className="mt-6"
      >
        {tab === 'chapters' && <ChapterUpdates />}
      </div>
      <div
        id="notifications-panel-log"
        role="tabpanel"
        aria-labelledby="notifications-tab-log"
        tabIndex={0}
        hidden={tab !== 'log'}
        className="mt-6"
      >
        {tab === 'log' && <UpdateLog />}
      </div>
    </PageShell>
  );
}
