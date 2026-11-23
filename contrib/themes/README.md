# Example themes

Theme files for the themes folder (`THEMES_DIR`) or for **Import theme** under
**Administration → Appearance**. The format is described in
[docs/themes.md](../../docs/themes.md).

| Files | What it is |
| --- | --- |
| `starter.json`, `starter.css` | Starter template for your own theme: every token is set, also the optional ones, and the CSS file explains the rules for extra CSS in its comments. |
| `ocean.json`, `ocean.css` | A finished example theme (blue-green surfaces, teal accent). |

Both pass WCAG 2.2 AA in light and dark mode (checked by the automated tests).

## Start your own theme

1. Copy `starter.json` to `<your-id>.json`. Change `id` (it must equal the file
   name without `.json`) and `name`. Copy `starter.css` too if you want extra
   CSS, or delete the copy if you do not.
2. Set the colours in `light` and `dark`. Keep every token in both blocks.
3. Check the contrast in **Administration → Appearance** (WCAG 2.2 AA).
4. Preview it with **Preview the public page** (`/?theme=<your-id>`).
5. Install it: **Import theme** in the admin, or copy the files to the themes
   folder and restart.

The full guide, with troubleshooting, is
[Creating a theme](../../docs/guide/en/15-creating-a-theme.md) (German:
[Ein Theme erstellen](../../docs/guide/de/15-creating-a-theme.md)). The file
format is in [docs/themes.md](../../docs/themes.md).

### Using the examples

- **`starter.*`** is the template to copy. Its id `starter` is valid, so it
  works as it is, but it looks like a placeholder: rename it before you use it
  for a real page. If you copy the whole folder into the themes folder, the
  `starter` theme appears too; delete its files or give your theme another id.
- **`ocean.*`** is a complete example with its own colours and a few extra CSS
  rules. Use it to see what a finished theme looks like, or copy it and change
  the colours. It keeps the id `ocean` in its files, so rename the files and the
  id together.
