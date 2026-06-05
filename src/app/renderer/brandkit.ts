/**
 * Brand-kit editor panel (brief §6).
 *
 * Two colour inputs (primary, secondary). On change, `resolveBrandTheme` (instant
 * engine math — no LLM) resolves contrast-safe role swatches; we render the
 * foreground/background pairs, any warnings, and a live template preview in the
 * §4 sandboxed iframe. "Save kit" persists the palette; saved kits list with
 * delete, and clicking one reloads its colours.
 */
import { api, el, errorMessage, setHidden, type El } from './ui.js';
import { previewFrame } from './preview.js';
import type { BrandKit, ResolvedColor, ThemeResult } from '../../contracts/index.js';

export interface BrandKitDeps {
  onError(message: string): void;
}

export interface BrandKitPanel {
  element: El;
  refresh(): Promise<void>;
}

const DEFAULT_PRIMARY = '#0374b5';
const DEFAULT_SECONDARY = '#2d3b45';

export function createBrandKit(deps: BrandKitDeps): BrandKitPanel {
  const primaryInput = el('input', { type: 'color', value: DEFAULT_PRIMARY, 'aria-label': 'Primary colour' });
  const secondaryInput = el('input', { type: 'color', value: DEFAULT_SECONDARY, 'aria-label': 'Secondary colour' });
  primaryInput.value = DEFAULT_PRIMARY;
  secondaryInput.value = DEFAULT_SECONDARY;

  const swatches = el('div', { class: 'brand__swatches' });
  const warnings = el('ul', { class: 'brand__warnings' });
  setHidden(warnings, true);
  const previewWrap = el('div', { class: 'brand__preview' });

  const nameInput = el('input', {
    type: 'text',
    class: 'brand__name',
    placeholder: 'Kit name',
    'aria-label': 'Kit name',
  });
  const saveBtn = el('button', { type: 'button', class: 'brand__save' }, 'Save kit');
  saveBtn.addEventListener('click', () => void save());

  const kitList = el('ul', { class: 'brand__kits' });
  const kitsEmpty = el('p', { class: 'brand__kits-empty' }, 'No saved kits yet.');
  setHidden(kitsEmpty, true);

  const element = el(
    'aside',
    { class: 'panel brand', 'aria-label': 'Brand kit' },
    el('h2', {}, 'Brand kit'),
    el(
      'div',
      { class: 'brand__inputs' },
      el('label', {}, 'Primary', primaryInput),
      el('label', {}, 'Secondary', secondaryInput),
    ),
    el('h3', {}, 'Resolved roles'),
    swatches,
    warnings,
    el('h3', {}, 'Live preview'),
    previewWrap,
    el('div', { class: 'brand__saverow' }, nameInput, saveBtn),
    el('h3', {}, 'Saved kits'),
    kitList,
    kitsEmpty,
  );

  primaryInput.addEventListener('input', () => void resolve());
  secondaryInput.addEventListener('input', () => void resolve());

  function swatchEl(color: ResolvedColor): El {
    const chip = el(
      'div',
      { class: 'brand__swatch' },
      el('span', { class: 'brand__role' }, color.role),
      el('span', { class: 'brand__ratio' }, `${color.contrast.ratio.toFixed(2)} · ${color.contrast.level}`),
    );
    chip.setAttribute('style', `background:${color.background};color:${color.foreground};`);
    return chip;
  }

  function sampleHtml(theme: ThemeResult, primary: string, secondary: string): string {
    const banner = theme.colors[0];
    const accent = theme.colors[1] ?? banner;
    const bannerBg = banner?.background ?? primary;
    const bannerFg = banner?.foreground ?? '#ffffff';
    const btnBg = accent?.background ?? secondary;
    const btnFg = accent?.foreground ?? '#ffffff';
    return [
      `<div style="background:${bannerBg};color:${bannerFg};padding:16px;border-radius:8px;margin-bottom:12px;">`,
      `<h2 style="margin:0;color:${bannerFg};">Module 1 — Welcome</h2>`,
      `<p style="margin:.4em 0 0;color:${bannerFg};">Your brand colours, contrast-checked.</p></div>`,
      '<p>Body copy in Canvas ink stays readable on a white page.</p>',
      `<button style="background:${btnBg};color:${btnFg};">Start module</button>`,
    ].join('');
  }

  async function resolve(): Promise<void> {
    const primary = primaryInput.value;
    const secondary = secondaryInput.value;
    try {
      const theme = await api().resolveBrandTheme(primary, secondary);
      swatches.replaceChildren(...theme.colors.map(swatchEl));
      if (theme.warnings.length > 0) {
        warnings.replaceChildren(...theme.warnings.map((w) => el('li', {}, w)));
        setHidden(warnings, false);
      } else {
        warnings.replaceChildren();
        setHidden(warnings, true);
      }
      previewWrap.replaceChildren(previewFrame(sampleHtml(theme, primary, secondary), 'Brand template preview'));
    } catch (err) {
      deps.onError(errorMessage(err));
    }
  }

  async function save(): Promise<void> {
    try {
      const name = nameInput.value.trim() || 'Untitled kit';
      await api().saveBrandKit({
        name,
        palette: { primary: primaryInput.value, secondary: secondaryInput.value },
      });
      nameInput.value = '';
      await refresh();
    } catch (err) {
      deps.onError(errorMessage(err));
    }
  }

  function renderKits(kits: BrandKit[]): void {
    setHidden(kitsEmpty, kits.length > 0);
    kitList.replaceChildren(
      ...kits.map((kit) => {
        const open = el('button', { type: 'button', class: 'brand__kit' }, kit.name);
        const dot = el('span', { class: 'brand__kit-dot' });
        dot.setAttribute(
          'style',
          `background:linear-gradient(90deg, ${kit.palette.primary} 50%, ${kit.palette.secondary} 50%);`,
        );
        open.append(dot);
        open.addEventListener('click', () => {
          primaryInput.value = kit.palette.primary;
          secondaryInput.value = kit.palette.secondary;
          void resolve();
        });

        const del = el(
          'button',
          { type: 'button', class: 'brand__kit-del', 'aria-label': `Delete ${kit.name}` },
          '×',
        );
        del.addEventListener('click', () => void removeKit(kit.id));

        return el('li', { class: 'brand__kit-row' }, open, del);
      }),
    );
  }

  async function removeKit(id: string): Promise<void> {
    try {
      await api().deleteBrandKit(id);
      await refresh();
    } catch (err) {
      deps.onError(errorMessage(err));
    }
  }

  async function refresh(): Promise<void> {
    try {
      const kits = await api().listBrandKits();
      renderKits(kits);
    } catch (err) {
      deps.onError(errorMessage(err));
    }
  }

  // Initial resolve so the panel shows defaults immediately when opened.
  void resolve();

  return { element, refresh };
}
