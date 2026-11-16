import { SearchX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useDocumentTitle } from '../hooks/dom';

/** In-layout "not found" state for unknown routes and entities. */
export function NotFoundState({ message }: { message?: string }) {
  const { t } = useTranslation('public');
  useDocumentTitle(t('notFound.title'));
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 text-center">
      <SearchX aria-hidden className="size-10 text-muted" />
      <h1 className="text-2xl font-semibold">{t('notFound.title')}</h1>
      <p className="max-w-md text-muted">{message ?? t('notFound.description')}</p>
      <Link to="/" className="rounded-full bg-[color:var(--osp-accent-solid,var(--accent))] px-5 py-2 text-sm font-medium text-[color:var(--osp-accent-solid-fg,var(--accent-fg))] hover:opacity-90">
        {t('notFound.home')}
      </Link>
    </div>
  );
}
