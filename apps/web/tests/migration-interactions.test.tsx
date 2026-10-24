import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  MigrationOptionsStage,
  type MigrationOptions,
} from '@/components/manga-detail/migration-stages';
import { ToggleSwitch } from '@/components/settings/field-controls';

vi.mock('@/components/cover', () => ({ Cover: () => null }));
const sources = [
  { id: 'alpha', name: 'Alpha', lang: 'en' },
  { id: 'beta', name: 'Beta', lang: 'fr' },
  { id: 'gamma', name: 'Gamma', lang: 'es' },
];
const apply = vi.fn();
const changed = vi.fn();
function Fixture({
  disabled = false,
  initial = ['alpha', 'beta', 'gamma'],
}: {
  disabled?: boolean;
  initial?: string[];
}) {
  const [selectedIds, setSelectedIds] = useState(initial);
  const [options, setOptions] = useState<MigrationOptions>({
    read: true,
    shelf: true,
    bookmark: true,
    categories: true,
  });
  const [hide, setHide] = useState(false);
  return (
    <MigrationOptionsStage
      sources={sources}
      selectedIds={selectedIds}
      options={options}
      hideUnmatched={hide}
      disabled={disabled}
      onSources={(ids) => {
        changed(ids);
        setSelectedIds(ids);
      }}
      onOptions={setOptions}
      onHideUnmatched={setHide}
      onApply={apply}
    />
  );
}
function selectedList() {
  return screen.getByRole('region', { name: /^Selected/ });
}
function order() {
  return within(selectedList())
    .queryAllByRole('button')
    .map((button) =>
      button.textContent?.replace(/^\d+/, '').replace(/(English|French|Spanish|en|fr|es)$/, ''),
    );
}
function row(name: string) {
  return screen.getByRole('button', { name: `Remove ${name} from selected sources` });
}
let hit: Element | null;
const originalHitTest = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
const originalCapture = Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture');
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.isPrimary = init.isPrimary ?? true;
  }
}
const point = (y: number, extra = {}) => ({
  pointerId: 1,
  isPrimary: true,
  button: 0,
  clientX: 150,
  clientY: y,
  ...extra,
});
beforeEach(() => {
  vi.clearAllMocks();
  hit = null;
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit });
  Object.defineProperty(Element.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalHitTest) Object.defineProperty(document, 'elementFromPoint', originalHitTest);
  else Reflect.deleteProperty(document, 'elementFromPoint');
  if (originalCapture)
    Object.defineProperty(Element.prototype, 'setPointerCapture', originalCapture);
  else Reflect.deleteProperty(Element.prototype, 'setPointerCapture');
});

describe('migration source and option interactions', () => {
  it('toggles each whole option row without submitting; only Apply advances', async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    for (const label of [
      'Completed progress',
      'Reading shelf',
      'Bookmark',
      'Categories',
      'Hide sources without a match',
    ]) {
      const toggle = screen.getByRole('switch', { name: label });
      const before = toggle.getAttribute('aria-checked');
      await user.click(within(toggle).getByText(label));
      expect(toggle).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true');
      expect(apply).not.toHaveBeenCalled();
      await user.click(toggle.lastElementChild as HTMLElement);
      expect(toggle).toHaveAttribute('aria-checked', before);
    }
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it('shared toggle buttons never submit their parent form', async () => {
    const submit = vi.fn((event) => event.preventDefault());
    const toggle = vi.fn();
    render(
      <form onSubmit={submit}>
        <ToggleSwitch on label="Test switch" onToggle={toggle} />
      </form>,
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Test switch' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });
  it('clicking a selected row removes it and clicking available adds it back', async () => {
    render(<Fixture />);
    hit = row('Alpha');
    await userEvent.click(row('Alpha'));
    expect(order()).toEqual(['Beta', 'Gamma']);
    await userEvent.click(screen.getByRole('button', { name: 'Select Alpha' }));
    expect(order()).toEqual(['Beta', 'Gamma', 'Alpha']);
    expect(apply).not.toHaveBeenCalled();
  });
  it('reorders from the source name area and suppresses the trailing click', () => {
    render(<Fixture />);
    fireEvent.pointerDown(within(row('Alpha')).getByText('Alpha'), point(100));
    hit = row('Gamma');
    fireEvent.pointerMove(selectedList().querySelector('ul')!, point(220));
    expect(order()).toEqual(['Beta', 'Gamma', 'Alpha']);
    fireEvent.pointerUp(selectedList().querySelector('ul')!, point(220));
    fireEvent.click(row('Alpha'), { detail: 1 });
    expect(order()).toEqual(['Beta', 'Gamma', 'Alpha']);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });
  it('small pointer movement counts as one click, while cancellation never removes', () => {
    render(<Fixture />);
    hit = row('Alpha');
    fireEvent.pointerDown(row('Alpha'), point(100));
    fireEvent.pointerMove(selectedList().querySelector('ul')!, point(102));
    fireEvent.pointerUp(selectedList().querySelector('ul')!, point(102));
    expect(order()).toEqual(['Beta', 'Gamma']);
    expect(changed).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(row('Beta'), point(130));
    fireEvent.pointerCancel(selectedList().querySelector('ul')!, point(130));
    expect(order()).toEqual(['Beta', 'Gamma']);
  });
  it('release outside the source row does not remove it', () => {
    render(<Fixture />);
    fireEvent.pointerDown(row('Alpha'), point(100));
    hit = null;
    fireEvent.pointerUp(selectedList().querySelector('ul')!, point(100));
    expect(order()).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(changed).not.toHaveBeenCalled();
  });
  it('keeps keyboard reordering without separate arrow buttons', async () => {
    render(<Fixture />);
    row('Alpha').focus();
    fireEvent.keyDown(row('Alpha'), { key: 'ArrowDown' });
    expect(order()).toEqual(['Beta', 'Alpha', 'Gamma']);
    fireEvent.keyDown(row('Alpha'), { key: 'ArrowUp' });
    expect(order()).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(screen.queryByRole('button', { name: /Move .* (up|down)/ })).not.toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(order()).toEqual(['Beta', 'Gamma']);
  });
  it('does not reorder or change options while disabled', async () => {
    render(<Fixture disabled />);
    await userEvent.click(row('Alpha'));
    fireEvent.pointerDown(row('Alpha'), point(100));
    hit = row('Gamma');
    fireEvent.pointerMove(selectedList().querySelector('ul')!, point(220));
    for (const toggle of screen.getAllByRole('switch')) {
      expect(toggle).toBeDisabled();
      await userEvent.click(toggle);
    }
    expect(order()).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(changed).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
  it('requires at least one selected source to advance', async () => {
    render(<Fixture initial={[]} />);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await userEvent.click(screen.getByRole('switch', { name: 'Bookmark' }));
    expect(apply).not.toHaveBeenCalled();
  });
});
