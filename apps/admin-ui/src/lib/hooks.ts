import { keepPreviousData, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { useSession } from '../api/session';

/**
 * Tenant-scoped query with configurable auto-refresh (toolbar). `keepPrevious` keeps the last page on
 * screen while the next one loads (server-side pagination, ADR-029).
 */
export function useTenantQuery<T>(key: QueryKey, path: string | null, opts: { refetchMs?: number; keepPrevious?: boolean } = {}) {
  const { tenant } = useSession();
  return useQuery({
    queryKey: [tenant, ...key],
    queryFn: () => api<T>(path!),
    enabled: path !== null,
    refetchInterval: opts.refetchMs || false,
    ...(opts.keepPrevious ? { placeholderData: keepPreviousData } : {}),
  });
}

export function useInvalidate() {
  const qc = useQueryClient();
  const { tenant } = useSession();
  return (...key: unknown[]) => qc.invalidateQueries({ queryKey: [tenant, ...key] });
}

export function useAutoRefresh(defaultMs = 7000): [number, (v: number) => void] {
  return useState(defaultMs);
}
