/**
 * The Build flow's prompt, assembled from what the wizard already knows.
 *
 * The instructor picks a template in step 1 and types the fields in step 2, so
 * the app holds a real `TemplateType` and real values — and used to throw both
 * away: it wrote the human LABEL into prose ("Build a General content page
 * Canvas page") and left the model to reconstruct the machine id and invent
 * slot names. It reconstructed `general_content_page`, which no renderer
 * dispatches on, then guessed slots nothing reads, and the bounded tool loop
 * ran out mid-turn with an error on screen.
 *
 * Worse than the error: on the run before that one it silently chose
 * `module-overview` instead — because the title said "Module 1" — quietly
 * overriding a choice the instructor had explicitly made two screens earlier.
 *
 * So the id and the slot names are stated outright. The model still writes the
 * prose, which is the part it is for; it no longer has to re-derive structure
 * the app was already holding.
 *
 * Pure and DOM-free on purpose (the `catalog-view.ts` convention) so it is
 * unit-tested with plain `node:test` and no browser.
 */
import { TEMPLATE_SLOTS, TEMPLATE_SLOT_SHAPES, type CatalogCourse, type TemplateType } from '../../contracts/index.js';
import { catalogPromptLines } from './catalog-view.js';

export interface BuildPromptInput {
  /** The template chosen in step 1 — authoritative, not a suggestion. */
  template: TemplateType;
  title: string;
  rhythm: string;
  tasks: string;
  /** The attached LACCD catalog course, when the instructor picked one. */
  course: CatalogCourse | undefined;
  brandKitName: string;
}

/** `title, sections[{ heading, body }]` — the slots of one template, with shapes. */
function slotSpec(template: TemplateType): string {
  return TEMPLATE_SLOTS[template].map((s) => `${s}${TEMPLATE_SLOT_SHAPES[s] ?? ''}`).join(', ');
}

export function buildPagePrompt(input: BuildPromptInput): string {
  const title = input.title || 'Module 1 - Getting Started';
  return [
    `Build a Canvas page using render_template with type "${input.template}".`,
    `Use exactly that template type — it is the one the instructor chose; do not choose another.`,
    `Its slots are: ${slotSpec(input.template)}. Put the content below into those slots.`,
    '',
    `Title: ${title}`,
    input.rhythm ? `Dates or rhythm: ${input.rhythm}` : 'Dates or rhythm: [TBD]',
    input.tasks
      ? `Learner tasks: ${input.tasks}`
      : 'Learner tasks: read chapter 1; post to the introductions discussion.',
    ...catalogPromptLines(input.course),
    `Use the ${input.brandKitName} brand kit when accessible.`,
  ].join('\n');
}
