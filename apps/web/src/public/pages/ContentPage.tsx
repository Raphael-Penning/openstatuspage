/**
 * Content pages: the about page, the legal notice, the privacy policy, the
 * accessibility statement (/about, /legal-notice, /privacy, /accessibility)
 * and custom pages (/pages/<slug>). Markdown per language, edited in the
 * management UI; a page in a language without its own text shows the other
 * language (marked with its `lang`).
 *
 * Loaded lazily (routes.tsx): the Markdown renderer is only fetched by
 * visitors of these pages, not by every page of the status page.
 */
import { localizedText, type LocalizedText, type SystemPageKey } from '@openstatuspage/shared';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { DateTime } from '../components/Time';
import { PageMarkdown } from '../components/PageMarkdown';
import { ErrorState, Skeleton, SkeletonList } from '../components/ui';
import { useBaseUrl, usePageHead } from '../head';
import { isNotFound, useSitePage } from '../hooks/queries';
import { markdownText, type WebPageType } from '../seo';
import { NotFoundState } from './NotFoundState';

/** schema.org type of a page: the about page describes the organization; every other one is a plain web page. */
const pageType = (key: SystemPageKey | null): WebPageType => (key === 'about' ? 'AboutPage' : 'WebPage');

/** `lang` of a text shown in the UI language `lang`: the other language when it has none of its own (WCAG 3.1.2). */
function fallbackLang(text: LocalizedText, lang: string): 'en' | 'de' | undefined {
  const own = lang === 'de' ? 'de' : 'en';
  return text[own].trim() ? undefined : own === 'de' ? 'en' : 'de';
}

function ContentPage({ slug, custom }: { slug: string; custom?: boolean }) {
  const { t, i18n } = useTranslation('public');
  const { data, isPending, isError, error, refetch } = useSitePage(slug);
  const baseUrl = useBaseUrl();
  const lang = i18n.language;
  // A system page has its own path; /pages/<system key> is not one of its URLs.
  const page = data && (!custom || data.systemKey === null) ? data : undefined;
  const title = page ? localizedText(page.title, lang) : undefined;
  const description = page ? localizedText(page.description, lang) || markdownText(localizedText(page.body, lang)) : undefined;

  usePageHead({
    title: title ?? t('page.loading'),
    description,
    canonical: page?.path,
    breadcrumbs: page && title ? [{ name: title, path: page.path }] : undefined,
    webPage: page ? { type: pageType(page.systemKey), datePublished: page.createdAt, dateModified: page.updatedAt } : undefined,
  });

  if (isPending) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <Skeleton className="h-10 w-72 max-w-full" />
        <SkeletonList rows={4} />
      </div>
    );
  }
  if (isError && !isNotFound(error)) return <ErrorState onRetry={() => void refetch()} />;
  if (!page || !title) return <NotFoundState message={t('page.notFound')} />;

  return (
    <article className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-semibold tracking-tight break-words" lang={fallbackLang(page.title, lang)}>
        {title}
      </h1>
      <p className="mt-2 text-sm text-muted">
        {t('page.updated')} <DateTime value={page.updatedAt} />
      </p>
      <div className="mt-8" lang={fallbackLang(page.body, lang)}>
        <PageMarkdown markdown={localizedText(page.body, lang)} images={page.images} baseUrl={baseUrl} />
      </div>
    </article>
  );
}

/** A system page at its fixed path. */
export const systemPage = (key: SystemPageKey) =>
  function SystemContentPage() {
    return <ContentPage slug={key} />;
  };

/** A custom page at /pages/<slug>. */
export function CustomContentPage() {
  const { slug = '' } = useParams();
  return <ContentPage slug={slug} custom />;
}
