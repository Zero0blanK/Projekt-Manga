import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NavSearch } from '@/components/nav/nav-search';

describe('navigation search scope', () => {
  it('shows the selected scope and submits source searches explicitly', () => {
    const onScopeChange = vi.fn();
    const onSubmitSourceSearch = vi.fn();
    render(
      <NavSearch
        inputRef={createRef<HTMLInputElement>()}
        search="target"
        onSearchChange={vi.fn()}
        scope="sources"
        onScopeChange={onScopeChange}
        shortcutLabel="Ctrl+K"
        open={false}
        onOpenChange={vi.fn()}
        results={[]}
        onSelect={vi.fn()}
        onSubmitSourceSearch={onSubmitSourceSearch}
      />,
    );

    const input = screen.getByRole('textbox', { name: 'Search installed sources' });
    expect(input).toHaveAttribute('placeholder', expect.stringContaining('Ctrl+K'));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmitSourceSearch).toHaveBeenCalledWith('target');
    fireEvent.click(screen.getByRole('button', { name: /Search scope: sources/ }));
    expect(onScopeChange).toHaveBeenCalledWith('library');
  });
});
