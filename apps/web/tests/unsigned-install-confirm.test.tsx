import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  WARN_UNSIGNED_REPOSITORIES,
  useUnsignedInstallConfirm,
} from '@/hooks/use-unsigned-install-confirm';
import { actions, getSetting } from '@/lib/app-store';
import { findInstallableSource } from '@/lib/external-backup/mapping';

/** Shows the warning's dialog, and keeps what each ask resolved to. */
function Harness({ answers }: { answers: boolean[] }) {
  const { confirmUnsigned, dialog } = useUnsignedInstallConfirm();
  return (
    <>
      <button type="button" onClick={() => void confirmUnsigned().then((yes) => answers.push(yes))}>
        Install
      </button>
      {dialog}
    </>
  );
}

afterEach(() => {
  cleanup();
  act(() => actions.setSetting(WARN_UNSIGNED_REPOSITORIES, true));
});

describe('the unsigned repository warning', () => {
  it('stops asking once "Don\'t ask again" is ticked and Install anyway chosen', async () => {
    const user = userEvent.setup();
    const answers: boolean[] = [];
    render(<Harness answers={answers} />);

    await user.click(screen.getByRole('button', { name: 'Install' }));
    await user.click(await screen.findByRole('checkbox', { name: "Don't ask again" }));
    await user.click(screen.getByRole('button', { name: 'Install anyway' }));
    expect(answers).toEqual([true]);
    expect(getSetting(WARN_UNSIGNED_REPOSITORIES, true)).toBe(false);

    // The next install goes ahead without the dialog.
    await user.click(screen.getByRole('button', { name: 'Install' }));
    await act(async () => undefined);
    expect(answers).toEqual([true, true]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('keeps asking when the box is ticked but the install cancelled', async () => {
    const user = userEvent.setup();
    const answers: boolean[] = [];
    render(<Harness answers={answers} />);

    await user.click(screen.getByRole('button', { name: 'Install' }));
    await user.click(await screen.findByRole('checkbox', { name: "Don't ask again" }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(answers).toEqual([false]);
    expect(getSetting(WARN_UNSIGNED_REPOSITORIES, true)).toBe(true);
  });
});

describe('finding an import source to install', () => {
  const available = [
    { name: 'MangaDex', lang: 'en' },
    { name: 'MangaDex', lang: 'ja' },
    { name: 'Comick', lang: 'all' },
  ];

  it('matches the name as the import does, with the language suffix choosing between them', () => {
    expect(findInstallableSource('MangaDex (JA)', available)).toEqual({
      name: 'MangaDex',
      lang: 'ja',
    });
    expect(findInstallableSource('comick', available)).toEqual({ name: 'Comick', lang: 'all' });
    expect(findInstallableSource('Somewhere else', available)).toBeNull();
  });
});
