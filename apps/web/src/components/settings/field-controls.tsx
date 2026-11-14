import {
  createContext,
  useContext,
  useId,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { actions, useSetting, useNumberSetting } from '@/lib/app-store';
import { SelectMenu } from '@/components/ui/select-menu';
import { Skeleton } from '@/components/ui/skeleton';

/** Settings > Appearance > Interface density — spacing scale for Panel/Field. */
const DENSITY_CLASSES: Record<string, { panel: string; stack: string; field: string }> = {
  Compact: { panel: 'p-4', stack: 'space-y-3', field: 'pt-3' },
  Comfortable: { panel: 'p-6', stack: 'space-y-5', field: 'pt-5' },
  Cozy: { panel: 'p-8', stack: 'space-y-7', field: 'pt-7' },
};

/** Card wrapper shared by every settings panel. */
export function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  const density = useSetting('density', 'Comfortable') as string;
  const d = DENSITY_CLASSES[density] ?? DENSITY_CLASSES.Comfortable;
  return (
    <section className={`rounded-2xl border border-border/60 bg-surface/40 ${d.panel}`}>
      <div>
        <h2 className="text-display text-2xl text-foreground">{title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <div className={`mt-6 ${d.stack}`}>{children}</div>
    </section>
  );
}

/** A labelled break inside a panel, for grouping a long list of fields. */
export function Group({ label }: { label: string }) {
  return (
    <div className="border-t border-border/50 pt-5 first:border-0 first:pt-0">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </h3>
    </div>
  );
}

/** Lets a control inside a `Field` name itself after the field's visible label. */
const FieldLabelContext = createContext<string | undefined>(undefined);

/** The id of the enclosing `Field`'s label, for `aria-labelledby`. */
function useFieldLabelId(): string | undefined {
  return useContext(FieldLabelContext);
}

/** Label + control row shared by every settings panel. */
export function Field({
  label,
  hint,
  children,
  /** Renders as a sub-row of the field above — used for options that only apply while a
   * toggle is on, so they read as part of it rather than as an unrelated setting. */
  nested = false,
  /** Dims the row and blocks interaction. */
  disabled = false,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  nested?: boolean;
  disabled?: boolean;
}) {
  const density = useSetting('density', 'Comfortable') as string;
  const d = DENSITY_CLASSES[density] ?? DENSITY_CLASSES.Comfortable;
  const labelId = useId();
  const spacing = nested ? 'mt-3 border-0 pt-0 pl-4' : `border-t border-border/50 ${d.field}`;
  return (
    // Stacked on a phone: the row never wraps and the label alone may reach `max-w-sm`
    // (384px), so label + control cannot fit side by side below `sm`.
    <div
      className={`flex flex-col gap-2 first:border-0 first:pt-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6 ${spacing} ${
        disabled ? 'pointer-events-none opacity-45' : ''
      }`}
      aria-disabled={disabled || undefined}
    >
      <div className="min-w-0 sm:max-w-sm">
        <div
          id={labelId}
          className={`font-medium text-foreground ${nested ? 'text-[13px]' : 'text-sm'}`}
        >
          {label}
        </div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="min-w-0 sm:shrink-0">
        <FieldLabelContext.Provider value={labelId}>{children}</FieldLabelContext.Provider>
      </div>
    </div>
  );
}

/**
 * A text input for a `Field` row, named by that field's visible label.
 *
 * `Field` provides the label context around its children, so the hook must run in a
 * component rendered inside `Field`, not in the one that renders `<Field>`.
 *
 * Full width on a phone and capped on larger screens: a fixed-width control would push the
 * non-wrapping `Field` row wider than the viewport.
 */
export function FieldInput({
  className = '',
  ...props
}: Omit<ComponentPropsWithoutRef<'input'>, 'aria-labelledby'>) {
  const fieldLabelId = useFieldLabelId();
  return (
    <input
      {...props}
      aria-labelledby={fieldLabelId}
      className={`w-full rounded-lg border border-border/60 bg-background px-3 py-1.5 text-foreground outline-none focus:border-primary/60 disabled:opacity-60 sm:w-72 ${className}`}
    />
  );
}

/**
 * A stateless boolean switch. `Toggle` renders it for app-store settings; settings stored
 * elsewhere use it directly to look the same.
 */
export function ToggleSwitch({
  on,
  onToggle,
  disabled = false,
  label,
}: {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** Only needed when the switch isn't already described by a `Field` label. */
  label?: string;
}) {
  // Named by the Field's visible label when there is one, so the switch has an accessible name.
  const fieldLabelId = useFieldLabelId();
  return (
    <button
      type="button"
      role="switch"
      onClick={onToggle}
      disabled={disabled}
      aria-checked={on}
      aria-label={label}
      aria-labelledby={label ? undefined : fieldLabelId}
      // The pseudo-element widens the touch target without changing the switch's look.
      className={`relative h-6 w-11 rounded-full transition after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-[''] disabled:opacity-50 ${
        on ? 'bg-primary' : 'bg-muted'
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-background transition ${
          on ? 'left-[22px]' : 'left-0.5'
        }`}
      />
    </button>
  );
}

/** A boolean setting, persisted to the app store under `settingKey`. */
export function Toggle({
  settingKey,
  defaultOn = false,
  label,
}: {
  settingKey: string;
  defaultOn?: boolean;
  label?: string;
}) {
  const on = useSetting(settingKey, defaultOn) as boolean;
  return (
    <ToggleSwitch on={on} onToggle={() => actions.setSetting(settingKey, !on)} label={label} />
  );
}

/** A single-choice setting, persisted to the app store under `settingKey`. */
export function Select({
  settingKey,
  options,
  defaultValue,
}: {
  settingKey: string;
  options: string[];
  defaultValue?: string;
}) {
  const value = useSetting(settingKey, defaultValue ?? options[0]) as string;
  return (
    <SelectMenu
      value={value}
      options={options.map((option) => ({ value: option, label: option }))}
      onChange={(next) => actions.setSetting(settingKey, next)}
      placeholder={value}
    />
  );
}

/** A single-choice setting whose stored value differs from what's shown — the store keeps
 * the stable id ("plan") while the menu shows the human label ("Plan to Read"). */
export function OptionSelect({
  settingKey,
  options,
  defaultValue,
}: {
  settingKey: string;
  options: Array<{ value: string; label: string }>;
  defaultValue: string;
}) {
  const stored = String(useSetting(settingKey, defaultValue));
  const current = options.find((o) => o.value === stored) ?? options[0];
  return (
    <SelectMenu
      value={current.value}
      options={options}
      onChange={(next) => actions.setSetting(settingKey, next)}
    />
  );
}

/** A numeric single-choice setting — stored as a number so consumers don't re-parse. */
export function NumberSelect({
  settingKey,
  options,
  defaultValue,
  format = (n) => String(n),
}: {
  settingKey: string;
  options: number[];
  defaultValue: number;
  format?: (n: number) => string;
}) {
  const value = useNumberSetting(settingKey, defaultValue);
  return (
    <SelectMenu
      value={String(value)}
      options={options.map((option) => ({ value: String(option), label: format(option) }))}
      onChange={(next) => actions.setSetting(settingKey, Number(next))}
      placeholder={format(value)}
    />
  );
}

/** A continuous numeric setting with a live read-out. */
export function Range({
  settingKey,
  min,
  max,
  step = 1,
  defaultValue,
  format = (n) => String(n),
}: {
  settingKey: string;
  min: number;
  max: number;
  step?: number;
  defaultValue: number;
  format?: (n: number) => string;
}) {
  const value = useNumberSetting(settingKey, defaultValue);
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => actions.setSetting(settingKey, Number(e.target.value))}
        aria-label={settingKey}
        className="h-1 w-40 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
      />
      <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
        {format(value)}
      </span>
    </div>
  );
}

