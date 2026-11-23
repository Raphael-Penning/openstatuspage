import { SettingsInput, type AdminPageSettings, type PublicPageSettings } from '@openstatuspage/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, TriangleAlert, X } from 'lucide-react';
import type { CSSProperties, FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { LANGUAGES } from '../../lib/i18n';
import { CheckboxField, FormErrorSummary, inputClass, SelectField, TextAreaField, TextField } from '../components/fields';
import { NotificationStatusPanel } from '../components/NotificationStatusPanel';
import { UploadButton } from '../components/UploadButton';
import { Button, Card, IconButton, PageHeader, QueryState } from '../components/ui';
import { moveId } from '../lib/ordering';
import { useAdminMutation, useSettings } from '../lib/queries';
import { useForm } from '../lib/useForm';

interface FooterLinkRow {
  key: string;
  label: string;
  url: string;
}

interface Values {
  siteName: string;
  description: string;
  logoUrl: string;
  faviconUrl: string;
  accentColor: string;
  defaultLocale: 'en' | 'de';
  defaultTheme: 'system' | 'dark' | 'light';
  footerLinks: FooterLinkRow[];
  supportUrl: string;
  showLocations: boolean;
  showUptime: boolean;
  uptimeDays: string;
  recentIncidentDays: string;
  emailSubscriptionsEnabled: boolean;
  maintenanceReminderHours: string;
  imprintUrl: string;
  imprintLabel: string;
  privacyUrl: string;
  privacyLabel: string;
  accessibilityUrl: string;
  accessibilityLabel: string;
  copyrightText: string;
  brandUrl: string;
  showPoweredBy: boolean;
  infoLinkUrl: string;
  infoLinkLabel: string;
  utmEnabled: boolean;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  analyticsEnabled: boolean;
  analyticsWebsiteId: string;
  analyticsDomains: string;
  analyticsRespectDnt: boolean;
  analyticsForwardIp: boolean;
}

/** Legal links of the footer: settings keys and the public default label. */
const LEGAL = [
  { key: 'imprint', url: 'imprintUrl', label: 'imprintLabel', placeholder: 'https://www.example.com/imprint' },
  { key: 'privacy', url: 'privacyUrl', label: 'privacyLabel', placeholder: 'https://www.example.com/privacy' },
  { key: 'accessibility', url: 'accessibilityUrl', label: 'accessibilityLabel', placeholder: 'https://www.example.com/accessibility' },
] as const;

let rowKey = 0;
const nextKey = () => `link-${++rowKey}`;

const toValues = (s: PublicPageSettings): Values => ({
  siteName: s.siteName,
  description: s.description,
  logoUrl: s.logoUrl ?? '',
  faviconUrl: s.faviconUrl ?? '',
  accentColor: s.accentColor ?? '',
  defaultLocale: s.defaultLocale,
  defaultTheme: s.defaultTheme,
  footerLinks: s.footerLinks.map((l) => ({ ...l, key: nextKey() })),
  supportUrl: s.supportUrl ?? '',
  showLocations: s.showLocations,
  showUptime: s.showUptime,
  uptimeDays: String(s.uptimeDays),
  recentIncidentDays: String(s.recentIncidentDays),
  emailSubscriptionsEnabled: s.emailSubscriptionsEnabled,
  maintenanceReminderHours: String(s.maintenanceReminderHours),
  imprintUrl: s.imprintUrl ?? '',
  imprintLabel: s.imprintLabel,
  privacyUrl: s.privacyUrl ?? '',
  privacyLabel: s.privacyLabel,
  accessibilityUrl: s.accessibilityUrl ?? '',
  accessibilityLabel: s.accessibilityLabel,
  copyrightText: s.copyrightText,
  brandUrl: s.brandUrl ?? '',
  showPoweredBy: s.showPoweredBy,
  infoLinkUrl: s.infoLinkUrl ?? '',
  infoLinkLabel: s.infoLinkLabel,
  utmEnabled: s.utmEnabled,
  utmSource: s.utmSource,
  utmMedium: s.utmMedium,
  utmCampaign: s.utmCampaign,
  analyticsEnabled: s.analyticsEnabled,
  analyticsWebsiteId: s.analyticsWebsiteId ?? '',
  analyticsDomains: s.analyticsDomains,
  analyticsRespectDnt: s.analyticsRespectDnt,
  analyticsForwardIp: s.analyticsForwardIp,
});

const HEX = /^#[0-9a-fA-F]{6}$/;
/** The accent of the built-in default theme (shown while no override is set). */
const DEFAULT_ACCENT = '#7c6cf2';

export default function SettingsPage() {
  const { t } = useTranslation('admin');
  const settings = useSettings();
  return (
    <>
      <PageHeader title={t('settings.title')} description={t('settings.description')} />
      <QueryState query={settings}>{(s) => <SettingsForm settings={s} />}</QueryState>
    </>
  );
}

function SettingsForm({ settings }: { settings: AdminPageSettings }) {
  const { t } = useTranslation('admin');
  const queryClient = useQueryClient();
  const form = useForm<Values>(() => toValues(settings));
  const v = form.values;

  const save = useAdminMutation((body: SettingsInput) => api.patch<AdminPageSettings>('/api/admin/settings', body, { type: 'settings', id: 'site' }), {
    success: t('settings.saved'),
    onSuccess: async (saved) => {
      form.setValues(toValues(saved));
      // Branding (accent color, site name) of the admin UI comes from the public settings.
      await queryClient.invalidateQueries({ queryKey: ['public'] });
    },
    onError: form.applyServerError,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const empty = (s: string) => s.trim() || null;
    const int = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));
    const body = form.validate(SettingsInput, {
      siteName: v.siteName.trim(),
      description: v.description.trim(),
      logoUrl: empty(v.logoUrl),
      faviconUrl: empty(v.faviconUrl),
      accentColor: empty(v.accentColor),
      defaultLocale: v.defaultLocale,
      defaultTheme: v.defaultTheme,
      footerLinks: v.footerLinks.map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
      supportUrl: empty(v.supportUrl),
      showLocations: v.showLocations,
      showUptime: v.showUptime,
      uptimeDays: int(v.uptimeDays),
      recentIncidentDays: int(v.recentIncidentDays),
      emailSubscriptionsEnabled: v.emailSubscriptionsEnabled,
      maintenanceReminderHours: int(v.maintenanceReminderHours),
      imprintUrl: empty(v.imprintUrl),
      imprintLabel: v.imprintLabel.trim(),
      privacyUrl: empty(v.privacyUrl),
      privacyLabel: v.privacyLabel.trim(),
      accessibilityUrl: empty(v.accessibilityUrl),
      accessibilityLabel: v.accessibilityLabel.trim(),
      copyrightText: v.copyrightText.trim(),
      brandUrl: empty(v.brandUrl),
      showPoweredBy: v.showPoweredBy,
      infoLinkUrl: empty(v.infoLinkUrl),
      infoLinkLabel: v.infoLinkLabel.trim(),
      utmEnabled: v.utmEnabled,
      utmSource: v.utmSource.trim(),
      utmMedium: v.utmMedium.trim(),
      utmCampaign: v.utmCampaign.trim(),
      analyticsEnabled: v.analyticsEnabled,
      analyticsWebsiteId: empty(v.analyticsWebsiteId),
      analyticsDomains: v.analyticsDomains,
      analyticsRespectDnt: v.analyticsRespectDnt,
      analyticsForwardIp: v.analyticsForwardIp,
    });
    if (body) save.mutate(body);
  };

  const links = v.footerLinks;
  const setLinks = (next: FooterLinkRow[]) => form.set('footerLinks', next);
  const previewColor = HEX.test(v.accentColor) ? v.accentColor : (settings.accentColor ?? DEFAULT_ACCENT);

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <Card title={t('settings.sections.branding')}>
        <div className="grid gap-5 p-4 sm:p-6 md:grid-cols-2">
          <TextField
            label={t('settings.fields.siteName')}
            value={v.siteName}
            onValue={(x) => form.set('siteName', x)}
            error={form.error('siteName')}
            required
            maxLength={120}
          />
          <TextField
            label={t('settings.fields.supportUrl')}
            type="url"
            value={v.supportUrl}
            onValue={(x) => form.set('supportUrl', x)}
            error={form.error('supportUrl')}
            placeholder="https://support.example.com"
            help={t('settings.supportUrlHelp')}
          />
          <TextAreaField
            className="md:col-span-2"
            label={t('settings.fields.description')}
            value={v.description}
            onValue={(x) => form.set('description', x)}
            error={form.error('description')}
            rows={2}
            maxLength={500}
          />
          {(['logoUrl', 'faviconUrl'] as const).map((field) => (
            <div key={field} className="flex flex-col gap-2">
              <TextField
                label={t(`settings.fields.${field}`)}
                value={v[field]}
                onValue={(x) => form.set(field, x)}
                error={form.error(field)}
                placeholder={field === 'logoUrl' ? 'https://www.example.com/logo.png' : 'https://www.example.com/favicon.ico'}
                help={t('settings.imageUrlHelp')}
              />
              <div className="flex items-center gap-3">
                <UploadButton
                  size="sm"
                  label={t(field === 'logoUrl' ? 'settings.uploadLogo' : 'settings.uploadFavicon')}
                  onUploaded={(u) => form.set(field, u.url)}
                />
                {v[field].startsWith('/uploads/') && (
                  <img src={v[field]} alt="" className="h-8 w-auto max-w-32 rounded border border-border bg-bg object-contain" />
                )}
              </div>
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="accent-hex" className="text-sm font-medium">
              {t('settings.fields.accentColor')}
            </label>
            <div className="flex gap-2">
              <input
                type="color"
                aria-label={t('settings.pickColor')}
                value={previewColor}
                onChange={(e) => form.set('accentColor', e.target.value)}
                className="h-9 w-12 shrink-0 cursor-pointer rounded-lg border border-border bg-bg p-1"
              />
              <input
                id="accent-hex"
                className={`${inputClass} font-mono`}
                value={v.accentColor}
                onChange={(e) => form.set('accentColor', e.target.value)}
                aria-invalid={form.error('accentColor') ? true : undefined}
                aria-describedby="accent-hex-help"
                maxLength={7}
                spellCheck={false}
              />
            </div>
            <p id="accent-hex-help" className={`text-xs ${form.error('accentColor') ? 'text-status-major-outage-text' : 'text-muted'}`}>
              {form.error('accentColor') ?? t('settings.accentHelp')}
            </p>
          </div>
          <div
            className="flex flex-col gap-2 rounded-xl border border-border bg-bg p-4"
            style={{ '--accent': previewColor } as CSSProperties}
            aria-label={t('settings.preview')}
          >
            <p className="text-xs font-medium text-muted">{t('settings.preview')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg">
                {t('settings.previewButton')}
              </span>
              <span className="text-sm font-medium text-accent underline">{t('settings.previewLink')}</span>
              <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">{v.siteName || '—'}</span>
            </div>
          </div>
        </div>
      </Card>

      <Card title={t('settings.sections.display')}>
        <div className="grid gap-5 p-4 sm:p-6 md:grid-cols-2">
          <SelectField
            label={t('settings.fields.defaultLocale')}
            value={v.defaultLocale}
            onValue={(x) => form.set('defaultLocale', x)}
            options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
            help={t('settings.defaultLocaleHelp')}
          />
          <SelectField
            label={t('settings.fields.defaultTheme')}
            value={v.defaultTheme}
            onValue={(x) => form.set('defaultTheme', x)}
            options={(['system', 'light', 'dark'] as const).map((p) => ({ value: p, label: t(`common:theme.${p}`) }))}
          />
          <CheckboxField
            label={t('settings.fields.showUptime')}
            help={t('settings.showUptimeHelp')}
            checked={v.showUptime}
            onChecked={(x) => form.set('showUptime', x)}
          />
          <CheckboxField
            label={t('settings.fields.showLocations')}
            help={t('settings.showLocationsHelp')}
            checked={v.showLocations}
            onChecked={(x) => form.set('showLocations', x)}
          />
          <TextField
            label={t('settings.fields.uptimeDays')}
            type="number"
            inputMode="numeric"
            min={7}
            max={180}
            value={v.uptimeDays}
            onValue={(x) => form.set('uptimeDays', x)}
            error={form.error('uptimeDays')}
            help={t('settings.uptimeDaysHelp')}
          />
          <TextField
            label={t('settings.fields.recentIncidentDays')}
            type="number"
            inputMode="numeric"
            min={1}
            max={90}
            value={v.recentIncidentDays}
            onValue={(x) => form.set('recentIncidentDays', x)}
            error={form.error('recentIncidentDays')}
            help={t('settings.recentIncidentDaysHelp')}
          />
        </div>
      </Card>

      <Card title={t('settings.sections.email')}>
        <div className="grid gap-5 p-4 sm:p-6 md:grid-cols-2">
          <CheckboxField
            label={t('settings.fields.emailSubscriptionsEnabled')}
            help={t('settings.emailSubscriptionsHelp')}
            checked={v.emailSubscriptionsEnabled}
            onChecked={(x) => form.set('emailSubscriptionsEnabled', x)}
          />
          <TextField
            label={t('settings.fields.maintenanceReminderHours')}
            type="number"
            inputMode="numeric"
            min={0}
            max={168}
            value={v.maintenanceReminderHours}
            onValue={(x) => form.set('maintenanceReminderHours', x)}
            error={form.error('maintenanceReminderHours')}
            help={t('settings.maintenanceReminderHoursHelp')}
          />
        </div>
        <div className="border-t border-border p-4 sm:p-6">
          <NotificationStatusPanel enabled={v.emailSubscriptionsEnabled} />
        </div>
      </Card>

      <Card
        title={t('settings.sections.footer')}
        actions={
          <Button
            size="sm"
            icon={Plus}
            disabled={links.length >= 10}
            onClick={() => setLinks([...links, { key: nextKey(), label: '', url: '' }])}
          >
            {t('settings.addLink')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 p-4 sm:p-6">
          {links.length === 0 && <p className="text-sm text-muted">{t('settings.noLinks')}</p>}
          {links.map((link, i) => (
            <div key={link.key} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-start">
              <TextField
                label={t('settings.linkLabel')}
                value={link.label}
                onValue={(x) => setLinks(links.map((l) => (l.key === link.key ? { ...l, label: x } : l)))}
                error={form.error(`footerLinks.${i}.label`)}
                maxLength={60}
              />
              <TextField
                label={t('settings.linkUrl')}
                type="url"
                value={link.url}
                onValue={(x) => setLinks(links.map((l) => (l.key === link.key ? { ...l, url: x } : l)))}
                error={form.error(`footerLinks.${i}.url`)}
                placeholder="https://www.example.com/imprint"
              />
              <div className="flex gap-1 sm:pt-7">
                <IconButton
                  icon={ArrowUp}
                  label={t('reorder.up', { name: link.label })}
                  disabled={i === 0}
                  onClick={() => {
                    const order = moveId(links.map((l) => l.key), i, -1);
                    setLinks(order.map((k) => links.find((l) => l.key === k)!));
                  }}
                />
                <IconButton
                  icon={ArrowDown}
                  label={t('reorder.down', { name: link.label })}
                  disabled={i === links.length - 1}
                  onClick={() => {
                    const order = moveId(links.map((l) => l.key), i, 1);
                    setLinks(order.map((k) => links.find((l) => l.key === k)!));
                  }}
                />
                <IconButton
                  icon={X}
                  label={t('settings.removeLink', { name: link.label })}
                  onClick={() => setLinks(links.filter((l) => l.key !== link.key))}
                />
              </div>
            </div>
          ))}
          {form.errors.footerLinks && <p className="text-xs text-status-major-outage-text">{form.error('footerLinks')}</p>}
        </div>
      </Card>

      <Card title={t('settings.sections.legal')}>
        <div className="flex flex-col gap-3 p-4 sm:p-6">
          <p className="text-sm text-muted">{t('settings.legalHelp')}</p>
          {LEGAL.map((l) => (
            <div key={l.key} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] sm:items-start">
              <TextField
                label={t(`settings.fields.${l.url}`)}
                type="url"
                value={v[l.url]}
                onValue={(x) => form.set(l.url, x)}
                error={form.error(l.url)}
                placeholder={l.placeholder}
              />
              <TextField
                label={t(`settings.fields.${l.label}`)}
                value={v[l.label]}
                onValue={(x) => form.set(l.label, x)}
                error={form.error(l.label)}
                help={t('settings.legalLabelHelp', { label: t(`settings.defaultLabels.${l.key}`) })}
                maxLength={60}
              />
            </div>
          ))}
        </div>
      </Card>

      <Card title={t('settings.sections.brand')}>
        <div className="grid gap-5 p-4 sm:p-6 md:grid-cols-2">
          <TextField
            label={t('settings.fields.copyrightText')}
            value={v.copyrightText}
            onValue={(x) => form.set('copyrightText', x)}
            error={form.error('copyrightText')}
            placeholder="© {year} Example Ltd."
            help={t('settings.copyrightHelp')}
            maxLength={200}
          />
          <TextField
            label={t('settings.fields.brandUrl')}
            type="url"
            value={v.brandUrl}
            onValue={(x) => form.set('brandUrl', x)}
            error={form.error('brandUrl')}
            placeholder="https://www.example.com"
            help={t('settings.brandUrlHelp')}
          />
          <CheckboxField
            label={t('settings.fields.showPoweredBy')}
            help={t('settings.showPoweredByHelp')}
            checked={v.showPoweredBy}
            onChecked={(x) => form.set('showPoweredBy', x)}
          />
        </div>
      </Card>

      <Card title={t('settings.sections.infoLink')}>
        <div className="grid gap-5 p-4 sm:p-6 md:grid-cols-2">
          <p className="text-sm text-muted md:col-span-2">{t('settings.infoLinkHelp')}</p>
          <TextField
            label={t('settings.fields.infoLinkLabel')}
            value={v.infoLinkLabel}
            onValue={(x) => form.set('infoLinkLabel', x)}
            error={form.error('infoLinkLabel')}
            help={t('settings.infoLinkLabelHelp', { label: t('settings.defaultLabels.info') })}
            maxLength={60}
          />
          <TextField
            label={t('settings.fields.infoLinkUrl')}
            value={v.infoLinkUrl}
            onValue={(x) => form.set('infoLinkUrl', x)}
            error={form.error('infoLinkUrl')}
            placeholder="/about"
            spellCheck={false}
          />
        </div>
      </Card>

      <Card title={t('settings.sections.utm')}>
        <div className="grid gap-5 p-4 sm:p-6 md:grid-cols-3">
          <CheckboxField
            className="md:col-span-3"
            label={t('settings.fields.utmEnabled')}
            help={t('settings.utmHelp')}
            checked={v.utmEnabled}
            onChecked={(x) => form.set('utmEnabled', x)}
          />
          {(['utmSource', 'utmMedium', 'utmCampaign'] as const).map((k) => (
            <TextField
              key={k}
              label={t(`settings.fields.${k}`)}
              value={v[k]}
              onValue={(x) => form.set(k, x)}
              error={form.error(k)}
              maxLength={100}
              spellCheck={false}
            />
          ))}
        </div>
      </Card>

      <Card title={t('settings.sections.analytics')}>
        <div className="grid gap-5 p-4 sm:p-6 md:grid-cols-2">
          <CheckboxField
            className="md:col-span-2"
            label={t('settings.fields.analyticsEnabled')}
            help={t('settings.analyticsHelp')}
            checked={v.analyticsEnabled}
            onChecked={(x) => form.set('analyticsEnabled', x)}
          />
          {/* The (possibly unsaved) switch is on, but this instance cannot forward anything. */}
          {v.analyticsEnabled && !settings.analyticsAvailable && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-status-degraded/12 px-3 py-2 text-sm text-fg md:col-span-2">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-status-degraded-text" />
              <span>{t('settings.analyticsUnavailable')}</span>
            </p>
          )}
          <TextField
            label={t('settings.fields.analyticsWebsiteId')}
            value={v.analyticsWebsiteId}
            onValue={(x) => form.set('analyticsWebsiteId', x)}
            error={form.error('analyticsWebsiteId')}
            help={t('settings.analyticsWebsiteIdHelp')}
            placeholder="00000000-0000-0000-0000-000000000000"
            maxLength={36}
            spellCheck={false}
          />
          <TextField
            label={t('settings.fields.analyticsDomains')}
            value={v.analyticsDomains}
            onValue={(x) => form.set('analyticsDomains', x)}
            error={form.error('analyticsDomains')}
            help={t('settings.analyticsDomainsHelp')}
            placeholder="status.example.com"
            maxLength={500}
            spellCheck={false}
          />
          <CheckboxField
            label={t('settings.fields.analyticsRespectDnt')}
            help={t('settings.analyticsRespectDntHelp')}
            checked={v.analyticsRespectDnt}
            onChecked={(x) => form.set('analyticsRespectDnt', x)}
          />
          <CheckboxField
            label={t('settings.fields.analyticsForwardIp')}
            help={t('settings.analyticsForwardIpHelp')}
            checked={v.analyticsForwardIp}
            onChecked={(x) => form.set('analyticsForwardIp', x)}
          />
        </div>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <FormErrorSummary errors={form.errors} />
        <Button type="submit" variant="primary" pending={save.isPending}>
          {t('common:actions.save')}
        </Button>
      </div>
    </form>
  );
}
