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
import { API_TODAY, API_YESTERDAY, CHANNEL_TOKEN, PRIVATE_TOKEN, SUBSCRIPTION_TOKEN } from './fixtures';

// axe walks every node; the overview has hundreds of day links and needs
// more than vitest's 5 s default on slow CI runners.
const AXE_TIMEOUT_MS = 30_000;

const PAGES: [name: string, path: string][] = [
  ['overview', '/'],
  ['services', '/services'],
  ['service detail', '/services/api'],
  ['service day', `/services/api/days/${API_YESTERDAY}`],
  ['service day (today)', `/services/api/days/${API_TODAY}`],
  ['unknown service day', '/services/api/days/2001-01-01'],
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
  ['subscribe by webhook', '/subscribe/webhook'],
  ['subscribe by SMS', '/subscribe/sms'],
  ['subscribe by SMS (rate limited)', '/subscribe/sms?error=rate_limited'],
  ['verify code', '/subscription/verify?ref=0123456789abcdefghij&channel=sms'],
  ['verify code (wrong code)', '/subscription/verify?ref=0123456789abcdefghij&channel=webhook&error=code'],
  ['channel manage', `/subscription/channel?id=ch-1&token=${CHANNEL_TOKEN}&confirmed=1`],
  ['channel invalid link', '/subscription/channel'],
  ['channel unsubscribed', '/subscription/channel?unsubscribed=1'],
  ['unsubscribed', '/subscription/manage?unsubscribed=1'],
  ['services filtered', '/services?q=api&status=operational'],
  ['unknown incident', '/incidents/missing'],
  ['not found', '/does-not-exist'],
  ['content page (accessibility statement)', '/accessibility'],
  ['custom content page', '/pages/faq'],
  ['unpublished content page', '/legal-notice'],
  ['private page', `/p/${PRIVATE_TOKEN}`],
  ['private service', `/p/${PRIVATE_TOKEN}/services/backend`],
  ['private service day', `/p/${PRIVATE_TOKEN}/services/api/days/${API_YESTERDAY}`],
  ['private incident', `/p/${PRIVATE_TOKEN}/incidents/inc-1`],
  ['private maintenance', `/p/${PRIVATE_TOKEN}/maintenance/m-1`],
  ['private page (wrong link)', '/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
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
  }, AXE_TIMEOUT_MS);
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

describe.each(VARIANTS)('footer and info link ($lang, $theme)', ({ lang, theme }) => {
  it('are labelled landmarks with outbound links that say they open a new tab', async () => {
    page = await renderPublic({ path: '/services', lang, theme });
    const footer = page.container.querySelector('footer')!;
    expect(footer).not.toBeNull();
    const navs = [...footer.querySelectorAll('nav')].map((n) => n.getAttribute('aria-label'));
    expect(navs).toEqual(lang === 'de' ? ['Fußzeile', 'Rechtliches'] : ['Footer', 'Legal']);
    const legal = footer.querySelectorAll<HTMLAnchorElement>('nav:last-of-type a');
    expect([...legal].map((a) => a.firstChild?.textContent)).toEqual(
      lang === 'de' ? ['Impressum', 'Privacy', 'Erklärung zur Barrierefreiheit'] : ['Imprint', 'Privacy', 'Accessibility statement'],
    );
    for (const a of footer.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')) {
      expect(a.rel).toBe('noopener noreferrer');
      expect(a.querySelector('.sr-only')?.textContent).toMatch(lang === 'de' ? /neuen Tab/ : /new tab/);
      expect(new URL(a.href).searchParams.get('utm_source')).toBe('status');
    }
    expect(footer.textContent).toContain(`© ${new Date().getUTCFullYear()} Example GmbH`);
    const info = page.container.querySelector<HTMLAnchorElement>('nav a[href="/about"]');
    expect(info?.textContent).toBe('What does the status mean?');
    expect(info?.target).toBe('');
    expect(await axeViolations()).toEqual([]);
  });
});

