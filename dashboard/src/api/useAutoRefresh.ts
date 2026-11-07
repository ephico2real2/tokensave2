import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { Refresh } from './useResource';

export type AutoRefresh = Refresh & {
  /** When a dataset last loaded, in milliseconds since the epoch. */
  updatedAt: number | null;
  /** The last load failed, so the figures on screen are from `updatedAt`. */
  failed: boolean;
};

/**
 * Ticks every `seconds`, and not while the tab is hidden: nobody reads those figures, and a
 * browser slows hidden timers anyway. A tab that returns after the interval ticks at once.
 * Zero or less never ticks.
 */
export function useAutoRefresh(seconds: number): AutoRefresh {
  const [tick, setTick] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (seconds <= 0) return undefined;
    let last = Date.now();
    const fire = () => {
      last = Date.now();
      setTick((n) => n + 1);
    };
    const timer = setInterval(() => {
      if (!document.hidden) fire();
    }, seconds * 1000);
    const onVisibility = () => {
      if (!document.hidden && Date.now() - last >= seconds * 1000) fire();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [seconds]);

  const report = useCallback((ok: boolean) => {
    setFailed(!ok);
    if (ok) setUpdatedAt(Date.now());
  }, []);

  return useMemo(() => ({ tick, report, updatedAt, failed }), [tick, report, updatedAt, failed]);
}
