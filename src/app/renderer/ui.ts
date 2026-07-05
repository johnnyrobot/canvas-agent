/**
 * Renderer DOM facade + helpers — the ONE module that touches `document` /
 * `window`. Every other renderer module imports these helpers and the `El` type
 * and never references a DOM global directly.
 *
 * DOM typing: we deliberately do NOT pull in the full `dom` lib. A global
 * `/// <reference lib="dom" />` would redefine shared globals (e.g.
 * `ReadableStream`) for the WHOLE program and break sibling modules typed
 * against Node's lib. Instead this file declares a small, module-scoped DOM
 * facade covering exactly the surface the renderer touches — isolated, with no
 * effect on any other track's types.
 *
 * Safety: this facade exposes `innerHTML`, but the ONLY place it is ever written
 * is each fragment's `gate.html` (already allowlist+audit-safe). All user /
 * assistant / model text is written via `textContent`.
 */
import type { AppApi } from '../../contracts/index.js';

// ── Module-local DOM facade (see header) ─────────────────────────────────────
export interface DomEvent {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly key: string;
}

export interface El {
  className: string;
  textContent: string | null;
  innerHTML: string;
  value: string;
  disabled: boolean;
  hidden: boolean;
  scrollTop: number;
  readonly scrollHeight: number;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  append(...nodes: (El | string)[]): void;
  replaceChildren(...nodes: (El | string)[]): void;
  remove(): void;
  click(): void;
  focus(): void;
  addEventListener(type: string, handler: (event: DomEvent) => void): void;
}

interface Clipboard {
  writeText(text: string): Promise<void>;
}
interface Nav {
  readonly clipboard?: Clipboard;
}
interface Doc {
  readonly readyState: string;
  createElement(tag: string): El;
  getElementById(id: string): El | null;
  addEventListener(type: string, handler: () => void): void;
}
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
declare const document: Doc;
declare const window: { canvasAgent: AppApi; navigator: Nav; open(url: string): void };
declare const localStorage: StorageLike;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create an element, applying attributes (`class` → className) and children. */
export function el(
  tag: string,
  attrs: Record<string, string> = {},
  ...children: (El | string)[]
): El {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

/** `getElementById`, narrowed to the facade type. */
export function byId(id: string): El | null {
  return document.getElementById(id);
}

/** Show / hide an element via the `hidden` attribute (CSS hides `[hidden]`). */
export function setHidden(node: El, hidden: boolean): void {
  node.hidden = hidden;
}

/** Run `fn` once the DOM is ready (now if it already is). */
export function onReady(fn: () => void): void {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
  else fn();
}

/** The single IPC surface the preload bridge exposes to the renderer. */
export function api(): AppApi {
  return window.canvasAgent;
}

/** Copy `text` to the clipboard; resolves false if the clipboard is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  const clip = window.navigator.clipboard;
  if (!clip) return false;
  try {
    await clip.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open `url` in the OS browser. Electron main (`main.ts`'s `setWindowOpenHandler`)
 * intercepts every `window.open` call globally, routes http(s) targets to
 * `shell.openExternal`, and denies an in-app window — so this never needs a new
 * IPC channel or preload surface.
 */
export function openUrl(url: string): void {
  window.open(url);
}

/** Normalize any thrown value to a display string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run `fn` after `ms` (thin wrapper so modules don't touch globals directly). */
export function later(fn: () => void, ms: number): void {
  setTimeout(fn, ms);
}

/**
 * Read a `localStorage` value, returning `undefined` if the key is absent OR if
 * storage throws/is unavailable (e.g. a `file://` origin in the packaged app).
 */
export function readStorage(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Write a `localStorage` value; silently no-ops if storage throws/is unavailable. */
export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Best-effort persistence only — e.g. a `file://` origin may disallow storage.
  }
}
