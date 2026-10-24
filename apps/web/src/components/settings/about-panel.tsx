'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { getHealth, getApiBaseUrl } from '@projekt-manga/api-client';
import { Panel, Field, Group } from '@/components/settings/field-controls';
import { DiagnosticReportButton } from '@/components/settings/diagnostic-report-button';
import { UpdateControls } from '@/components/settings/update-controls';
import { StartupBackgroundControl } from '@/components/settings/startup-background-control';
import { SourceHealthPanel } from '@/components/settings/source-health-panel';
import { CURRENT_RELEASE, RELEASES } from '@/lib/changelog';
import { formatRelative } from '@/lib/manga-data';
import { CheckCircle2, XCircle, Loader2, ExternalLink } from 'lucide-react';

/** The project's public repository; matches the `publish` block in apps/desktop/electron-builder.yml. */
const REPOSITORY_URL = 'https://github.com/Zero0blanK/Projekt-Manga';

const RESOURCE_LINKS = [
  {
    label: 'Source code',
    hint: 'The repository this build was made from',
    href: REPOSITORY_URL,
  },
  {
    label: 'Report a problem',
    hint: 'Open an issue — the diagnostic report above is the useful thing to paste in',
    href: `${REPOSITORY_URL}/issues/new`,
  },
  {
    label: 'Releases',
    hint: 'Every published version, and what changed in it',
    href: `${REPOSITORY_URL}/releases`,
  },
];

const credits = [
  ['Framework', 'Next.js + React 19'],
  ['Styling', 'Tailwind CSS 4'],
  ['Components', 'shadcn/ui'],
  ['Icons', 'Lucide'],
  ['Server', 'Express + Prisma'],
  ['Desktop shell', 'Electron'],
];

type Health = { state: 'checking' | 'ok' | 'down'; checkedAt?: string };

/** Liveness check against GET /api/health. */
function ServerStatus() {
  const [health, setHealth] = useState<Health>({ state: 'checking' });
  const [baseUrl, setBaseUrl] = useState('');

  const check = () => {
    setHealth({ state: 'checking' });
    getHealth()
      .then(() => setHealth({ state: 'ok', checkedAt: new Date().toISOString() }))
      .catch(() => setHealth({ state: 'down', checkedAt: new Date().toISOString() }));
  };

  // getApiBaseUrl() reads process.env at call time; running it in an effect keeps the
  // server render and the first client render identical.
  useEffect(() => {
    setBaseUrl(getApiBaseUrl());
    check();
  }, []);

  const label =
    health.state === 'checking' ? 'Checking…' : health.state === 'ok' ? 'Connected' : 'Unreachable';
  const Icon =
    health.state === 'checking' ? Loader2 : health.state === 'ok' ? CheckCircle2 : XCircle;
  const tone =
    health.state === 'checking'
      ? 'text-muted-foreground'
      : health.state === 'ok'
        ? 'text-primary'
        : 'text-destructive';

  return (
    <>
      <Field
        label="Server"
        hint={health.checkedAt ? `Last checked ${formatRelative(health.checkedAt)}` : undefined}
      >
        <div className="flex items-center gap-3">
          <span className={`flex items-center gap-1.5 text-xs ${tone}`}>
            <Icon className={`h-3.5 w-3.5 ${health.state === 'checking' ? 'animate-spin' : ''}`} />
            {label}
          </span>
          <button
            onClick={check}
            className="rounded-lg border border-border/60 px-2.5 py-1 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            Re-check
          </button>
        </div>
      </Field>
      <Field label="API endpoint" hint="Set with NEXT_PUBLIC_API_URL">
        <span className="max-w-64 truncate font-mono text-[11px] text-muted-foreground">
          {baseUrl || '—'}
        </span>
      </Field>
    </>
  );
}

export function AboutPanel() {
  return (
    <div className="space-y-6">
      <Panel title="About" subtitle="What's under the hood">
        <div className="flex flex-col items-start gap-3 pb-2">
          <Image
            src="/brand/ProjektManga.origin.svg"
            alt="Projekt Manga"
            width={5016}
            height={1277}
            unoptimized
            className="h-auto w-52 max-w-full sm:w-60"
          />
          <div>
            <div className="text-xs text-muted-foreground">
              Version {CURRENT_RELEASE.version} · Released {CURRENT_RELEASE.date}
            </div>
          </div>
        </div>

        <Field label="Build" hint="Self-hosted — connects to your own server">
          <span className="text-xs text-muted-foreground">
            {CURRENT_RELEASE.version} · {RELEASES.length} release{RELEASES.length === 1 ? '' : 's'}
          </span>
        </Field>
        <ServerStatus />

        {/* Render their own Group/Fields, or nothing outside the desktop app. */}
        <UpdateControls />
        <StartupBackgroundControl />

        <Field
          label="Diagnostics"
          hint="Versions, installed sources, scraper health and recent logs — with secrets left out"
        >
          <DiagnosticReportButton />
        </Field>

        <Group label="Built with" />
        {credits.map(([label, value]) => (
          <Field key={label} label={label}>
            <span className="text-xs text-muted-foreground">{value}</span>
          </Field>
        ))}
      </Panel>

      <SourceHealthPanel />

      <Panel title="Resources" subtitle="Links and legal">
        {RESOURCE_LINKS.map(({ label, hint, href }) => (
          <Field key={label} label={label} hint={hint}>
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface/60"
            >
              Open
              <ExternalLink className="h-3 w-3" />
            </a>
          </Field>
        ))}

        <Group label="Your data" />
        <Field label="Where it lives" hint="Nothing is sent anywhere you did not configure">
          <span className="max-w-xs text-right text-xs text-muted-foreground">
            Library, history and downloads stay on this machine.
          </span>
        </Field>
      </Panel>
    </div>
  );
}
