# Creating a theme

This chapter shows step by step how to create your own theme for the public
status page. You start from the starter template, change the colors, check the
contrast, look at the result, and install it. The complete reference is in
[Themes](../../themes.md); the files are described in
[contrib/themes](../../../contrib/themes/README.md).

## Who this is for

- Administrators who want the status page to match their brand or their
  website, without changing the code.
- Anyone who maintains several installations and wants one theme file for all
  of them.

You do not need to know CSS. A theme is a JSON file with colors, a corner
radius, font names and a density. Extra CSS is optional.

## Step by step

### 1. Start from a template

You have two ways to start:

- **Starter template:** download `starter.json` (and optionally `starter.css`)
  from [contrib/themes](../../../contrib/themes/README.md). Every color is set,
  including the optional ones, so you can see all the tokens at once.
- **Customize a copy:** in **Administration → Appearance**, click the copy
  icon (labelled **Customize a copy of …**) on a built-in or folder theme. The
  editor opens with all values filled in, and you can change them there.
  Uploaded themes have no copy icon: edit them directly, or download the JSON,
  change the `id` and import it as a new theme.

Choose a new **ID** before you save. The ID is the name of the theme in the
URL and the file name (`my-theme.json`). It may contain 1 to 48 lower-case
letters, digits and hyphens, and it **cannot be changed later**. It must not be
the ID of another theme (`default`, `slate`, `forest` and `high-contrast` are taken, and so is the ID
of any installed theme; a taken ID is refused).

Give the theme a `name` (shown in the admin list) and, optionally, an `author`
and a `description`.

```json
{
  "id": "my-theme",
  "name": "My theme",
  "version": 1,
  "author": "Example Ltd.",
  "description": "Our brand colors on the status page."
}
```

`version` is always `1`.

### 2. Set the colors for light and dark mode

The colors are in two blocks, `light` and `dark`. Each block has the same
tokens. The most important ones are:

| Token | What it colors |
| --- | --- |
| `background` | The page background |
| `surface` | Cards and the header |
| `surfaceAlt` | Insets, table heads, hover backgrounds |
| `border` | Hairlines between items |
| `borderStrong` | Borders of form fields and buttons |
| `text` | Body text |
| `muted` | Secondary text |
| `accent` | Your brand color, selected states, links |
| `status` | The five status colors and the color for days without data (`noData`) |

```json
"light": {
  "background": "#f7f7f8",
  "surface": "#ffffff",
  "surfaceAlt": "#efeff2",
  "border": "#dcdce2",
  "borderStrong": "#71717a",
  "text": "#18181b",
  "muted": "#52525b",
  "accent": "#0e7490",
  "status": {
    "operational": "#15803d",
    "maintenance": "#2563eb",
    "degraded": "#a16207",
    "partialOutage": "#c2410c",
    "majorOutage": "#dc2626",
    "noData": "#71717a"
  }
}
```

Use opaque colors only, in one of these forms: `#rgb`, `#rrggbb`,
`rgb(20 80 120)`, `rgb(20, 80, 120)`, `hsl(200 60% 30%)` or `oklch(0.45 0.1 230)`.
Transparent colors (alpha) and color names such as `navy` are refused, and so
is `var(...)`.

A good way to work: fill in `light` first, then copy the block to `dark` and
adjust the colors there. Dark mode usually needs lighter text and status colors
and darker surfaces.

Optionally, set `focus` (the focus ring) and `statusText` (the text and icons
for the status). If you leave them out, they are derived from the other colors.
The starter template shows both.

### 3. Check the contrast

Every theme is checked against **WCAG 2.2 AA** in both modes. In short:

- Text (`text`, `muted`) must have a contrast of at least **4.5 : 1** against
  the background, surface and inset colors.
- Controls and status colors (`borderStrong`, `accent`, `focus`, the status
  colors) must have at least **3 : 1**.
- Decorative hairlines (`border`) are not checked.

The editor shows the contrast live in **Contrast and preview**. A failing pair
looks like this:

```text
Light: muted on surface 2.4:1 (needs 4.5:1)
```

Read it as: in light mode, the `muted` text on the `surface` color has a ratio
of 2.4 to 1, but at least 4.5 to 1 is needed. To fix it, make `muted` darker
(or `surface` lighter) and check again. The message names the mode, the
foreground and the background, so you know which token to change.

The admin list shows **Passes AA** when everything is fine, or the number of
problems otherwise.

### 4. Optional: radius, fonts and density

- **`radius`**: the base corner radius, `0`, or a length up to `2rem` or `32px`
  (for example `0.5rem`, the default). Larger and smaller corners scale with it.
- **`fonts`**: only fonts that are **installed** on the visitor's device. Nothing
  is downloaded, so there are no web fonts and no CDN. A font stack is a list of
  family names separated by commas, and it must end with a generic family:

  ```json
  "fonts": {
    "sans": "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    "mono": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
  }
  ```

- **`density`**: `compact` (90 % spacing), `comfortable` (the default) or
  `spacious` (110 %).

### 5. Optional: extra CSS

Extra CSS changes what the tokens cannot do, for example a line under the
header. Put it in a file `my-theme.css` (same name as the JSON file), or in the
**Extra CSS** field of the editor. The starter template has a commented example
in `starter.css`.

