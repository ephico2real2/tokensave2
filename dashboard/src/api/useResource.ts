import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import type { Endpoint } from './http';

export type Resource<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T };

export type ResourceHandle<T> = { resource: Resource<T>; retry: () => void };

/** `tick` asks every dataset on the page to load again; `report` hears how each load ended. */
export type Refresh = { tick: number; report: (ok: boolean) => void };
export const RefreshContext = createContext<Refresh>({ tick: 0, report: () => {} });

/**
 * Loads one dataset and reloads it whenever `key` changes (the key is the request's identity:
 * the endpoint and its query). A newer request aborts the one in flight, so a slow answer for
 * an old range never overwrites the current one.
 *
 * A tick asks for the same request again. Its figures stay on screen while it loads, and when it
 * fails, because a section that blinks every minute or drops good figures for one lost request
 * is worse than one a little old. The header says when that happens.
 */
export function useResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>): ResourceHandle<T> {
  const [resource, setResource] = useState<Resource<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const { tick, report } = useContext(RefreshContext);
  const shown = useRef('');

  useEffect(() => {
    const controller = new AbortController();
    const request = `${key}#${attempt}`;
    const again = shown.current === request;
    shown.current = request;
    if (!again) setResource({ status: 'loading' });
    loadRef.current(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        setResource({ status: 'ready', data });
        report(true);
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        const failed: Resource<T> = { status: 'error', message: err instanceof Error ? err.message : String(err) };
        setResource((current) => (again && current.status === 'ready' ? current : failed));
        report(false);
      },
    );
    return () => controller.abort();
  }, [key, attempt, tick, report]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { resource, retry };
}

/** Loads an endpoint for the page's current scope; it reloads when the endpoint's own query changes. */
export function useDataset<T, S>(api: Endpoint<T, S>, scope: S): ResourceHandle<T> {
  return useResource(api.url(scope), (signal) => api.fetch(scope, signal));
}

/** The loaded data, or undefined while loading or after an error. */
export const dataOf = <T,>(handle: ResourceHandle<T>): T | undefined =>
  handle.resource.status === 'ready' ? handle.resource.data : undefined;
