'use client';

import Link from 'next/link';
import type { ComponentType } from 'react';

export type NavItem = {
  label: string;
  to: string;
  icon: ComponentType<{ size?: number; className?: string }>;
};

/**
 * A nav bar item's box: 44px tall everywhere; on a phone the items share the bar's width,
 * so the bar stays one row even where a scrollbar or a small screen leaves less than the
 * seven 44px circles need. From sm up each is a 44px circle.
 */
export const NAV_ITEM_SIZE = 'h-11 min-w-0 flex-1 sm:w-11 sm:flex-none sm:shrink-0';

export function NavButton({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.to}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      className={`group relative grid ${NAV_ITEM_SIZE} place-items-center rounded-full transition focus-visible:outline-2 focus-visible:outline-primary ${
        active
          ? 'bg-primary/15 text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      <Icon size={20} />
      <span className="pointer-events-none absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border/60 bg-popover px-2 py-1 text-[10px] font-medium text-foreground opacity-0 shadow-sm transition group-hover:opacity-100 group-focus-visible:opacity-100">
        {item.label}
      </span>
    </Link>
  );
}
