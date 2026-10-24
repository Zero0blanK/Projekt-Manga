import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsNav, SECTION_IDS } from '@/components/settings/settings-nav';

/**
 * The nav is a sidebar beside the panel on desktop and a horizontal strip above it on a
 * phone. A vertical list at every width would, below `md` where the settings grid is a
 * single column, stack all eleven sections above the panel: roughly 420px of navigation
 * to scroll past to reach the setting just tapped.
 *
 * jsdom computes no layout, so these assert the contract the layout rests on rather than
 * pixel positions: the strip scrolls horizontally, the items do not wrap or shrink, and
 * the selected one is identifiable by something other than its colour.
 */
describe('Settings navigation', () => {
  it('exposes the selected section to assistive tech, not just as a tint', () => {
    render(<SettingsNav active="about" onChange={vi.fn()} />);

    const current = screen.getByRole('button', { current: 'page' });
    expect(current).toHaveTextContent('About');

    // Exactly one, or "current" stops meaning anything.
    expect(screen.getAllByRole('button', { current: 'page' })).toHaveLength(1);
  });

  it('is a labelled landmark holding every section', () => {
    render(<SettingsNav active="account" onChange={vi.fn()} />);

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(nav.querySelectorAll('button')).toHaveLength(SECTION_IDS.length);
  });

  it('scrolls sideways on a phone and becomes a column from md up', () => {
    render(<SettingsNav active="account" onChange={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });

    // Without overflow-x the strip would wrap to several rows, i.e. the stacked layout.
    expect(nav.className).toContain('overflow-x-auto');
    expect(nav.className).toContain('md:flex-col');
  });

  it('keeps tab labels on one line so the strip scrolls instead of wrapping', () => {
    render(<SettingsNav active="account" onChange={vi.fn()} />);

    const tab = screen.getByRole('button', { name: /Sync & Storage/ });
    expect(tab.className).toContain('whitespace-nowrap');
    expect(tab.className).toContain('shrink-0');
  });

  it('reports the chosen section', async () => {
    const onChange = vi.fn();
    render(<SettingsNav active="account" onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: /Privacy/ }));

    expect(onChange).toHaveBeenCalledWith('privacy');
  });
});
