/**
 * Smoke script: start the sidecar, run a streaming chat, a JSON call, and (if an
 * image path is given) an alt-text describe. Requires a local `ollama` binary
 * with the model pulled (`ollama pull granite4.1:8b`), and — for the describe
 * path — a vision model in `MODEL_VISION`, which the text model cannot stand in
 * for.
 *
 *   npm run llm:smoke -- "Explain accessible tables in Canvas in one sentence."
 *   MODEL_VISION=qwen3-vl:4b \
 *     npm run llm:smoke -- "Describe this image" ./diagram.png
 */
import { readFile } from 'node:fs/promises';
import { createOllamaSidecar } from './index.js';

const consoleLogger = {
  info: (m: string) => console.error(`[sidecar] ${m}`),
  warn: (m: string) => console.error(`[sidecar:warn] ${m}`),
  error: (m: string) => console.error(`[sidecar:error] ${m}`),
};

async function main(): Promise<void> {
  const prompt = process.argv[2] ?? 'Say hello to a Canvas course designer in one sentence.';
  const imagePath = process.argv[3];

  // This module carries no shipping default (ADR-0007) — the runtime injects one,
  // and a standalone script has no runtime. Say which model you mean.
  if (!process.env.MODEL_TEXT) {
    console.error('MODEL_TEXT is required, e.g. MODEL_TEXT=granite4.1:8b npm run llm:smoke');
    process.exit(1);
  }

  // The describe path needs a model that can actually SEE. Left unset, `vision`
  // falls back to MODEL_TEXT (`config.ts`), and if that tag is text-only the call
  // fails with an opaque `/api/chat returned 400` — so say so up front.
  //
  // A WARNING and not a refusal: pointing both roles at one multimodal tag
  // (`MODEL_TEXT=qwen3-vl:4b`, no MODEL_VISION) is a supported configuration,
  // and this script cannot tell a multimodal text model from a text-only one
  // without asking Ollama. Refusing here would reject a valid setup.
  if (imagePath && !process.env.MODEL_VISION) {
    console.error(
      `[warn] MODEL_VISION is unset, so the describe path will use MODEL_TEXT (${process.env.MODEL_TEXT}).\n` +
        '[warn] That works only if it is multimodal (`ollama show <tag>` must list `vision`);\n' +
        '[warn] a text-only tag fails with `/api/chat returned 400`. Set MODEL_VISION to be sure, e.g.\n' +
        '[warn]   MODEL_VISION=qwen3-vl:4b',
    );
  }

  const llm = createOllamaSidecar({ logger: consoleLogger });

  // Graceful shutdown: only kills ollama if we spawned it.
  const shutdown = () => void llm.stop().finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await llm.start();

  console.error('\n--- streaming chat ---');
  for await (const chunk of llm.chatStream({ role: 'text', messages: [{ role: 'user', content: prompt }] })) {
    process.stdout.write(chunk.delta);
  }
  process.stdout.write('\n');

  console.error('\n--- json mode ---');
  const json = await llm.chatJSON({
    role: 'text',
    messages: [{ role: 'user', content: 'Return {"ok": true, "rubric": "D4"} as JSON.' }],
  });
  console.log(json);

  if (imagePath) {
    console.error('\n--- describe image (alt text) ---');
    const base64 = (await readFile(imagePath)).toString('base64');
    const alt = await llm.describeImage({
      image: base64,
      prompt: 'Write concise alt text (<=80 characters) for this image. Return only the alt text.',
    });
    console.log(alt.content);
  }

  await llm.stop();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
