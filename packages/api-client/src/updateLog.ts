import { request } from './client.js';

export type UpdateLogKind = 'NEW_CHAPTER' | 'ERROR';

export interface UpdateLogEntry {
  id: string;
  source_id: string;
  manga_id: string | null;
  kind: UpdateLogKind;
  message: string;
  detail: string;
  created_at: string;
  manga: { id: string; slug: string; title: string; thumbnail_url: string } | null;
}

export const getUpdateLog = (limit?: number, signal?: AbortSignal) =>
  request<UpdateLogEntry[]>('/update-log', { query: { limit }, signal });
