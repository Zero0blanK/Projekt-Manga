'use client';

import { useEffect, useRef, useState } from 'react';
import { SPLASH_SKIP_ATTR } from '@/lib/splash';

const LATIN = 'PROJEKT MANGA';
const JP = 'プロジェクト・マンガ';
const POOL =
  'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789#%&@$/\\<>[]{}';

/**
 * One fixed-width cell per slot, for the longer of the two titles, with both strings
 * centred inside that grid.
 *
 * This keeps the layout still: Japanese glyphs are full-width where Latin capitals are
 * roughly 0.6em, so rendering plain text would resize the row, and dropping spare slots
 * mid-animation would shift it again. A constant grid of constant cells means the title
 * never changes width — only what's inside each cell does.
 */
const SLOTS = Math.max(LATIN.length, JP.length);
const LATIN_OFFSET = Math.floor((SLOTS - LATIN.length) / 2);
const JP_OFFSET = Math.floor((SLOTS - JP.length) / 2);

const latinAt = (slot: number) => LATIN[slot - LATIN_OFFSET];
const jpAt = (slot: number) => JP[slot - JP_OFFSET];

/**
 * Half-cell nudge that optically centres a string inside the slot grid.
 *
 * The two titles differ in length by an odd number, so the spare slots can never split
 * evenly between both — one of them is always a half cell off. Rather than accept a
 * visibly off-centre title, the row itself shifts by the leftover. Derived from the
 * strings so it stays correct if either is edited; the grid's width never changes, only
 * where it sits.
 */
const centeringShift = (length: number, offset: number) => SLOTS / 2 - (offset + length / 2);
const LATIN_SHIFT = centeringShift(LATIN.length, LATIN_OFFSET);
const JP_SHIFT = centeringShift(JP.length, JP_OFFSET);

type Phase = 'boot' | 'glitch' | 'resolve' | 'hold' | 'out' | 'done';
type Cell = { char: string; locked: boolean; hot: boolean };

/** Timings up to the point the title has resolved. The animation has to run at its own
 * pace to read properly, so these are fixed; everything after `resolve` waits on the app. */
const BOOT_MS = 420;
const GLITCH_MS = 1650;
/** Held after the app reports ready, so the splash doesn't snap away the instant a warm
 * cache resolves. */
const TAIL_AFTER_READY_MS = 650;
/** Nothing traps the reader behind the splash: an unreachable server still lets go. */
const MAX_HOLD_MS = 6000;
const OUT_MS = 620;

function randChar() {
  return POOL[Math.floor(Math.random() * POOL.length)]!;
}

/** Per-slot lock schedule: each character settles at its own moment, centre outward. */
function buildSchedule() {
  const order = Array.from({ length: SLOTS }, (_, i) => i).sort(
    (a, b) => Math.abs(a - (SLOTS - 1) / 2) - Math.abs(b - (SLOTS - 1) / 2) || Math.random() - 0.5,
  );
  const lockAt: number[] = [];
  order.forEach((slot, rank) => {
    // Staggered, with a little jitter so it never feels metronomic.
    lockAt[slot] = 0.16 + (rank / SLOTS) * 0.7 + (Math.random() - 0.5) * 0.08;
  });
  return lockAt;
}

const latinCells = (): Cell[] =>
  Array.from({ length: SLOTS }, (_, i) => ({
    char: latinAt(i) ?? ' ',
    locked: true,
    hot: false,
  }));

const jpCells = (): Cell[] =>
  Array.from({ length: SLOTS }, (_, i) => ({ char: jpAt(i) ?? ' ', locked: true, hot: false }));

/**
 * Boot sequence: PROJEKT MANGA corrupts glyph by glyph into プロジェクト・マンガ.
 *
 * Runs its animation at a fixed pace, then holds on the resolved title until `ready` —
 * so the splash covers however long the app actually takes to come up, rather than
 * finishing early over a half-built page or lingering past a warm one.
 */
