/**
 * A tool schema is the only thing telling the model what a tool will accept.
 *
 * When it says nothing, the model guesses — and a wrong guess here does not
 * fail loudly, it comes back as a soft warning plus a useless result, so the
 * model tries again and the bounded tool loop runs out. That is exactly how a
 * plain "generate a page" turn died: five iterations, no answer, an error in
 * the user's face.
 *
 * Two schemas caused it, and both are asserted here:
 *   - `render_template.type` was `{ type: 'string' }`, so "General content page"
 *     became `general_content_page` (the real id is `page-content`).
 *   - `render_template.slots` was an opaque object, so the model invented slot
 *     names that no renderer reads and got back a heading and nothing else.
 *   - `retrieve_kb.packs` was unconstrained too, so two of the five iterations
 *     were spent retrieving from a pack that does not exist.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { TEMPLATE_SLOTS, TEMPLATE_SLOT_SHAPES, TEMPLATE_TYPES } from '../contracts/index.js';
import { createCanonicalTools } from './tools.js';
import { KB_PACKS_BY_MODE } from './modes.js';

const definitionOf = (name: string) => {
  const tool = createCanonicalTools({}).find((t) => t.definition.name === name);
  assert.ok(tool, `no such tool: ${name}`);
  return tool.definition;
};

/** The JSON-Schema property bag, typed loosely the way a schema literal is. */
const propsOf = (name: string): Record<string, { enum?: unknown[] }> =>
  (definitionOf(name).parameters as { properties: Record<string, { enum?: unknown[] }> }).properties;

describe('render_template advertises what it will actually accept', () => {
  test('type is constrained to the real template ids', () => {
    const type = propsOf('render_template')['type'];
    assert.ok(type?.enum, '`type` must be an enum — a bare string makes the model guess an id');
    assert.deepEqual(
      [...(type.enum as string[])].sort(),
      [...TEMPLATE_TYPES].sort(),
      'the advertised ids must be exactly the ones renderTemplate dispatches on',
    );
  });

  test('the enum rules out the id the model actually invented', () => {
    // The specific failure, pinned: this is the value that reached
    // renderTemplate and produced "unknown template type".
    const type = propsOf('render_template')['type'];
    assert.ok(
      !(type?.enum as string[]).includes('general_content_page'),
      'sanity: the invented id must not be a valid value',
    );
    assert.ok(
      (type?.enum as string[]).includes('page-content'),
      'the real id for the "General content page" template must be offered',
    );
  });

  test('the description names each template’s slots, so they need not be guessed', () => {
    const { description } = definitionOf('render_template');
    for (const type of TEMPLATE_TYPES) {
      assert.ok(description.includes(type), `description omits the "${type}" template`);
      for (const slot of TEMPLATE_SLOTS[type]) {
        assert.ok(
          description.includes(slot),
          `description omits the "${slot}" slot of "${type}" — the model would invent one`,
        );
      }
    }
  });

  test('the description gives the inner shape of object-valued slots', () => {
    // The failure this prevents is quieter than the loop error: the model sent
    // `sections: [{ heading, content }]` where the renderer reads `body`, so the
    // page rendered as headings with no text and reported no warning.
    const { description } = definitionOf('render_template');
    for (const [slot, shape] of Object.entries(TEMPLATE_SLOT_SHAPES)) {
      assert.ok(
        description.includes(`${slot}${shape}`),
        `description must show "${slot}" as "${shape}", or its keys get guessed`,
      );
    }
    assert.ok(description.includes('body'), 'the key the model got wrong must be spelled out');
  });

  test('the slot names the model actually invented are absent', () => {
    // Guards the description against being vacuously "complete" by listing
    // everything: these are the names granite sent, and no renderer reads them.
    const { description } = definitionOf('render_template');
    for (const invented of ['dates_or_rhythm', 'learner_tasks', 'official_course_outcomes']) {
      assert.ok(!description.includes(invented), `description should not suggest "${invented}"`);
    }
  });
});

describe('retrieve_kb advertises the packs that exist', () => {
  test('packs items are constrained to the real pack ids', () => {
    const packs = propsOf('retrieve_kb')['packs'] as { items?: { enum?: unknown[] } } | undefined;
    const known = [...new Set(Object.values(KB_PACKS_BY_MODE).flat())].sort();
    assert.ok(packs?.items?.enum, '`packs` items must be an enum — an unknown pack silently returns zero hits');
    assert.deepEqual([...(packs.items.enum as string[])].sort(), known);
  });

  test('the pack name the model invented is not among them', () => {
    const packs = propsOf('retrieve_kb')['packs'] as { items?: { enum?: unknown[] } };
    assert.ok(
      !(packs.items?.enum as string[]).includes('Canvas Template Guide'),
      'sanity: the invented pack must not be valid',
    );
  });
});
