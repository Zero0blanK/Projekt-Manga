/**
 * Appearance: the palette, accent and scale settings, plus the two ways they get applied.
 *
 * These land on `<html>` twice: once from a blocking script in `<head>` (before the first
 * paint, so a saved theme never flashes the default first), and again from the app shell
 * whenever the settings change at runtime. Both go through the same definitions here so
 * the two can't drift apart.
 */

/** Must match the key `app-store` persists under — the init script reads it directly,
 * before any module has loaded. */
export const APP_STATE_STORAGE_KEY = 'projekt-manga:state:v1';

export type ThemeId = 'dark' | 'dim' | 'midnight' | 'light' | 'paper' | 'auto';

export type ThemeOption = {
  id: ThemeId;
  label: string;
  hint: string;
  /** Preview swatch: page background, raised surface, and text — approximations of the
   * palette in `styles.css`, only used to draw the little theme cards. */
  preview: { background: string; surface: string; foreground: string };
};

export const THEMES: ThemeOption[] = [
  {
    id: 'dark',
    label: 'Dark',
    hint: 'Warm near-black',
    preview: { background: '#16130f', surface: '#221e19', foreground: '#f4f0ea' },
  },
  {
    id: 'dim',
    label: 'Dim',
    hint: 'Softer, lifted greys',
    preview: { background: '#2a2621', surface: '#35302a', foreground: '#f4f0ea' },
  },
  {
    id: 'midnight',
    label: 'Midnight',
    hint: 'True black, for OLED',
    preview: { background: '#000000', surface: '#0d0d0d', foreground: '#f2f2f2' },
  },
  {
    id: 'light',
    label: 'Light',
    hint: 'Warm off-white',
    preview: { background: '#faf8f5', surface: '#ffffff', foreground: '#2b2621' },
  },
  {
    id: 'paper',
    label: 'Paper',
    hint: 'Sepia, easy on the eyes',
    preview: { background: '#f3e9d8', surface: '#faf3e6', foreground: '#3a2f22' },
  },
  {
    id: 'auto',
    label: 'Auto',
    hint: 'Follows your system',
    preview: { background: '#16130f', surface: '#faf8f5', foreground: '#8a8378' },
  },
];

/** Light-palette themes. Every other theme gets the `dark` class that Tailwind's `dark:`
 * variant keys off. */
export const LIGHT_THEMES: string[] = ['light', 'paper'];

export const DEFAULT_THEME: ThemeId = 'dark';
export const DEFAULT_ACCENT = '#7fb1ff';

export const ACCENTS: Array<{ value: string; label: string }> = [
  { value: '#e9a25a', label: 'Amber' },
  { value: '#f2795b', label: 'Coral' },
  { value: '#ff7f9f', label: 'Rose' },
  { value: '#c07fff', label: 'Violet' },
  { value: '#7fb1ff', label: 'Azure' },
  { value: '#5ad1d1', label: 'Teal' },
  { value: '#7fffb5', label: 'Mint' },
  { value: '#c9d16a', label: 'Citron' },
  { value: '#6b8f6b', label: 'Sage' },
];

/**
 * The interface style. Classic is the app's own look. Frost is a quieter, denser one:
 * frosted-glass surfaces, near-black (or paper) layers, DM Sans with DM Mono labels, small
 * corners and quick motion, on this app's own layout. Its tokens are in `styles.css` under
 * `data-ui="frost"` (with the credit for where they come from), and its own palettes are
 * picked by `data-frost` on `<html>`.
 */
export type UiStyle = 'classic' | 'frost';

export const UI_STYLES: Array<{ id: UiStyle; label: string; hint: string }> = [
  { id: 'classic', label: 'Classic', hint: 'The look you know: rounded, warm, roomy' },
  { id: 'frost', label: 'Frost', hint: 'Frosted glass, compact and quiet' },
];

export const DEFAULT_UI_STYLE: UiStyle = 'classic';

export function resolveUiStyle(value: unknown): UiStyle {
  return value === 'frost' ? 'frost' : DEFAULT_UI_STYLE;
}

/** Frost's own palettes. Each has its own accent. */
export type FrostThemeId = 'original' | 'dark' | 'midnight' | 'warm' | 'light' | 'auto';

export type FrostThemeOption = Omit<ThemeOption, 'id'> & { id: FrostThemeId };