export function SplashIntro({ ready, onFinish }: { ready: boolean; onFinish?: () => void }) {
  const [phase, setPhase] = useState<Phase>('boot');
  const [cells, setCells] = useState<Cell[]>(latinCells);
  const raf = useRef<number | null>(null);
  const finished = useRef(false);

  // Fixed run-up: boot → glitch → resolve. `hold` is open-ended and ends below.
  //
  // This component is always rendered — see app-shell.tsx — so its "boot" phase markup
  // (deterministic; no randomness until "glitch") is genuinely part of the server-rendered
  // HTML rather than something a client-only mount adds a beat late. That's what closes
  // the gap where the real page was briefly visible underneath.
  //
  // A session that's already seen the splash is decided *before this component even
  // hydrates*, by a blocking script in <head> (SPLASH_INIT_SCRIPT) that stamps
  // SPLASH_SKIP_ATTR on <html> — a plain CSS rule hides `.splash-root` on that attribute,
  // so the skip is instant and flash-free regardless of how long hydration takes. This
  // effect only needs to stop the animation from running invisibly in the background and
  // let the component unmount.
  useEffect(() => {
    if (document.documentElement.hasAttribute(SPLASH_SKIP_ATTR)) {
      finished.current = true;
      setPhase('done');
      return;
    }

    const timers = [
      setTimeout(() => setPhase('glitch'), BOOT_MS),
      setTimeout(() => setPhase('resolve'), BOOT_MS + GLITCH_MS),
      setTimeout(() => setPhase('hold'), BOOT_MS + GLITCH_MS + 260),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  // A click, tap or key press skips straight to the fade-out once the app can be shown.
  useEffect(() => {
    if (phase === 'done' || phase === 'out' || finished.current) return;
    const skip = () => {
      if (finished.current) return;
      finished.current = true;
      setPhase('out');
      setTimeout(() => {
        setPhase('done');
        onFinish?.();
      }, OUT_MS);
    };
    window.addEventListener('pointerdown', skip, { once: true });
    window.addEventListener('keydown', skip, { once: true });
    return () => {
      window.removeEventListener('pointerdown', skip);
      window.removeEventListener('keydown', skip);
    };
  }, [phase, onFinish]);

  // Hand over once the app is ready — plus a beat — or when the cap runs out.
  useEffect(() => {
    if (phase !== 'hold' || finished.current) return;
    const leave = () => {
      if (finished.current) return;
      finished.current = true;
      setPhase('out');
      setTimeout(() => {
        setPhase('done');
        onFinish?.();
      }, OUT_MS);
    };
    const timer = setTimeout(leave, ready ? TAIL_AFTER_READY_MS : MAX_HOLD_MS);
    return () => clearTimeout(timer);
  }, [phase, ready, onFinish]);

  useEffect(() => {
    if (phase === 'boot') {
      setCells(latinCells());
      return;
    }
    if (phase !== 'glitch') {
      setCells(jpCells());
      return;
    }

    const lockAt = buildSchedule();
    const start = performance.now();
    // Each slot cycles glyphs at its own rate — this is what reads as individual letters
    // swapping rather than one word jiggling.
    const speed = Array.from({ length: SLOTS }, () => 45 + Math.random() * 85);
    const nextAt = new Array<number>(SLOTS).fill(0);
    const current = Array.from({ length: SLOTS }, (_, i) => latinAt(i) ?? ' ');

    const tick = (now: number) => {
      const elapsed = now - start;
      const p = Math.min(1, elapsed / GLITCH_MS);
      const out: Cell[] = [];

      for (let i = 0; i < SLOTS; i++) {
        const target = jpAt(i);
        const settled = p >= lockAt[i]!;

        // Slots with no kana still scramble, then blank out in place. Removing them would
        // shorten the row — the very reflow this grid exists to prevent.
        if (target === undefined || target === ' ') {
          if (settled) {
            out.push({ char: ' ', locked: true, hot: false });
            continue;
          }
          if (elapsed >= nextAt[i]!) {
            current[i] = randChar();
            nextAt[i] = elapsed + speed[i]!;
          }
          out.push({ char: current[i]!, locked: false, hot: true });
          continue;
        }

        if (settled) {
          out.push({ char: target, locked: true, hot: p - lockAt[i]! < 0.06 });
          continue;
        }

        if (elapsed >= nextAt[i]!) {
          // Early on it still flickers between its Latin origin and pure noise.
          current[i] = p < 0.3 && Math.random() < 0.4 ? (latinAt(i) ?? randChar()) : randChar();
          nextAt[i] = elapsed + speed[i]!;
        }
        out.push({ char: current[i]!, locked: false, hot: false });
      }

      setCells(out);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };

    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [phase]);

  if (phase === 'done') return null;

  const jpMode = phase !== 'boot' && phase !== 'glitch';

  const renderRow = (variant: 'main' | 'r' | 'b') => (
    <span className={`splash-layer splash-layer-${variant}`} key={variant}>
      {cells.map((cell, i) => (
        <span
          key={`${variant}-${i}`}
          className={`splash-char${cell.locked ? ' is-locked' : ' is-scrambling'}${
            cell.hot ? ' is-hot' : ''
          }`}
          style={{ animationDelay: `${(i % 5) * 37}ms` }}
        >
          {cell.char === ' ' ? ' ' : cell.char}
        </span>
      ))}
    </span>
  );

  return (
    <div
      className={`splash-root${phase === 'out' ? ' splash-out' : ''}`}
      role="presentation"
      aria-hidden="true"
      data-phase={phase}
    >
      <div className="splash-vignette" />
      <div className="splash-grid" />

      <div className={`splash-stage${phase === 'glitch' ? ' is-glitching' : ''}`}>
        <div
          className={`splash-title${jpMode ? ' is-jp' : ' is-latin'}`}
          style={{ ['--splash-shift' as string]: `${jpMode ? JP_SHIFT : LATIN_SHIFT}em` }}
        >
          {renderRow('r')}
          {renderRow('b')}
          {renderRow('main')}
        </div>
        <div className="splash-slice" />
      </div>

      <div className="splash-sub">
        <span>{jpMode ? 'SYSTEM READY' : '// INITIALIZING'}</span>
      </div>

      <div className="splash-scan" />
      <div className="splash-scanlines" />
      <div className="splash-noise" />
    </div>
  );
}

export default SplashIntro;
