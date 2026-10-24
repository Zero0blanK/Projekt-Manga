import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsSearch } from '@/components/settings/settings-search';

// Settings search lives in the navbar: the navbar owns the text box and passes its
// query in, and clears it after a result is chosen (see floating-nav.tsx).
afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
});
describe('Settings search platform restrictions', () => {
  it('searches descriptions and opens the relevant setting with its label', () => {
    const onSelect = vi.fn();
    render(<SettingsSearch query="blur adult" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Blur adult covers/ }));
    expect(onSelect).toHaveBeenCalledWith('privacy', 'Blur adult covers');
  });
  it('shows nothing until there is a query', () => {
    render(<SettingsSearch query="  " onSelect={vi.fn()} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('explains desktop controls and prevents browser changes', () => {
    render(<SettingsSearch query="automatic sync" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Automatic sync/ })).toBeDisabled();
    expect(screen.getByText(/This browser cannot change this setting/)).toBeInTheDocument();
  });
  it('enables desktop controls only when the bridge exists', () => {
    (window as unknown as { desktop?: unknown }).desktop = {};
    render(<SettingsSearch query="automatic sync" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Automatic sync/ })).toBeEnabled();
  });
});
