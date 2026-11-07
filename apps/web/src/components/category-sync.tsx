'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCategoryState } from '@projekt-manga/api-client';
import {
  applyServerCategories,
  showCachedCategories,
  uploadLocalCategories,
} from '@/lib/category-sync';
import { queryKeys } from '@/lib/query-client';
import { useCurrentUser } from '@/lib/session-resource';

/** Loads the signed-in identity's categories into the store, and again whenever they
 * change, here or on another device. */
export function CategorySync() {
  const { user, loading } = useCurrentUser();
  const owner = user?.id ?? null;

  const { data } = useQuery({
    queryKey: [...queryKeys.categories, owner],
    queryFn: ({ signal }) => getCategoryState(signal),
    enabled: !loading,
  });

  useEffect(() => {
    if (loading) return;
    showCachedCategories(owner);
    void uploadLocalCategories();
  }, [loading, owner]);

  useEffect(() => {
    if (!loading && data) applyServerCategories(owner, data);
  }, [data, loading, owner]);

  return null;
}
