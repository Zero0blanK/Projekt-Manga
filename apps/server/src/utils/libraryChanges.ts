import { EventEmitter } from 'node:events';

/**
 * Tells open apps and tabs that a library changed. Only a kind of change crosses this,
 * never data: a listener refetches through the normal, authorized routes.
 *
 * `progress` is reading (chapters and history), which happens constantly while someone
 * reads; `library` is everything else, so a client can refresh less for the first.
 */
export type LibraryChangeScope = 'library' | 'progress';

/** `user:<id>` or `anonymous`; `everyone` for server work that isn't anyone's request,
 * such as a library update check or a finished download. */
export type LibraryOwner = string;

export const EVERYONE: LibraryOwner = 'everyone';

const changes = new EventEmitter();
// One listener per open stream, which the stream route caps.
changes.setMaxListeners(60);

export function announceLibraryChange(owner: LibraryOwner, scope: LibraryChangeScope): void {
  changes.emit('change', owner, scope);
}

export function onLibraryChange(
  listener: (owner: LibraryOwner, scope: LibraryChangeScope) => void,
): () => void {
  changes.on('change', listener);
  return () => changes.off('change', listener);
}
