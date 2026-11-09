import type { RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The open modals, oldest first. Only the topmost one answers Tab and Escape: a dialog opened
 * over the landing (sign-in) must not have both fighting over focus.
 */
export class ModalStack<T> {
  private readonly open: T[] = [];

  push(modal: T): void {
    this.open.push(modal);
  }

  /** Takes a modal off; true when it was the one on top (only that one gives focus back). */
  remove(modal: T): boolean {
    const top = this.isTop(modal);
    const at = this.open.lastIndexOf(modal);
    if (at >= 0) this.open.splice(at, 1);
    return top;
  }

  isTop(modal: T): boolean {
    return this.open.length > 0 && this.open[this.open.length - 1] === modal;
  }
}

const stack = new ModalStack<HTMLElement>();

/** What a key does in the topmost modal: close it, move focus somewhere, or nothing. */
export type KeyStep<T> =
  | { readonly kind: 'close' }
  | { readonly kind: 'focus'; readonly target: T }
  | null;

/**
 * Escape closes; Tab wraps from the last control to the first and Shift+Tab from the first to
 * the last; with focus outside the modal, Tab brings it back in. `box` stands in when the modal
 * has no control. Pure, so it is tested without a browser.
 */
export function modalKey<T>(
  key: { readonly key: string; readonly shiftKey: boolean },
  items: readonly T[],
  active: T | null,
  inside: boolean,
  box: T,
): KeyStep<T> {
  if (key.key === 'Escape') return { kind: 'close' };
  if (key.key !== 'Tab') return null;
  if (items.length === 0) return { kind: 'focus', target: box };
  const head = items[0]!;
  const tail = items[items.length - 1]!;
  if (key.shiftKey && (active === head || !inside)) return { kind: 'focus', target: tail };
  if (!key.shiftKey && (active === tail || !inside)) return { kind: 'focus', target: head };
  return null;
}

/** What had focus before a modal opened. */
export interface Opener {
  readonly isConnected: boolean;
  focus(options?: FocusOptions): void;
  closest?(selectors: string): unknown;
}

/** Nothing on the page has focus (or no DOM, in tests): a deferred restore may take it. */
function focusIsFree(): boolean {
  const doc = globalThis.document;
  return !doc || doc.activeElement === null || doc.activeElement === doc.body;
}

/**
 * Gives focus back to what had it before the modal opened, if it is still on the page. An
 * opener still inside an inert part of the page (the game under the landing stays inert until
 * the render that closes the landing has finished) cannot take focus yet: it gets it `later`,
 * unless something else took focus meanwhile.
 */
export function restoreFocus(
  previous: Opener | null,
  later: (run: () => void) => void = (run) => requestAnimationFrame(run),
): boolean {
  if (!previous?.isConnected) return false;
  if (previous.closest?.('[inert]')) {
    later(() => {
      if (previous.isConnected && !previous.closest?.('[inert]') && focusIsFree()) {
        previous.focus({ preventScroll: true });
      }
    });
    return true;
  }
  previous.focus({ preventScroll: true });
  return true;
}

function focusables(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Focus for a modal: moves focus into it when it opens (to `[data-autofocus]`, else its first
 * control, else the box itself), keeps Tab inside it, closes on Escape, and gives focus back
 * to whatever had it before when it closes. Only the topmost modal handles keys.
 */
export function useModalFocus(
  box: RefObject<HTMLElement | null>,
  onClose: (() => void) | undefined,
): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stack.push(element);
    const first =
      element.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(element)[0] ?? element;
    first.focus({ preventScroll: true });
    // On the window: Escape still closes after a click on the backdrop moved focus out.
    const onKey = (event: KeyboardEvent) => {
      if (!stack.isTop(element)) return;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const step = modalKey(event, focusables(element), active, element.contains(active), element);
      if (!step) return;
      if (step.kind === 'close') {
        close.current?.();
        return;
      }
      event.preventDefault();
      step.target.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // A modal closing under another one (the landing as sign-in opens over it) must not pull
      // focus out of the one on top.
      if (stack.remove(element)) restoreFocus(previous);
    };
  }, [box]);
}
