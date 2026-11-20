/**
 * Renders the public pages in jsdom against the fake API of fixtures.ts and
 * runs axe-core on the result. Used by pages.a11y.test.tsx.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axe from 'axe-core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import i18n from '../../lib/i18n';
import { ThemeProvider } from '../../lib/theme';
import { publicRoutes } from '../routes';
import { respond } from './fixtures';

/** WCAG 2.0, 2.1 and 2.2 level A and AA rules of axe-core. */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

/** Best-practice rules that support WCAG 1.3.1 and 2.4.x and work reliably in jsdom. */
const EXTRA_RULES = ['region', 'landmark-one-main', 'landmark-unique', 'page-has-heading-one', 'heading-order', 'aria-allowed-role'];

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** Browser APIs jsdom does not implement. */
export function installBrowserStubs(): void {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  window.scrollTo = () => {};
  // axe-core probes canvas support; jsdom only logs "not implemented".
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const { status, body } = respond(init?.method ?? 'GET', url.pathname);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/vnd.api+json' } });
  };
}

export interface Rendered {
  container: HTMLElement;
  unmount: () => void;
}

export interface RenderOptions {
  path: string;
  lang: 'en' | 'de';
  theme: 'light' | 'dark';
}

export async function renderPublic({ path, lang, theme }: RenderOptions): Promise<Rendered> {
  localStorage.clear();
  // The cookie is the visitor's choice (the stored one is mirrored into it).
  document.cookie = `osp-theme=${theme}; Path=/`;
  localStorage.setItem('osp-theme', theme);
  localStorage.setItem('osp-lang-chosen', '1');
  await i18n.changeLanguage(lang);
  document.title = '';
  document.body.innerHTML = '';
  const container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
  const router = createMemoryRouter(publicRoutes, { initialEntries: [path] });
  let root: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });
  await waitUntilLoaded(container);
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      queryClient.clear();
    },
  };
}

/** Lets React, the fake API and lazy components settle. */
export async function settle(ms = 10): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const LOADING = '.motion-safe\\:animate-pulse, .motion-safe\\:animate-spin, [role="status"][aria-label]';

async function waitUntilLoaded(container: HTMLElement): Promise<void> {
  for (let i = 0; i < 300; i++) {
    await settle();
    const main = container.querySelector('main');
    if (main && main.querySelector('h1') && !container.querySelector(LOADING)) return;
  }
  throw new Error(`Page did not finish loading:\n${container.innerHTML.slice(0, 2000)}`);
}

/** Runs axe-core on the document and returns readable violations. */
export async function axeViolations(): Promise<string[]> {
  const result = await axe.run(document, {
    runOnly: { type: 'tag', values: WCAG_TAGS },
    rules: {
      // jsdom has no layout or computed colors: contrast is covered by tokens.test.ts and the manual checklist.
      'color-contrast': { enabled: false },
    },
  });
  const extra = await axe.run(document, { runOnly: { type: 'rule', values: EXTRA_RULES } });
  return [...result.violations, ...extra.violations].flatMap((v) =>
    v.nodes.map((n) => `${v.id} (${v.impact}): ${v.help}\n    at ${n.target.join(' ')}\n    ${n.failureSummary ?? ''}`),
  );
}
