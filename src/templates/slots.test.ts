/**
 * The slot manifest has to describe the templates that actually exist.
 *
 * `render_template` advertises each template's slot names to the model. A
 * manifest that drifts from the renderers is worse than none: the model would
 * fill slots nothing reads and get back a hollow fragment, which is exactly the
 * bug this manifest exists to fix — the model sent `dates_or_rhythm`,
 * `learner_tasks` and `official_course_outcomes` to `module-overview`, which
 * reads `title`, `objectives` and `items`, so every value was silently dropped.
 *
 * So the manifest is checked against the renderers' OWN account of what they
 * wanted: rendered with no slots at all, each renderer names every slot it
 * missed in its warnings. That is a runtime fact, not a second copy of the list.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { TEMPLATE_SLOTS, TEMPLATE_TYPES } from '../contracts/index.js';
import { renderTemplate } from './index.js';

/** Every slot name a renderer complains about when handed nothing. */
async function slotsTheRendererAsksFor(type: (typeof TEMPLATE_TYPES)[number]): Promise<string[]> {
  const { warnings } = await renderTemplate(type, {});
  const names = new Set<string>();
  for (const warning of warnings) {
    // `no "objectives" slot provided; …` / `no "title" slot provided; …`
    const match = /"([A-Za-z_][\w-]*)" slot provided/.exec(warning);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names].sort();
}

describe('the template slot manifest matches the renderers', () => {
  test('every template type has a manifest entry', () => {
    assert.deepEqual(
      Object.keys(TEMPLATE_SLOTS).sort(),
      [...TEMPLATE_TYPES].sort(),
      'a template with no manifest entry would be advertised to the model with no slots',
    );
  });

  for (const type of TEMPLATE_TYPES) {
    test(`${type}: the manifest lists exactly the slots the renderer reads`, async () => {
      const actual = await slotsTheRendererAsksFor(type);
      assert.deepEqual(
        [...TEMPLATE_SLOTS[type]].sort(),
        actual,
        `manifest for "${type}" disagrees with the slots its renderer names in its own warnings`,
      );
    });
  }

  test('the manifest is non-empty for every template', () => {
    // A template advertising zero slots tells the model nothing, which is the
    // state that caused the loop to exhaust in the first place.
    for (const type of TEMPLATE_TYPES) {
      assert.ok(TEMPLATE_SLOTS[type].length > 0, `"${type}" advertises no slots`);
    }
  });
});

describe('the documented shape of a structured slot actually renders', () => {
  /**
   * Naming a slot is not enough when its value is a list of objects. The model
   * supplied `sections: [{ heading, content }]` — the right slot, the right
   * outer shape, one wrong key — and the renderer, which reads `body`, emitted
   * the headings and dropped every paragraph with `warnings: []`. A hollow page
   * and no complaint is worse than the loop error it replaced, so these assert
   * on OUTPUT: feed each documented shape and require its content to survive
   * into the HTML. Renaming a key in a renderer fails this.
   */
  const CASES: ReadonlyArray<{
    type: (typeof TEMPLATE_TYPES)[number];
    slots: Record<string, unknown>;
    mustContain: readonly string[];
  }> = [
    {
      type: 'page-content',
      slots: { title: 'T', sections: [{ heading: 'SectionHeading', body: 'SectionBody' }] },
      mustContain: ['SectionHeading', 'SectionBody'],
    },
    {
      type: 'lecture-notes',
      slots: { title: 'T', topics: [{ heading: 'TopicHeading', points: ['TopicPoint'] }] },
      mustContain: ['TopicHeading', 'TopicPoint'],
    },
    {
      type: 'study-guide',
      slots: {
        title: 'T',
        keyTerms: [{ term: 'TheTerm', definition: 'TheDefinition' }],
        questions: ['TheQuestion'],
      },
      mustContain: ['TheTerm', 'TheDefinition', 'TheQuestion'],
    },
    {
      type: 'rubric',
      slots: {
        title: 'T',
        criteria: [
          { name: 'CriterionName', levels: [{ label: 'LevelLabel', points: '5', descriptor: 'LevelDescriptor' }] },
        ],
      },
      mustContain: ['CriterionName', 'LevelLabel', 'LevelDescriptor'],
    },
  ];

  for (const { type, slots, mustContain } of CASES) {
    test(`${type}: every documented key reaches the output`, async () => {
      const { html, warnings } = await renderTemplate(type, slots);
      for (const needle of mustContain) {
        assert.ok(
          html.includes(needle),
          `"${needle}" was dropped by "${type}" — the documented shape disagrees with the renderer.\nhtml: ${html}`,
        );
      }
      assert.deepEqual(warnings, [], `a fully-populated "${type}" should warn about nothing`);
    });
  }
});
