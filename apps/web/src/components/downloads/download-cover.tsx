import { Cover } from '@/components/cover';
import type { DownloadRow } from '@/components/downloads/row-data';

/** Cover thumbnail for a download row. */
export function DownloadCover({ row, className }: { row: DownloadRow; className: string }) {
  return (
    <Cover
      sourceId={row.sourceId}
      mangaId={row.mangaId}
      src={row.thumbnailUrl}
      alt={row.title}
      className={className}
    />
  );
}
