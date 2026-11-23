# Themes

A theme changes the look of the public status page: colours in light and dark
mode, corner radius, font stacks and spacing, plus optional extra CSS. Themes
are chosen in the management UI under **Administration → Appearance**. The
management UI itself keeps its own look (only the accent follows the theme).

## Quickstart

1. Copy [contrib/themes/starter.json](../contrib/themes/starter.json) (and
   optionally `starter.css`), or open **Administration → Appearance** and click
   the copy icon (**Customize a copy of …**) on a built-in or folder theme you
   like. For an uploaded theme, download its JSON, change the `id` and import it.
2. Change the `id` and `name`. The `id` (lower-case letters, digits, hyphens)
   cannot be changed later.
3. Set the colours of `light` and `dark`. Keep the same tokens in both.
4. Check the contrast in the editor (WCAG 2.2 AA: 4.5:1 for text, 3:1 for
   controls and status colours) and fix every failing pair.
5. Look at the result: **Preview** in the list, and **Preview the public page**
   (`/?theme=<id>`, visible to signed-in admins only).
6. Install it: **Import theme** in the admin, or put `<id>.json` (and
   `<id>.css`) into the themes folder and restart.
7. Click **Activate**, and download the theme as JSON to keep a copy.

The step-by-step guide, with troubleshooting, is
[Creating a theme](guide/en/15-creating-a-theme.md) (German:
[Ein Theme erstellen](guide/de/15-creating-a-theme.md)). The starter template is
described in [contrib/themes](../contrib/themes/README.md).

Contents:

