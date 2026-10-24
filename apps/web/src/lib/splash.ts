/**
 * Session-once gating for the boot splash, mirroring how `lib/theme.ts` prevents a theme
 * flash: a blocking script in `<head>` decides *before the first paint* whether this
 * session has already seen the splash, by setting an attribute on `<html>` that a plain
 * CSS rule (see `.splash-root` in styles.css) hides on. `SplashIntro` itself is rendered
 * unconditionally (not behind a client-only `useState` flip) so its markup is part of the
 * actual server-rendered HTML — that's what closes the gap where the real page was
 * visible for a moment before the splash mounted.
 */

/** Set once per browser session (sessionStorage — clears on tab/window close, survives a
 * reload), so a refresh of a page you're already using doesn't replay the boot animation,
 * while a genuinely new visit still gets it. */
export const SPLASH_SESSION_KEY = 'projekt-manga:splash-shown';

/** The attribute the blocking script stamps on `<html>` when this session has already
 * shown the splash. Purely a CSS hook — see the `html[${SPLASH_SKIP_ATTR}]` rule. */
export const SPLASH_SKIP_ATTR = 'data-skip-splash';

/** When the browser last showed the splash (localStorage, a timestamp in ms). */
export const SPLASH_LAST_SHOWN_KEY = 'projekt-manga:splash-last-shown';

/** The splash plays at most once in this window per browser. */
export const SPLASH_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * Runs synchronously in `<head>`, before the first paint, and stamps `SPLASH_SKIP_ATTR` on
 * `<html>` (so the CSS rule hides `.splash-root` before React hydrates, with nothing to
 * flash) when any of these hold:
 *
 * - this tab already showed it (a reload);
 * - the page was opened from inside the app, e.g. a title opened in a new tab: the
 *   referrer is this origin;
 * - this browser showed it within `SPLASH_INTERVAL_MS`.
 *
 * Checking `sessionStorage` alone would replay the intro in every new tab, hence the
 * referrer and interval checks. Otherwise it records the showing right away and leaves the
 * splash visible.
 */
export const SPLASH_INIT_SCRIPT = `(function(){try{
var KEY=${JSON.stringify(SPLASH_SESSION_KEY)},LAST=${JSON.stringify(SPLASH_LAST_SHOWN_KEY)},now=Date.now();
var fromApp=false;try{fromApp=!!document.referrer&&new URL(document.referrer).origin===location.origin;}catch(e){}
var last=0;try{last=Number(localStorage.getItem(LAST))||0;}catch(e){}
if(sessionStorage.getItem(KEY)||fromApp||(last>0&&now-last<${SPLASH_INTERVAL_MS})){
document.documentElement.setAttribute(${JSON.stringify(SPLASH_SKIP_ATTR)},"1");
sessionStorage.setItem(KEY,"1");
}else{
sessionStorage.setItem(KEY,"1");
try{localStorage.setItem(LAST,String(now));}catch(e){}
}
}catch(e){}})();`;
