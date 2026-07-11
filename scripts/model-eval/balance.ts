/**
 * Balance the labelled corpus to 50/50 pass/fail per task.
 *
 * WHY THIS IS NOT OPTIONAL: real Canvas content is overwhelmingly "pass" on any
 * single dimension (heading 103:9, contrast 284:30). Scored on that raw
 * distribution, a model that answers "pass" to everything scores 92% on heading
 * — and PASSES remedy's 0.90 gate. The metric would certify the exact
 * always-pass collapse the eval exists to catch.
 *
 * Balancing pins the chance baseline at 50%, so status accuracy measures
 * discrimination rather than the prior. All failures are kept (they are scarce
 * and precious); passes are down-sampled deterministically.
 *
 *   npx tsx scripts/model-eval/balance.ts --in .frugal-fable/eval-corpus/labeled.json \
 *                                         --out .frugal-fable/eval-corpus/balanced.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { TASK_KEYS, type Fixture, type TaskKey } from './types.ts';

const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};

/** Gold → pass/fail, using each task's own gold shape (mirrors score.ts's
 *  `normalizedStatus`, which is what the eval will actually apply). */
export function goldStatus(f: Fixture): 'pass' | 'fail' {
  const g = f.gold as Record<string, unknown>;
  if (f.task === 'alt') {
    const figs = (g.figures ?? []) as { status?: string }[];
    return figs.some((x) => x.status === 'fail') ? 'fail' : 'pass';
  }
  if (f.task === 'contrast') return ((g.issues ?? []) as unknown[]).length ? 'fail' : 'pass';
  return g.status === 'fail' ? 'fail' : 'pass';
}

/** Deterministic (no Math.random): stable string hash → stable ordering. */
const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

async function main(): Promise<number> {
  const fixtures = JSON.parse(await readFile(arg('in', '.frugal-fable/eval-corpus/labeled.json'), 'utf8')) as Fixture[];
  const cap = Number(arg('cap', '30')); // max fixtures per class, per task

  const out: Fixture[] = [];
  for (const task of TASK_KEYS) {
    const rows = fixtures.filter((f) => f.task === task);
    const fails = rows.filter((f) => goldStatus(f) === 'fail');
    const passes = rows.filter((f) => goldStatus(f) === 'pass').sort((a, b) => hash(a.id) - hash(b.id));
    const n = Math.min(fails.length, passes.length, cap);
    // Keep failures first (scarce), then an equal number of passes.
    const picked = [...fails.slice(0, Math.min(fails.length, cap)).slice(0, n), ...passes.slice(0, n)];
    out.push(...picked);
    const dropped = rows.length - picked.length;
    console.log(
      `${task.padEnd(9)} kept ${String(picked.length).padStart(3)} (${n} fail / ${n} pass)` +
        `  — dropped ${dropped} (had ${fails.length} fail / ${passes.length} pass)`,
    );
    if (fails.length < 5) {
      console.log(`  ⚠ only ${fails.length} real failures exist for '${task}' — treat its numbers as indicative only.`);
    }
  }

  const outFile = arg('out', '.frugal-fable/eval-corpus/balanced.json');
  await writeFile(outFile, JSON.stringify(out, null, 2));
  console.log(`\nbalanced corpus: ${out.length} fixtures → ${outFile}`);
  console.log('chance baseline is now 50% per task: an always-pass model scores 0.50, not 0.92.');
  return 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
