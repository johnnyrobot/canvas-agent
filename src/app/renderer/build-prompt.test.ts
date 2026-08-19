import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { TEMPLATE_SLOTS } from '../../contracts/index.js';
import type { CatalogCourse } from '../../contracts/index.js';
import { buildPagePrompt } from './build-prompt.js';

const base = {
  template: 'page-content' as const,
  title: 'Module 1 - Getting Started',
  rhythm: '',
  tasks: '',
  course: undefined,
  brandKitName: 'Ocean',
};

describe('the build prompt hands over what the app already knows', () => {
  test('names the machine template id, not just the human label', () => {
    // The label is what broke it: "General content page" was all the model got,
    // so it produced `general_content_page`, which no renderer dispatches on.
    const prompt = buildPagePrompt(base);
    assert.ok(prompt.includes('page-content'), 'the exact template id must appear verbatim');
    assert.ok(
      !prompt.includes('general_content_page'),
      'the label-derived guess must not be reintroduced',
    );
  });

  test('names the slots of THAT template, and no others', () => {
    const prompt = buildPagePrompt({ ...base, template: 'module-overview' });
    for (const slot of TEMPLATE_SLOTS['module-overview']) {
      assert.ok(prompt.includes(slot), `"${slot}" must be offered for module-overview`);
    }
    // `sections` belongs to page-content; offering it here invites a dropped slot.
    assert.ok(!prompt.includes('sections'), 'slots of other templates must not leak in');
  });

  test('the user’s template choice is stated as binding', () => {
    // The model picked `module-overview` on its own because the title said
    // "Module 1", overriding the choice made in step 1 of the wizard.
    const prompt = buildPagePrompt(base);
    assert.match(prompt, /exactly|must use|do not choose another/i);
  });

  test('carries the title, rhythm and tasks the instructor typed', () => {
    const prompt = buildPagePrompt({
      ...base,
      rhythm: 'Weekly, due Sundays',
      tasks: 'Read chapter 2',
    });
    assert.ok(prompt.includes('Module 1 - Getting Started'));
    assert.ok(prompt.includes('Weekly, due Sundays'));
    assert.ok(prompt.includes('Read chapter 2'));
  });

  test('empty optional fields become an explicit placeholder, never invented', () => {
    // The hard rules forbid inventing institutional facts; an empty date field
    // has to reach the model as a marked gap.
    const prompt = buildPagePrompt(base);
    assert.ok(prompt.includes('[TBD]'), 'an empty rhythm must be a visible placeholder');
  });

  test('includes official course outcomes verbatim when a course is attached', () => {
    const course: CatalogCourse = {
      id: 1,
      code: 'CS160',
      title: 'Introduction to Artificial Intelligence',
      slos: ['The student will be able to demonstrate their understanding of the limitations of logic'],
      objectives: [],
      source: 'live',
    };
    const prompt = buildPagePrompt({ ...base, course });
    assert.ok(prompt.includes('CS160'));
    assert.ok(prompt.includes('limitations of logic'), 'SLOs must be passed through, not summarised');
  });

  test('names the brand kit', () => {
    assert.ok(buildPagePrompt(base).includes('Ocean'));
  });
});
