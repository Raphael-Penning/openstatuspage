# Accessibility

OpenStatusPage aims to conform to **WCAG 2.2 Level AA** for everything your
visitors and subscribers see:

- the **public status page** (`apps/web/src/public` and the shared components it
  uses): overview, services and service detail, locations with the world map,
  history, incident and maintenance pages, the email subscription pages
  (subscribe, confirm, manage) and the "not found" page, including the header
  controls (time zone, language, theme) and the subscribe menu;
- the **notification emails** (`apps/server/src/mail/templates.ts`): HTML and
  plain text part of the confirmation, manage, test, incident and maintenance
  mails.

The management UI under `/admin` is **not** in scope (yet). It shares the design
tokens and therefore benefits from the contrast fixes, but it is not audited or
tested against WCAG.

This page lists how the requirements are met, what is checked automatically,
what has to be checked by hand before a release, and the known limitations.

## How the requirements are met

| Area | WCAG | Implementation |
| --- | --- | --- |
| Text alternatives | 1.1.1 | Decorative icons are `aria-hidden`; status dots have a text label; every status is also shown as text (pills, tooltips, counters). The world map has a text alternative: the list of all locations with their status below it. |
| Structure | 1.3.1, 2.4.6 | Landmarks (`header`, `nav`, `main`, `footer`), one `h1` per page and no skipped heading levels, lists for lists, `dl` for facts, `fieldset`/`legend` for the scope picker. |
| Input purpose | 1.3.5 | The email field has `type="email"` and `autocomplete="email"`. |
| Use of color | 1.4.1 | Uptime bars: days that were not fully operational are **striped**, days without data are **outlined**. Map markers have a **shape per status** (circle, square, triangle, diamond, cross) that the legend repeats. Badges and counters always carry text. |
| Contrast | 1.4.3, 1.4.11 | Separate design tokens for status *text* (≥ 4.5:1) and status *fills* (≥ 3:1) in both themes; form fields use a stronger border (≥ 3:1). Contrast is verified by `apps/web/src/tokens.test.ts`. |
| Brand color | 1.4.3, 1.4.11 | Any accent color can be configured. The page derives a text/focus variant that reaches 4.5:1 on every background of the current theme and a button variant with readable text (white or dark). Emails do the same for their button. |
| Resize and reflow | 1.4.4, 1.4.10 | Relative font sizes; the navigation wraps instead of scrolling sideways; long names wrap instead of being cut off. No horizontal scrolling at 320 CSS px. |
| Text spacing | 1.4.12 | Controls use minimum heights instead of fixed heights. |
| Hover and focus content | 1.4.13 | Uptime bar and map tooltips can be hovered without disappearing, stay until the pointer or focus leaves, and **Escape** hides them. On touch screens, tapping a day shows its details. |
| Keyboard | 2.1.1, 2.1.2 | Everything works with the keyboard: uptime bars are one tab stop each (arrow keys, Home, End), map markers are buttons, the map has zoom and pan buttons, menus close with Escape and return focus. No keyboard traps. |
| Skip link, titles, focus | 2.4.1, 2.4.2, 2.4.3 | "Skip to content" link; every page has a title "Page · Site name"; after a client-side navigation the focus moves to the main content; after a form error the focus moves to the first invalid field. |
| Focus visible | 2.4.7, 2.4.11 | A 2 px focus outline in the contrast-safe accent on every interactive element. There is no sticky header that could cover the focus. |
| Dragging, target size | 2.5.7, 2.5.8 | Panning the map by dragging has button alternatives. Targets are at least 24×24 px or have enough spacing; the whole uptime bar is a single target (the day follows from the pointer position); map markers have an equivalent in the location list. |
| Language | 3.1.1, 3.1.2 | `<html lang>` and `dir` follow the selected UI language; the language names in the language selectors carry their own `lang`. |
| Consistent help | 3.2.6 | The support link (if configured) is always in the footer at the same place. |
| Errors | 3.3.1, 3.3.3 | Errors are shown as text next to the field, linked with `aria-describedby`, the field is marked `aria-invalid` and the message suggests a fix (for example `name@example.com`). |
| Redundant entry, authentication | 3.3.7, 3.3.8 | The manage page shows the stored address instead of asking again; there is no CAPTCHA (a hidden honeypot field filters bots). |
| Name, role, value | 4.1.2 | Native elements where possible; toggle buttons use `aria-pressed`, disclosure buttons `aria-expanded`. |
| Status messages | 4.1.3 | Polite live regions for search results, filter results, the saved state and status changes of the overview. The uptime bar announces the selected day only on keyboard navigation, so moving the mouse or the 60 s auto refresh do not flood screen readers. |
| Motion | 2.3.3 (AAA, best effort) | `prefers-reduced-motion` turns off animations and transitions (spinners, skeleton pulse). |

### Emails

| Requirement | Implementation |
| --- | --- |
| Language | `<html lang="…" dir="ltr">` with the subscriber's locale (`en` or `de`). |
| Title | The subject is the `<title>`. |
| Structure | Layout tables carry `role="presentation"`; the topic is a real `<h1>`; label/value pairs are plain rows. |
| Contrast | Body text `#18181b`, secondary text `#52525b` (≥ 7:1 on white and on the grey page background); the button colors are derived from the accent with `solidAccent` (≥ 4.5:1). |
| Font size | Only relative sizes (`em`), nothing below 0.875 em, so the reader's font size settings apply. |
| Link texts | Links say where they lead ("View the incident on the status page", "Manage subscription", "Unsubscribe"). |
| Images and color | No images; no information is conveyed by color alone. |
| Plain text | Every mail has a complete plain text part with the same content and all link targets. |

