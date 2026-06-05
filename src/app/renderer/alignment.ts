/**
 * Alignment Coach (brief §7).
 *
 * No dedicated API — it's a COMPOSED guidance turn. The panel takes pasted
 * content (+ optional objectives / rubric), composes a prompt asking the model to
 * map the content to learning objectives and rubric criteria and flag gaps, then
 * hands it to the shell to run as `runTurn({ user, mode: 'guidance' })`. The
 * runtime scopes guidance to the rubric-criteria / WCAG packs.
 */
import { el, type El } from './ui.js';

export interface AlignmentInput {
  content: string;
  objectives?: string;
  rubric?: string;
}

/** Compose the guidance prompt. Exported so a per-fragment check can reuse it. */
export function composeAlignmentPrompt(input: AlignmentInput): string {
  const objectives = input.objectives?.trim()
    ? input.objectives.trim()
    : '(none provided — infer the likely objectives for this content)';
  const rubric = input.rubric?.trim()
    ? input.rubric.trim()
    : '(none provided — infer reasonable rubric criteria)';
  return [
    'You are an instructional-design alignment coach. Map the course content below',
    'to its learning objectives and rubric criteria. For each objective, say whether',
    'the content addresses it and where; for each rubric criterion, say whether the',
    'content would satisfy it. Then flag every gap: objectives or criteria that are',
    'unmet or only partially met, and list concrete, specific additions to close them.',
    '',
    'Learning objectives:',
    objectives,
    '',
    'Rubric criteria:',
    rubric,
    '',
    'Content:',
    input.content.trim(),
  ].join('\n');
}

export interface AlignmentDeps {
  /** The shell runs the composed prompt as a guidance turn in the transcript. */
  onCheck(prompt: string): void;
}

export interface AlignmentPanel {
  element: El;
}

export function createAlignment(deps: AlignmentDeps): AlignmentPanel {
  const content = el('textarea', {
    class: 'align__field',
    rows: '6',
    placeholder: 'Paste the content to check (page text, assignment prompt, …)',
    'aria-label': 'Content to check',
  });
  const objectives = el('textarea', {
    class: 'align__field',
    rows: '3',
    placeholder: 'Learning objectives (optional, one per line)',
    'aria-label': 'Learning objectives',
  });
  const rubric = el('textarea', {
    class: 'align__field',
    rows: '3',
    placeholder: 'Rubric criteria (optional, one per line)',
    'aria-label': 'Rubric criteria',
  });

  const checkBtn = el('button', { type: 'button', class: 'align__check' }, 'Check alignment');
  const hint = el('p', { class: 'align__hint' }, 'Add content to check its alignment.');

  checkBtn.addEventListener('click', () => {
    const text = content.value.trim();
    if (!text) {
      hint.textContent = 'Add some content first.';
      return;
    }
    hint.textContent = 'Running a guidance turn in the transcript…';
    deps.onCheck(
      composeAlignmentPrompt({ content: text, objectives: objectives.value, rubric: rubric.value }),
    );
  });

  const element = el(
    'aside',
    { class: 'panel align', 'aria-label': 'Alignment coach' },
    el('h2', {}, 'Alignment coach'),
    el('label', { class: 'align__label' }, 'Content'),
    content,
    el('label', { class: 'align__label' }, 'Objectives'),
    objectives,
    el('label', { class: 'align__label' }, 'Rubric'),
    rubric,
    el('div', { class: 'align__row' }, checkBtn, hint),
  );

  return { element };
}
