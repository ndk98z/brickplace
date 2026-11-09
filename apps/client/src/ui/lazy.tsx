import { type FunctionComponent, h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/**
 * Loads something once and keeps it; a failed load is forgotten, so the next call tries again
 * (a chunk missing after a deploy may load once the page is reloaded, or the network is back).
 */
export function once<T>(load: () => Promise<T>): { loaded(): T | null; load(): Promise<T> } {
  let value: T | null = null;
  let loading: Promise<T> | null = null;
  return {
    loaded: () => value,
    load: () => {
      loading ??= load().then(
        (v) => {
          value = v;
          return v;
        },
        (error: unknown) => {
          loading = null;
          throw error;
        },
      );
      return loading;
    },
  };
}

/**
 * Starts loading `code` for one mounted component: `loaded` gets the result, `failed` runs
 * when the load fails. The returned function cancels both (the component went away).
 */
export function startLoad<T>(
  code: { load(): Promise<T> },
  loaded: (value: T) => void,
  failed: (() => void) | undefined,
): () => void {
  let live = true;
  code.load().then(
    (value) => {
      if (live) loaded(value);
    },
    () => {
      if (live) failed?.();
    },
  );
  return () => {
    live = false;
  };
}

/** Props of a lazy component: its own, plus what to do when its code cannot be loaded. */
export type LazyProps<P> = P & { readonly onLoadError?: () => void };

/**
 * A component whose code loads on first render (its own chunk), so screens most visits never
 * open (landing, guide, share) stay out of the game's first download. Renders nothing until
 * loaded. When the load fails (typically a chunk gone after a deploy), `onLoadError` runs;
 * opening the screen again tries again.
 */
export function lazy<P extends object>(
  load: () => Promise<FunctionComponent<P>>,
): FunctionComponent<LazyProps<P>> {
  const code = once(load);
  return function Lazy({ onLoadError, ...props }: LazyProps<P>) {
    const [component, setComponent] = useState<FunctionComponent<P> | null>(() => code.loaded());
    useEffect(() => {
      if (component) return;
      return startLoad(code, (c) => setComponent(() => c), onLoadError);
    }, [component]);
    return component ? h(component, props as unknown as P) : null;
  };
}
