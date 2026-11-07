import type {
  ChapterAlertBody,
  CreateNotificationChannelBody,
  UpdateNotificationChannelBody,
} from '@projekt-manga/schemas';
import { request } from './client.js';
import type { NotificationChannel } from '@projekt-manga/types';
export type { NotificationChannel } from '@projekt-manga/types';

const base = '/notification-channels';
const one = (id: string) => `${base}/${encodeURIComponent(id)}`;

export const getNotificationChannels = (signal?: AbortSignal) =>
  request<NotificationChannel[]>(base, { signal });

export const addNotificationChannel = (body: CreateNotificationChannelBody) =>
  request<NotificationChannel>(base, { method: 'POST', body });

export const updateNotificationChannel = (id: string, body: UpdateNotificationChannelBody) =>
  request<NotificationChannel>(one(id), { method: 'PATCH', body });

export const removeNotificationChannel = (id: string) =>
  request<null>(one(id), { method: 'DELETE' });

export const testNotificationChannel = (id: string) =>
  request<NotificationChannel>(`${one(id)}/test`, { method: 'POST' });

/** What one library update found, to every enabled channel (once per update run). */
export const sendChapterAlert = (body: ChapterAlertBody) =>
  request<{ sent: number; skipped: boolean }>(`${base}/alert`, { method: 'POST', body });