```css
header {
  border-bottom: 3px solid var(--accent);
}
```

Use the theme's variables (`var(--accent)`, `var(--surface)`, `var(--fg)`,
`var(--muted)`, `var(--border)`) instead of fixed colors, so the rule works in
light and dark mode.

The filter **refuses the whole file** (it is never rewritten) when it finds:

- more than 64 KB;
- `@import`;
- `url()` to anything except `/uploads/...` (images uploaded in the admin) or a
  relative path on the same site (no `..`, no query string). No other host, no
  `//host`, no `data:`;
- `expression()`, `javascript:` or `vbscript:`, `behavior`, `-moz-binding`,
  `image-set()` and `src()`;
- the characters `<` and `-->`, also in comments;
- control characters and a comment that is not closed.

Extra CSS can change anything on the page. The contrast check looks only at the
tokens, so always check the result with the preview (step 6).

### 6. Test with the preview

Two previews are available:

- **Preview** in the admin list (or the live preview in the editor) draws a mock
  of the public page in light and dark mode.
- **Preview the public page** opens the real page with your theme in a new tab,
  for example `/?theme=my-theme`. Only you see it, because the server honours
  `?theme=` for signed-in **admins** only. Visitors keep the active theme.

Check the page in both modes, with a long status name, an incident and a
day with no data. Then check it on a phone.

### 7. Install the theme

There are three ways to install a theme. Choose the one that fits your setup.

**Upload in the admin (the simplest):** in **Administration → Appearance**,
click **Import theme**. Choose `my-theme.json` and, optionally, `my-theme.css`.
The theme is stored in the database and can be edited in the admin.

**Themes folder:** put the files into the themes folder and restart the server.
The file names must match the ID: `my-theme.json` and `my-theme.css`. Folder
themes cannot be edited in the admin, but you can download them and install
them elsewhere.

- Docker Compose: put the files into `./themes` next to the Compose file and
  mount it as described in [Themes](../../themes.md#docker-compose). Then run
  `docker compose up -d`.
- Helm: add the files under `themes.files` in your values (or use
  `themes.existingConfigMap`), see the
  [Themes section of the chart README](../../../deploy/helm/openstatuspage/README.md#themes).
- Without containers: copy the files into `/etc/openstatuspage/themes` and make
  them readable by everyone (`install -m 0644 my-theme.json my-theme.css
  /etc/openstatuspage/themes/`), then run `systemctl restart openstatuspage`
  (or `openstatuspage-split.target` in a split deployment).

The folder is read only when the server starts, so restart after every change.

### 8. Activate the theme

In **Administration → Appearance**, click **Activate** on your theme. It
becomes the theme of the public page for all visitors. Visitors can still switch
between light and dark mode.

If the theme does not pass the contrast check, **Activate** asks for
confirmation with **Activate anyway**. Do not use it as a shortcut: fix the
colors instead, because a low-contrast page is hard to read for many visitors.

### 9. Share and update the theme

- Click the download button on a theme to save it as JSON (and the extra CSS
  as `.css`). Use this to move a theme to another installation, or to share it.
- To change an uploaded theme, open it with the edit button, change it and save.
  If it is the active theme, saving a version that fails the contrast check asks
  for **Save anyway**.
- To change a folder theme, edit the file on the server and restart. To change
  a built-in theme, use **Customize a copy** and give the copy a new ID.
- Keep the same ID when you update a theme: the ID cannot be changed for an
  uploaded theme.

## Troubleshooting

| Message or symptom | What to do |
| --- | --- |
| **The theme cannot be saved:** with an invalid colour (the list names the field) | Use `#rrggbb`, `#rgb`, `rgb()`, `hsl()` or `oklch()` without transparency. Names and `var()` are not allowed. |
| The list names a field you did not expect | Remove the key or check its spelling. Only the keys in [Themes](../../themes.md#theme-file-format) are allowed, at every level (`$schema` is the one optional extra). |
| `contrast_failures` (409) or **Activate anyway** appears | Read the failing pairs in the editor and make the colors darker or lighter. Confirm only if you accept the result. |
| `A theme with the id "…" exists already` (409) | Choose another ID. Built-in, folder and uploaded themes share one ID space. |
| A folder file is skipped in the server log (`Theme file skipped: …`) | Check the file name (it must equal the `id`) and the JSON. The log names the reason. |
| The extra CSS is refused | The message names the rule (for example `@import is not allowed`) and shows a short excerpt. Remove the rule and save again. |
| A folder theme does not show after a change | The folder is read only at start: restart the server. |
| The active theme is marked as unconfirmed | Its file or the accent color in the settings changed. Open **Appearance**, click **Review**, and activate it again or fix the colors. |
| Visitors see the default theme | The active theme was removed (for example a folder file was deleted). Activate another theme. |

## Next steps

- [Themes](../../themes.md) has the complete reference: every token, every limit
  and the management API.
- [Configuration](04-configuration.md#themes) describes the Appearance page.
- [contrib/themes](../../../contrib/themes/README.md) lists the example themes
  `ocean` and `starter`.
