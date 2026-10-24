import { AsyncLocalStorage } from 'node:async_hooks';

const requestIds = new AsyncLocalStorage<string>();

export function withRequestId<T>(requestId: string, next: () => T): T {
  return requestIds.run(requestId, next);
}

export function currentRequestId(): string | undefined {
  return requestIds.getStore();
}
