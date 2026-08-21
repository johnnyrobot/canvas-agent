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
import { TEMPLATE_SLOTS, TEMPLATE_SLOT_SHAPES, TEMPLATE_TYPES } from '../contracts/index.js';
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

describe('the manifest documents the shape of every slot that is not a plain string', () => {
  /**
   * Naming a slot is only enough when a plain string is what it takes.
   *
   * `module-overview: title, objectives, items` reads as three strings, and that
   * is what the model sent. `objectives` and `items` are read with `strList`,
   * which drops a non-array outright — so the fragment came back as a bare
   * heading and the renderer reported `no "objectives" slot provided` about a
   * slot that HAD been provided. Nothing in that reply tells the model what it
   * got wrong, so it rephrased the same string and the bounded loop ran out.
   *
   * The kind of each slot is derived from the renderer here rather than
   * restated: feed a plain string and ask whether the renderer took it at face
   * value — rendered, and with no complaint about that slot. A slot that has to
   * salvage the string first is not a string slot, and must carry a documented
   * shape.
   */
  const PROBE = 'ProbeSlotValue';

  async function keepsAPlainString(
    type: (typeof TEMPLATE_TYPES)[number],
    slot: string,
  ): Promise<boolean> {
    const { html, warnings } = await renderTemplate(type, { [slot]: PROBE });
    return html.includes(PROBE) && !warnings.some((w) => w.includes(`"${slot}"`));
  }

  for (const type of TEMPLATE_TYPES) {
    for (const slot of TEMPLATE_SLOTS[type]) {
      test(`${type}.${slot}: documented as a list exactly when a string is not enough`, async () => {
        const scalar = await keepsAPlainString(type, slot);
        const documented = TEMPLATE_SLOT_SHAPES[slot];
        if (scalar) {
          assert.equal(
            documented,
            undefined,
            `"${slot}" renders a plain string, so advertising the shape "${documented}" would mislead`,
          );
        } else {
          assert.ok(
            documented,
            `"${slot}" DROPS a plain string, so the model must be told its shape — it is advertised as a bare name today`,
          );
        }
      });
    }
  }

  test('every documented list-of-strings shape renders its content', async () => {
    // Non-vacuity: the manifest could claim `[string]` for a slot that reads
    // something else entirely. Each one is fed the shape it advertises.
    for (const type of TEMPLATE_TYPES) {
      for (const slot of TEMPLATE_SLOTS[type]) {
        if (TEMPLATE_SLOT_SHAPES[slot] !== '[string]') continue;
        const { html } = await renderTemplate(type, { title: 'T', [slot]: [PROBE] });
        assert.ok(
          html.includes(PROBE),
          `"${type}.${slot}" is advertised as [string] but dropped one.\nhtml: ${html}`,
        );
      }
    }
  });
});

describe('a slot filled with the wrong shape is not silently discarded', () => {
  /**
   * Defense in depth behind the manifest above. The model still gets shapes
   * wrong, and when it does the reply has to say so: a warning that denies the
   * slot was provided at all is worse than useless, because the only correction
   * it suggests is the one the model already made.
   */
  test('a string sent to a list slot keeps its text', async () => {
    const { html } = await renderTemplate('module-overview', {
      title: 'T',
      objectives: 'Understand the course structure',
    });
    assert.ok(
      html.includes('Understand the course structure'),
      `instructor content sent in the wrong shape must not vanish.\nhtml: ${html}`,
    );
  });

  test('a string sent to a list slot is not reported as missing', async () => {
    const { warnings } = await renderTemplate('module-overview', {
      title: 'T',
      objectives: 'Understand the course structure',
    });
    assert.ok(
      !warnings.some((w) => w.includes('no "objectives" slot provided')),
      `the slot WAS provided; claiming otherwise sends the model back the same way.\nwarnings: ${JSON.stringify(warnings)}`,
    );
  });

  test('the warning names the slot and the shape it wanted', async () => {
    const { warnings } = await renderTemplate('module-overview', {
      title: 'T',
      objectives: 'Understand the course structure',
    });
    assert.ok(
      warnings.some((w) => w.includes('"objectives"') && w.includes('list of strings')),
      `a correctable warning has to name both.\nwarnings: ${JSON.stringify(warnings)}`,
    );
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
