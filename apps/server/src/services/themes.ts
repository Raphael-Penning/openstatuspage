/**
 * Themes of the public pages (docs/themes.md).
 *
 * Three sources, by precedence when ids collide: the built-in themes
 * (packages/shared theme-builtins.ts), the themes folder (THEMES_DIR, read
 * once, `<id>.json` plus an optional `<id>.css`; invalid files are logged and
 * skipped) and the themes uploaded in the management UI (table `themes`).
 * The active theme's id is the one row of `active_theme`.
 *
 * The public pages load the active theme as one or two same-origin
 * stylesheets, `/theme/<hash>.css` (routes/themes.ts): the tokens
 * (themeTokensCss, with the accent override of the page settings) and the
 * extra CSS. The hash is part of the URL, so they are cached as immutable and
 * a change of the theme is a new URL. Stylesheets of recently rendered pages
 * stay available for a while (a page answered from the render cache still
 * finds its stylesheet). Preview stylesheets (?theme=<id> for signed-in
 * admins) are only served to signed-in admins.
 *
 * On a public instance (restricted PostgreSQL role) only `active_theme` and
 * the active row of `themes` are readable (views of 0017_themes); list() and
 * the other management functions are for the admin side.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  BUILTIN_THEMES,
  checkExtraCss,
  cssColorToHex,
  DEFAULT_THEME_ID,
  THEME_CSS_MAX_BYTES,
  THEME_CSS_PREFIX,
  THEME_JSON_MAX_BYTES,
  themeContrastFailures,
  ThemeFile,
  themeTokensCss,
  type PublicThemeInfo,
  type ThemeSource,
} from '@openstatuspage/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import { getSettings } from './settings.js';

/** A theme of any source. */
export interface ThemeEntry {
  id: string;
  source: ThemeSource;
  theme: ThemeFile;
  /** Extra CSS (already checked); null: none. */
  css: string | null;
  /** Last change (database themes: updated_at; folder themes: file time). */
  updatedAt: string | null;
}

/** The active theme with what the pages need. */
export interface ActiveTheme {
  entry: ThemeEntry;
  /** The accent override of the page settings (null: the theme's accent). */
  accentOverride: string | null;
  /** The accent in effect (light mode, #rrggbb): theme-color, mails, the admin branding. */
  accent: string;
  /** Stylesheet URLs, tokens first. */
  stylesheets: string[];
  contrastAccepted: boolean;
  /** Failed AA checks (with the accent override) that no admin confirmed. */
  unconfirmedContrastFailures: number;
}

interface Stylesheet {
  css: string;
  /** Only for signed-in admins (a preview of a theme that is not active). */
  preview: boolean;
}

/** Most theme files a folder may hold (more are skipped). */
const MAX_FOLDER_FILES = 200;
/** How long the active theme is reused before it is read again (ms). */
const ACTIVE_TTL_MS = 5_000;
/** A stylesheet miss reads the active theme again if it is older than this (ms). */
const MISS_REFRESH_MS = 500;
/** Stylesheets kept besides the active ones (recently rendered pages, previews). */
const MAX_STYLESHEETS = 32;
/** Hex digits of the content hash in a stylesheet URL. */
const HASH_LENGTH = 20;

const FILE_PATTERN = new RegExp(`^([0-9a-f]{${HASH_LENGTH}})\\.css$`);

/** The themes folder: THEMES_DIR, else `themes` next to the SQLite database, else ./themes. */
export function themesDir(config: Pick<Config, 'THEMES_DIR' | 'database'>): string | null {
  if (config.THEMES_DIR) return resolve(config.THEMES_DIR);
  if (config.database.dialect === 'sqlite') {
    if (config.database.filename === ':memory:') return null;
    return resolve(dirname(config.database.filename), 'themes');
  }
  return resolve('themes');
}

/** Problems of a theme file as `path: message` lines (logged, answered by the API). */
export function themeFileIssues(value: unknown): { theme: ThemeFile } | { issues: { path: (string | number)[]; message: string }[] } {
  const parsed = ThemeFile.safeParse(value);
  if (parsed.success) return { theme: parsed.data };
  return { issues: parsed.error.issues.map((i) => ({ path: i.path as (string | number)[], message: i.message })) };
}

