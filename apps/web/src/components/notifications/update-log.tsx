'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { getUpdateLog, type UpdateLogEntry } from '@projekt-manga/api-client';
import {
  parseUpdateLogDetail,
  UPDATE_LOG_CATEGORIES,
  UPDATE_LOG_CATEGORY_HINTS,
  UPDATE_LOG_CATEGORY_LABELS,
  type UpdateLogCategory,
  type UpdateLogDetail,
} from '@projekt-manga/types';
import { useSources } from '@/lib/library-store';
import { toDisplaySource, formatRelative, type DisplaySource } from '@/lib/manga-data';
import { EmptyState } from '@/components/page-shell';
import { RowListSkeleton } from '@/components/skeletons';
import {
  CircleCheck,
  TriangleAlert,
  ChevronDown,
  Filter,
  WifiOff,
  Clock,
  ShieldAlert,
  Gauge,
  SearchX,
  FileWarning,
  ServerCrash,
  CircleHelp,
  type LucideIcon,
} from 'lucide-react';
import { reportError } from '@/lib/report-error';

const CATEGORY_ICONS: Record<UpdateLogCategory, LucideIcon> = {
  NETWORK_ERROR: WifiOff,
  TIMEOUT: Clock,
  BLOCKED: ShieldAlert,
  RATE_LIMITED: Gauge,
  NOT_FOUND: SearchX,
  PARSE_ERROR: FileWarning,
  UPSTREAM_ERROR: ServerCrash,
  UNCLASSIFIED: CircleHelp,
};

/** Colour per category, so the list is scannable without reading every label. */
const CATEGORY_STYLES: Record<UpdateLogCategory, string> = {
  NETWORK_ERROR: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  TIMEOUT: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  BLOCKED: 'border-destructive/40 bg-destructive/10 text-destructive',
  RATE_LIMITED: 'border-orange-500/40 bg-orange-500/10 text-orange-400',
  NOT_FOUND: 'border-border/70 bg-muted/60 text-muted-foreground',
  PARSE_ERROR: 'border-violet-500/40 bg-violet-500/10 text-violet-400',
  UPSTREAM_ERROR: 'border-rose-500/40 bg-rose-500/10 text-rose-400',
  UNCLASSIFIED: 'border-border/70 bg-muted/60 text-muted-foreground',
};

/** An entry paired with its decoded diagnostics (errors only). */
type DecodedEntry = UpdateLogEntry & { diagnostic: UpdateLogDetail | null };

function decode(entry: UpdateLogEntry): DecodedEntry {
  return {
    ...entry,
    diagnostic: entry.kind === 'ERROR' ? parseUpdateLogDetail(entry.detail) : null,
  };
}

function CategoryBadge({ category, reason }: { category: UpdateLogCategory; reason?: string }) {
  const Icon = CATEGORY_ICONS[category];
  return (
    <span
      title={UPDATE_LOG_CATEGORY_HINTS[category]}
      className={`flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${CATEGORY_STYLES[category]}`}
    >
      <Icon className="h-3 w-3" />
      {reason || UPDATE_LOG_CATEGORY_LABELS[category]}
    </span>
  );
}

/** The expanded diagnostic: what failed, why, and where. Each field is omitted rather
 * than shown empty, so an entry that genuinely carried no cause doesn't imply one. */
function Diagnostic({ entry }: { entry: DecodedEntry }) {
  const d = entry.diagnostic;
  if (!d) {
    return <p className="text-xs text-muted-foreground">{entry.detail}</p>;
  }

  const rows: Array<[string, ReactNode]> = [
    [
      'Category',
      `${UPDATE_LOG_CATEGORY_LABELS[d.category]} — ${UPDATE_LOG_CATEGORY_HINTS[d.category]}`,
    ],
    ['Reason', d.reason],
  ];
  if (d.status !== undefined) rows.push(['HTTP status', d.status]);
  if (d.url) rows.push(['Request', <span className="break-all font-mono">{d.url}</span>]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-foreground">{d.summary}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[11px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      {d.cause && (
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Underlying error
          </div>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border/60 bg-background/60 p-2.5 font-mono text-[11px] text-muted-foreground">
            {d.cause}
          </pre>
        </div>
      )}
    </div>
  );
}

function SourceSection({
  source,
  count,
  badge,
  children,
}: {
  source: DisplaySource;
  count: number;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="overflow-hidden rounded-2xl border border-border/60 bg-surface/40">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-accent/30"
      >
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[10px] font-bold text-white"
          style={{ background: source.accent }}
        >
          {source.name.slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {source.name}
        </span>
        {badge}
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{count}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && <ul className="divide-y divide-border/60 border-t border-border/60">{children}</ul>}
    </section>
  );
}

function groupBySource(items: DecodedEntry[], sources: DisplaySource[]) {
  const byId = new Map<string, DecodedEntry[]>();
  for (const item of items) {
    const id = item.source_id ?? 'unknown';
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(item);
  }
  return sources
    .filter((s) => byId.has(s.id))
    .map((source) => ({ source, items: byId.get(source.id)! }));
}

/** "Successes" is a pseudo-category so the same control can hide the noise of successful
 * checks — it is not an error class, hence a separate constant rather than another
 * UpdateLogCategory value. */
const SUCCESS_KEY = 'NEW_CHAPTER' as const;
type FilterKey = UpdateLogCategory | typeof SUCCESS_KEY;

/**
 * Where notifications were aggregated from — the per-source library update job, success
 * and failure alike. Failures carry a decoded diagnostic (category, reason, HTTP status,
 * request URL and the underlying error), and can be filtered down to the categories worth
 * looking at.
 */
