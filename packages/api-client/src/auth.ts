import { request } from './client.js';

export interface PublicUser {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
}

export interface RegisterPayload {
  email: string;
  password: string;
  display_name?: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export const register = (payload: RegisterPayload) =>
  request<{ user: PublicUser }>('/auth/register', { method: 'POST', body: payload });

export const login = (payload: LoginPayload) =>
  request<{ user: PublicUser }>('/auth/login', { method: 'POST', body: payload });

export const logout = () => request<null>('/auth/logout', { method: 'POST' });

export const getCurrentUser = (signal?: AbortSignal) =>
  request<{ user: PublicUser | null }>('/auth/me', { signal });

export const deleteAccount = (password: string) =>
  request<null>('/auth/me', { method: 'DELETE', body: { password } });

export type DevicePlatform = 'WEB' | 'DESKTOP';

export const registerDevice = (label: string, platform: DevicePlatform) =>
  request<{ id: string; label: string; platform: DevicePlatform }>('/auth/devices/register', {
    method: 'POST',
    body: { label, platform },
  });

export const signOutOtherDevices = () =>
  request<{ revoked: number }>('/auth/sessions/revoke-others', { method: 'POST' });
