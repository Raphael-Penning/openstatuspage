/**
 * Help area of the management UI (/admin/help and /admin/help/:topic) for
 * every signed-in user. Shows the setup and operations guide from docs/guide
 * in the current UI language, falling back to English per topic.
 */
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useLocation, useParams } from 'react-router';
import { Button, EmptyState, LinkButton, LoadingState, PageHeader } from '../admin/components/ui';
import { loadGuide, type GuideTopic } from './guide';
import { HelpMarkdown } from './HelpMarkdown';
import { extractHeadings, HELP_BASE_PATH } from './markdown';
import './help.css';

const topicPath = (slug: string) => `${HELP_BASE_PATH}/${slug}`;

/**
 * Loaded guides per language. A plain promise cache instead of TanStack Query:
 * importing useQuery here makes the bundler split it out of the public entry.
 */
const guideCache = new Map<string, Promise<GuideTopic[]>>();

function useGuide(lang: string) {
  const [state, setState] = useState<{ lang: string; topics?: GuideTopic[]; error?: unknown }>({ lang });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let promise = guideCache.get(lang);
    if (!promise) {
      promise = loadGuide(lang);
      guideCache.set(lang, promise);
      promise.catch(() => guideCache.delete(lang));
    }
    promise.then(
      (topics) => active && setState({ lang, topics }),
      (error: unknown) => active && setState({ lang, error }),
    );
    return () => {
      active = false;
    };
  }, [lang, attempt]);

  const current = state.lang === lang ? state : { lang };
  return {
    topics: current.topics,
    error: current.error,
    retry: () => {
      setState({ lang });
      setAttempt((n) => n + 1);
    },
  };
}

export default function HelpPage() {
  const { t, i18n } = useTranslation('help');
  const lang = i18n.resolvedLanguage ?? 'en';
  const { topic: slug } = useParams();
  const guide = useGuide(lang);

  if (guide.error) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 p-10 text-center text-sm">
        <p className="text-status-major-outage">{t('loadError')}</p>
        <Button size="sm" onClick={guide.retry}>
          {t('common:actions.retry')}
        </Button>
      </div>
    );
  }
  if (!guide.topics) return <LoadingState />;

  const topics = guide.topics;
  if (!slug) return <HelpIndex topics={topics} />;

  const index = topics.findIndex((topic) => topic.slug === slug);
  if (index === -1) {
    return (
      <EmptyState action={<LinkButton to={HELP_BASE_PATH}>{t('allTopics')}</LinkButton>}>{t('notFound')}</EmptyState>
    );
  }
  return <HelpTopic topics={topics} index={index} lang={lang} />;
}

function HelpIndex({ topics }: { topics: GuideTopic[] }) {
  const { t } = useTranslation('help');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <ul className="grid gap-3 sm:grid-cols-2" aria-label={t('topics')}>
        {topics.map((topic) => (
          <li key={topic.slug}>
            <Link
              to={topicPath(topic.slug)}
              className="flex h-full flex-col gap-1 rounded-xl border border-border bg-surface p-4 transition hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span className="font-medium">{topic.title}</span>
              <span className="text-sm text-muted">{topic.summary}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function HelpTopic({ topics, index, lang }: { topics: GuideTopic[]; index: number; lang: string }) {
  const { t } = useTranslation('help');
  const topic = topics[index]!;
  const previous = topics[index - 1];
  const next = topics[index + 1];
  const sections = useMemo(() => extractHeadings(topic.markdown).filter((h) => h.depth === 2), [topic.markdown]);
  const { hash } = useLocation();

  // Jump to the heading named in the URL hash, otherwise start at the top.
  useEffect(() => {
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [topic, hash]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${topic.title} · ${t('title')}`;
    return () => {
      document.title = previousTitle;
    };
  }, [topic.title, t]);

  return (
    <div className="lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-10">
      <aside className="hidden lg:block">
        <nav aria-label={t('topics')} className="sticky top-8 flex max-h-[calc(100dvh-4rem)] flex-col gap-3 overflow-y-auto pb-4">
          <Link to={HELP_BASE_PATH} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
            <ChevronLeft aria-hidden className="size-4" />
            {t('allTopics')}
          </Link>
          <ul className="flex flex-col gap-0.5 text-sm">
            {topics.map((item) => (
              <li key={item.slug}>
                <NavLink
                  to={topicPath(item.slug)}
                  className={({ isActive }) =>
                    clsx(
                      'block rounded-lg px-2.5 py-1.5 transition focus-visible:outline-2 focus-visible:outline-accent',
                      isActive ? 'bg-surface-2 font-medium text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
                    )
                  }
                >
                  {item.title}
                </NavLink>
                {item.slug === topic.slug && sections.length > 0 && (
                  <ul aria-label={t('onThisPage')} className="my-1 ml-3 flex flex-col border-l border-border">
                    {sections.map((section) => (
                      <li key={section.id}>
                        <Link
                          to={{ hash: section.id }}
                          className={clsx(
                            '-ml-px block border-l py-1 pr-2 pl-3 text-xs transition hover:text-fg',
                            hash === `#${section.id}` ? 'border-accent text-fg' : 'border-transparent text-muted',
                          )}
                        >
                          {section.text}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <article className="min-w-0">
        <Link to={HELP_BASE_PATH} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg lg:hidden">
          <ChevronLeft aria-hidden className="size-4" />
          {t('allTopics')}
        </Link>
        {topic.lang !== lang && (
          <p role="note" className="mb-4 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
            {t('fallbackNotice')}
          </p>
        )}
        <div className="rounded-xl border border-border bg-surface p-5 sm:p-8" lang={topic.lang}>
          <HelpMarkdown markdown={topic.markdown} lang={lang} />
        </div>
        <nav aria-label={`${t('previous')} / ${t('next')}`} className="mt-4 flex flex-wrap justify-between gap-3 text-sm">
          {previous ? (
            <Link to={topicPath(previous.slug)} className="group flex flex-col rounded-lg px-1 py-1">
              <span className="text-xs text-muted">{t('previous')}</span>
              <span className="inline-flex items-center gap-1 font-medium group-hover:text-accent">
                <ChevronLeft aria-hidden className="size-4" />
                {previous.title}
              </span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link to={topicPath(next.slug)} className="group ml-auto flex flex-col items-end rounded-lg px-1 py-1 text-right">
              <span className="text-xs text-muted">{t('next')}</span>
              <span className="inline-flex items-center gap-1 font-medium group-hover:text-accent">
                {next.title}
                <ChevronRight aria-hidden className="size-4" />
              </span>
            </Link>
          )}
        </nav>
      </article>
    </div>
  );
}
