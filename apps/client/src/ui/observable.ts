import { useEffect, useRef, useState } from 'preact/hooks';

/** A minimal state container: the game writes, components read slices with useSelector. */
export class Observable<T extends object> {
  private listeners = new Set<() => void>();

  constructor(private state: T) {}

  get(): T {
    return this.state;
  }

  update(patch: Partial<T> | ((state: T) => Partial<T>)): void {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function shallowEqual<S>(a: S, b: S): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) =>
    Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Re-renders the component only when the selected slice changes. */
export function useSelector<T extends object, S>(
  source: Observable<T>,
  select: (state: T) => S,
  equal: (a: S, b: S) => boolean = shallowEqual,
): S {
  const [value, setValue] = useState(() => select(source.get()));
  const latest = useRef({ select, equal, value });
  latest.current = { select, equal, value };
  useEffect(() => {
    const check = () => {
      const { select: sel, equal: eq, value: current } = latest.current;
      const next = sel(source.get());
      if (!eq(current, next)) setValue(() => next);
    };
    check();
    return source.subscribe(check);
  }, [source]);
  return value;
}