## Automated checks

All of these run in the CI job **check** (`pnpm -r test`):

| Test | What it checks |
| --- | --- |
| `apps/web/src/public/a11y/pages.a11y.test.tsx` | Renders every public page (13 routes and states, including error and "not found" states) in **light and dark theme** and in **English and German** in jsdom with a fake API and runs **axe-core** with all WCAG 2.0, 2.1 and 2.2 A/AA rules plus a few structural best practices (landmarks, heading order). Any violation fails the test. It also checks interactive states: the open subscribe menu (Escape returns focus), the uptime tooltip (keyboard, live region, Escape), the map with a selected location and pan controls, form errors (focus, `aria-invalid`, suggestion), the success message and focus after navigation. |
| `apps/web/src/tokens.test.ts` | Contrast of the design tokens in `styles.css` for both themes: text and muted text (4.5:1), status text (4.5:1), status fills, the no-data outline and field borders (3:1), accent text and focus color (4.5:1), and that the default accent variants match the runtime calculation. jsdom has no layout, so axe's `color-contrast` rule is disabled in the page tests and covered here instead. |
| `apps/web/src/public/utils/color.test.ts` | The accent adjustment keeps any configured color readable on every background of both themes. |
| `apps/web/src/public/utils/uptime.test.ts`, `shapes.test.ts` | Pointer-to-day mapping of the uptime bar, patterns per day, one distinct marker shape per status. |
| `apps/server/test/mail-accessibility.test.ts` | Every mail in both languages: `lang`/`dir`, `<title>`, exactly one `h1`, presentation tables, relative font sizes, no images, meaningful link texts, text contrast, button contrast for several accent colors, and a plain text part that contains every text and link of the HTML part. |

Automated tools find only part of the problems. The following manual checks are
needed before a release that changes the public page or the emails.

## Manual test checklist

Run through it in a recent Chrome or Firefox and in Safari, in light and dark
theme, with demo data (`pnpm db:seed`).

**Keyboard only** (unplug the mouse):

- [ ] The first Tab shows "Skip to content"; Enter moves to the main content.
- [ ] Every link, button, select, uptime bar and map control can be reached in
  a sensible order, and the focus is always clearly visible and never hidden.
- [ ] In an uptime bar, ←/→/Home/End move through the days, the tooltip follows,
  Escape hides it, Tab moves on.
- [ ] On the locations page, the map markers, zoom and pan buttons work; the
  focus never gets stuck in the map.
- [ ] The subscribe menu opens with Enter/Space and closes with Escape; the
  focus goes back to its button.
- [ ] Submitting the subscribe form empty moves the focus to the email field
  and the error is read out.

**Screen reader smoke test** (NVDA + Firefox on Windows, VoiceOver + Safari on
macOS/iOS):

- [ ] The page language is right (German text is not read with an English
  voice after switching to Deutsch).
- [ ] The headings list (NVDA: H / Insert+F7, VoiceOver: rotor) gives a useful
  outline of every page.
- [ ] Status pills, counters and the hero are read with their status text.
- [ ] Uptime bar: name, number of days and uptime are read on focus; arrow keys
  announce the selected day once, without repeating while the page refreshes.
- [ ] The location list below the map is read with every location and status.
- [ ] Subscribing announces the confirmation; the manage page announces "saved".

**Zoom, reflow and spacing:**

- [ ] 200 % browser zoom: nothing is cut off or overlaps.
- [ ] 400 % zoom, or a 320 px wide window: no horizontal scrolling (except the
  map itself), the navigation wraps, all content is reachable.
- [ ] Text spacing bookmarklet (line height 1.5, paragraph spacing 2, letter
  spacing 0.12, word spacing 0.16; for example the one from
  [W3C's understanding document](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html)):
  no text is clipped.
- [ ] With "reduce motion" enabled in the operating system, spinners and
  skeletons do not animate.

**Brand color:** set an unusual accent (for example a light yellow `#ffd400`)
in the settings and check that links, focus outlines and the subscribe button
are still readable in both themes.

**Emails:** send a test mail and an incident mail to a real mailbox and check
them in at least one webmail client and one desktop client: language, headings
(screen reader), larger font settings of the client, dark mode of the client,
plain text view.

## Known limitations

- **Content written by your team** (site name, description, incident and
  maintenance texts, service names) is shown as entered. It is marked with the
  UI language; text written in another language is not marked as such
  (WCAG 3.1.2). Write updates in the language most of your visitors use, and
  keep titles short and descriptive.
- **Logos** are shown with an empty `alt` because the site name is always shown
  next to them. A logo that contains important text other than the site name is
  not described.
- **Links you configure** (support URL, footer links) open in a new tab; their
  label is yours.
- **Color contrast** of the page is verified for the design tokens, not for
  every rendered pixel (jsdom has no layout); the in-browser check of the manual
  checklist covers the rest.
- The **world map** itself is a visual overview; its information is fully
  available in the location list below it. Very small screens show small map
  markers; the list is the equivalent with large targets.
- **Emails** are rendered by the subscriber's mail client, which may ignore
  parts of the markup (for example `lang` or dark mode handling).
- The **management UI** (`/admin`) is out of scope.