export function UpdateLog() {
  const [log, setLog] = useState<DecodedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Empty means "everything" — the common case shouldn't require pre-selecting anything. */
  const [selected, setSelected] = useState<Set<FilterKey>>(new Set());
  const { sources: apiSources } = useSources();
  const sources = useMemo(() => apiSources.map(toDisplaySource), [apiSources]);

  useEffect(() => {
    const controller = new AbortController();
    getUpdateLog(undefined, controller.signal)
      .then((entries) => setLog(entries.map(decode)))
      // This log is the whole screen; empty otherwise reads as "nothing has happened".
      .catch((error) => reportError(error, "Couldn't load the update log."))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const keyOf = (entry: DecodedEntry): FilterKey =>
    entry.diagnostic ? entry.diagnostic.category : SUCCESS_KEY;

  const counts = useMemo(() => {
    const tally = new Map<FilterKey, number>();
    for (const entry of log) tally.set(keyOf(entry), (tally.get(keyOf(entry)) ?? 0) + 1);
    return tally;
  }, [log]);

  // Only categories actually present are offered — a filter for something that can't
  // appear is just clutter.
  const availableCategories = UPDATE_LOG_CATEGORIES.filter((c) => (counts.get(c) ?? 0) > 0);
  const successCount = counts.get(SUCCESS_KEY) ?? 0;

  const visible = selected.size === 0 ? log : log.filter((e) => selected.has(keyOf(e)));
  const errorCount = log.filter((e) => e.kind === 'ERROR').length;
  const groups = groupBySource(visible, sources);

  const toggle = (key: FilterKey) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (loading && log.length === 0) {
    return <RowListSkeleton count={6} thumbnail={false} />;
  }

  if (!loading && log.length === 0) {
    return (
      <EmptyState>
        No update checks yet — run &ldquo;Update Library&rdquo; from your library to check sources
        for new chapters.
      </EmptyState>
    );
  }

  const chip = (key: FilterKey, label: string, count: number, Icon: LucideIcon, hint: string) => {
    const active = selected.has(key);
    return (
      <button
        key={key}
        onClick={() => toggle(key)}
        aria-pressed={active}
        title={hint}
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
          active
            ? 'border-primary bg-primary/15 text-primary'
            : 'border-border/60 bg-surface/40 text-muted-foreground hover:border-border hover:text-foreground'
        }`}
      >
        <Icon className="h-3.5 w-3.5" />
        {label}
        <span className="tabular-nums opacity-70">{count}</span>
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {log.length} events from the last library check ·{' '}
        <span className={errorCount > 0 ? 'text-destructive' : ''}>{errorCount} errors</span> ·{' '}
        <Link href="/discover" className="text-primary hover:opacity-80">
          Manage extensions →
        </Link>
      </p>

      {(availableCategories.length > 0 || successCount > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            <Filter className="h-3 w-3" /> Show
          </span>
          {availableCategories.map((category) =>
            chip(
              category,
              UPDATE_LOG_CATEGORY_LABELS[category],
              counts.get(category) ?? 0,
              CATEGORY_ICONS[category],
              UPDATE_LOG_CATEGORY_HINTS[category],
            ),
          )}
          {successCount > 0 &&
            chip(
              SUCCESS_KEY,
              'Successful',
              successCount,
              CircleCheck,
              'Checks that found new chapters',
            )}
          {selected.size > 0 && (
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-primary transition hover:opacity-80"
            >
              Clear filter
            </button>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState>
          Nothing matches the selected categories.
          <button
            onClick={() => setSelected(new Set())}
            className="mt-3 block w-full text-xs text-primary hover:opacity-80"
          >
            Clear filter
          </button>
        </EmptyState>
      ) : (
        groups.map(({ source, items }) => {
          const errorsInGroup = items.filter((e) => e.kind === 'ERROR').length;
          return (
            <SourceSection
              key={source.id}
              source={source}
              count={items.length}
              badge={
                errorsInGroup > 0 ? (
                  <span className="shrink-0 rounded-full bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
                    {errorsInGroup} error{errorsInGroup > 1 ? 's' : ''}
                  </span>
                ) : undefined
              }
            >
              {items.map((entry) => {
                const isError = entry.kind === 'ERROR';
                const isOpen = expanded.has(entry.id);
                return (
                  <li key={entry.id}>
                    <button
                      onClick={() => toggleExpanded(entry.id)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-accent/40"
                    >
                      {isError ? (
                        <TriangleAlert className="h-4 w-4 shrink-0 text-destructive" />
                      ) : (
                        <CircleCheck className="h-4 w-4 shrink-0 text-primary" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-foreground">
                          {entry.message}
                        </span>
                        <span className="block text-[10px] text-muted-foreground">
                          {formatRelative(entry.created_at)}
                        </span>
                      </span>
                      {entry.diagnostic && (
                        <CategoryBadge
                          category={entry.diagnostic.category}
                          reason={entry.diagnostic.reason}
                        />
                      )}
                      <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition ${isOpen ? 'rotate-180' : ''}`}
                      />
                    </button>
                    {isOpen && (
                      <div className="border-t border-border/50 bg-background/40 px-4 py-3 pl-11">
                        <Diagnostic entry={entry} />
                        {entry.manga && (
                          <Link
                            href={`/manga/${entry.manga.id}`}
                            className="mt-3 inline-block text-[11px] text-primary hover:opacity-80"
                          >
                            View title →
                          </Link>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </SourceSection>
          );
        })
      )}
    </div>
  );
}
