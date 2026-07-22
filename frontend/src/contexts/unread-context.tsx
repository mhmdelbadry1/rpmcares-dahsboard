import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { api, type CommSummary } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { useAuth } from './auth-context';

type UnreadContextValue = {
  counts: Record<string, CommSummary>;
  total: number;
  refresh: () => Promise<void>;
  markRead: (patientId: string) => Promise<void>;
  markAllRead: (patientIds: string[]) => Promise<{ failedCount: number }>;
};

const UnreadContext = createContext<UnreadContextValue>({
  counts: {},
  total: 0,
  refresh: async () => {},
  markRead: async () => {},
  markAllRead: async () => ({ failedCount: 0 }),
});

export function UnreadProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const token = session?.token ?? null;
  const [counts, setCounts] = useState<Record<string, CommSummary>>({});
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const { counts: data } = await api.getUnreadCounts(token);
      setCounts(data);
    } catch { /* silent */ }
  }, [token]);

  const markRead = useCallback(async (patientId: string) => {
    if (!token) return;
    const previous = counts[patientId];
    // Optimistically clear unread badge so it doesn't flicker while the API call completes.
    setCounts(prev => {
      if (!prev[patientId]) return prev;
      const next = { ...prev };
      next[patientId] = { ...next[patientId], unread: 0 };
      return next;
    });
    try {
      await api.markCommRead(token, patientId);
      // Refresh AFTER the server has recorded the view so the next fetch is accurate.
      const { counts: data } = await api.getUnreadCounts(token);
      setCounts(data);
    } catch {
      // Roll back immediately instead of leaving a stale "read" state that
      // silently reverts on the next poll with no explanation.
      if (previous) setCounts(prev => ({ ...prev, [patientId]: previous }));
      throw new Error('Could not mark as read. Check your connection and try again.');
    }
  }, [token, counts]);

  const markAllRead = useCallback(async (patientIds: string[]) => {
    if (!token || !patientIds.length) return { failedCount: 0 };
    const previous = counts;
    // Optimistically clear every badge at once so the list updates immediately
    // instead of waiting for every request to round-trip before anything changes.
    setCounts(prev => {
      const next = { ...prev };
      for (const id of patientIds) {
        if (next[id]) next[id] = { ...next[id], unread: 0 };
      }
      return next;
    });
    const results = await Promise.allSettled(patientIds.map(id => api.markCommRead(token, id)));
    const failedIds = patientIds.filter((_, i) => results[i].status === 'rejected');
    if (failedIds.length) {
      // Roll back only the ones that actually failed; leave successful clears in place.
      setCounts(prev => {
        const next = { ...prev };
        for (const id of failedIds) {
          if (previous[id]) next[id] = previous[id];
        }
        return next;
      });
    }
    try {
      const { counts: data } = await api.getUnreadCounts(token);
      setCounts(data);
    } catch { /* keep optimistic state; next poll will reconcile */ }
    return { failedCount: failedIds.length };
  }, [token, counts]);

  // Load on mount and whenever token changes
  useEffect(() => {
    if (!token) { setCounts({}); return; }
    refresh();
    // Poll every 60s as a fallback in case the realtime subscription below
    // ever misses an event or disconnects.
    intervalRef.current = setInterval(refresh, 60_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [token, refresh]);

  // Push-driven refresh: without this, a new message from a patient you
  // aren't currently viewing (or aren't viewing at all — e.g. sitting on the
  // sidebar) only shows up in the unread badge / "Unread" filter up to 60s
  // later via the poll above. Scoped to the caller's own clinic (matching
  // the same scoping getUnreadCounts already applies server-side) so a
  // clinic_admin/staff doesn't even get woken up for another clinic's
  // traffic; super_admin has no clinic_id, so it subscribes unfiltered.
  useEffect(() => {
    if (!token) return;
    const role = session?.user.role;
    const clinicId = session?.user.clinicId;
    if (role !== 'super_admin' && !clinicId) return;
    const filter = role === 'super_admin' ? undefined : `clinic_id=eq.${clinicId}`;

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const debouncedRefresh = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(refresh, 400);
    };

    const channel = supabase
      .channel('unread-counts-global')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'communications_log', ...(filter ? { filter } : {}) },
        debouncedRefresh,
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'communications_log', ...(filter ? { filter } : {}) },
        debouncedRefresh,
      )
      .subscribe();

    return () => {
      if (debounce) clearTimeout(debounce);
      supabase.removeChannel(channel);
    };
  }, [token, session?.user.role, session?.user.clinicId, refresh]);

  // Re-fetch when app comes back to foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const total = Object.values(counts).reduce((s, v) => s + (v.unread ?? 0), 0);

  return (
    <UnreadContext.Provider value={{ counts, total, refresh, markRead, markAllRead }}>
      {children}
    </UnreadContext.Provider>
  );
}

export const useUnread = () => useContext(UnreadContext);
