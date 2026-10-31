import { request } from './client.js';
import type { SourceNetworkConfig } from '@projekt-manga/types';
import type { UpdateSourceNetworkConfigBody } from '@projekt-manga/schemas';

/** Admin only: the User-Agent and DNS over HTTPS resolver sandboxed sources use. */
export const getSourceNetworkConfig = (signal?: AbortSignal) =>
  request<SourceNetworkConfig>('/source-network', { signal, cache: 'no-store' });

export const updateSourceNetworkConfig = (patch: UpdateSourceNetworkConfigBody) =>
  request<SourceNetworkConfig>('/source-network', { method: 'PATCH', body: patch });
