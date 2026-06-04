/**
 * Smoke script: start the sidecar, run a streaming chat, a JSON call, and (if an
 * image path is given) an alt-text describe. Requires a local `ollama` binary
 * with the model pulled (`ollama pull gemma4:12b-mlx`).
 *
 *   npm run llm:smoke -- "Explain accessible tables in Canvas in one sentence."
 *   npm run llm:smoke -- "Describe this image" ./diagram.png
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

  const llm = createOllamaSidecar({ logger: consoleLogger });

  // Graceful shutdown: only kills ollama if we spawned it.
  const shutdown = () => void llm.stop().finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await llm.start();

  console.error('\n--- streaming chat ---');
  for await (const chunk of llm.chatStream({ role: 'fast', messages: [{ role: 'user', content: prompt }] })) {
    process.stdout.write(chunk.delta);
  }
  process.stdout.write('\n');

  console.error('\n--- json mode ---');
  const json = await llm.chatJSON({
    role: 'deep',
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