describe.each(VARIANTS)('content pages ($lang, $theme)', ({ lang, theme }) => {
  it('render the Markdown safely with one h1, sized images and the language of the text', async () => {
    page = await renderPublic({ path: '/accessibility', lang, theme });
    const main = page.container.querySelector('main')!;
    expect([...main.querySelectorAll('h1')].map((h) => h.textContent)).toEqual([
      lang === 'de' ? 'Erklärung zur Barrierefreiheit' : 'Accessibility statement',
    ]);
    // Markdown headings are one level down, raw HTML is not rendered.
    expect([...main.querySelectorAll('h2, h3')].map((h) => `${h.tagName}:${h.textContent}`)).toEqual(['H2:Our commitment', 'H3:Known limitations']);
    expect(main.querySelector('script')).toBeNull();
    expect(main.textContent).not.toContain('alert(1)');
    const img = main.querySelector('img')!;
    expect([img.getAttribute('width'), img.getAttribute('height'), img.getAttribute('loading'), img.alt]).toEqual(['640', '320', 'lazy', 'Diagram of the status page']);
    const external = main.querySelector<HTMLAnchorElement>('a[href^="https://www.w3.org"]')!;
    expect([external.target, external.rel]).toEqual(['_blank', 'noopener noreferrer']);
    expect(main.querySelector('[role="region"] table')).not.toBeNull();
    // No German text: the English one, marked as English.
    expect(main.querySelector('.page-prose')?.parentElement?.getAttribute('lang') ?? null).toBe(lang === 'de' ? 'en' : null);
    expect(await axeViolations()).toEqual([]);
  }, AXE_TIMEOUT_MS);

  it('link custom pages from the navigation and the footer, and internal legal pages without a new tab', async () => {
    page = await renderPublic({ path: '/pages/faq', lang, theme });
    const title = lang === 'de' ? 'Häufige Fragen' : 'FAQ';
    expect(page.container.querySelector('main h1')?.textContent).toBe(title);
    const navLink = page.container.querySelector<HTMLAnchorElement>('header ~ nav a[href="/pages/faq"]');
    expect(navLink?.getAttribute('aria-current')).toBe('page');
    expect(page.container.querySelector('footer a[href="/pages/faq"]')?.textContent).toBe(title);
    const legal = page.container.querySelector<HTMLAnchorElement>('footer a[href="/accessibility"]');
    expect(legal?.target).toBe('');
    expect(await axeViolations()).toEqual([]);
  }, AXE_TIMEOUT_MS);
});

