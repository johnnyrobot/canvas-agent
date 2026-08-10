/**
 * The reduced alt-suggestion gate — run it before shipping a vision default.
 *
 *   npx tsx scripts/alt-gate/run.ts                    # shipped default + control
 *   npx tsx scripts/alt-gate/run.ts --candidate <tag>  # try another tag
 *   npx tsx scripts/alt-gate/run.ts --out <dir>        # artifacts (default .frugal-fable/alt-gate)
 *
 * Needs a reachable local Ollama with the candidate pulled. Everything else is
 * offline: fixtures render through the repo's own Chromium path and the model is
 * driven through the app's own `describeImage`, so a pass means the REAL path
 * works — not that a bespoke request shaped for the harness did.
 *
 * WHAT A PASS MEANS, exactly: the candidate produced no catastrophic alt text on
 * ten rendered images. It does NOT mean the alt text is good, and it does not
 * rank this candidate against any other — that is the adjudicated gate of #42.
 * The verdict printed at the end says so, deliberately, because this run exists
 * to be quoted in a release decision.
 *
 * THE CONTROL ARM IS NOT OPTIONAL. A text-only model runs alongside the
 * candidate and must fail. A gate that cannot demonstrate it detects an
 * incapable model proves nothing when it goes green — and this repo has shipped
 * a green suite over a broken path before.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createOllamaSidecar } from '../../src/llm/index.js';
import { runtimeLlmEnv, RUNTIME_DEFAULT_MODEL, RUNTIME_DEFAULT_VISION_MODEL } from '../../src/runtime/index.js';
import { renderHtmlToPng } from '../model-eval/render.js';
import { ALT_FIXTURES, type AltFixture } from './fixtures.js';
import { checkFloor, summarise, MAX_ALT_CHARS, type FloorResult } from './floor.js';

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const OUT = arg('--out') ?? '.frugal-fable/alt-gate';
const CANDIDATE = arg('--candidate') ?? RUNTIME_DEFAULT_VISION_MODEL;

/**
 * The instruction the candidate is judged on.
 *
 * Deliberately states the rules the floor enforces. Withholding them would
 * measure whether the model guesses our house style, when the question is
 * whether it can describe the picture at all — and a model that follows a clear
 * instruction is the one we want anyway.
 */
const altPrompt = (fixture: AltFixture): string =>
  [
    'Write a text alternative (alt text) for this image, for a screen-reader user.',
    '',
    `Where the image appears: ${fixture.context}`,
    '',
    'Rules:',
    `- One sentence or two. Never more than ${MAX_ALT_CHARS} characters.`,
    '- Do NOT begin with "Image of", "Picture of", "Screenshot of" or similar.',
    '- If the image contains text, reproduce the important text exactly.',
    '- State only what the image actually shows. Never guess a number or a name.',
    '- If the image is purely decorative, reply with nothing at all.',
    '',
    'Reply with the alt text only — no preamble, no quotes, no explanation.',
  ].join('\n');

interface ArmResult {
  arm: string;
  tag: string;
  results: FloorResult[];
  errors: Array<{ fixtureId: string; error: string }>;
}

async function runArm(arm: string, tag: string, rendered: Array<AltFixture & { png: string }>): Promise<ArmResult> {
  const sidecar = createOllamaSidecar({ env: runtimeLlmEnv({ ...process.env, MODEL_VISION: tag }) });
  const results: FloorResult[] = [];
  const errors: Array<{ fixtureId: string; error: string }> = [];

  for (const fixture of rendered) {
    const { readFile } = await import('node:fs/promises');
    const image = (await readFile(fixture.png)).toString('base64');
    try {
      const out = await sidecar.describeImage({ image, prompt: altPrompt(fixture) });
      results.push(checkFloor(fixture, out.content));
    } catch (err) {
      // A transport failure is recorded as a fixture-level failure, never thrown:
      // the text-only control arm fails exactly this way (`/api/chat returned
      // 400`), and that IS its expected result rather than a crashed run.
      const message = (err as Error).message;
      errors.push({ fixtureId: fixture.id, error: message });
      results.push({
        fixtureId: fixture.id,
        suggestion: '',
        violations: [{ rule: 'model-error', detail: message }],
        passed: false,
      });
    }
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return { arm, tag, results, errors };
}

async function main(): Promise<void> {
  await mkdir(path.join(OUT, 'renders'), { recursive: true });

  console.log(`Rendering ${ALT_FIXTURES.length} fixtures…`);
  const rendered: Array<AltFixture & { png: string }> = [];
  for (const fixture of ALT_FIXTURES) {
    const png = await renderHtmlToPng(fixture.html, path.join(OUT, 'renders', `${fixture.id}.png`));
    rendered.push({ ...fixture, png });
  }

  console.log(`\ncandidate: ${CANDIDATE}`);
  const candidate = await runArm('candidate', CANDIDATE, rendered);
  console.log(`control (must FAIL): ${RUNTIME_DEFAULT_MODEL}`);
  const control = await runArm('control', RUNTIME_DEFAULT_MODEL, rendered);

  const candidateSummary = summarise(candidate.results);
  const controlSummary = summarise(control.results);

  for (const [label, arm, sum] of [
    ['CANDIDATE', candidate, candidateSummary],
    ['CONTROL  ', control, controlSummary],
  ] as const) {
    console.log(`\n${label} ${arm.tag}`);
    console.log(`  floor: ${sum.passed ? 'PASS' : 'FAIL'}   failing fixtures: ${sum.failedFixtures.join(', ') || 'none'}`);
    if (Object.keys(sum.ruleCounts).length > 0) console.log(`  violations: ${JSON.stringify(sum.ruleCounts)}`);
    for (const r of arm.results) {
      const mark = r.passed ? 'ok  ' : 'FAIL';
      console.log(`  ${mark} ${r.fixtureId.padEnd(22)} ${JSON.stringify(r.suggestion.slice(0, 90))}`);
      for (const v of r.violations) console.log(`         ↳ ${v.rule}: ${v.detail}`);
    }
  }

  await writeFile(
    path.join(OUT, 'results.json'),
    JSON.stringify({ candidate, control, candidateSummary, controlSummary }, null, 2),
  );

  // The control's failure is a precondition for reading the candidate's result
  // at all. Reporting "candidate passed" from a run where the harness also
  // passed a model that cannot see would be the vacuous-green failure.
  const controlBehaved = !controlSummary.passed;
  console.log('\n────────────────────────────────────────────');
  if (!controlBehaved) {
    console.log('VERDICT: VOID — the text-only control PASSED the floor.');
    console.log('The harness cannot detect an incapable model, so the candidate result means nothing.');
    process.exitCode = 2;
    return;
  }
  if (!candidateSummary.passed) {
    console.log(`VERDICT: FAIL — ${CANDIDATE} produced harmful alt text on: ${candidateSummary.failedFixtures.join(', ')}`);
    console.log('Do not ship this tag with suggestion enabled. Options: a different candidate, or');
    console.log('LLM_VISION_ENABLED=false (detection still runs, suggestion honestly reported off).');
    process.exitCode = 1;
    return;
  }
  console.log(`VERDICT: FLOOR PASSED — ${CANDIDATE} produced no catastrophic alt text on ${ALT_FIXTURES.length} rendered images,`);
  console.log('and the text-only control failed as required.');
  console.log('This does NOT rank this tag against alternatives, and does NOT say its alt text is good.');
  console.log('Every image here is RENDERED, not photographed — a real scan is a harder read (#42).');
  console.log(`Artifacts: ${OUT}/results.json, ${OUT}/renders/`);
}

await main();
