/**
 * The deterministic FLOOR for a suggested text alternative.
 *
 * Pure functions over (suggestion, fixture) — no model, no network, no judge —
 * so the whole thing is unit-testable offline and a failure is attributable to
 * one named rule rather than to an aggregate score.
 *
 * These are not quality measures. Every rule here marks alt text that is
 * actively WORSE than no suggestion, because an instructor will paste it and a
 * screen-reader user will then be told something false, redundant, or empty. A
 * model can clear this floor and still write mediocre alt text — deciding
 * between models is the adjudicated gate of #42/#43, not this.
 *
 * The floor is a HARD filter: failing any rule on any fixture disqualifies the
 * candidate. That is deliberate. Averaging a hallucinated scan against nine
 * competent charts is how a model that invents exam dates gets promoted.
 */
import type { AltFixture } from './fixtures.ts';

/** Practical ceiling for a text alternative before it stops being usable aloud. */
export const MAX_ALT_CHARS = 250;

/** Openers that waste the first words a screen-reader user hears. */
const REDUNDANT_PREFIX = /^\s*(an?\s+)?(image|picture|photo|photograph|graphic|illustration|screenshot)\s+(of|showing|depicting)\b/i;

/** A filename is not a text alternative. */
const FILENAME = /\b[\w-]+\.(png|jpe?g|gif|svg|webp|bmp|tiff?)\b/i;

export interface FloorViolation {
  rule: string;
  detail: string;
}

export interface FloorResult {
  fixtureId: string;
  suggestion: string;
  violations: FloorViolation[];
  passed: boolean;
}

/**
 * Longest run of a phrase repeated back-to-back.
 *
 * Present because the provisional vision candidate is on record looping a
 * sentence, and a looping alt is unusable aloud however accurate its first
 * clause was. Compares normalised sentence-ish chunks so punctuation and case
 * cannot hide the repetition.
 */
export function maxConsecutiveRepeats(text: string): number {
  const chunks = text
    .split(/[.;\n]+/)
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter((s) => s.length > 8);
  let best = 1;
  let run = 1;
  for (let i = 1; i < chunks.length; i++) {
    run = chunks[i] === chunks[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/** Check one suggestion against the floor. */
export function checkFloor(fixture: AltFixture, rawSuggestion: string): FloorResult {
  const suggestion = rawSuggestion.trim();
  const violations: FloorViolation[] = [];
  const add = (rule: string, detail: string) => violations.push({ rule, detail });

  // A decorative image is the one case where empty is the CORRECT answer, so it
  // is checked first and exits: every other rule below would misjudge it.
  if (fixture.category === 'decorative') {
    if (suggestion !== '' && !/^\s*(none|empty|no alt|decorative)\b/i.test(suggestion)) {
      add(
        'decorative-narrated',
        `a decorative graphic must get an empty alternative, got ${JSON.stringify(suggestion.slice(0, 80))}`,
      );
    }
    return { fixtureId: fixture.id, suggestion, violations, passed: violations.length === 0 };
  }

  if (suggestion === '') {
    add('empty', 'an informative image was given no alternative at all');
    // Nothing further is meaningful about an empty string.
    return { fixtureId: fixture.id, suggestion, violations, passed: false };
  }

  if (suggestion.length > MAX_ALT_CHARS) {
    add('too-long', `${suggestion.length} chars exceeds the ${MAX_ALT_CHARS}-char ceiling`);
  }

  if (REDUNDANT_PREFIX.test(suggestion)) {
    add('redundant-prefix', 'opens with "image of"-style boilerplate the screen reader already announces');
  }

  if (FILENAME.test(suggestion)) {
    add('filename', 'contains a filename, which is not a text alternative');
  }

  const repeats = maxConsecutiveRepeats(suggestion);
  if (repeats > 1) {
    add('looping', `the same phrase repeats ${repeats}× in a row`);
  }

  // The teeth. Only text-in-image fixtures declare `mustMention`, and there the
  // rendered words ARE the content: a suggestion missing them has described the
  // picture without reading it, which is the confident-fiction failure.
  //
  // Compared with WHITESPACE STRIPPED on both sides. The first run of this gate
  // failed a model that had read the page perfectly, because it emitted
  // "Room214" where the fixture says "Room 214" — spacing is a formatting
  // complaint, and this rule is about whether the pixels were read at all.
  // Conflating the two is how a harness bug gets reported as a model verdict.
  const flat = suggestion.toLowerCase().replace(/\s+/g, '');
  for (const required of fixture.mustMention ?? []) {
    if (!flat.includes(required.toLowerCase().replace(/\s+/g, ''))) {
      add('unread-content', `did not reproduce ${JSON.stringify(required)}, which is rendered in the image`);
    }
  }

  return { fixtureId: fixture.id, suggestion, violations, passed: violations.length === 0 };
}

/** Roll per-fixture results into a candidate verdict. The floor is all-or-nothing. */
export function summarise(results: readonly FloorResult[]): {
  passed: boolean;
  failedFixtures: string[];
  ruleCounts: Record<string, number>;
} {
  const failedFixtures = results.filter((r) => !r.passed).map((r) => r.fixtureId);
  const ruleCounts: Record<string, number> = {};
  for (const r of results) {
    for (const v of r.violations) ruleCounts[v.rule] = (ruleCounts[v.rule] ?? 0) + 1;
  }
  return { passed: failedFixtures.length === 0, failedFixtures, ruleCounts };
}
