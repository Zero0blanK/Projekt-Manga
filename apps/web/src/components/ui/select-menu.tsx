'use client';

import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface SelectMenuOption {
  value: string;
  label: string;
}

/** The app's one dropdown: the control every single-choice setting and filter uses. */
export function SelectMenu({
  value,
  options,
  onChange,
  label,
  placeholder = '',
  id,
  disabled = false,
  className,
}: {
  value: string;
  options: readonly SelectMenuOption[];
  onChange: (value: string) => void;
  /** Its name for screen readers, when nothing on the page labels it. */
  label?: string;
  /** Shown while `value` matches none of the options. */
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}) {
  // One entry per value: a repeated one (from a source's own list, say) would be the same
  // choice twice, and React can't tell the two rows apart.
  const choices = options.filter(
    (option, index) => options.findIndex((other) => other.value === option.value) === index,
  );
  const shown = choices.find((option) => option.value === value)?.label ?? placeholder;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        id={id}
        disabled={disabled}
        aria-label={label ? `${label}: ${shown}` : undefined}
        className={cn(
          'flex h-8 min-w-40 items-center justify-between gap-2 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-xs text-foreground outline-none focus:border-primary/60 disabled:opacity-50',
          className,
        )}
      >
        <span className="truncate">{shown}</span>
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-50" />
      </DropdownMenuTrigger>
      {/* Level with its button and at least as wide, whatever width the button is given; a
          small button (the year picker) gets no wider floor than itself. */}
      <DropdownMenuContent
        align="start"
        className="max-h-72 min-w-(--radix-dropdown-menu-trigger-width)"
      >
        {choices.map((option) => (
          <DropdownMenuItem
            key={option.value}
            aria-current={option.value === value ? 'true' : undefined}
            onSelect={() => onChange(option.value)}
            className={`text-xs ${option.value === value ? 'text-primary' : ''}`}
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
