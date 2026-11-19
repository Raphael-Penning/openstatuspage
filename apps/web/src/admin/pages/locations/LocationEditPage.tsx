import { LocationInput, type AdminLocation, type Region } from '@openstatuspage/shared';
import { Info, Trash2 } from 'lucide-react';
import { useMemo, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../../../lib/api';
import { ConfirmDialog, useConfirm } from '../../components/Dialog';
import { CheckboxField, FormErrorSummary, SelectField, TextAreaField, TextField } from '../../components/fields';
import { Button, Card, LinkButton, PageHeader, QueryState, StatusBadge } from '../../components/ui';
import { countryOptions, parseCoordinate } from '../../lib/countries';
import { useFormat, useOptions } from '../../lib/format';
import { nextSortOrder } from '../../lib/ordering';
import { useAdminMutation, useLocation, useLocations, useServices } from '../../lib/queries';
import { LOCATION_DOCUMENT } from '../../lib/documents';
import { useForm } from '../../lib/useForm';
import { useIsAdmin } from '../../session';

interface Values {
  name: string;
  slug: string;
  code: string;
  city: string;
  country: string;
  region: Region;
  latitude: string;
  longitude: string;
  description: string;
  isPublic: boolean;
  statusOverride: string;
}

const toValues = (l?: AdminLocation): Values => ({
  name: l?.name ?? '',
  slug: l?.slug ?? '',
  code: l?.code ?? '',
  city: l?.city ?? '',
  country: l?.country ?? '',
  region: l?.region ?? 'europe',
  latitude: l?.latitude != null ? String(l.latitude) : '',
  longitude: l?.longitude != null ? String(l.longitude) : '',
  description: l?.description ?? '',
  isPublic: l?.isPublic ?? true,
  statusOverride: l?.statusOverride ?? '',
});

export default function LocationEditPage() {
  const { id } = useParams();
  const { t } = useTranslation('admin');
  const location = useLocation(id);
  const all = useLocations();
  if (!id) {
    if (!all.data) return <QueryState query={all}>{() => null}</QueryState>;
    return <LocationForm key="new" sortOrder={nextSortOrder(all.data)} />;
  }
  if (location.data) return <LocationForm key={location.data.id} location={location.data} sortOrder={location.data.sortOrder} />;
  return (
    <>
      <PageHeader title={t('locations.title')} back={{ to: '/admin/locations', label: t('locations.title') }} />
      <QueryState query={location}>{() => null}</QueryState>
    </>
  );
}

function LocationForm({ location, sortOrder }: { location?: AdminLocation; sortOrder: number }) {
  const { t } = useTranslation('admin');
  const isAdmin = useIsAdmin();
  const readOnly = !isAdmin;
  const navigate = useNavigate();
  const confirm = useConfirm();
  const fmt = useFormat();
  const opts = useOptions();
  const services = useServices();
  const form = useForm<Values>(() => toValues(location));
  const v = form.values;
  const countries = useMemo(() => [{ value: '', label: t('locations.noCountry') }, ...countryOptions(fmt.locale)], [fmt.locale, t]);

  const save = useAdminMutation(
    (body: LocationInput) =>
      location
        ? api.patch<AdminLocation>(`/api/admin/locations/${location.id}`, body, { ...LOCATION_DOCUMENT, id: location.id })
        : api.post<AdminLocation>('/api/admin/locations', body, LOCATION_DOCUMENT),
    {
      success: location ? t('locations.saved') : t('locations.created'),
      onSuccess: (l) => {
        if (!location) void navigate(`/admin/locations/${l.id}`, { replace: true });
        else form.setValues(toValues(l));
      },
      onError: form.applyServerError,
    },
  );
  const remove = useAdminMutation(() => api.delete(`/api/admin/locations/${location!.id}`), {
    success: t('locations.deleted'),
    onSuccess: () => navigate('/admin/locations', { replace: true }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const latitude = parseCoordinate(v.latitude);
    const longitude = parseCoordinate(v.longitude);
    const empty = (s: string) => s.trim() || null;
    const body = form.validate(LocationInput, {
      name: v.name.trim(),
      slug: empty(v.slug),
      code: empty(v.code),
      city: empty(v.city),
      country: v.country || null,
      region: v.region,
      latitude,
      longitude,
      description: empty(v.description),
      sortOrder,
      isPublic: v.isPublic,
      statusOverride: v.statusOverride || null,
    });
    if (body) save.mutate(body);
  };

  const locationServices = (services.data ?? []).filter((s) => s.locationIds.includes(location?.id ?? ''));

  return (
    <>
      <PageHeader
        back={{ to: '/admin/locations', label: t('locations.title') }}
        title={location ? location.name : t('locations.new')}
        description={location && <StatusBadge status={location.status} />}
        actions={
          location &&
          isAdmin && (
            <Button
              variant="danger"
              icon={Trash2}
              onClick={() =>
                confirm.ask({
                  title: t('locations.deleteTitle'),
                  message: t('locations.deleteConfirm', { name: location.name }),
                  action: () => remove.mutate(),
                })
              }
            >
              {t('common:actions.delete')}
            </Button>
          )
        }
      />
      {readOnly && (
        <p className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted">
          <Info aria-hidden className="size-4 shrink-0" />
          {t('readOnlyNotice')}
        </p>
      )}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <form onSubmit={submit} noValidate>
          <fieldset disabled={readOnly} className="contents">
            <Card>
              <div className="grid gap-5 p-4 sm:p-6 md:grid-cols-2">
                <TextField label={t('locations.fields.name')} value={v.name} onValue={(x) => form.set('name', x)} error={form.error('name')} required />
                <TextField
                  label={t('form.slug')}
                  value={v.slug}
                  onValue={(x) => form.set('slug', x)}
                  error={form.error('slug')}
                  help={t('form.slugHelp')}
                  placeholder={t('form.slugPlaceholder')}
                />
                <TextField
                  label={t('locations.fields.code')}
                  value={v.code}
                  onValue={(x) => form.set('code', x)}
                  error={form.error('code')}
                  help={t('locations.codeHelp')}
                  placeholder="FRA-1"
                  maxLength={32}
                />
                <TextField label={t('locations.fields.city')} value={v.city} onValue={(x) => form.set('city', x)} error={form.error('city')} />
                <SelectField
                  label={t('locations.fields.country')}
                  value={v.country}
                  onValue={(x) => form.set('country', x)}
                  options={countries}
                  error={form.error('country')}
                />
                <SelectField
                  label={t('locations.fields.region')}
                  value={v.region}
                  onValue={(x) => form.set('region', x)}
                  options={opts.region}
                  help={t('locations.regionHelp')}
                  error={form.error('region')}
                />
                <TextField
                  label={t('locations.fields.latitude')}
                  inputMode="decimal"
                  value={v.latitude}
                  onValue={(x) => form.set('latitude', x)}
                  error={form.error('latitude')}
                  placeholder="50.11"
                  help={t('locations.coordinatesHelp')}
                />
                <TextField
                  label={t('locations.fields.longitude')}
                  inputMode="decimal"
                  value={v.longitude}
                  onValue={(x) => form.set('longitude', x)}
                  error={form.error('longitude')}
                  placeholder="8.68"
                />
                <TextAreaField
                  className="md:col-span-2"
                  label={t('locations.fields.description')}
                  value={v.description}
                  onValue={(x) => form.set('description', x)}
                  error={form.error('description')}
                  rows={2}
                />
                <SelectField
                  label={t('locations.fields.statusOverride')}
                  value={v.statusOverride}
                  onValue={(x) => form.set('statusOverride', x)}
                  options={[{ value: '', label: t('locations.automatic') }, ...opts.serviceStatus]}
                  help={t('locations.statusOverrideHelp')}
                  error={form.error('statusOverride')}
                />
                <div className="flex items-end">
                  <CheckboxField
                    label={t('form.isPublic')}
                    help={t('locations.publicHelp')}
                    checked={v.isPublic}
                    onChecked={(x) => form.set('isPublic', x)}
                  />
                </div>
              </div>
              {!readOnly && (
                <div className="flex flex-col gap-3 border-t border-border p-4 sm:flex-row sm:items-center sm:justify-end">
                  <FormErrorSummary errors={form.errors} />
                  <div className="flex justify-end gap-2">
                    <LinkButton to="/admin/locations">{t('common:actions.cancel')}</LinkButton>
                    <Button type="submit" variant="primary" pending={save.isPending}>
                      {location ? t('common:actions.save') : t('common:actions.create')}
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          </fieldset>
        </form>
        {location && (
          <Card title={t('locations.services')} className="self-start">
            {locationServices.length === 0 ? (
              <p className="p-4 text-sm text-muted">{t('locations.noServices')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {locationServices.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                    <Link to={`/admin/services/${s.id}`} className="hover:text-accent">
                      {s.name}
                    </Link>
                    <StatusBadge status={s.status} />
                  </li>
                ))}
              </ul>
            )}
            <p className="border-t border-border px-4 py-2 text-xs text-muted">{t('locations.servicesHint')}</p>
          </Card>
        )}
      </div>
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </>
  );
}
