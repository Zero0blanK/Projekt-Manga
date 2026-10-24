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
export const DEFAULT_ACCENT = '#e9a25a';

export const ACCENTS: Array<{ value: string; label: string }> = [
  { value: '#e9a25a', label: 'Amber' },
  { value: '#f2795b', label: 'Coral' },
  { value: '#ff7f9f', label: 'Rose' },
  { value: '#c07fff', label: 'Violet' },
  { value: '#7fb1ff', label: 'Azure' },
  { value: '#5ad1d1', label: 'Teal' },
  { value: '#7fffb5', label: 'Mint' },
  { value: '#c9d16a', label: 'Citron' },
];

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
  accent: string;
  uiScale: string;
  reduceMotion: boolean;
};

/** Applies appearance to `<html>`. Mirrored by THEME_INIT_SCRIPT — keep the two in step. */
export function applyAppearance(settings: AppearanceSettings) {
  const root = document.documentElement;
  const resolved = resolveTheme(settings.theme);

  root.setAttribute('data-theme', resolved);
  root.classList.toggle('dark', !LIGHT_THEMES.includes(resolved));

  if (isValidAccent(settings.accent)) {
    const fg = accentForeground(settings.accent);
    root.style.setProperty('--primary', settings.accent);
    root.style.setProperty('--primary-foreground', fg);
    root.style.setProperty('--ring', settings.accent);
    root.style.setProperty('--sidebar-primary', settings.accent);
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

  root.style.fontSize = /^\d{2,3}%$/.test(settings.uiScale) ? settings.uiScale : '';
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
r.setAttribute("data-theme",t);
r.classList.toggle("dark",L.indexOf(t)===-1);
var a=s.accent;
if(typeof a==="string"&&/^#[0-9a-f]{6}$/i.test(a)){
var n=parseInt(a.slice(1),16);
var c=[(n>>16)&255,(n>>8)&255,n&255].map(function(v){v=v/255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});
var f=(0.2126*c[0]+0.7152*c[1]+0.0722*c[2])>${ACCENT_LUMINANCE_PIVOT}?${JSON.stringify(ACCENT_FG_DARK)}:${JSON.stringify(ACCENT_FG_LIGHT)};
r.style.setProperty("--primary",a);r.style.setProperty("--primary-foreground",f);
r.style.setProperty("--ring",a);r.style.setProperty("--sidebar-primary",a);r.style.setProperty("--sidebar-primary-foreground",f);
}
if(typeof s.uiScale==="string"&&/^[0-9]{2,3}%$/.test(s.uiScale)){r.style.fontSize=s.uiScale;}
if(s.reduceMotion===true){r.classList.add("reduce-motion");}
}catch(e){}})();`;
