import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

export function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-5xl font-semibold text-muted">404</p>
      <p>{t('notFound')}</p>
      <Link to="/" className="text-accent hover:underline">
        {t('actions.back')}
      </Link>
    </div>
  );
}
