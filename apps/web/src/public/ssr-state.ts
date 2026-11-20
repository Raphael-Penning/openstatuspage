/**
 * The state block of a server-rendered page (`<script type="application/json"
 * id="osp-state">`): the inputs of the render and the dehydrated React Query
 * cache. "Not found" answers are part of it, so a page that rendered its 404
 * state hydrates into the same state; ApiError instances travel as plain data.
 */
import type { SsrFormState, ThemePreference } from '@openstatuspage/shared';
import type { DehydratedState } from '@tanstack/react-query';
import { ApiError } from '../lib/api';
import type { LanguageCode } from '../lib/languages';

export interface SsrState {
  v: 1;
  lang: LanguageCode;
  theme: ThemePreference;
  /** Render time (ms since epoch). */
  now: number;
  baseUrl: string;
  queries: DehydratedState;
  /** Form state of a page that answers a form submission. */
  form?: SsrFormState;
}

interface EncodedApiError {
  __apiError: { status: number; body: ApiError['body']; errors: ApiError['errors'] };
}

const isEncoded = (v: unknown): v is EncodedApiError =>
  typeof v === 'object' && v !== null && '__apiError' in v && typeof (v as EncodedApiError).__apiError === 'object';

function mapErrors(state: DehydratedState, fn: (error: unknown) => unknown): DehydratedState {
  return {
    ...state,
    queries: state.queries.map((q) =>
      q.state.error == null && q.state.fetchFailureReason == null
        ? q
        : {
            ...q,
            state: {
              ...q.state,
              // Plain data in the JSON, an ApiError again after decoding.
              error: fn(q.state.error) as Error | null,
              fetchFailureReason: fn(q.state.fetchFailureReason) as Error | null,
            },
          },
    ),
  };
}

/** Before serializing: ApiError → plain data. */
export function encodeQueries(state: DehydratedState): DehydratedState {
  return mapErrors(state, (e) =>
    e instanceof ApiError ? ({ __apiError: { status: e.status, body: e.body, errors: e.errors } } satisfies EncodedApiError) : e,
  );
}

/** After parsing: plain data → ApiError (isNotFound() and friends work again). */
export function decodeQueries(state: DehydratedState): DehydratedState {
  return mapErrors(state, (e) => (isEncoded(e) ? new ApiError(e.__apiError.status, e.__apiError.body, e.__apiError.errors) : e));
}
