/**
 * "Notify subscribers" checkbox of the incident and maintenance forms
 * (maps to the `notify` field of the inputs).
 */
import { useTranslation } from 'react-i18next';
import { CheckboxField } from './fields';

type Context = 'incident' | 'update' | 'maintenance' | 'maintenanceEdit';

export function NotifySubscribersField({
  checked,
  onChecked,
  isPublic,
  context,
  className,
}: {
  checked: boolean;
  onChecked: (v: boolean) => void;
  /** Hidden incidents and maintenance never notify; the flag is kept anyway. */
  isPublic: boolean;
  context: Context;
  className?: string;
}) {
  const { t } = useTranslation('admin');
  const what = {
    incident: t('notify.incidentHelp'),
    update: t('notify.updateHelp'),
    maintenance: t('notify.maintenanceHelp'),
    maintenanceEdit: t('notify.maintenanceEditHelp'),
  }[context];
  return (
    <CheckboxField
      className={className}
      label={t('notify.label')}
      help={
        <>
          {isPublic ? what : t('notify.hiddenHelp')} {t('notify.enabledHint')}
        </>
      }
      checked={checked}
      onChecked={onChecked}
    />
  );
}
