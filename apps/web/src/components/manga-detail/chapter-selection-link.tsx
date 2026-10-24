'use client';

import Link from 'next/link';
import type { KeyboardEvent, ReactNode } from 'react';
import { useHoldToSelect } from '@/hooks/use-hold-to-select';

export function ChapterSelectionLink({
  href,
  children,
  selected,
  selectionMode,
  onSelect,
  disabled,
  index,
  onNavigate,
  label,
}: {
  href: string;
  children: ReactNode;
  selected: boolean;
  selectionMode: boolean;
  onSelect: () => void;
  disabled: boolean;
  index: number;
  onNavigate: (event: KeyboardEvent<HTMLElement>, index: number) => void;
  label: string;
}) {
  const hold = useHoldToSelect({ onSelect, disabled });
  return (
    <Link
      {...hold}
      href={href}
      data-chapter-index={index}
      aria-label={`${label}${selected ? ', selected' : ', hold or press Space to select'}`}
      onKeyDown={(event) => {
        hold.onKeyDown(event);
        onNavigate(event, index);
      }}
      onClick={(event) => {
        if (selectionMode || disabled) {
          event.preventDefault();
          if (!disabled) onSelect();
        }
      }}
      className={`flex h-full min-w-0 flex-1 items-center gap-4 px-4 py-3 ${selected ? '' : 'group'}`}
    >
      {children}
    </Link>
  );
}
