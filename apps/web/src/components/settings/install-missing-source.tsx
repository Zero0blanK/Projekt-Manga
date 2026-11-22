'use client';

import { useState } from 'react';
import { extensionActions, useSourceCatalog } from '@/lib/extensions-store';
import {
  ENGINE_AUTHOR,
  useEngineExtensionActions,
  useSuwayomiExtensions,
} from '@/lib/engine-extensions';
import { findInstallableSource } from '@/lib/external-backup/mapping';
import { repositoryAuthor } from '@/lib/repository-url';
import { repairSourceName } from '@/lib/source-language';
import { useUnsignedInstallConfirm } from '@/hooks/use-unsigned-install-confirm';
import { toast } from '@/hooks/use-toast';

/**
 * For a source in an import that isn't installed: installs it right there, from whichever
 * repository (or the extension engine) offers a source of that name, so the reader doesn't
 * have to leave the import for Discover and come back. Renders nothing when none does.
 */
export function InstallMissingSource({
  name,
  disabled,
  onInstalled,
}: {
  /** The source's name as the backup gives it, e.g. "MangaDex (EN)". */
  name: string;
  disabled?: boolean;
  /** After installing: re-read the installed sources and match them again. */
  onInstalled: () => Promise<void>;
}) {
  const { entries, repositories } = useSourceCatalog();
  const engine = useSuwayomiExtensions();
  const engineActions = useEngineExtensionActions();
  const { confirmUnsigned, dialog } = useUnsignedInstallConfirm();
  const [installing, setInstalling] = useState(false);

  const fromRepository = findInstallableSource(
    name,
    entries
      .filter((item) => item.installedId === null && !item.conflictsWithInstalled)
      .map((item) => ({ name: repairSourceName(item.entry.name), lang: item.entry.lang, item })),
  );
  const fromEngine = fromRepository
    ? null
    : findInstallableSource(
        name,
        (engine.enabled ? (engine.list.data ?? []) : []).filter(
          (extension) => !extension.installed && !extension.obsolete,
        ),
      );
  if (!fromRepository && !fromEngine) return null;

  const repository = fromRepository
    ? repositories.find((entry) => entry.id === fromRepository.item.repositoryId)
    : null;
  const author = fromEngine ? ENGINE_AUTHOR : repository ? repositoryAuthor(repository) : null;

  const install = async () => {
    setInstalling(true);
    try {
      if (fromRepository) {
        await extensionActions.install(
          fromRepository.item.repositoryId,
          fromRepository.item.entry.source_key,
          confirmUnsigned,
        );
        toast({ description: `${fromRepository.name} installed.` });
      } else if (fromEngine) {
        await engineActions.change(fromEngine, 'install');
      }
      await onInstalled();
    } catch (error) {
      toast({
        description:
          error instanceof Error && error.message
            ? `Couldn't install ${name}: ${error.message}`
            : `Couldn't install ${name}.`,
      });
    } finally {
      setInstalling(false);
    }
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled || installing}
        onClick={() => void install()}
        aria-label={`Install ${fromRepository?.name ?? fromEngine?.name}${author ? ` from ${author}` : ''}`}
        className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
      >
        {installing ? 'Installing…' : `Install${author ? ` from ${author}` : ''}`}
      </button>
      {dialog}
    </>
  );
}
