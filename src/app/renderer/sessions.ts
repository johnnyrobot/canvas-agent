/**
 * Session switcher sidebar (brief §2).
 *
 * Lists `listSessions()`; "New" creates a session in the current mode; clicking
 * a row loads it (`loadSession` → transcript repaint); the "×" deletes it. The
 * active session id is owned by the shell and threaded into every `runTurn`.
 */
import { api, el, errorMessage, setHidden, type El } from './ui.js';
import type { ProductMode, Session, SessionState } from '../../contracts/index.js';

export interface SessionsDeps {
  /** Current selected mode (Auto maps to 'guidance' for a new session's record). */
  getMode(): ProductMode;
  /** A new/loaded session becomes active; the shell stores its id + repaints. */
  onActivate(state: SessionState | { session: Session; messages: [] }): void;
  /** The active session was deleted; the shell clears state if it was current. */
  onDeleted(id: string): void;
  onError(message: string): void;
}

export interface Sessions {
  element: El;
  refresh(): Promise<void>;
  /** Re-render the active highlight when the shell's current id changes. */
  setActive(id: string | undefined): void;
}

export function createSessions(deps: SessionsDeps): Sessions {
  let activeId: string | undefined;
  let cache: Session[] = [];

  const list = el('ul', { class: 'sessions__list' });
  const empty = el('p', { class: 'sessions__empty' }, 'No saved sessions yet.');
  setHidden(empty, true);

  const newBtn = el('button', { type: 'button', class: 'sessions__new' }, '+ New session');
  newBtn.addEventListener('click', () => void createNew());

  const element = el(
    'aside',
    { class: 'sessions', 'aria-label': 'Sessions' },
    el('div', { class: 'sessions__head' }, el('h2', {}, 'Sessions'), newBtn),
    list,
    empty,
  );

  function rowLabel(s: Session): string {
    return `${s.title} · ${s.mode}`;
  }

  function render(): void {
    setHidden(empty, cache.length > 0);
    list.replaceChildren(
      ...cache.map((s) => {
        const open = el('button', { type: 'button', class: 'sessions__open' }, rowLabel(s));
        open.addEventListener('click', () => void load(s.id));

        const del = el(
          'button',
          { type: 'button', class: 'sessions__del', 'aria-label': `Delete ${s.title}` },
          '×',
        );
        del.addEventListener('click', () => void remove(s.id));

        const cls = s.id === activeId ? 'sessions__row sessions__row--active' : 'sessions__row';
        return el('li', { class: cls }, open, del);
      }),
    );
  }

  async function refresh(): Promise<void> {
    try {
      cache = await api().listSessions();
      render();
    } catch (err) {
      deps.onError(errorMessage(err));
    }
  }

  async function createNew(): Promise<void> {
    try {
      const mode = deps.getMode();
      const title = `Session ${cache.length + 1}`;
      const session = await api().createSession({ title, mode });
      activeId = session.id;
      await refresh();
      deps.onActivate({ session, messages: [] });
    } catch (err) {
      deps.onError(errorMessage(err));
    }
  }

  async function load(id: string): Promise<void> {
    try {
      const state = await api().loadSession(id);
      if (!state) {
        deps.onError('That session could not be loaded.');
        await refresh();
        return;
      }
      activeId = id;
      render();
      deps.onActivate(state);
    } catch (err) {
      deps.onError(errorMessage(err));
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api().deleteSession(id);
      if (activeId === id) activeId = undefined;
      deps.onDeleted(id);
      await refresh();
    } catch (err) {
      deps.onError(errorMessage(err));
    }
  }

  function setActive(id: string | undefined): void {
    activeId = id;
    render();
  }

  return { element, refresh, setActive };
}
