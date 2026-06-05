/**
 * Brand-kit persistence on the `Database` port (PRD product layer: brand kits).
 *
 * A brand kit is a saved two-colour palette (+ optional heading/body/mono
 * fonts) the theme engine resolves into accessible color assignments. The
 * three font slots are stored as three nullable columns and mapped back into
 * the contract's optional `fonts` object (omitted entirely when all are null).
 *
 * SECURITY: every value is passed as a *bound* parameter — never concatenated
 * into the SQL string.
 */
import { randomUUID } from 'node:crypto';
import type { BrandKit, Database } from '../contracts/index.js';

export interface BrandKitStore {
  /** All saved brand kits, newest first. */
  listBrandKits(): Promise<BrandKit[]>;
  /** Persist a new kit, assigning its `id` + `createdAt`. */
  saveBrandKit(kit: Omit<BrandKit, 'id' | 'createdAt'>): Promise<BrandKit>;
  /** Delete a kit by id. */
  deleteBrandKit(id: string): Promise<void>;
}

/** Shape of a `brand_kits` row. */
interface BrandKitRow {
  id: string;
  name: string;
  primary_color: string;
  secondary_color: string;
  font_heading: string | null;
  font_body: string | null;
  font_mono: string | null;
  created_at: string;
}

const BRAND_KIT_COLUMNS =
  'id, name, primary_color, secondary_color, font_heading, font_body, font_mono, created_at';

/** Map a DB row → the contract `BrandKit`, omitting `fonts` when all null. */
function toBrandKit(row: BrandKitRow): BrandKit {
  const fonts: { heading?: string; body?: string; mono?: string } = {};
  if (row.font_heading !== null) fonts.heading = row.font_heading;
  if (row.font_body !== null) fonts.body = row.font_body;
  if (row.font_mono !== null) fonts.mono = row.font_mono;

  const kit: BrandKit = {
    id: row.id,
    name: row.name,
    palette: { primary: row.primary_color, secondary: row.secondary_color },
    createdAt: row.created_at,
  };
  if (Object.keys(fonts).length > 0) kit.fonts = fonts;
  return kit;
}

export function createBrandKitStore(db: Database): BrandKitStore {
  return {
    async listBrandKits(): Promise<BrandKit[]> {
      const rows = await db.all<BrandKitRow>(
        `SELECT ${BRAND_KIT_COLUMNS} FROM brand_kits
         ORDER BY created_at DESC, rowid DESC`,
      );
      return rows.map(toBrandKit);
    },

    async saveBrandKit(kit: Omit<BrandKit, 'id' | 'createdAt'>): Promise<BrandKit> {
      const row: BrandKitRow = {
        id: randomUUID(),
        name: kit.name,
        primary_color: kit.palette.primary,
        secondary_color: kit.palette.secondary,
        font_heading: kit.fonts?.heading ?? null,
        font_body: kit.fonts?.body ?? null,
        font_mono: kit.fonts?.mono ?? null,
        created_at: new Date().toISOString(),
      };
      await db.run(
        `INSERT INTO brand_kits (${BRAND_KIT_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.name,
          row.primary_color,
          row.secondary_color,
          row.font_heading,
          row.font_body,
          row.font_mono,
          row.created_at,
        ],
      );
      return toBrandKit(row);
    },

    async deleteBrandKit(id: string): Promise<void> {
      await db.run(`DELETE FROM brand_kits WHERE id = ?`, [id]);
    },
  };
}
