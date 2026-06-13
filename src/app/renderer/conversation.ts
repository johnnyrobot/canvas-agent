/**
 * Conversation transcript controller (brief §3–§5).
 *
 * Owns the live transcript: user bubbles, streaming assistant turns, gated
 * fragment cards (with the §4 preview/export strip), the resolved mode label,
 * and the remediate before→after diff. All decision logic is delegated to the
 * pure `turnViewToVm`; this module only does DOM work.
 *
 * Streaming: `beginAssistantTurn()` mounts an empty turn immediately. Text
 * chunks append incrementally, tool chunks show a transient "Using …" line, and
 * fragment chunks render live. `finalize(view)` then reconciles to the complete,
 * authoritative `TurnView` (so a non-streaming backend that only resolves still
 * renders fully).
 *
 * Safety: the ONLY `innerHTML` sink is each fragment's gate-approved `html`. All
 * other text — including the remediate `before` source — is written via
 * `textContent`.
 */
import { el, setHidden, type El } from './ui.js';
import { fragmentArtifacts } from './preview.js';
import { turnViewToVm, type FragmentVm, type RemediateVm, type TurnVm } from '../view.js';
import type { SessionMessage, TurnChunk, TurnView } from '../../contracts/index.js';

export interface AssistantTurn {
  /** Apply one streamed chunk (text delta / tool indicator / live fragment). */
  onChunk(chunk: TurnChunk): void;
  /** Reconcile to the final, authoritative turn view. */
  finalize(view: TurnView): void;
  /** Replace the turn with an error message. */
  fail(message: string): void;
}

export interface Conversation {
  appendUser(text: string): void;
  beginAssistantTurn(): AssistantTurn;
  appendError(message: string): void;
  /** Repaint the transcript from a loaded session's stored text messages. */
  repaint(messages: SessionMessage[]): void;
  clear(): void;
}

export interface ConversationDeps {
  transcript: El;
  /** Optional per-fragment "Check alignment" action (brief §7). */
  onCheckAlignment?: (html: string) => void;
}

const MODE_LABELS: Record<string, string> = {
  guidance: 'Guidance',
  build: 'Build',
  remediate: 'Remediate',
};

