import { useTranslation } from 'react-i18next';
import { LinkButton } from '../components/ui';

export default function AdminNotFound() {
  const { t } = useTranslation('admin');
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <p className="text-5xl font-semibold text-muted">404</p>
      <p>{t('common:notFound')}</p>
      <LinkButton to="/admin">{t('nav.dashboard')}</LinkButton>
    </div>
  );
}