export const FROST_THEMES: FrostThemeOption[] = [
  {
    id: 'original',
    label: 'Original',
    hint: 'Near-black, sage accent',
    preview: { background: '#0c0c0c', surface: '#151515', foreground: '#f0efec' },
  },
  {
    id: 'dark',
    label: 'Dark',
    hint: 'True black, brighter text',
    preview: { background: '#000000', surface: '#111111', foreground: '#ffffff' },
  },
  {
    id: 'midnight',
    label: 'Midnight',
    hint: 'Deep navy, indigo accent',
    preview: { background: '#080c18', surface: '#101428', foreground: '#eeeef8' },
  },
  {
    id: 'warm',
    label: 'Warm',
    hint: 'Brown and amber',
    preview: { background: '#100e08', surface: '#1c1810', foreground: '#f5f0e0' },
  },
  {
    id: 'light',
    label: 'Light',
    hint: 'Warm paper',
    preview: { background: '#e2deda', surface: '#f5f2ec', foreground: '#080806' },
  },
  {
    id: 'auto',
    label: 'Auto',
    hint: 'Original or Light, as your system',
    preview: { background: '#0c0c0c', surface: '#f5f2ec', foreground: '#8a8880' },
  },
];

export const DEFAULT_FROST_THEME: FrostThemeId = 'original';

export function resolveFrostTheme(theme: unknown): Exclude<FrostThemeId, 'auto'> {
  const id = String(theme || DEFAULT_FROST_THEME).toLowerCase();
  if (id === 'auto') {
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'original'
      : 'light';
  }
  return (FROST_THEMES.some((t) => t.id === id) ? id : DEFAULT_FROST_THEME) as Exclude<
    FrostThemeId,
    'auto'
  >;
}

/** Each Frost palette's own accent: what the swatches show as selected until one is picked. */
export const FROST_ACCENTS: Record<Exclude<FrostThemeId, 'auto'>, string> = {
  original: '#6b8f6b',
  dark: '#7aaa7a',
  midnight: '#6a7ab8',
  warm: '#c0902a',
  light: '#3f9142',
};

/** Frost sets its body in 13px where Classic's is 14px: the same scale, a size smaller. */
const FROST_TYPE_SCALE = 13 / 14;

/**
 * The accent picked, or none: Classic then uses its default, and Frost its palette's own
 * accent from `styles.css`.
 */
export function effectiveAccent(accent: unknown, uiStyle: unknown): string | null {
  if (isValidAccent(accent)) return accent;
  return resolveUiStyle(uiStyle) === 'frost' ? null : DEFAULT_ACCENT;
}

/** The accent the swatches show as current. */
export function shownAccent(accent: unknown, uiStyle: unknown, frostTheme: unknown): string {
  return (
    effectiveAccent(accent, uiStyle) ??
    FROST_ACCENTS[resolveFrostTheme(frostTheme)] ??
    DEFAULT_ACCENT
  );
}

export const UI_SCALES = ['90%', '100%', '110%', '125%'] as const;
export const DEFAULT_UI_SCALE = '100%';

/**
 * Luminance at which black and white text score the same WCAG contrast against the
 * accent: solving `(L + 0.05) / 0.05 = 1.05 / (L + 0.05)` gives `L = sqrt(0.0525) - 0.05`.
 * Above it black wins, below it white — a fixed eyeballed threshold puts white text on
 * light accents like amber or mint, where it's barely readable.
 */
const ACCENT_LUMINANCE_PIVOT = 0.1791;
const ACCENT_FG_DARK = 'oklch(0.18 0.02 60)';
const ACCENT_FG_LIGHT = 'oklch(0.99 0.005 80)';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** WCAG relative luminance, so button labels stay readable on a custom accent instead of
 * always assuming a light one. */
function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function accentForeground(hex: string): string {
  if (!HEX_COLOR.test(hex)) return ACCENT_FG_DARK;
  return relativeLuminance(hex) > ACCENT_LUMINANCE_PIVOT ? ACCENT_FG_DARK : ACCENT_FG_LIGHT;
}

