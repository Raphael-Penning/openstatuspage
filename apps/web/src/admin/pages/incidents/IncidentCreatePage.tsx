import {
  IncidentCreateInput,
  type AdminIncident,
  type IncidentImpact,
  type IncidentStatus,
} from '@openstatuspage/shared';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api } from '../../../lib/api';
import {
  CheckboxField,
  DateTimeField,
  FormErrorSummary,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/fields';
import { NotifySubscribersField } from '../../components/NotifySubscribersField';
import { AffectedServicesPicker, defaultImpactStatus, LocationsPicker, type AffectedValue } from '../../components/pickers';
import { Button, Card, LinkButton, PageHeader } from '../../components/ui';
import { localInputToIso, nowLocalInput } from '../../lib/datetime';
import { useOptions } from '../../lib/format';
import { useAdminMutation } from '../../lib/queries';
import { useForm } from '../../lib/useForm';

interface Values {
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  message: string;
  startedAt: string;
  isPublic: boolean;
  affectedServices: AffectedValue[];
  locationIds: string[];
  notify: boolean;
}

export default function IncidentCreatePage() {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const opts = useOptions();
  const form = useForm<Values>(() => ({
    title: '',
    status: 'investigating',
    impact: 'minor',
    message: '',
    startedAt: nowLocalInput(),
    isPublic: true,
    affectedServices: [],
    locationIds: [],
    notify: true,
  }));
  const v = form.values;

  const create = useAdminMutation((body: IncidentCreateInput) => api.post<AdminIncident>('/api/admin/incidents', body), {
    success: t('incidents.created'),
    onSuccess: (incident) => navigate(`/admin/incidents/${incident.id}`),
    onError: form.applyServerError,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const startedAt = localInputToIso(v.startedAt);
    if (v.startedAt && !startedAt) {
      form.setErrors({ startedAt: { key: 'validation.datetime' } });
      return;
    }
    const body = form.validate(IncidentCreateInput, {
      title: v.title.trim(),
      status: v.status,
      impact: v.impact,
      message: v.message.trim(),
      startedAt,
      isPublic: v.isPublic,
      affectedServices: v.affectedServices,
      locationIds: v.locationIds,
      notify: v.notify,
    });
    if (body) create.mutate(body);
  };

  return (
    <>
      <PageHeader title={t('incidents.new')} back={{ to: '/admin/incidents', label: t('incidents.title') }} />
      <form onSubmit={submit} noValidate>
        <Card>
          <div className="grid gap-5 p-4 sm:p-6 md:grid-cols-2">
            <TextField
              className="md:col-span-2"
              label={t('incidents.fields.title')}
              value={v.title}
              onValue={(x) => form.set('title', x)}
              error={form.error('title')}
              placeholder={t('incidents.titlePlaceholder')}
              required
              maxLength={200}
            />
            <SelectField
              label={t('incidents.fields.status')}
              value={v.status}
              onValue={(x) => form.set('status', x)}
              options={opts.incidentStatus}
              error={form.error('status')}
            />
            <SelectField
              label={t('incidents.fields.impact')}
              value={v.impact}
              onValue={(x) => form.set('impact', x)}
              options={opts.incidentImpact}
              help={t('incidents.impactHelp')}
              error={form.error('impact')}
            />
            <TextAreaField
              className="md:col-span-2"
              label={t('incidents.fields.message')}
              help={t('incidents.messageHelp')}
              value={v.message}
              onValue={(x) => form.set('message', x)}
              error={form.error('message')}
              rows={5}
              required
            />
            <DateTimeField
              label={t('incidents.fields.startedAt')}
              value={v.startedAt}
              onValue={(x) => form.set('startedAt', x)}
              error={form.error('startedAt')}
            />
            <div className="flex items-end">
              <CheckboxField
                label={t('form.isPublic')}
                help={t('incidents.publicHelp')}
                checked={v.isPublic}
                onChecked={(x) => form.set('isPublic', x)}
              />
            </div>
            <NotifySubscribersField
              className="md:col-span-2"
              context="incident"
              isPublic={v.isPublic}
              checked={v.notify}
              onChecked={(x) => form.set('notify', x)}
            />
            <AffectedServicesPicker
              value={v.affectedServices}
              onChange={(x) => form.set('affectedServices', x)}
              defaultStatus={defaultImpactStatus(v.impact)}
              error={form.error('affectedServices')}
            />
            <LocationsPicker
              label={t('incidents.affectedLocations')}
              help={t('incidents.affectedLocationsHelp')}
              value={v.locationIds}
              onChange={(x) => form.set('locationIds', x)}
              error={form.error('locationIds')}
            />
          </div>
          <div className="flex flex-col gap-3 border-t border-border p-4 sm:flex-row sm:items-center sm:justify-end">
            <FormErrorSummary errors={form.errors} />
            <div className="flex justify-end gap-2">
              <LinkButton to="/admin/incidents">{t('common:actions.cancel')}</LinkButton>
              <Button type="submit" variant="primary" pending={create.isPending}>
                {t('incidents.create')}
              </Button>
            </div>
          </div>
        </Card>
      </form>
    </>
  );
}
