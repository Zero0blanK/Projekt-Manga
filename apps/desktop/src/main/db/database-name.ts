import { createHash } from 'node:crypto';

export function databaseFileName(accountId: string | null): string {
  if (!accountId) return 'local-anonymous.db';
  const key = createHash('sha256').update(accountId).digest('hex');
  return `local-user-${key}.db`;
}
