'use client';

import Link from 'next/link';
import type { ComponentType } from 'react';

export type NavItem = {
  label: string;
  to: string;
  icon: ComponentType<{ size?: number; className?: string }>;
};

export function NavButton({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.to}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      className={`group relative grid h-11 w-11 shrink-0 place-items-center rounded-full transition focus-visible:outline-2 focus-visible:outline-primary ${
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
