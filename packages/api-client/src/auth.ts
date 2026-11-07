import { request } from './client.js';
import type {
  PublicUser,
  RegisterPayload,
  LoginPayload,
  DevicePlatform,
} from '@projekt-manga/types';
export type {
  PublicUser,
  RegisterPayload,
  LoginPayload,
  DevicePlatform,
} from '@projekt-manga/types';

export const register = (payload: RegisterPayload) =>
  request<{ user: PublicUser }>('/auth/register', { method: 'POST', body: payload });

export const login = (payload: LoginPayload) =>
  request<{ user: PublicUser }>('/auth/login', { method: 'POST', body: payload });

export const logout = () => request<null>('/auth/logout', { method: 'POST' });

export const getCurrentUser = (signal?: AbortSignal) =>
  request<{ user: PublicUser | null }>('/auth/me', { signal });

/** Signs out every other session. Answers with how many that was. */
export const changePassword = (currentPassword: string, newPassword: string) =>
  request<{ revoked: number }>('/auth/password', {
    method: 'POST',
    body: { current_password: currentPassword, new_password: newPassword },
  });

export const deleteAccount = (password: string) =>
  request<null>('/auth/me', { method: 'DELETE', body: { password } });

export const registerDevice = (label: string, platform: DevicePlatform) =>
  request<{ id: string; label: string; platform: DevicePlatform }>('/auth/devices/register', {
    method: 'POST',
    body: { label, platform },
  });

export const signOutOtherDevices = () =>
  request<{ revoked: number }>('/auth/sessions/revoke-others', { method: 'POST' });
