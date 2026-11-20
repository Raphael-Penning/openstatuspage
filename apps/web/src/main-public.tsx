/**
 * Entry of public.html: the public status page only. APP_ROLE=public instances
 * serve this page and none of the chunks that only the management UI loads.
 *
 * A page rendered by the server carries its state block (#osp-state) and is
 * hydrated; without it (vite dev, the server's fallback page) the app renders
 * on the client.
 */
import { SSR_STATE_ID } from '@openstatuspage/shared';
import { boot } from './boot';
import { hydratePublic } from './hydrate';
import { publicOnlyRoutes } from './public-router';
import type { SsrState } from './public/ssr-state';

function serverState(): SsrState | null {
  const text = document.getElementById(SSR_STATE_ID)?.textContent;
  if (!text) return null;
  try {
    const state = JSON.parse(text) as SsrState;
    return state.v === 1 ? state : null;
  } catch {
    return null;
  }
}

const state = serverState();
if (state) void hydratePublic(document.getElementById('root')!, state);
else boot(publicOnlyRoutes);
