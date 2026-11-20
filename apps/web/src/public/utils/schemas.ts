/**
 * The input schemas of the subscription forms, loaded on demand: they bring zod
 * (about 90 kB), which no public page needs to render or hydrate. The forms
 * start loading it once hydrated, so a submit rarely waits for it.
 */
export const loadSchemas = () => import('@openstatuspage/shared/schemas');
