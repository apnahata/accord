import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export function useResource<T>(path: string | null, revision = 0) {
  const [state, setState] = useState<{ path: string | null; data?: T; error?: Error; loading: boolean }>({ path, loading: !!path });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState(previous => ({ path, data: previous.path === path ? previous.data : undefined, loading: true }));
    api<T>(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ path, data, loading: false });
    }).catch(error => { if (!controller.signal.aborted) setState({ path, error, loading: false }); });
    return () => controller.abort();
  }, [path, revision, retry]);
  return {
    path,
    data: state.path === path ? state.data : undefined,
    error: state.path === path ? state.error : undefined,
    loading: path !== null && (state.path !== path || state.loading),
    refresh: useCallback(() => setRetry(value => value + 1), []),
  };
}

export function useRoomEvents(roomId?: string) {
  const [revision, setRevision] = useState(0);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  useEffect(() => {
    if (!roomId) return;
    const source = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/events/stream`, { withCredentials: true });
    // Carries only this member's own notifications (e.g. private messages from Accord).
    const personal = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/me/events/stream`, { withCredentials: true });
    const update = () => setRevision(value => value + 1);
    source.onopen = () => { setConnection('live'); update(); };
    // The backend stream uses named `update` and `resync` events (SSE named
    // events do not fire EventSource.onmessage).
    for (const stream of [source, personal]) { stream.addEventListener('update', update); stream.addEventListener('resync', update); }
    source.onerror = () => { setConnection('reconnecting'); update(); };
    // Reconcile even if a tab slept or events were missed; events are invalidation only.
    const timer = window.setInterval(update, 15000);
    window.addEventListener('focus', update);
    return () => { source.close(); personal.close(); clearInterval(timer); window.removeEventListener('focus', update); };
  }, [roomId]);
  return { revision, connection };
}

export function useAction() {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(undefined);
    try { await action(); } catch (error) { setError(error instanceof Error ? error : new Error('Please try again.')); }
    finally { locked.current = false; setBusy(false); }
  }
  return { busy, error, run };
}
