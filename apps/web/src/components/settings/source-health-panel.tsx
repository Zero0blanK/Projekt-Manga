'use client';

import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import {
  getScraperHealth,
  getSourceHealth,
  listInstalledExtensions,
  type InstalledExtension,
  type SourceHealth,
} from '@projekt-manga/api-client';
import { SUPPORTED_EXTENSION_API_VERSION } from '@projekt-manga/schemas';
import { summarizeSourceHealth, type SourceHealthStatus } from '@/lib/source-health-status';
import { absoluteTime, countdown, relativeTime } from '@/lib/relative-time';
import { Panel, Field } from '@/components/settings/field-controls';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type Breakers = NonNullable<Awaited<ReturnType<typeof getScraperHealth>>['circuitBreakers']>;

/**
 * One verdict per source, which is the question this screen exists to answer.
 *
 * `unsupported` is checked first and outranks every observation: an adapter the server
 * cannot run will not produce a successful browse no matter what the counters say, so
 * reporting it as "failing" would point at the wrong cause. The remaining states come from
 * `summarizeSourceHealth` rather than being re-derived here, so a source called "failing"
 * on a Discover card is called "failing" here too.
 */
type Verdict = 'unsupported' | 'cooling-down' | 'failing' | 'ok' | 'unknown' | 'unavailable';

const VERDICT_ORDER: Record<Verdict, number> = {
  unsupported: 0,
  failing: 1,
  'cooling-down': 2,
  unknown: 3,
  unavailable: 4,
  ok: 5,
};

const VERDICT_LABEL: Record<Verdict, string> = {
  unsupported: 'Needs an update',
  failing: 'Failing',
  'cooling-down': 'Cooling down',
  unknown: 'Not used yet',
  unavailable: 'Status unknown',
  ok: 'Working',
};

/**
 * Status colour carries meaning here, so it is the only thing on the row that is coloured.
 * "Enabled" is deliberately not accented: it means "not switched off", not success.
 */
const VERDICT_DOT: Record<Verdict, string> = {
  unsupported: 'bg-destructive',
  failing: 'bg-destructive',
  'cooling-down': 'bg-amber-500',
  unknown: 'bg-muted-foreground/50',
  unavailable: 'bg-muted-foreground/50',
  ok: 'bg-emerald-500',
};

function isCompatible(extension: InstalledExtension): boolean {
  return extension.api_version <= SUPPORTED_EXTENSION_API_VERSION;
}

function verdictFor(
  extension: InstalledExtension,
  entry: SourceHealth | undefined,
  breaker: Breakers[number] | undefined,
  observationsUnavailable: boolean,
): Verdict {
  if (!isCompatible(extension)) return 'unsupported';
  if (observationsUnavailable) return 'unavailable';
  if (breaker?.isOpen) return 'cooling-down';
  const status: SourceHealthStatus = summarizeSourceHealth(entry);
  return status;
}

/** "Last success" and friends, as a label/value pair rather than a run-on sentence. */
function Observation({
  label,
  value,
  title,
  muted,
}: {
  label: string;
  value: string;
  title?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd
        title={title}
        className={`min-w-0 truncate text-right text-xs ${muted ? 'text-muted-foreground' : 'text-foreground'}`}
      >
        {value}
      </dd>
    </div>
  );
}

function operationRow(
  label: string,
  operation: SourceHealth['browse'] | undefined,
  observationsUnavailable: boolean,
) {
  if (observationsUnavailable) {
    return <Observation key={label} label={label} value="Server did not report" muted />;
  }
  if (!operation) {
    return <Observation key={label} label={label} value="No requests yet" muted />;
  }
  const success = relativeTime(operation.lastSuccessAt);
  const parts = [success ? `Succeeded ${success}` : 'Never succeeded'];
  if (operation.lastErrorCode) parts.push(operation.lastErrorCode);
  return (
    <Observation
      key={label}
      label={label}
      value={parts.join(' · ')}
      title={absoluteTime(operation.lastSuccessAt)}
      muted={!success}
    />
  );
}

