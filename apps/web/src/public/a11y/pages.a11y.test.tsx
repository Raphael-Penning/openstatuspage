// @vitest-environment jsdom
/**
 * Automated accessibility checks of the public status page (WCAG 2.2 AA, see
 * docs/accessibility.md): every public page in both themes and both
 * languages, plus the interactive states (menus, tooltips, form errors).
 * Fails on any axe-core violation of a WCAG 2.0/2.1/2.2 A or AA rule.
 */
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { axeViolations, installBrowserStubs, renderPublic, settle, type Rendered } from './harness';
import { SUBSCRIPTION_TOKEN } from './fixtures';

const PAGES: [name: string, path: string][] = [
  ['overview', '/'],
  ['services', '/services'],
  ['service detail', '/services/api'],
  ['locations', '/locations'],
  ['history', '/history'],
  ['incident', '/incidents/inc-1'],
  ['maintenance', '/maintenance/m-1'],
  ['subscribe', '/subscribe'],
  ['subscription confirm', `/subscription/confirm?id=sub-1#token=${SUBSCRIPTION_TOKEN}`],
  ['subscription manage', `/subscription/manage?id=sub-1#token=${SUBSCRIPTION_TOKEN}`],
  ['subscription invalid link', '/subscription/manage'],
  ['subscription confirm (query token)', `/subscription/confirm?id=sub-1&token=${SUBSCRIPTION_TOKEN}`],
  ['subscription unsubscribe step', `/subscription/manage?id=sub-1&token=${SUBSCRIPTION_TOKEN}&unsubscribe=1&confirmed=1`],
  ['subscribed', '/subscribe?sent=1'],
  ['unsubscribed', '/subscription/manage?unsubscribed=1'],
  ['services filtered', '/services?q=api&status=operational'],
  ['unknown incident', '/incidents/missing'],
  ['not found', '/does-not-exist'],
];

const VARIANTS = [
  { lang: 'en', theme: 'light' },
  { lang: 'en', theme: 'dark' },
  { lang: 'de', theme: 'light' },
  { lang: 'de', theme: 'dark' },
] as const;

let page: Rendered | null = null;

beforeAll(() => installBrowserStubs());
afterEach(() => {
  page?.unmount();
  page = null;
});

async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

async function key(el: Element, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
  await settle();
}

describe.each(VARIANTS)('public pages ($lang, $theme)', ({ lang, theme }) => {
  it.each(PAGES)('%s has no WCAG A/AA violations', async (_name, path) => {
    page = await renderPublic({ path, lang, theme });
    expect(document.documentElement.lang).toBe(lang);
    expect(document.documentElement.dataset.theme).toBe(theme);
    // WCAG 2.4.2: every page has a title naming the page and the site.
    expect(document.title).toMatch(/Example Status|Status/);
    expect(await axeViolations()).toEqual([]);
  });
});

describe('the check itself', () => {
  it('reports violations (guards against a silently passing setup)', async () => {
    page = await renderPublic({ path: '/', lang: 'en', theme: 'light' });
    const main = page.container.querySelector('main')!;
    main.insertAdjacentHTML('beforeend', '<img src="/x.png"><button></button><input type="text">');
    const violations = await axeViolations();
    expect(violations.some((v) => v.startsWith('image-alt'))).toBe(true);
    expect(violations.some((v) => v.startsWith('button-name'))).toBe(true);
    expect(violations.some((v) => v.startsWith('label'))).toBe(true);
  });
});

