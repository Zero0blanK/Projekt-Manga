'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { InstalledExtension } from '@projekt-manga/api-client';
import type { DisplaySource } from '@/lib/manga-data';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';
import {
  Clock,
  TrendingUp,
  MoreVertical,
  Pin,
  PinOff,
  ExternalLink,
  EyeOff,
  ArrowUp,
  ArrowDown,
  Download,
  Loader2,
} from 'lucide-react';
import { useSourceFilters, useSourceCapabilities } from '@/lib/library-store';
import { sourceLanguageFilter, useSourceDisplayLanguage } from '@/lib/source-display-language';
import { sourceLanguageName as languageName, repairSourceName } from '@/lib/source-language';
import { extensionActions, type CatalogEntry } from '@/lib/extensions-store';
import { toast } from '@/hooks/use-toast';
import { useSourceHealthStatus } from '@/lib/source-health-status';
import { websiteUrl } from '@/lib/source-url';
import { useConfirm } from '@/hooks/use-confirm';
/** The extension's own icon when its repository ships one, the lettered tile otherwise. */
function SourceAvatar({
  name,
  accent,
  iconUrl,
}: {
  name: string;
  accent: string;
  iconUrl: string | null | undefined;
}) {
  const [failed, setFailed] = useState(false);
  const url = websiteUrl(iconUrl);
  if (url && !failed)
    return (
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-secondary">
        {/* eslint-disable-next-line @next/next/no-img-element -- repository icons are small remote SVGs, not optimisable images */}
        <img
          src={url}
          alt=""
          aria-hidden
          width={28}
          height={28}
          loading="lazy"
          onError={() => setFailed(true)}
          className="size-7 rounded-md object-contain"
        />
      </span>
    );
  return (
    <div
      className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-sm font-semibold text-white"
      // Darkened so white initials keep ≥4.5:1 contrast on the lighter accent colours.
      style={{ background: `color-mix(in oklch, ${accent} 60%, black)` }}
    >
      {name.slice(0, 2).toUpperCase()}
    </div>
  );
}

