/**
 * HTML → DOM structure (the element list + figure list the prompts interpolate).
 *
 * This is the HTML analogue of remedy's PDF structure-tree dump. Tags are
 * rendered `/H1`-style and figures carry laid-out bboxes, so the adapters see
 * the token shape they were trained on.
 *
 * Browser-side code is a string expression, cast on return — the same
 * convention `src/engine/render/playwright-runner.ts` uses (see
 * `EXTRACT_TEXT_RUNS`), which keeps DOM lib types out of the Node build.
 *
 * Separate pass from render.ts by design: rendering produces pixels, this
 * produces structure. Both are cheap over an offline corpus.
 */
import { chromium, type Browser } from 'playwright';
import type { Fixture } from './types.ts';
import type { PageStructure } from './contracts.ts';

/** Walks the structural elements the tasks reason about. Images become
 *  `figures` (with laid-out bboxes and a null-vs-"" alt distinction — alt=""
 *  is an intentional decorative marker, a missing attribute is a defect);
 *  everything else becomes a 1-based `/TAG` element list. */
const EXTRACT_STRUCTURE = `(() => {
  const SEL = 'h1,h2,h3,h4,h5,h6,p,table,thead,tbody,tr,th,td,li,figure,img,a';
  const elements = [];
  const figures = [];
  let i = 1, figIndex = 1;
  for (const el of Array.from(document.querySelectorAll(SEL))) {
    if (el.tagName.toLowerCase() === 'img') {
      const r = el.getBoundingClientRect();
      figures.push({
        index: figIndex++,
        alt: el.hasAttribute('alt') ? el.getAttribute('alt') : null,
        bbox: (r.width && r.height)
          ? [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]
          : null,
      });
      continue;
    }
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    elements.push({
      index: i++,
      tag: '/' + el.tagName.toUpperCase(),
      // Container tags (table/tr) would otherwise dump every descendant's text.
      text: text.length > 120 ? text.slice(0, 117) + '...' : text,
    });
  }
  return { elements, figures };
})()`;

async function structureOf(browser: Browser, html: string): Promise<PageStructure> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    return (await page.evaluate(EXTRACT_STRUCTURE)) as PageStructure;
  } finally {
    await page.close();
  }
}

/** Extract structure for a whole corpus in one browser. */
export async function extractStructures(fixtures: Fixture[]): Promise<Map<string, PageStructure>> {
  const browser = await chromium.launch();
  try {
    const out = new Map<string, PageStructure>();
    for (const f of fixtures) out.set(f.id, await structureOf(browser, f.html));
    return out;
  } finally {
    await browser.close();
  }
}
