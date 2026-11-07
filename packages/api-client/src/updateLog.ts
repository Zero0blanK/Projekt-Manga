import { request } from './client.js';
import type { UpdateLogKind, UpdateLogEntry } from '@projekt-manga/types';
export type { UpdateLogKind, UpdateLogEntry } from '@projekt-manga/types';

export const getUpdateLog = (limit?: number, signal?: AbortSignal) =>
  request<UpdateLogEntry[]>('/update-log', { query: { limit }, signal });
