import { request } from './client.js';

export interface Category {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

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