- [Where themes come from](#where-themes-come-from)
- [Theme file format](#theme-file-format)
- [Token reference](#token-reference)
- [Contrast (WCAG 2.2 AA)](#contrast-wcag-22-aa)
- [Extra CSS](#extra-css)
- [Accent colour override](#accent-colour-override)
- [How the public pages load a theme](#how-the-public-pages-load-a-theme)
- [Preview](#preview)
- [Themes folder: Compose, Helm, bare metal](#themes-folder-compose-helm-bare-metal)
- [Management API](#management-api)

## Where themes come from

| Source | Badge in the admin | Editable | Notes |
| --- | --- | --- | --- |
| Built-in | Built-in | no (copy it) | `default` (the original look), `slate`, `forest`, `high-contrast`; all pass WCAG 2.2 AA in light and dark ([packages/shared/src/theme-builtins.ts](../packages/shared/src/theme-builtins.ts)). |
| Themes folder | Themes folder | no (copy it) | `THEMES_DIR`, read once on start. `<id>.json` and an optional `<id>.css` with the same name. Invalid files are logged (`Theme file skipped: ...`) and skipped. |
| Upload | Uploaded | yes | **Import theme** in the admin (a `.json` and optionally a `.css`), or **Customize a copy** of any theme. Stored in the database (table `themes`, migration 0017). |

Ids are unique across the sources. When ids collide, a built-in theme wins over
a folder theme (the folder file is skipped and logged), and a folder theme wins
over an uploaded one (the upload of a taken id is refused). An uploaded theme
whose id a folder file takes later is hidden: instances with the management
API log its id on start (`Uploaded themes are hidden by folder themes ...`),
and `DELETE /api/admin/themes/<id>?uploadedCopy=true` removes it. Every theme can be
downloaded as JSON (and its extra CSS as `.css`), also built-in and folder
themes. If the active theme disappears (a folder file removed), the public
pages fall back to `default` and the server logs a warning.

An example theme for the folder is in
[contrib/themes/](../contrib/themes/) (`ocean.json`, `ocean.css`).

## Theme file format

A JSON object; unknown keys are rejected at every level.

```json
{
  "id": "ocean",
  "name": "Ocean",
  "version": 1,
  "author": "Example Ltd.",
  "description": "Blue-green surfaces and a teal accent.",
  "light": {
    "background": "#f5f8fa",
    "surface": "#ffffff",
    "surfaceAlt": "#eaf0f4",
    "border": "#d9e2e8",
    "borderStrong": "#6b7c88",
    "text": "#102a37",
    "muted": "#4a5d69",
    "accent": "#0e7490",
    "status": {
      "operational": "#15803d",
      "maintenance": "#2563eb",
      "degraded": "#a16207",
      "partialOutage": "#c2410c",
      "majorOutage": "#dc2626",
      "noData": "#6b7c88"
    }
  },
  "dark": { "...": "the same keys" },
  "radius": "0.625rem",
  "fonts": { "sans": "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  "density": "comfortable"
}
```

| Key | Required | Value |
| --- | --- | --- |
| `id` | yes | 1–48 characters: lower-case letters, digits, hyphens (not at the start or end). Folder themes: must equal the file name (`ocean.json`). |
| `name` | yes | 1–80 characters, shown in the admin. |
| `version` | yes | Schema version, `1`. |
| `author`, `description` | no | Up to 120 / 500 characters. |
| `light`, `dark` | yes | The colour tokens of each mode, see below. |
| `radius` | no | Base corner radius (`rounded-lg`): `0`, or up to `2rem` / `32px`. The smaller and larger radii scale with it. Default `0.5rem`. |
| `fonts.sans`, `fonts.mono` | no | Font stacks of **installed** fonts only (nothing is downloaded: no web fonts, no CDN): family names separated by commas, ending with a generic family (`sans-serif`, `system-ui`, `monospace`, ...). |
| `density` | no | `compact` (90 % spacing), `comfortable` (default), `spacious` (110 %). |
| `$schema` | no | Ignored (for editors). |

Colours are opaque CSS colours in one of these syntaxes: `#rgb`, `#rrggbb`,
`rgb(r g b)` / `rgb(r, g, b)`, `hsl(h s% l%)`, `oklch(L C H)`. No alpha, no
colour names, no `var()`: the contrast of a translucent colour depends on what
is behind it. `oklch` colours outside sRGB are checked as the sRGB colour they
are clipped to.

Limits: a theme file at most 64 KB, its extra CSS at most 64 KB, at most 50
uploaded themes and 200 files in the themes folder.

## Token reference

Each mode (`light`, `dark`) has these tokens. They become the CSS custom
properties the components use (`apps/web/src/styles.css`).

| Token | CSS property | Used for | Contrast checked |
| --- | --- | --- | --- |
| `background` | `--bg` | Page background | (background) |
| `surface` | `--surface` | Cards, panels, header | (background) |
| `surfaceAlt` | `--surface-2` | Insets, table heads, hover backgrounds | (background) |
| `border` | `--border` | Hairlines between items | decorative, not checked |
| `borderStrong` | `--border-strong` | Boundaries of form fields and controls | 3:1 |
| `text` | `--fg` | Body text | 4.5:1 |
| `muted` | `--muted` | Secondary text | 4.5:1 |
| `accent` | `--accent` | Brand colour; selected states | 3:1 |
| `focus` (optional) | `--focus` | Focus indicator | 3:1 (default: the readable accent) |
| `status.operational`, `.maintenance`, `.degraded`, `.partialOutage`, `.majorOutage` | `--status-*` | Fills of uptime bars, dots, markers | 3:1 |
| `status.noData` | `--status-nodata` | Outline of days without data | 3:1 |
| `statusText.*` (optional) | `--status-*-text` | Status text and icons | 4.5:1 (default: derived from the fills) |

Derived, not part of the file (computed for every surface of the mode):

| CSS property | Derived from |
| --- | --- |
| `--osp-accent-text` | The accent, darkened or lightened until it reaches 4.5:1 on every surface (links, accent text). |
| `--osp-accent-solid`, `--osp-accent-solid-fg` | Solid accent buttons: the accent adjusted for white or dark text at 4.5:1. |
| `--accent-fg` | Text on the accent. |
| `--status-*-text` | Without `statusText`: each fill made readable (4.5:1) on every surface. |
| `--osp-radius`, `--osp-font-sans`, `--osp-font-mono`, `--spacing` | `radius`, `fonts`, `density`. |

Extra CSS should use these properties (`var(--accent)`, `var(--surface)`)
rather than fixed colours, so it works in both modes.

## Contrast (WCAG 2.2 AA)

Every theme is checked against WCAG 2.2 AA (1.4.3 text 4.5:1, 1.4.11 non-text
3:1) in both modes: each text, control and status colour above on each of
`background`, `surface` and `surfaceAlt`, plus the text of solid accent
buttons. The checker is the same in the browser and on the server
([packages/shared/src/themes.ts](../packages/shared/src/themes.ts),
`checkThemeContrast`).

- The admin list shows **Passes AA** or the number of problems; the editor shows
  every failing pair live (`Light: muted on surface 2.4:1 (needs 4.5:1)`).
- A theme that fails is **not activated** by default: the API answers 409
  `contrast_failures` with the failed checks. The admin can confirm explicitly
  (**Activate anyway**, `acceptContrastFailures: true`); this is written to the
  audit log with the number of accepted failures.
- Editing the active theme so that it fails needs the same confirmation.
- The accent colour override of the settings is part of the check.
- The active theme can still end up failing without a confirmation: a folder
  file changed before a restart, or an accent override set in the settings.
  The public pages keep showing it (no silent switch of the theme), but the
  server logs `The active theme fails WCAG 2.2 AA and no admin confirmed it`
  (once per theme and tokens, the number of failures only), the API marks it
  with `contrastUnconfirmed: true`, and **Settings > Appearance** names it
  with a **Review** button. Confirming (activating it again with
  `acceptContrastFailures: true`) clears the flag; so does fixing the theme or
  the accent.

Automated tests render the public pages under every built-in theme in light and
dark with axe-core and check every built-in theme with the contrast checker.

## Extra CSS

A theme may come with extra CSS (`<id>.css`, or the **Extra CSS** field). It is
written by admins, who are trusted, but it is **still filtered**, as defense in
depth and so a copied snippet cannot track visitors:

- at most 64 KB;
- no `@import`;
- `url()` only to `/uploads/...` (images uploaded in the admin) or to a relative
  path on the same site without `..` segments and query strings (the stylesheet
  is served from `/theme/`, so a relative path cannot reach other routes); no
  other host, no `//host`, no `data:`;
- no `expression()`, `javascript:` / `vbscript:`, `behavior`, `-moz-binding`,
  `image-set()` or `src()` (they can load URLs without `url()`);
- no `<` and no `-->` anywhere, also not in comments (nothing that looks like
  HTML, no way to end a `<style>` element);
- no control characters and no unterminated comment.

CSS escapes (`\75rl(`) and comments between letters (`@im/**/port`) are
decoded before the checks. CSS that fails is rejected as a whole, never
rewritten. It is served as its own stylesheet (see below), never inline, so the
Content-Security-Policy of the pages stays unchanged. Extra CSS can still change
anything on the page (hide content, reduce contrast): the contrast check only
covers the tokens, so check the result with the preview.

## Accent colour override

The **Accent color override** in the settings (0.3.x: **Accent color**) replaces
the accent of every theme in light and dark mode; empty means the theme's own
accent. On the upgrade to 0.4.0 an accent equal to the old default (`#7c6cf2`)
is removed, so other themes show their own accent; any other accent is kept as
override, so existing pages look the same. The public settings
(`/api/public/settings`) answer the accent in effect as `accentColor` (used for
`theme-color` and the management UI's buttons). Notification mails use the
override, or the default accent without one.

## How the public pages load a theme

The server turns the active theme into CSS custom properties and serves them as
a same-origin stylesheet whose URL contains a hash of its content:

```html
<link rel="stylesheet" href="/theme/3f1c0a9b7e2d4c5a6b8e.css" data-osp-theme>
<link rel="stylesheet" href="/theme/9a8b7c6d5e4f3a2b1c0d.css" data-osp-theme>   <!-- extra CSS, if any -->
```

- The links are part of the server-rendered `<head>`, after the app's own
  stylesheet: no flash of the default theme, and it works without JavaScript.
- Light and dark follow `prefers-color-scheme` as before; the visitor's theme
  switch (`data-theme`) picks the mode.
- `/theme/<hash>.css` is cached for a year (`immutable`): a change of the theme
  is a new URL. Stylesheets of recently rendered pages stay available, so a page
  served from the render cache still finds its stylesheet.
- Nothing is inline: no `<style>` element in the page (0.3.x put the accent into
  one), no external host, no fonts to download.
- A page rendered in the browser (the server-side rendering fell back) adds the
  same links from the public settings (`theme.stylesheets`).
- Themes are cached for 5 seconds per instance; an activation shows on other
  instances of a split deployment within that time (plus the page cache).

## Preview

- **Preview** in the admin list draws a small mock of the public page with the
  theme's tokens, in light and dark side by side; the editor shows it live.
- **Preview the public page** opens `/?theme=<id>` in a new tab. The server
  honours `?theme=` only for a signed-in **admin** on an instance with the
  admin side (`all`, `admin`): the page is rendered for this request only
  (`Cache-Control: private, no-store`, `noindex`), and its preview stylesheet is
  only served to signed-in admins. Anonymous visitors, editors and the public
  instance of a split deployment ignore the parameter and get the usual page.

## Themes folder: Compose, Helm, bare metal

`THEMES_DIR` defaults to `themes` next to the SQLite database (`/data/themes`
in the Docker image), or `./themes` with PostgreSQL. A missing folder is no
error. The folder is read once on start: restart after a change. In a split
deployment the public and the admin instance must read the same folder (the
admin activates a folder theme by id; a public instance that does not have it
shows the default theme and logs a warning).

### Docker Compose

`compose.yaml` and `compose.split.yaml` set `THEMES_DIR=/themes`. Put the files
into `./themes` next to the Compose file and uncomment the mount
(`- ./themes:/themes:ro`, in the split file for `public` and `admin`), then
`docker compose up -d`.

### Helm

```yaml
themes:
  enabled: true
  files:
    ocean.json: |
      { "id": "ocean", ... }
    ocean.css: |
      header { border-bottom: 3px solid var(--accent); }
  # or: existingConfigMap: example-themes
```

The chart creates a ConfigMap, mounts it read-only at `/themes` and sets
`THEMES_DIR` in the instances that serve pages (not the worker). A change of
`themes.files` restarts the pods. `themes.enabled` without `themes.files` or
`themes.existingConfigMap` fails the rendering of the chart. File names must be
`<id>.json` or `<id>.css`. See the
[chart README](../deploy/helm/openstatuspage/README.md#themes).

### Without containers

The packages and `install.sh` create `/etc/openstatuspage/themes`; the systemd
units set `THEMES_DIR` to it. The public instance of the split deployment runs
as its own user, which cannot enter `/etc/openstatuspage`: its unit binds the
folder read-only to `/opt/openstatuspage/themes`. Files must be readable by
everyone:

```sh
install -m 0644 ocean.json ocean.css /etc/openstatuspage/themes/
systemctl restart openstatuspage            # or: systemctl restart openstatuspage-split.target
```

## Management API

Admin role only (session or API token). See [api.md](api.md#themes).

| Method and path | |
| --- | --- |
| `GET /api/admin/themes` | Every theme: `source` (`builtin`, `folder`, `database`), `readOnly`, `active`, `definition`, `cssBytes`, `contrastFailures`, `contrastUnconfirmed`. |
| `POST /api/admin/themes` | Import: `definition` (the theme file) and optional `css`. 409 for a taken id. |
| `GET /api/admin/themes/{id}` | One theme with its `css`. |
| `PATCH /api/admin/themes/{id}` | Uploaded themes: new `definition` (same id) and/or `css`; `acceptContrastFailures` when it is active and fails AA. |
| `DELETE /api/admin/themes/{id}` | Uploaded themes that are not active. `?uploadedCopy=true`: the uploaded theme that a folder theme with the same id hides. |
| `POST /api/admin/themes/{id}/activate` | `acceptContrastFailures` (default `false`): 409 `contrast_failures` when the theme fails AA and it is not set. |
| `GET /api/admin/themes/{id}/export`, `/export-css` | Downloads (`<id>.json`, `<id>.css`). |

Changes are written to the audit log (`theme.create`, `theme.update`,
`theme.delete`, `theme.activate`), never the CSS itself.
