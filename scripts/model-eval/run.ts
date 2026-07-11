/**
 * Three-arm model eval — CLI entry point.
 *
 *   npx tsx scripts/model-eval/run.ts                          # all tasks, all arms
 *   npx tsx scripts/model-eval/run.ts --tasks contrast         # one task
 *   npx tsx scripts/model-eval/run.ts --arms generalist        # one arm
 *   npx tsx scripts/model-eval/run.ts --out /tmp/eval-run-1    # pick artifact dir
 *
 * Requires a running local Ollama with: gemma4:e2b, minicpm-v4.6, and the
 * remedy-*-v1 adapter models. Fully offline — no cloud calls.
 *
 * What this answers: on Canvas HTML, can each model be trusted with the calls
 * canvas-agent actually delegates to an LLM? Scored against remedy's own
 * promotion gates so the numbers are comparable to its PDF-domain results.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { TASK_KEYS, type ArmKind, type Fixture, type TaskKey, type Prediction, type RowScore, type TaskMetrics } from './types.ts';
import { fixturesFor } from './corpus.ts';
import { renderFixtures } from './render.ts';
import { extractStructures } from './extract.ts';
import { predict, armLabel } from './arms.ts';
import { parseJsonish, scoreOne, summarize } from './score.ts';

const ARMS: ArmKind[] = ['generalist', 'base', 'adapter'];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const pct = (n: number | null): string => (n === null ? '  n/a' : `${(n * 100).toFixed(0).padStart(4)}%`);

async function main(): Promise<number> {
  const tasksArg = arg('tasks', 'all');
  const armsArg = arg('arms', ARMS.join(','));
  const outDir = arg('out', '.frugal-fable/eval-runs/latest');

  const tasks: TaskKey[] = tasksArg === 'all' ? [...TASK_KEYS] : (tasksArg.split(',') as TaskKey[]);
  const arms = armsArg.split(',') as ArmKind[];

  // Default corpus is the synthetic one in corpus.ts. `--fixtures <file>` runs
  // against an imported real-Canvas corpus (see import-corpus.ts), which is the
  // only kind of result worth promoting on.
  const fixturesFile = arg('fixtures', '');
  const source = fixturesFile
    ? (JSON.parse(await readFile(fixturesFile, 'utf8')) as Fixture[])
    : fixturesFor('all');
  const fixtures = source.filter((f) => tasks.includes(f.task));
  if (!fixtures.length) throw new Error(`no fixtures for tasks: ${tasks.join(',')}`);

  await mkdir(outDir, { recursive: true });
  console.log(
    `corpus: ${fixtures.length} fixtures (${fixturesFile || 'synthetic'}) | tasks: ${tasks.join(',')} | arms: ${arms.join(',')}`,
  );

  console.log('rendering fixtures…');
  const rendered = await renderFixtures(fixtures, `${outDir}/renders`);
  console.log('extracting DOM structure…');
  const structures = await extractStructures(fixtures);

  const predictions: Prediction[] = [];
  for (const arm of arms) {
    for (const f of rendered) {
      const structure = structures.get(f.id);
      if (!structure) throw new Error(`no structure extracted for ${f.id}`);
      const p = await predict(arm, f, structure);
      predictions.push(p);
      const status = p.error ? `ERROR ${p.error.slice(0, 40)}` : `${(p.latencyMs / 1000).toFixed(1)}s`;
      console.log(`  ${arm.padEnd(10)} ${f.task.padEnd(8)} ${f.id.padEnd(32)} ${status}`);
    }
  }

  // Score: parse the raw text exactly as remedy does, then score against gold.
  const goldById = new Map(fixtures.map((f) => [f.id, f.gold]));
  const metrics: TaskMetrics[] = [];
  for (const arm of arms) {
    for (const task of tasks) {
      const rows: RowScore[] = [];
      const latencies: number[] = [];
      for (const p of predictions.filter((x) => x.arm === armLabel(arm, task) && x.task === task)) {
        p.parsed = parseJsonish(p.raw);
        rows.push(scoreOne(task, goldById.get(p.fixtureId), p.parsed, p.fixtureId));
        latencies.push(p.latencyMs);
      }
      if (rows.length) metrics.push(summarize(task, armLabel(arm, task), rows, latencies));
    }
  }

  // Report.
  console.log(`\n${'task'.padEnd(9)}${'arm'.padEnd(30)}${'  n'}${'  JSON'}${' status'}${'  passFP'}${'  extra'}${'   p50'}`);
  console.log('-'.repeat(95));
  for (const m of metrics) {
    const extra =
      m.task === 'contrast' ? `near ${pct(m.nearThresholdStatusAccuracy)}`
      : m.task === 'heading' ? `exact ${pct(m.exactCorrectionAccuracy)}`
      : '';
    const gatesPassed = m.gates.every((g) => g.passed);
    console.log(
      `${m.task.padEnd(9)}${m.arm.padEnd(30)}${String(m.n).padStart(3)}` +
        `${pct(m.validJsonRate)}${pct(m.statusAccuracy)}${pct(m.passFalsePositiveRate)}` +
        `  ${extra.padEnd(12)}${`${(m.medianLatencyMs / 1000).toFixed(1)}s`.padStart(6)}` +
        `  ${gatesPassed ? 'GATES PASS' : 'gates fail'}`,
    );
  }

  console.log('\nfailed gates:');
  const failed = metrics.flatMap((m) => m.gates.filter((g) => !g.passed).map((g) => ({ m, g })));
  if (!failed.length) console.log('  (none)');
  for (const { m, g } of failed) {
    console.log(`  ${m.task}/${m.arm}: ${g.name} — expected ${g.expected}, observed ${g.observed ?? 'n/a'}`);
  }

  await writeFile(`${outDir}/metrics.json`, JSON.stringify(metrics, null, 2));
  await writeFile(`${outDir}/predictions.jsonl`, predictions.map((p) => JSON.stringify(p)).join('\n'));
  console.log(`\nartifacts: ${outDir}/{metrics.json,predictions.jsonl,renders/}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