export function createConversation(deps: ConversationDeps): Conversation {
  const { transcript } = deps;

  function scroll(): void {
    transcript.scrollTop = transcript.scrollHeight;
  }

  function gatedBody(html: string): El {
    // The ONLY innerHTML sink — `html` is already through `enforceGate`.
    const body = el('div', { class: 'fragment__html' });
    body.innerHTML = html;
    return body;
  }

  function badgeEl(fragment: FragmentVm): El {
    return el(
      'span',
      { class: `badge badge--${fragment.badge.kind}`, role: 'status' },
      fragment.badge.label,
    );
  }

  function issueList(items: string[], cls: string, label: string): El | null {
    if (items.length === 0) return null;
    const list = el('ul', { class: cls });
    for (const message of items) list.append(el('li', {}, message));
    return el('div', {}, el('p', { class: `${cls}-label` }, label), list);
  }

  function remediateView(rr: RemediateVm): El {
    const wrap = el('section', { class: 'remediate' });

    // Before: UNGATED source — render as text only, never via innerHTML.
    const beforeCode = el('code');
    beforeCode.textContent = rr.before;
    wrap.append(
      el('p', { class: 'remediate__label' }, 'Before (source HTML)'),
      el('pre', { class: 'remediate__before' }, beforeCode),
    );

    // After: gated, safe-to-render result + the §4 preview/export strip.
    wrap.append(
      el('p', { class: 'remediate__label' }, 'After (remediated)'),
      gatedBody(rr.after),
      fragmentArtifacts(rr.after),
    );

    if (rr.issueDiffs.length > 0) {
      const list = el('ul', { class: 'remediate__diffs' });
      for (const diff of rr.issueDiffs) {
        const mark = el(
          'span',
          { class: `remediate__mark remediate__mark--${diff.fixed ? 'fixed' : 'unfixed'}` },
          diff.fixed ? '✓' : '✗',
        );
        list.append(el('li', {}, mark, el('span', { class: 'remediate__issue' }, diff.message)));
      }
      wrap.append(el('p', { class: 'remediate__label' }, 'Issues'), list);
    }

    return wrap;
  }

  function renderFragment(fragment: FragmentVm): El {
    const card = el('article', { class: 'fragment' }, badgeEl(fragment));

    if (fragment.remediateResult) {
      card.append(remediateView(fragment.remediateResult));
    } else {
      card.append(gatedBody(fragment.html), fragmentArtifacts(fragment.html));
    }

    const blockers = issueList(fragment.blockers, 'fragment__blockers', 'Blocking issues:');
    if (blockers) card.append(blockers);
    const warnings = issueList(fragment.warnings, 'fragment__warnings', 'Warnings:');
    if (warnings) card.append(warnings);
    const review = issueList(fragment.needsReview, 'fragment__review', 'Needs human review:');
    if (review) card.append(review);

    if (deps.onCheckAlignment) {
      const onCheck = deps.onCheckAlignment;
      const btn = el('button', { type: 'button', class: 'fragment__align' }, 'Check alignment');
      btn.addEventListener('click', () => onCheck(fragment.html));
      card.append(btn);
    }

    return card;
  }

  function appendUser(text: string): void {
    transcript.append(
      el('section', { class: 'turn turn--user' }, el('p', { class: 'turn__text' }, text)),
    );
    scroll();
  }

  function appendError(message: string): void {
    transcript.append(
      el('section', { class: 'turn turn--error' }, el('p', {}, `Error: ${message}`)),
    );
    scroll();
  }

  function beginAssistantTurn(): AssistantTurn {
    const modeEl = el('p', { class: 'turn__mode' });
    setHidden(modeEl, true);
    const textEl = el('p', { class: 'turn__text' });
    setHidden(textEl, true);
    const toolLiveEl = el('p', { class: 'turn__tool-live' });
    setHidden(toolLiveEl, true);
    const fragmentsEl = el('div', { class: 'turn__fragments' });
    const toolsEl = el('p', { class: 'turn__tools' });
    setHidden(toolsEl, true);

    const turn = el(
      'section',
      { class: 'turn turn--assistant' },
      modeEl,
      textEl,
      toolLiveEl,
      fragmentsEl,
      toolsEl,
    );
    transcript.append(turn);
    scroll();

    let streamedText = '';

    return {
      onChunk(chunk: TurnChunk): void {
        if (chunk.type === 'text') {
          streamedText += chunk.delta;
          textEl.textContent = streamedText;
          setHidden(textEl, streamedText.length === 0);
        } else if (chunk.type === 'tool') {
          toolLiveEl.textContent = `Using ${chunk.name}…`;
          setHidden(toolLiveEl, false);
        } else {
          fragmentsEl.append(renderFragment(turnViewToVm({
            text: '',
            fragments: [chunk.fragment],
            toolsUsed: [],
            iterations: 0,
          }).fragments[0]!));
        }
        scroll();
      },

      finalize(view: TurnView): void {
        const vm: TurnVm = turnViewToVm(view);

        if (vm.mode) {
          modeEl.textContent = `Mode: ${MODE_LABELS[vm.mode] ?? vm.mode}`;
          setHidden(modeEl, false);
        } else {
          setHidden(modeEl, true);
        }

        textEl.textContent = vm.text;
        setHidden(textEl, vm.text.length === 0);

        setHidden(toolLiveEl, true);

        // Reconcile fragments: replace any streamed-in cards with the final set.
        fragmentsEl.replaceChildren(...vm.fragments.map(renderFragment));

        if (vm.toolsUsed.length > 0) {
          toolsEl.textContent = `Tools used: ${vm.toolsUsed.join(', ')} · ${vm.iterations} iteration(s)`;
          setHidden(toolsEl, false);
        } else {
          setHidden(toolsEl, true);
        }

        scroll();
      },

      fail(message: string): void {
        turn.className = 'turn turn--error';
        turn.replaceChildren(el('p', {}, `Error: ${message}`));
        scroll();
      },
    };
  }

  function repaint(messages: SessionMessage[]): void {
    transcript.replaceChildren();
    for (const message of messages) {
      if (message.role === 'user') {
        appendUser(message.content);
      } else if (message.role === 'assistant') {
        transcript.append(
          el(
            'section',
            { class: 'turn turn--assistant' },
            el('p', { class: 'turn__text' }, message.content),
          ),
        );
      }
      // system / tool messages are internal — not shown in the transcript.
    }
    scroll();
  }

  function clear(): void {
    transcript.replaceChildren();
  }

  return { appendUser, beginAssistantTurn, appendError, repaint, clear };
}