export function isValidAccent(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

/** Resolves "auto" against the OS preference. Also accepts capitalised values
 * ("Dark", "Auto") from older persisted settings. */
export function resolveTheme(theme: string): Exclude<ThemeId, 'auto'> {
  const id = String(theme || DEFAULT_THEME).toLowerCase();
  if (id === 'auto') {
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return (THEMES.some((t) => t.id === id) ? id : DEFAULT_THEME) as Exclude<ThemeId, 'auto'>;
}

export type AppearanceSettings = {
  theme: string;
  /** The accent picked, or undefined for the interface style's default. */
  accent: string | undefined;
  uiScale: string;
  reduceMotion: boolean;
  uiStyle?: string;
  /** Frost's palette (Frost style only). */
  frostTheme?: string;
  /** Frost's glass; false gives solid surfaces. */
  frostGlass?: boolean;
};

/** Applies appearance to `<html>`. Mirrored by THEME_INIT_SCRIPT — keep the two in step. */
export function applyAppearance(settings: AppearanceSettings) {
  const root = document.documentElement;
  const style = resolveUiStyle(settings.uiStyle);
  const frost = style === 'frost' ? resolveFrostTheme(settings.frostTheme) : null;
  // Frost keeps data-theme on the nearest Classic one, which is what dark/light checks read.
  const resolved = frost ? (frost === 'light' ? 'light' : 'dark') : resolveTheme(settings.theme);

  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-ui', style);
  if (frost) root.setAttribute('data-frost', frost);
  else root.removeAttribute('data-frost');
  root.classList.toggle('frost-off', frost !== null && settings.frostGlass === false);
  root.classList.toggle('dark', !LIGHT_THEMES.includes(resolved));

  const accent = effectiveAccent(settings.accent, settings.uiStyle);
  if (isValidAccent(accent)) {
    const fg = accentForeground(accent);
    root.style.setProperty('--primary', accent);
    root.style.setProperty('--primary-foreground', fg);
    root.style.setProperty('--ring', accent);
    root.style.setProperty('--sidebar-primary', accent);
    root.style.setProperty('--sidebar-primary-foreground', fg);
  } else {
    for (const prop of [
      '--primary',
      '--primary-foreground',
      '--ring',
      '--sidebar-primary',
      '--sidebar-primary-foreground',
    ]) {
      root.style.removeProperty(prop);
    }
  }

  const scale = /^\d{2,3}%$/.test(settings.uiScale) ? parseInt(settings.uiScale, 10) : 100;
  const size = frost ? scale * FROST_TYPE_SCALE : scale;
  root.style.fontSize = size === 100 ? '' : `${Number(size.toFixed(3))}%`;
  root.classList.toggle('reduce-motion', settings.reduceMotion === true);
}

/**
 * Runs synchronously in `<head>`, before React and before the first paint, so a saved
 * theme is already on `<html>` when the page renders. Without it the document paints the
 * stylesheet defaults and only swaps to the saved theme once hydration runs an effect —
 * which is exactly the "flash of the wrong colour on refresh" this avoids.
 */
export const THEME_INIT_SCRIPT = `(function(){try{
var s=(JSON.parse(localStorage.getItem(${JSON.stringify(APP_STATE_STORAGE_KEY)})||"{}")||{}).settings||{};
var L=${JSON.stringify(LIGHT_THEMES)},r=document.documentElement;
var t=String(s.theme||${JSON.stringify(DEFAULT_THEME)}).toLowerCase();
if(t==="auto"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}
var u=s.uiStyle==="frost"?"frost":"classic";
if(u==="frost"){
var M=${JSON.stringify(FROST_THEMES.map((theme) => theme.id))};
var m=String(s.frostTheme||${JSON.stringify(DEFAULT_FROST_THEME)}).toLowerCase();
if(m==="auto"){m=window.matchMedia("(prefers-color-scheme: dark)").matches?"original":"light";}
if(M.indexOf(m)===-1){m=${JSON.stringify(DEFAULT_FROST_THEME)};}
r.setAttribute("data-frost",m);t=m==="light"?"light":"dark";
if(s.frostGlass===false){r.classList.add("frost-off");}
}
r.setAttribute("data-theme",t);
r.setAttribute("data-ui",u);
r.classList.toggle("dark",L.indexOf(t)===-1);
var a=s.accent;
if(!(typeof a==="string"&&/^#[0-9a-f]{6}$/i.test(a))&&u==="classic"){a=${JSON.stringify(DEFAULT_ACCENT)};}
if(typeof a==="string"&&/^#[0-9a-f]{6}$/i.test(a)){
var n=parseInt(a.slice(1),16);
var c=[(n>>16)&255,(n>>8)&255,n&255].map(function(v){v=v/255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});
var f=(0.2126*c[0]+0.7152*c[1]+0.0722*c[2])>${ACCENT_LUMINANCE_PIVOT}?${JSON.stringify(ACCENT_FG_DARK)}:${JSON.stringify(ACCENT_FG_LIGHT)};
r.style.setProperty("--primary",a);r.style.setProperty("--primary-foreground",f);
r.style.setProperty("--ring",a);r.style.setProperty("--sidebar-primary",a);r.style.setProperty("--sidebar-primary-foreground",f);
}
var z=typeof s.uiScale==="string"&&/^[0-9]{2,3}%$/.test(s.uiScale)?parseInt(s.uiScale,10):100;
if(u==="frost"){z=z*${FROST_TYPE_SCALE};}
if(z!==100){r.style.fontSize=Number(z.toFixed(3))+"%";}
if(s.reduceMotion===true){r.classList.add("reduce-motion");}
}catch(e){}})();`;