describe('interactive states', () => {
  it('open subscribe menu', async () => {
    page = await renderPublic({ path: '/', lang: 'en', theme: 'light' });
    // A disclosure (<details>): it opens without JavaScript, too.
    const details = page.container.querySelector<HTMLDetailsElement>('main details')!;
    const summary = details.querySelector('summary')!;
    await act(async () => summary.focus());
    await click(summary);
    expect(details.open).toBe(true);
    expect(details.querySelectorAll('a[href]').length).toBeGreaterThanOrEqual(3);
    expect(await axeViolations()).toEqual([]);
    // Escape closes the menu and keeps the focus on its summary.
    await key(summary, 'Escape');
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it('open language menu', async () => {
    page = await renderPublic({ path: '/history?type=incident', lang: 'en', theme: 'dark' });
    const details = page.container.querySelector<HTMLDetailsElement>('header details')!;
    await click(details.querySelector('summary'));
    expect(details.open).toBe(true);
    const links = [...details.querySelectorAll<HTMLAnchorElement>('a[hreflang]')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/preferences/language?lang=en&return=%2Fhistory%3Ftype%3Dincident',
      '/preferences/language?lang=de&return=%2Fhistory%3Ftype%3Dincident',
    ]);
    expect(await axeViolations()).toEqual([]);
    // With JavaScript the language switches in place.
    await click(links[1]!);
    expect(document.documentElement.lang).toBe('de');
    expect(details.open).toBe(false);
  });

  it('open language menu on a personal page (a form with buttons)', async () => {
    page = await renderPublic({ path: `/subscription/manage?id=sub-1&token=${SUBSCRIPTION_TOKEN}`, lang: 'en', theme: 'light' });
    const details = page.container.querySelector<HTMLDetailsElement>('header details')!;
    await click(details.querySelector('summary'));
    expect(details.querySelector('form')?.getAttribute('method')).toBe('post');
    expect(details.querySelectorAll('a').length).toBe(0);
    const buttons = [...details.querySelectorAll<HTMLButtonElement>('button[name="lang"]')];
    expect(buttons.map((b) => b.value)).toEqual(['en', 'de']);
    expect(await axeViolations()).toEqual([]);
    await click(buttons[1]!);
    expect(document.documentElement.lang).toBe('de');
    expect(details.open).toBe(false);
  });

  it('uptime bar with its tooltip, keyboard navigation and Escape', async () => {
    page = await renderPublic({ path: '/services/api', lang: 'en', theme: 'dark' });
    const bar = page.container.querySelector<HTMLElement>('[aria-roledescription="uptime bar"]')!;
    expect(bar).not.toBeNull();
    await act(async () => bar.focus());
    await settle();
    const tooltipId = bar.getAttribute('aria-describedby');
    expect(tooltipId).toBeTruthy();
    expect(document.getElementById(tooltipId!)?.textContent).toContain('Operational');
    await key(bar, 'ArrowLeft');
    const live = bar.parentElement!.querySelector('[aria-live="polite"]');
    expect(live?.textContent).not.toBe('');
    expect(await axeViolations()).toEqual([]);
    // WCAG 1.4.13: Escape hides the tooltip without moving the focus.
    await key(bar, 'Escape');
    expect(bar.getAttribute('aria-describedby')).toBeNull();
    expect(document.activeElement).toBe(bar);
  });

  it('days that were not fully operational are not marked by color alone', async () => {
    page = await renderPublic({ path: '/services/api', lang: 'en', theme: 'light' });
    const bar = page.container.querySelector('[aria-roledescription="uptime bar"]')!;
    const segments = [...bar.children];
    expect(segments.some((s) => s.classList.contains('uptime-issue'))).toBe(true);
    expect(segments.some((s) => s.className.includes('ring-status-nodata'))).toBe(true);
  });

  it('every day of the uptime bar as a table (no JavaScript or pointer needed)', async () => {
    page = await renderPublic({ path: '/services/api', lang: 'de', theme: 'dark' });
    const details = [...page.container.querySelectorAll<HTMLDetailsElement>('main details')].find((d) => d.querySelector('table'))!;
    expect(details).toBeDefined();
    await click(details.querySelector('summary'));
    expect(details.open).toBe(true);
    const rows = details.querySelectorAll('tbody tr');
    expect(rows.length).toBe(page.container.querySelector('[aria-roledescription]')!.children.length);
    expect(await axeViolations()).toEqual([]);
  });

  it('locations: selected location with map tooltip and pan controls', async () => {
    page = await renderPublic({ path: '/locations', lang: 'de', theme: 'light' });
    // Every location is listed with its status as text, also those without coordinates.
    const items = page.container.querySelectorAll('main section[aria-labelledby^="region-"] li');
    expect(items.length).toBe(4);
    const button = page.container.querySelector('main section[aria-labelledby^="region-"] li button');
    await click(button);
    expect(page.container.querySelector('[role="tooltip"]')).not.toBeNull();
    await click(page.container.querySelector('button[aria-label="Vergrößern"]'));
    expect(page.container.querySelector('[role="group"] button[aria-label="Karte nach oben verschieben"]')).not.toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('subscribe form with errors', async () => {
    page = await renderPublic({ path: '/subscribe', lang: 'de', theme: 'dark' });
    const form = page.container.querySelector<HTMLFormElement>('main form')!;
    const email = form.querySelector<HTMLInputElement>('input[type="email"]')!;
    // WCAG 1.3.5: the purpose of the field is machine readable.
    expect(email.getAttribute('autocomplete')).toBe('email');
    await act(async () => {
      form.requestSubmit();
    });
    await settle();
    expect(email.getAttribute('aria-invalid')).toBe('true');
    const error = document.getElementById(email.getAttribute('aria-describedby')!);
    // WCAG 3.3.3: the error suggests a correction.
    expect(error?.textContent).toContain('name@example.com');
    expect(document.activeElement).toBe(email);
    expect(await axeViolations()).toEqual([]);
  });

  it('subscribe success is announced by moving the focus to the result', async () => {
    page = await renderPublic({ path: '/subscribe', lang: 'en', theme: 'light' });
    const form = page.container.querySelector<HTMLFormElement>('main form')!;
    const email = form.querySelector<HTMLInputElement>('input[type="email"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(email, 'jane@example.com');
      email.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      form.requestSubmit();
    });
    await settle(50);
    const heading = page.container.querySelector('main h1');
    expect(document.activeElement).toBe(heading);
    expect(await axeViolations()).toEqual([]);
  });

  it('client-side navigation moves the focus to the main content', async () => {
    page = await renderPublic({ path: '/', lang: 'en', theme: 'light' });
    const link = page.container.querySelector<HTMLAnchorElement>('nav a[href="/history"]')!;
    await click(link);
    await settle(50);
    expect(document.activeElement?.id).toBe('main');
  });
});
