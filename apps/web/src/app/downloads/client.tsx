'use client';

import { useEffect, useState } from 'react';
import { getDownloadDirectory } from '@projekt-manga/api-client';
import { OpenFolderButton } from '@/components/downloads/open-folder-button';

import { useDownloadRows } from '@/components/downloads/row-data';
import { StorageStats } from '@/components/downloads/storage-stats';
import { ActiveDownloadsList } from '@/components/downloads/active-downloads-list';
import { CompletedDownloadsList } from '@/components/downloads/completed-downloads-list';
import { PageShell, PageHeader, PageBody } from '@/components/page-shell';
import { RowListSkeleton } from '@/components/skeletons';
import { Download } from 'lucide-react';
import { isAborted, reportError } from '@/lib/report-error';

export function DownloadsPageClient() {
  const { active, completed, loading, error, refresh } = useDownloadRows();
  // The library-wide download folder, for a single "where does all this live" action.
  const [rootFolder, setRootFolder] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getDownloadDirectory(controller.signal)
      .then(({ path }) => setRootFolder(path))
      .catch((error) => {
        if (!isAborted(error)) reportError(error, "Couldn't find the download folder.");
      });
    return () => controller.abort();
  }, []);

  return (
    <PageShell>
      <PageHeader
        icon={Download}
        eyebrow="Downloads"
        title="Offline library"
        description="Read anywhere — even without a connection."
        actions={<OpenFolderButton path={rootFolder} label="Download folder" withText />}
      />

      <PageBody>
        {error && (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-destructive/40 p-4 text-sm text-foreground"
          >
            Downloads could not be refreshed. The list below may be out of date.
            <button type="button" onClick={refresh} className="ml-2 text-primary hover:underline">
              Try again
            </button>
          </div>
        )}
        <StorageStats />
        {loading && active.length === 0 && completed.length === 0 ? (
          <>
            <RowListSkeleton count={2} thumbnail={false} />
            <RowListSkeleton count={4} />
          </>
        ) : error && active.length === 0 && completed.length === 0 ? null : (
          <>
            <ActiveDownloadsList rows={active} onChange={refresh} />
            <CompletedDownloadsList rows={completed} onChange={refresh} />
          </>
        )}
      </PageBody>
    </PageShell>
  );
}
