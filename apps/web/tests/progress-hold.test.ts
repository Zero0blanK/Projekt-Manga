import { afterEach, expect, it } from 'vitest';
import { awaitProgressWrite, setProgressWriteHold } from '@projekt-manga/api-client';

afterEach(() => setProgressWriteHold(null));

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

it('sends straight away when nothing holds writes', async () => {
  expect(await awaitProgressWrite('chapter:a:1')).toBe(true);
  setProgressWriteHold(() => null);
  expect(await awaitProgressWrite('chapter:a:1')).toBe(true);
});

it('holds writes until released, then sends only the newest per chapter', async () => {
  const { opened, open } = gate();
  setProgressWriteHold(() => opened);

  const first = awaitProgressWrite('chapter:a:1');
  const other = awaitProgressWrite('chapter:a:2');
  const newest = awaitProgressWrite('chapter:a:1');
  let settled = false;
  void Promise.all([first, other, newest]).then(() => (settled = true));
  await Promise.resolve();
  expect(settled).toBe(false);

  open();
  expect(await first).toBe(false);
  expect(await other).toBe(true);
  expect(await newest).toBe(true);
});
