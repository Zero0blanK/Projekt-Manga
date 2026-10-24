import type { ReactNode } from 'react';

export function IconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid h-8 w-8 place-items-center pointer-coarse:size-11 rounded-lg border border-border/60 text-muted-foreground transition hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}
