import { act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useSourceCatalog } from '@/lib/extensions-store';
import { queryKeys } from '@/lib/query-client';

function CatalogProbe() {
  const catalog = useSourceCatalog();
  return catalog.loading ? (
    <section>Loading sources</section>
  ) : catalog.hasNoRepositories ? (
    <section>No repositories</section>
  ) : (
    <section>{catalog.entries.map((item) => item.entry.name).join(',')}</section>
  );
}

describe('Persisted catalogue hydration', () => {
  it.each([false, true])(
    'keeps first render aligned with SSR when persisted repositories exist: %s',
    async (hasRepository) => {
      const serverClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const browserClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      browserClient.setQueryData(
        queryKeys.extensionRepositories,
        hasRepository
          ? [{ id: 'repo', sources: [{ source_key: 'fixture', name: 'Fixture source' }] }]
          : [],
      );
      browserClient.setQueryData(queryKeys.installedExtensions, []);
      const container = document.createElement('div');
      container.innerHTML = renderToString(
        <QueryClientProvider client={serverClient}>
          <CatalogProbe />
        </QueryClientProvider>,
      );
      expect(container.textContent).toBe('Loading sources');
      document.body.append(container);
      const onRecoverableError = vi.fn();
      let root!: ReturnType<typeof hydrateRoot>;
      try {
        await act(async () => {
          root = hydrateRoot(
            container,
            <QueryClientProvider client={browserClient}>
              <CatalogProbe />
            </QueryClientProvider>,
            { onRecoverableError },
          );
        });
        expect(onRecoverableError).not.toHaveBeenCalled();
        expect(container.textContent).toBe(hasRepository ? 'Fixture source' : 'No repositories');
      } finally {
        await act(async () => root.unmount());
        container.remove();
        serverClient.clear();
        browserClient.clear();
      }
    },
  );
});