/** A short free-text setting. */
export function TextInput({
  settingKey,
  defaultValue = '',
  placeholder,
  className = 'w-56',
}: {
  settingKey: string;
  defaultValue?: string;
  placeholder?: string;
  className?: string;
}) {
  const value = useSetting(settingKey, defaultValue) as string;
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => actions.setSetting(settingKey, e.target.value)}
      className={`${className} rounded-lg border border-border/60 bg-background px-3 py-1.5 text-xs text-foreground outline-none focus:border-primary/60`}
    />
  );
}

/** A plain action button for settings that *do* something rather than store a value. */
export function ActionButton({
  onClick,
  children,
  disabled = false,
  variant = 'default',
}: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  variant?: 'default' | 'destructive';
}) {
  const styles =
    variant === 'destructive'
      ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
      : 'border-border/60 text-foreground hover:bg-accent';
  return (
    <button
      // Never a form's submit button: it runs its own action.
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${styles}`}
    >
      {children}
    </button>
  );
}

/**
 * Where part of a panel waits for the server: its outline at about its final size, so the
 * rest of the panel is usable at once and nothing jumps when it arrives.
 */
export function LoadingBlock({ label, rows = 2 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="space-y-2 py-1">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton
          key={index}
          className={`h-8 rounded-lg ${index === rows - 1 && rows > 1 ? 'w-2/3' : 'w-full'}`}
        />
      ))}
    </div>
  );
}
