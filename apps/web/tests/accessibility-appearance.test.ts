import { afterEach, describe, expect, it } from 'vitest';
import { ACCENTS, accentForeground, applyAppearance } from '@/lib/theme';

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first: number, second: number): number {
  const [lighter, darker] = [first, second].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

afterEach(() => {
  document.documentElement.className = '';
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
});

describe('appearance accessibility', () => {
  it('chooses accent foregrounds with WCAG AA contrast for every preset and boundary colors', () => {
    const backgrounds = [...ACCENTS.map((accent) => accent.value), '#777777', '#767676'];
    for (const background of backgrounds) {
      const foreground = accentForeground(background);
      const foregroundLuminance = foreground.includes('0.18') ? 0 : 1;
      expect(
        contrastRatio(relativeLuminance(background), foregroundLuminance),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('applies and removes the reduced-motion class with the saved setting', () => {
    applyAppearance({
      theme: 'dark',
      accent: '#e9a25a',
      uiScale: '100%',
      reduceMotion: true,
    });
    expect(document.documentElement).toHaveClass('reduce-motion');

    applyAppearance({
      theme: 'dark',
      accent: '#e9a25a',
      uiScale: '100%',
      reduceMotion: false,
    });
    expect(document.documentElement).not.toHaveClass('reduce-motion');
  });
});
