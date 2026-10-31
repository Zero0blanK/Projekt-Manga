import { zoneGrid, type Zone } from '@/lib/click-zones';
import { cn } from '@/lib/utils';

const ZONE_TINT: Record<Zone, string> = {
  left: 'bg-sky-400/35',
  center: 'bg-white/10',
  right: 'bg-amber-400/35',
};

/** What a click-zone action does, in the reader's own direction. */
export function describeZoneAction(action: string, rtl: boolean): string {
  if (action === 'Forward') return 'Next page';
  if (action === 'Back') return 'Previous page';
  if (action === 'Direction') return rtl ? 'Next page' : 'Previous page';
  if (action === 'Opposite') return rtl ? 'Previous page' : 'Next page';
  if (action === 'Controls') return 'Show controls';
  return 'Nothing';
}

/**
 * A click-zone layout as a shaded grid with a legend of what each zone does: the reader's
 * first-run hint and the settings preview draw the same picture.
 */
export function ZoneLayoutPreview({
  layout,
  labels,
  className,
}: {
  layout: string;
  labels: Record<Zone, string>;
  className?: string;
}) {
  const grid = zoneGrid(layout);
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        aria-hidden
        className="grid aspect-[3/4] w-full grid-cols-6 overflow-hidden rounded-md border border-white/20"
      >
        {grid.flat().map((zone, index) => (
          <div key={index} className={zone ? ZONE_TINT[zone] : 'bg-transparent'} />
        ))}
      </div>
      <ul className="space-y-1 text-xs">
        {(['left', 'center', 'right'] as const)
          .filter((zone) => grid.some((row) => row.includes(zone)))
          .map((zone) => (
            <li key={zone} className="flex items-center gap-2">
              <span className={cn('h-3 w-3 shrink-0 rounded-sm', ZONE_TINT[zone])} />
              {labels[zone]}
            </li>
          ))}
      </ul>
    </div>
  );
}
