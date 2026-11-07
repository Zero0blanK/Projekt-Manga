import { request } from './client.js';
import type { Category, CategoryWithMembers } from '@projekt-manga/types';
export type { Category, CategoryWithMembers } from '@projekt-manga/types';

export const getCategoryState = (signal?: AbortSignal) =>
  request<CategoryWithMembers[]>('/category/state', { signal });

export const setCategoryMembership = (categoryId: string, mangaId: string, member: boolean) =>
  request<void>(
    `/category/${encodeURIComponent(categoryId)}/manga/${encodeURIComponent(mangaId)}`,
    { method: member ? 'PUT' : 'DELETE' },
  );

export const importCategories = (categories: { name: string; manga_ids: string[] }[]) =>
  request<{ categories: number; assignments: number }>('/category/import', {
    method: 'POST',
    body: { categories },
  });

export const getCategories = (signal?: AbortSignal) => request<Category[]>('/category', { signal });

export const getCategoryById = (categoryId: string, signal?: AbortSignal) =>
  request<Category>(`/category/${encodeURIComponent(categoryId)}`, { signal });

export const addCategory = (categoryName: string) =>
  request<Category>('/category/add', { method: 'POST', body: { category_name: categoryName } });

export const updateCategory = (categoryId: string, categoryName: string) =>
  request<Category>(`/category/update/${encodeURIComponent(categoryId)}`, {
    method: 'PUT',
    body: { category_name: categoryName },
  });

export const deleteCategory = (categoryId: string) =>
  request<void>(`/category/delete/${encodeURIComponent(categoryId)}`, { method: 'DELETE' });