export function InstalledSourceCard({
  source,
  record,
  editionEntries = [],
  pinned,
  privateReading,
  onTogglePin,
  onToggleIncognito,
  canMoveUp,
  canMoveDown,
  onMovePin,
}: {
  source: DisplaySource;
  record?: InstalledExtension;
  editionEntries?: CatalogEntry[];
  pinned: boolean;
  privateReading: boolean;
  onTogglePin: () => void;
  onToggleIncognito: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMovePin: (direction: number) => void;
}) {
  const [installing, setInstalling] = useState<string | null>(null);
  const pendingInstall = useRef(false);
  const { confirm, dialog } = useConfirm();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { capabilities } = useSourceCapabilities(source.id);
  const health = useSourceHealthStatus(source.id);
  const [displayLanguage, setDisplayLanguage] = useSourceDisplayLanguage(source.id);
  const { filters } = useSourceFilters(capabilities?.languageFilter ? source.id : null);
  const nativeLanguage = sourceLanguageFilter(filters);
  const hasLanguageFilter = capabilities?.languageFilter && nativeLanguage;
  const languages =
    nativeLanguage?.options?.filter((option) => option.value !== 'all') ??
    (source.lang !== 'all' ? [{ value: source.lang, label: languageName(source.lang) }] : []);
  const rating = record?.content_rating ?? (source.isNSFW ? 'nsfw' : null);
  const selectEdition = async (key: string) => {
    const edition = editionEntries.find((item) => item.entry.source_key === key);
    if (!edition || key === source.id || pendingInstall.current) return;
    if (edition.installedId) {
      toast({ description: `${languageName(edition.entry.lang)} is already installed.` });
      return;
    }
    if (edition.conflictsWithInstalled) return;
    pendingInstall.current = true;
    setInstalling(key);
    try {
      await extensionActions.install(edition.repositoryId, key, () =>
        confirm({
          title: 'Install from an unsigned repository?',
          description:
            'This repository does not sign its sources, so nothing verifies who wrote this code. Only install it if you trust the repository.',
          confirmLabel: 'Install anyway',
        }),
      );
      toast({ description: `${repairSourceName(edition.entry.name)} installed.` });
    } catch (error) {
      toast({
        variant: 'destructive',
        description:
          error instanceof Error
            ? error.message
            : `Couldn't install ${languageName(edition.entry.lang)}.`,
      });
    } finally {
      pendingInstall.current = false;
      if (mounted.current) setInstalling(null);
    }
  };
  const website =
    websiteUrl(record?.homepage) ??
    (source.id.startsWith('mangadex') ? 'https://mangadex.org/' : websiteUrl(source.base_url));
  return (
    <article className="rounded-2xl border border-border/60 bg-surface/40 p-4 transition hover:border-primary/30">
      <div className="flex items-start gap-3">
        <SourceAvatar name={source.name} accent={source.accent} iconUrl={record?.icon_url} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{source.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              {displayLanguage === 'all'
                ? languageName(source.lang)
                : (languages.find((language) => language.value === displayLanguage)?.label ??
                  languageName(source.lang))}
            </span>
            <span className="tabular-nums">
              {record ? `v${record.version}` : 'Version unavailable'}
            </span>
            {rating === 'nsfw' && <span className="text-destructive">Adult</span>}
            {rating === 'mixed' && <span className="text-primary">Mixed</span>}
            {health === 'failing' && (
              <span
                className="inline-flex items-center gap-1 text-destructive"
                title="The last request to this source failed. Settings → About has details."
              >
                <span aria-hidden="true" className="size-1.5 rounded-full bg-destructive" />
                Failing
              </span>
            )}
            {health === 'cooling-down' && (
              <span
                className="inline-flex items-center gap-1 text-amber-500"
                title="This source asked for a pause; requests resume automatically."
              >
                <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500" />
                Cooling down
              </span>
            )}
            {privateReading && (
              <span className="inline-flex items-center gap-1 text-primary">
                <EyeOff size={12} />
                Incognito
              </span>
            )}
          </div>
        </div>
        <button
          aria-label={`${pinned ? 'Unpin' : 'Pin'} ${source.name}`}
          title={pinned ? 'Unpin source' : 'Pin source'}
          aria-pressed={pinned}
          className={`rounded-lg p-2 hover:bg-accent ${pinned ? 'text-primary' : 'text-muted-foreground'}`}
          onClick={onTogglePin}
        >
          {pinned ? <PinOff size={17} /> : <Pin size={17} />}
        </button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            aria-label={`Options for ${source.name}`}
            className="rounded-lg p-2 text-muted-foreground hover:bg-accent"
          >
            <MoreVertical size={18} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Display languages</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                {hasLanguageFilter ? (
                  <DropdownMenuRadioGroup
                    value={displayLanguage}
                    onValueChange={setDisplayLanguage}
                  >
                    <DropdownMenuRadioItem value="all">All languages</DropdownMenuRadioItem>
                    <DropdownMenuSeparator />
                    {languages.map((language) => (
                      <DropdownMenuRadioItem key={language.value} value={language.value}>
                        {language.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                ) : (
                  <DropdownMenuRadioGroup
                    value={source.id}
                    onValueChange={(key) => void selectEdition(key)}
                  >
                    {!editionEntries.some((item) => item.entry.source_key === source.id) && (
                      <DropdownMenuRadioItem value={source.id}>
                        {languageName(source.lang)}
                        <span className="ml-4 text-xs text-muted-foreground">Installed</span>
                      </DropdownMenuRadioItem>
                    )}
                    {editionEntries.map((edition) => (
                      <DropdownMenuRadioItem
                        key={edition.entry.source_key}
                        value={edition.entry.source_key}
                        disabled={!!installing || edition.conflictsWithInstalled}
                        className="gap-4"
                      >
                        <span className="flex-1">{languageName(edition.entry.lang)}</span>
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                          {installing === edition.entry.source_key ? (
                            <>
                              <Loader2 size={12} className="animate-spin" />
                              Installing…
                            </>
                          ) : edition.conflictsWithInstalled ? (
                            'Other repository'
                          ) : edition.installedId || edition.entry.source_key === source.id ? (
                            'Installed'
                          ) : (
                            <>
                              <Download size={12} />
                              Install
                            </>
                          )}
                        </span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem
              role="menuitemcheckbox"
              aria-checked={privateReading}
              onSelect={onToggleIncognito}
              className="justify-between gap-4"
            >
              Incognito mode
              <span className="text-xs text-muted-foreground">{privateReading ? 'On' : 'Off'}</span>
            </DropdownMenuItem>
            {pinned && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!canMoveUp} onSelect={() => onMovePin(-1)}>
                  <ArrowUp size={14} className="mr-2" />
                  Move pin up
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canMoveDown} onSelect={() => onMovePin(1)}>
                  <ArrowDown size={14} className="mr-2" />
                  Move pin down
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {installing && (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          Installing language edition…
        </p>
      )}
      <div className="mt-5 flex items-center gap-2 border-t border-border/50 pt-3">
        <Link
          href={`/discover/popular?source=${encodeURIComponent(source.id)}`}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/20"
        >
          <TrendingUp size={14} />
          Popular
        </Link>
        {capabilities?.latest && (
          <Link
            href={`/discover/latest?source=${encodeURIComponent(source.id)}`}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-secondary px-3 py-2 text-xs font-medium hover:bg-accent"
          >
            <Clock size={14} />
            Latest
          </Link>
        )}
        {website && (
          <a
            href={website}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${source.name} website`}
            title="Open original website"
            className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-primary"
          >
            <ExternalLink size={17} />
          </a>
        )}
      </div>
      {dialog}
    </article>
  );
}
