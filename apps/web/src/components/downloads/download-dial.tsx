'use client';

import { ProgressDial } from '@/components/progress-dial';
import { useDownloadQueueSummary } from '@/components/downloads/row-data';

/** Chapter downloads under way, in the same corner and form as the library update dial. */
export function DownloadDial() {
  const summary = useDownloadQueueSummary();
  if (!summary) return null;
  const { fraction, remaining, title } = summary;
  return (
    <ProgressDial
      id="downloads"
      name="downloads"
      fraction={fraction}
      status={`Downloading ${remaining} chapter${remaining === 1 ? '' : 's'}`}
      detail={title}
    />
  );
}
