/**
 * A real DOM per mounted React tree.
 *
 * `react-dom/client`'s `createRoot` needs a genuine `document` with working
 * events; a stub object is not enough and tends to fail deep inside React with a
 * message that says nothing about the test. So each mount constructs a real
 * `jsdom` window, installs the globals React reads, and tears them down with the
 * tree — which also stops one component's mount leaking into the next test.
 */
import { JSDOM } from "jsdom";

/** Globals React and the DOM event system read off the global object. */
const REQUIRED_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

export interface MountedDom {
  readonly window: JSDOM["window"];
  readonly document: Document;
  /** Dispatch a real bubbling click, the way a user activation would. */
  click(element: Element): void;
  /** Restore the globals this DOM installed. */
  restore(): void;
}

/** Build an isolated DOM and install the globals for the duration of a test. */
export function createDom(): MountedDom {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of REQUIRED_GLOBALS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }

  // `defineProperty`, not assignment: on Node 24 `globalThis.navigator` is a
  // getter-only accessor, so a plain assignment throws and no DOM could ever be
  // installed.
  for (const key of REQUIRED_GLOBALS) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: (dom.window as unknown as Record<string, unknown>)[key],
    });
  }
  // React 18 checks this flag; without it `act` warns and updates may not flush.
  (globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

  return {
    window: dom.window,
    document: dom.window.document,
    click(element: Element): void {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    },
    restore(): void {
      // Restore the original DESCRIPTORS, not the values: replacing a getter-only
      // global with a plain value would leak that change into later tests.
      for (const [key, descriptor] of saved) {
        if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[key];
        else Object.defineProperty(globalThis, key, descriptor);
      }
      delete (globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"];
      dom.window.close();
    },
  };
}