function SourceHealthRow({
  extension,
  entry,
  breaker,
  observationsUnavailable,
  breakersUnavailable,
}: {
  extension: InstalledExtension;
  entry: SourceHealth | undefined;
  breaker: Breakers[number] | undefined;
  observationsUnavailable: boolean;
  breakersUnavailable: boolean;
}) {
  const verdict = verdictFor(extension, entry, breaker, observationsUnavailable);
  const retryAfter = [entry?.browse, entry?.update]
    .map((operation) => operation?.retryAfterAt)
    .find((value) => value && Date.parse(value) > Date.now());

  return (
    <li className="rounded-xl border border-border/60 bg-surface/40 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/* aria-hidden: the dot is a duplicate of the verdict text beside it, so
                announcing it would just repeat the status. */}
            <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${VERDICT_DOT[verdict]}`} />
            <span className="truncate text-sm font-medium text-foreground">{extension.name}</span>
            {!extension.enabled && (
              <span className="shrink-0 rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                Off
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {extension.source_key} · v{extension.version} · API v{extension.api_version}
          </p>
        </div>
        <span
          className={`shrink-0 text-xs font-medium ${
            verdict === 'unsupported' || verdict === 'failing'
              ? 'text-destructive'
              : verdict === 'cooling-down'
                ? 'text-amber-500'
                : verdict === 'ok'
                  ? 'text-emerald-500'
                  : 'text-muted-foreground'
          }`}
        >
          {VERDICT_LABEL[verdict]}
        </span>
      </div>

      {verdict === 'unsupported' && (
        <p className="mt-2 text-xs text-destructive">
          This adapter targets API v{extension.api_version}, newer than the v
          {SUPPORTED_EXTENSION_API_VERSION} this build runs. Update the app, or the source, before
          it will load.
        </p>
      )}

      <dl className="mt-2.5 grid gap-1 border-t border-border/50 pt-2.5">
        {operationRow('Browse', entry?.browse, observationsUnavailable)}
        {operationRow('Updates', entry?.update, observationsUnavailable)}
        {retryAfter && (
          <Observation
            label="Upstream retry-after"
            value={relativeTime(retryAfter) ?? 'Unknown'}
            title={absoluteTime(retryAfter)}
          />
        )}
        <Observation
          label="Scraper circuit"
          value={
            breakersUnavailable
              ? 'Not available in this build'
              : breaker
                ? breaker.isOpen
                  ? `Open · retries in ${countdown(breaker.openRemainingMs)}`
                  : `Closed · ${breaker.consecutiveFailures} consecutive failure(s)`
                : 'No failures recorded'
          }
          muted={breakersUnavailable || !breaker}
        />
      </dl>
    </li>
  );
}

/**
 * Loads everything the dialog shows, and only once it is open.
 *
 * Shares query keys with Discover's source cards, so a warm cache makes opening the dialog
 * free. `enabled` keeps the requests lazy until the dialog opens.
 */
function useSourceHealthDetail(open: boolean) {
  const installed = useQuery({
    queryKey: ['installed-extensions'],
    queryFn: ({ signal }) => listInstalledExtensions(signal),
    enabled: open,
  });
  const observations = useQuery({
    queryKey: ['source-health'],
    queryFn: ({ signal }) => getSourceHealth(signal),
    staleTime: 60_000,
    enabled: open,
    retry: false,
  });
  const scraper = useQuery({
    queryKey: ['scraper-health'],
    queryFn: ({ signal }) => getScraperHealth(signal),
    staleTime: 60_000,
    enabled: open,
    retry: false,
  });

  const breakers: Breakers | null =
    scraper.isSuccess && scraper.data.available !== false
      ? (scraper.data.circuitBreakers ?? [])
      : scraper.isPending
        ? []
        : null;

  return {
    installed: installed.data ?? [],
    // Only the installed list is load-bearing: without it there is nothing to list at all,
    // while a missing observation or breaker is reported per row as unavailable.
    loading: installed.isPending,
    failed: installed.isError,
    refetch: () => void installed.refetch(),
    observations: observations.data ?? [],
    observationsUnavailable: observations.isError,
    breakers,
  };
}

function SourceHealthDetail({ open }: { open: boolean }) {
  const detail = useSourceHealthDetail(open);

  if (detail.loading) {
    return (
      <p role="status" className="py-6 text-center text-xs text-muted-foreground">
        Checking installed sources…
      </p>
    );
  }

  if (detail.failed) {
    return (
      <p role="alert" className="py-6 text-center text-xs text-destructive">
        Installed source health is unavailable.
        <button type="button" onClick={detail.refetch} className="ml-2 underline">
          Try again
        </button>
      </p>
    );
  }

  if (!detail.installed.length) {
    return (
      <div className="py-6 text-center">
        <p className="text-sm text-foreground">No sources installed yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Add a repository from Discover → Extensions and installed sources will be listed here.
        </p>
      </div>
    );
  }

  const byKey = new Map(detail.observations.map((health) => [health.sourceId, health]));
  const rows = detail.installed
    .map((extension) => {
      const entry = byKey.get(extension.source_key);
      const breaker = detail.breakers?.find((item) => item.source === extension.source_key);
      return {
        extension,
        entry,
        breaker,
        verdict: verdictFor(extension, entry, breaker, detail.observationsUnavailable),
      };
    })
    // Problems first, so the rows worth reading are easiest to find.
    .sort(
      (a, b) =>
        VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
        a.extension.name.localeCompare(b.extension.name),
    );

  const attention = rows.filter(
    (row) => VERDICT_ORDER[row.verdict] <= VERDICT_ORDER['cooling-down'],
  ).length;
  // "Working" claims observed successes, so it is only reported when every source has one;
  // never-used sources must not read as working.
  const working = rows.filter((row) => row.verdict === 'ok').length;

  return (
    <>
      <p
        className={`text-xs ${attention > 0 ? 'font-medium text-destructive' : 'text-muted-foreground'}`}
      >
        {attention > 0
          ? `${attention} of ${rows.length} sources need attention`
          : working === rows.length
            ? `All ${rows.length} sources are working`
            : `${rows.length} sources · nothing reporting problems`}
      </p>
      <ul className="grid gap-2">
        {rows.map((row) => (
          <SourceHealthRow
            key={row.extension.id}
            extension={row.extension}
            entry={row.entry}
            breaker={row.breaker}
            observationsUnavailable={detail.observationsUnavailable}
            breakersUnavailable={detail.breakers === null}
          />
        ))}
      </ul>
    </>
  );
}

/**
 * Source health as a summary row that opens a dialog, so per-source detail does not grow the
 * About page with the number of installed sources.
 *
 * The collapsed row still reports a count and whether anything needs attention, so a broken
 * source is not hidden behind a click.
 */
export function SourceHealthPanel() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Not gated on `open`: this is the summary the collapsed row reports. It shares
  // Discover's query keys, so on a warm cache it costs nothing.
  const installed = useQuery({
    queryKey: ['installed-extensions'],
    queryFn: ({ signal }) => listInstalledExtensions(signal),
  });
  const observations = useQuery({
    queryKey: ['source-health'],
    queryFn: ({ signal }) => getSourceHealth(signal),
    staleTime: 60_000,
    retry: false,
  });

  const attention = (installed.data ?? []).filter((extension) => {
    const verdict = verdictFor(
      extension,
      observations.data?.find((entry) => entry.sourceId === extension.source_key),
      undefined,
      observations.isError,
    );
    return VERDICT_ORDER[verdict] <= VERDICT_ORDER['cooling-down'];
  }).length;

  const count = installed.data?.length ?? 0;
  const summary = installed.isError
    ? 'Installed source health is unavailable'
    : installed.isPending
      ? 'Checking installed sources…'
      : count === 0
        ? 'No repository-installed sources'
        : attention > 0
          ? `${attention} of ${count} need attention`
          : `${count} installed · nothing reporting problems`;

  return (
    <Panel
      title="Source health"
      subtitle="Installed adapter compatibility and recent request results"
    >
      <Field label="Installed sources" hint={summary}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 rounded-full border border-border/60 px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface/60"
        >
          <Activity
            className={`h-3.5 w-3.5 ${attention > 0 ? 'text-destructive' : 'text-muted-foreground'}`}
          />
          View source health
        </button>
      </Field>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Source health</DialogTitle>
            <DialogDescription>
              Browse and update observations are held in server memory and reset when the server
              restarts. Error categories omit upstream URLs and response text.
            </DialogDescription>
          </DialogHeader>
          {/* Mounted only while open so the detail queries stay unfetched for a dialog
              nobody opened. */}
          {open && <SourceHealthDetail open={open} />}
          <DialogFooter>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-muted"
            >
              Close
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