describe.each(VARIANTS)('statistics choice ($lang, $theme)', ({ lang, theme }) => {
  afterEach(() => {
    document.cookie = 'osp-analytics=; Path=/; Max-Age=0';
  });

  it('is a form in the legal landmark right after the privacy policy', async () => {
    page = await renderPublic({ path: '/history', lang, theme });
    const items = [...page.container.querySelectorAll('footer nav:last-of-type li')];
    const form = items[2]?.querySelector('form');
    expect(items[1]?.querySelector('a')?.firstChild?.textContent).toBe('Privacy');
    expect(form?.getAttribute('method')).toBe('post');
    expect(form?.getAttribute('action')).toBe('/preferences/analytics');
    expect(form?.querySelector<HTMLInputElement>('input[name="analytics"]')?.value).toBe('off');
    expect(form?.querySelector<HTMLInputElement>('input[name="return"]')?.value).toBe('/history');
    expect(form?.querySelector('button[type="submit"]')?.textContent).toBe(
      lang === 'de' ? 'Statistik deaktivieren' : 'Disable statistics',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('says that statistics are disabled and offers to enable them again', async () => {
    document.cookie = 'osp-analytics=off; Path=/';
    page = await renderPublic({ path: '/', lang, theme });
    const form = page.container.querySelector('footer form[action="/preferences/analytics"]')!;
    expect(form.querySelector<HTMLInputElement>('input[name="analytics"]')?.value).toBe('on');
    expect(form.textContent).toBe(
      lang === 'de' ? 'Statistik ist deaktiviert. Statistik aktivieren' : 'Statistics are disabled. Enable statistics',
    );
    // Umami's own switch is set as well, so a tracker that is still loaded stops.
    expect(localStorage.getItem('umami.disabled')).toBe('1');
    expect(await axeViolations()).toEqual([]);
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

  it('uptime bar: one tab stop, arrow keys move between day links, tooltip and Escape', async () => {
    page = await renderPublic({ path: '/services/api', lang: 'en', theme: 'dark' });
    const bar = page.container.querySelector<HTMLElement>('[aria-roledescription="uptime bar"]')!;
    expect(bar).not.toBeNull();
    const links = [...bar.querySelectorAll<HTMLAnchorElement>('a')];
    expect(links.length).toBe(90);
    // Roving tabindex: one tab stop, the newest day.
    expect(links.filter((a) => a.tabIndex === 0)).toEqual([links.at(-1)]);
    expect(links.at(-1)!.getAttribute('href')).toBe(`/services/api/days/${API_TODAY}`);
    expect(links.at(-1)!.getAttribute('aria-label')).toMatch(/Operational, 100% uptime/);
    await act(async () => links.at(-1)!.focus());
    await settle();
    const tooltip = () => bar.parentElement!.querySelector('[aria-hidden="true"].absolute');
    expect(tooltip()?.textContent).toContain('Operational');
    await key(links.at(-1)!, 'ArrowLeft');
    expect(document.activeElement).toBe(links.at(-2));
    expect(links.at(-2)!.tabIndex).toBe(0);
    expect(links.at(-1)!.tabIndex).toBe(-1);
    await key(links.at(-2)!, 'Home');
    expect(document.activeElement).toBe(links[0]);
    await key(links[0]!, 'End');
    expect(document.activeElement).toBe(links.at(-1));
    expect(await axeViolations()).toEqual([]);
    // WCAG 1.4.13: Escape hides the tooltip without moving the focus.
    await key(links.at(-1)!, 'Escape');
    expect(tooltip()).toBeNull();
    expect(document.activeElement).toBe(links.at(-1));
    // Enter (a click without a pointer) opens the day in the client.
    await click(links.at(-2)!);
    expect(page.container.querySelector('h1 time')?.getAttribute('datetime')).toBe(API_YESTERDAY);
    expect(await axeViolations()).toEqual([]);
  });

  it('uptime bar on touch screens: the first tap shows the day, the second opens it', async () => {
    page = await renderPublic({ path: '/services/api', lang: 'en', theme: 'light' });
    const bar = page.container.querySelector<HTMLElement>('[aria-roledescription="uptime bar"]')!;
    const day = bar.children[bar.children.length - 2] as HTMLAnchorElement;
    const tap = async () => {
      await act(async () => {
        const down = new MouseEvent('pointerdown', { bubbles: true });
        Object.defineProperty(down, 'pointerType', { value: 'touch' });
        day.dispatchEvent(down);
        day.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
      });
      await settle();
    };
    await tap();
    const tooltip = bar.parentElement!.querySelector('[aria-hidden="true"].absolute');
    expect(tooltip?.textContent).toContain(API_YESTERDAY.slice(0, 4));
    // The tooltip offers the day as a link, too (out of the tab order: the day link itself is in it).
    expect(tooltip?.querySelector('a')?.getAttribute('href')).toBe(`/services/api/days/${API_YESTERDAY}`);
    expect(tooltip?.querySelector('a')?.tabIndex).toBe(-1);
    expect(page.container.querySelector('h1 time')).toBeNull();
    await tap();
    expect(page.container.querySelector('h1 time')?.getAttribute('datetime')).toBe(API_YESTERDAY);
  });

  it('uptime bar with a screen reader: activating the focused day opens it at once', async () => {
    page = await renderPublic({ path: '/services/api', lang: 'en', theme: 'light' });
    const bar = page.container.querySelector<HTMLElement>('[aria-roledescription="uptime bar"]')!;
    const day = bar.children[bar.children.length - 2] as HTMLAnchorElement;
    // VoiceOver / TalkBack move the focus to the link, a double tap sends a touch press and a click.
    await act(async () => day.focus());
    await settle();
    await act(async () => {
      const down = new MouseEvent('pointerdown', { bubbles: true });
      Object.defineProperty(down, 'pointerType', { value: 'touch' });
      day.dispatchEvent(down);
      day.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    });
    await settle();
    expect(page.container.querySelector('h1 time')?.getAttribute('datetime')).toBe(API_YESTERDAY);
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
    // Every day links to its page.
    expect([...rows].map((r) => r.querySelector('th a')?.getAttribute('href'))).toContain(`/services/api/days/${API_YESTERDAY}`);
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

describe('private pages', () => {
  const base = `/p/${PRIVATE_TOKEN}`;

  it('keep every service, bar day and service chip link on the private page', async () => {
    page = await renderPublic({ path: base, lang: 'en', theme: 'light' });
    expect(page.container.querySelector('main h1')?.textContent).toBe('ACME status');
    expect(page.container.textContent).toContain('Partner backend');
    const hrefs = [...page.container.querySelectorAll('main a[href^="/services"], main .osp-bar a')].map((a) => a.getAttribute('href'));
    expect(hrefs.filter((h) => h?.startsWith('/services'))).toEqual([]);
    expect(page.container.querySelector(`main a[href="${base}/services/backend"]`)).not.toBeNull();
    expect(page.container.querySelector(`.osp-bar a[href^="${base}/services/backend/days/"]`)).not.toBeNull();
    // No navigation to the main pages; the logo leads to the private page itself.
    expect(page.container.querySelector('nav a[href="/history"]')).toBeNull();
    expect(page.container.querySelector(`header a[href="${base}"]`)).not.toBeNull();
    // The footer leaves out the main page's status API and feeds.
    expect(page.container.querySelector('footer a[href="/api/public/status"], footer a[href^="/feed."]')).toBeNull();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? 'noindex, nofollow').toBe('noindex, nofollow');
  });

  it('a service page goes back to the private page', async () => {
    page = await renderPublic({ path: `${base}/services/backend`, lang: 'en', theme: 'light' });
    expect(page.container.querySelector('main h1')?.textContent).toBe('Partner backend');
    expect(page.container.querySelector(`main a[href="${base}"]`)).not.toBeNull();
    expect(page.container.querySelector('main a[href^="/history"]')).toBeNull();
  });

  it('incidents and maintenance windows open below the private page and lead back to it', async () => {
    page = await renderPublic({ path: base, lang: 'en', theme: 'light' });
    expect(page.container.querySelector('main a[href^="/incidents/"], main a[href^="/maintenance/"]')).toBeNull();
    expect(page.container.querySelector(`main a[href="${base}/incidents/inc-1"]`)).not.toBeNull();
    expect(page.container.querySelector(`main a[href="${base}/maintenance/m-1"]`)).not.toBeNull();

    for (const path of [`${base}/incidents/inc-1`, `${base}/maintenance/m-1`]) {
      page.unmount();
      page = await renderPublic({ path, lang: 'en', theme: 'light' });
      expect(page.container.querySelector('main h1')?.textContent, path).not.toBe('Page not found');
      expect(page.container.querySelector(`main a[href="${base}"]`), path).not.toBeNull();
      expect(page.container.querySelector('main a[href^="/history"], main a[href^="/services/"]'), path).toBeNull();
      expect(page.container.querySelector(`main a[href="${base}/services/api"]`), path).not.toBeNull();
    }
  });

  it('a wrong link is "not found"', async () => {
    page = await renderPublic({ path: '/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', lang: 'en', theme: 'light' });
    expect(page.container.querySelector('main h1')?.textContent).toBe('Page not found');
  });
});