/** Reads the themes folder: valid themes by id; every skipped file is logged with the reason. */
export function loadThemeFolder(dir: string | null, log: Pick<FastifyBaseLogger, 'info' | 'warn'>): Map<string, ThemeEntry> {
  const themes = new Map<string, ThemeEntry>();
  if (!dir) return themes;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log.warn({ dir, code }, 'Cannot read the themes folder; no folder themes');
    return themes;
  }
  const builtin = new Set(BUILTIN_THEMES.map((t) => t.id));
  const files = names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  if (files.length > MAX_FOLDER_FILES) log.warn({ dir, files: files.length }, `Only the first ${MAX_FOLDER_FILES} theme files are read`);
  for (const name of files.slice(0, MAX_FOLDER_FILES)) {
    const file = join(dir, name);
    const skip = (reason: string, details: object = {}) => log.warn({ file, ...details }, `Theme file skipped: ${reason}`);
    try {
      // stat follows symbolic links (a ConfigMap mounts its files as links).
      const info = statSync(file);
      if (!info.isFile()) continue;
      if (info.size > THEME_JSON_MAX_BYTES) {
        skip(`larger than ${THEME_JSON_MAX_BYTES} bytes`);
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        skip('not valid JSON');
        continue;
      }
      const result = themeFileIssues(json);
      if ('issues' in result) {
        skip('not a valid theme', { issues: result.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`) });
        continue;
      }
      const { theme } = result;
      const stem = name.slice(0, -'.json'.length);
      if (theme.id !== stem) {
        skip(`its id "${theme.id}" differs from the file name`);
        continue;
      }
      if (builtin.has(theme.id)) {
        skip('a built-in theme has the same id');
        continue;
      }
      let css: string | null = null;
      const cssFile = join(dir, `${stem}.css`);
      let cssInfo: ReturnType<typeof statSync> | null = null;
      try {
        cssInfo = statSync(cssFile);
      } catch {
        cssInfo = null;
      }
      if (cssInfo?.isFile()) {
        if (cssInfo.size > THEME_CSS_MAX_BYTES) {
          skip(`its extra CSS is larger than ${THEME_CSS_MAX_BYTES} bytes`);
          continue;
        }
        css = readFileSync(cssFile, 'utf8');
        const issues = checkExtraCss(css);
        if (issues.length > 0) {
          skip('its extra CSS is not allowed', { issues: issues.map((i) => i.message) });
          continue;
        }
      }
      const mtime = Math.max(info.mtimeMs, cssInfo?.isFile() ? Number(cssInfo.mtimeMs) : 0);
      themes.set(theme.id, { id: theme.id, source: 'folder', theme, css: css && css.trim() ? css : null, updatedAt: new Date(mtime).toISOString() });
    } catch (err) {
      skip('cannot be read', { code: (err as NodeJS.ErrnoException).code });
    }
  }
  if (themes.size > 0) log.info({ dir, themes: [...themes.keys()] }, 'Themes loaded from the themes folder');
  return themes;
}

const sha = (css: string) => createHash('sha256').update(css).digest('hex').slice(0, HASH_LENGTH);

/** The URL of a stylesheet. */
export const stylesheetUrl = (hash: string) => `${THEME_CSS_PREFIX}${hash}.css`;

export class ThemeService {
  private folder: Map<string, ThemeEntry> | null = null;
  private readonly sheets = new Map<string, Stylesheet>();
  /** Hashes of the active theme's stylesheets: never dropped from `sheets`. */
  private activeHashes = new Set<string>();
  private cached: { at: number; value: Promise<ActiveTheme> } | null = null;
  private missingWarned: string | null = null;
  private contrastWarned: string | null = null;

  constructor(
    private readonly db: DB,
    private readonly dir: string | null,
    private readonly log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>,
  ) {}

  /** The folder themes (read on first use; call on start to log problems early). */
  folderThemes(): Map<string, ThemeEntry> {
    this.folder ??= loadThemeFolder(this.dir, this.log);
    return this.folder;
  }

  /** Every theme: built-in, folder, database (admin side). */
  async list(): Promise<ThemeEntry[]> {
    const taken = new Set<string>();
    const out: ThemeEntry[] = [];
    for (const theme of BUILTIN_THEMES) {
      out.push({ id: theme.id, source: 'builtin', theme, css: null, updatedAt: null });
      taken.add(theme.id);
    }
    for (const entry of this.folderThemes().values()) {
      out.push(entry);
      taken.add(entry.id);
    }
    const rows = await this.db.selectFrom('themes').selectAll().orderBy('name').execute();
    for (const row of rows) {
      if (taken.has(row.id)) continue;
      const entry = this.fromRow(row);
      if (entry) out.push(entry);
    }
    return out;
  }

  /** One uploaded theme by id, also when a built-in or folder theme hides it. */
  async findStored(id: string): Promise<ThemeEntry | null> {
    const row = await this.db.selectFrom('themes').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? this.fromRow(row) : null;
  }

  /** Ids of uploaded themes hidden by a built-in or folder theme with the same id. */
  async shadowedIds(): Promise<string[]> {
    const taken = new Set([...BUILTIN_THEMES.map((t) => t.id), ...this.folderThemes().keys()]);
    const rows = await this.db.selectFrom('themes').select('id').orderBy('id').execute();
    return rows.map((r) => r.id).filter((id) => taken.has(id));
  }

  /** Logs the hidden uploaded themes (on start of an instance with the management API). */
  async logShadowed(): Promise<void> {
    const ids = await this.shadowedIds();
    if (ids.length > 0) {
      this.log.warn(
        { themes: ids },
        'Uploaded themes are hidden by folder themes with the same id; delete them with DELETE /api/admin/themes/<id>?uploadedCopy=true',
      );
    }
  }

  /** One theme by id (built-in before folder before database). */
  async find(id: string): Promise<ThemeEntry | null> {
    const theme = BUILTIN_THEMES.find((t) => t.id === id);
    if (theme) return { id, source: 'builtin', theme, css: null, updatedAt: null };
    const folder = this.folderThemes().get(id);
    if (folder) return folder;
    const row = await this.db.selectFrom('themes').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? this.fromRow(row) : null;
  }

  private fromRow(row: { id: string; definition: string; css: string | null; updated_at: string }): ThemeEntry | null {
    let json: unknown;
    try {
      json = JSON.parse(row.definition);
    } catch {
      json = null;
    }
    const result = themeFileIssues(json);
    if ('issues' in result) {
      this.log.error({ theme: row.id }, 'A stored theme is not valid any more; it is ignored');
      return null;
    }
    return { id: row.id, source: 'database', theme: result.theme, css: row.css, updatedAt: row.updated_at };
  }

  /** The active theme's id and whether its contrast failures were accepted. */
  async selection(): Promise<{ themeId: string; contrastAccepted: boolean }> {
    const row = await this.db.selectFrom('active_theme').select(['theme_id', 'contrast_accepted']).where('slot', '=', 'active').executeTakeFirst();
    return { themeId: row?.theme_id ?? DEFAULT_THEME_ID, contrastAccepted: row?.contrast_accepted === 1 };
  }

  /** The active theme, reused for a few seconds (every page render asks). */
  active(): Promise<ActiveTheme> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < ACTIVE_TTL_MS) return this.cached.value;
    const value = this.resolveActive();
    this.cached = { at: now, value };
    value.catch(() => {
      if (this.cached?.value === value) this.cached = null;
    });
    return value;
  }

  /** Forgets the cached active theme (after a change on this instance). */
  invalidate(): void {
    this.cached = null;
  }

  private async resolveActive(): Promise<ActiveTheme> {
    const [{ themeId, contrastAccepted }, settings] = await Promise.all([this.selection(), getSettings(this.db)]);
    let entry = await this.find(themeId);
    if (!entry) {
      if (this.missingWarned !== themeId) {
        this.log.warn({ theme: themeId }, 'The active theme does not exist (any more); the default theme is shown');
        this.missingWarned = themeId;
      }
      entry = (await this.find(DEFAULT_THEME_ID))!;
    }
    const accentOverride = settings.accentColor ?? null;
    const { stylesheets, hashes } = this.register(entry, accentOverride, false);
    this.activeHashes = new Set(hashes);
    const accepted = contrastAccepted && entry.id === themeId;
    const failures = themeContrastFailures(entry.theme, accentOverride).length;
    const unconfirmed = failures > 0 && !accepted ? failures : 0;
    // A folder file or the accent setting changed after the activation:
    // the admin never confirmed these failures. Warn once per theme and tokens.
    const key = `${entry.id}:${hashes[0]}`;
    if (unconfirmed > 0 && this.contrastWarned !== key) {
      this.log.warn(
        { theme: entry.id, source: entry.source, contrastFailures: unconfirmed },
        'The active theme fails WCAG 2.2 AA and no admin confirmed it; confirm or change it in Settings > Appearance',
      );
    }
    this.contrastWarned = unconfirmed > 0 ? key : null;
    return {
      entry,
      accentOverride,
      accent: accentOverride ?? cssColorToHex(entry.theme.light.accent) ?? '#7c6cf2',
      stylesheets,
      contrastAccepted: accepted,
      unconfirmedContrastFailures: unconfirmed,
    };
  }

  /** The public part: id and stylesheets of the active theme. */
  async publicInfo(): Promise<PublicThemeInfo & { accent: string }> {
    const active = await this.active();
    return { id: active.entry.id, stylesheets: active.stylesheets, accent: active.accent };
  }

  /** Stylesheet URLs of any theme for the preview of a signed-in admin. */
  async previewStylesheets(id: string): Promise<string[] | null> {
    const entry = await this.find(id);
    if (!entry) return null;
    const settings = await getSettings(this.db);
    return this.register(entry, settings.accentColor ?? null, true).stylesheets;
  }

  /** The CSS of the token stylesheet and the extra CSS of a theme. */
  static stylesheetsOf(entry: ThemeEntry, accentOverride: string | null): string[] {
    const sheets = [themeTokensCss(entry.theme, accentOverride)];
    if (entry.css) sheets.push(entry.css);
    return sheets;
  }

  private register(entry: ThemeEntry, accentOverride: string | null, preview: boolean): { stylesheets: string[]; hashes: string[] } {
    const hashes: string[] = [];
    for (const css of ThemeService.stylesheetsOf(entry, accentOverride)) {
      const hash = sha(css);
      hashes.push(hash);
      const known = this.sheets.get(hash);
      // A stylesheet that is also public stays public; most recently used last.
      this.sheets.delete(hash);
      this.sheets.set(hash, { css, preview: preview && (known?.preview ?? true) });
    }
    while (this.sheets.size > MAX_STYLESHEETS + this.activeHashes.size) {
      const oldest = [...this.sheets.keys()].find((h) => !this.activeHashes.has(h) && !hashes.includes(h));
      if (!oldest) break;
      this.sheets.delete(oldest);
    }
    return { stylesheets: hashes.map(stylesheetUrl), hashes };
  }

  /**
   * The stylesheet for a file name (`<hash>.css`), after making sure the
   * active theme's are known. On a miss the active theme is read again (at
   * most every MISS_REFRESH_MS): another replica may have rendered a page
   * with a theme activated a moment ago, before this one's cache expired.
   */
  async stylesheet(file: string): Promise<Stylesheet | null> {
    const m = FILE_PATTERN.exec(file);
    if (!m) return null;
    await this.active();
    const sheet = this.sheets.get(m[1]!);
    if (sheet) return sheet;
    if (this.cached && Date.now() - this.cached.at >= MISS_REFRESH_MS) {
      this.invalidate();
      await this.active();
    }
    return this.sheets.get(m[1]!) ?? null;
  }
}
