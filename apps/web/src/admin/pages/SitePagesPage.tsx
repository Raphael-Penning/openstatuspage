/**
 * Content of the public page: the four system pages (about, legal notice,
 * privacy policy, accessibility statement), custom pages and uploaded images.
 *
 * A system page is either the internal page edited here (published) or, while
 * it is not published, the external link of the settings. Texts are Markdown
 * per language (no raw HTML), with a preview rendered like the public page.
 */
import {
  localizedText,
  PAGE_BODY_MAX,
  SitePageInput,
  type AdminSitePage,
  type AdminUpload,
  type ImageSize,
  type PageContentLanguage,
} from '@openstatuspage/shared';
import { ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { LANGUAGES } from '../../lib/i18n';
import { PageMarkdown } from '../../public/components/PageMarkdown';
import { CopyField } from '../components/CopyField';
import { ConfirmDialog, Dialog, useConfirm } from '../components/Dialog';
import { CheckboxField, FormErrorSummary, TextAreaField, TextField } from '../components/fields';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader, QueryState, Segmented, Table, td, th, tr } from '../components/ui';
import { UploadButton } from '../components/UploadButton';
import { useFormat } from '../lib/format';
import { useAdminMutation, useSitePages, useUploads } from '../lib/queries';
import { useForm } from '../lib/useForm';

const path = (id: string) => `/api/admin/pages/${encodeURIComponent(id)}`;
const PAGE_DOCUMENT = { type: 'pages' } as const;

/** Sizes of the uploads by URL, for the preview (like the public page document). */
function useImageSizes(): Record<string, ImageSize> {
  const uploads = useUploads();
  return useMemo(() => Object.fromEntries((uploads.data ?? []).map((u) => [u.url, { width: u.width, height: u.height }])), [uploads.data]);
}

export default function SitePagesPage() {
  const { t, i18n } = useTranslation('admin');
  const pages = useSitePages();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<AdminSitePage | 'new' | null>(null);
  const remove = useAdminMutation((p: AdminSitePage) => api.delete(path(p.id)), {
    success: t('sitePages.deleted'),
    onSuccess: () => confirm.close(),
  });
  const lang = i18n.language;

  return (
    <>
      <PageHeader
        title={t('sitePages.title')}
        description={t('sitePages.description')}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
            {t('sitePages.new')}
          </Button>
        }
      />
      <div className="flex flex-col gap-6">
        <QueryState query={pages}>
          {(list) => {
            const system = list.filter((p) => p.systemKey !== null);
            const custom = list.filter((p) => p.systemKey === null);
            return (
              <>
                <Card title={t('sitePages.system')}>
                  <p className="px-4 pt-4 text-sm text-muted sm:px-6">{t('sitePages.systemHelp')}</p>
                  <Table label={t('sitePages.system')}>
                    <thead>
                      <tr>
                        <th className={th}>{t('sitePages.fields.title')}</th>
                        <th className={th}>{t('sitePages.fields.path')}</th>
                        <th className={th}>{t('sitePages.mode')}</th>
                        <th className={`${th} text-right`}>{t('table.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {system.map((p) => (
                        <tr key={p.id} className={tr}>
                          <td className={`${td} font-medium`}>{localizedText(p.title, lang)}</td>
                          <td className={`${td} font-mono text-xs`}>{p.path}</td>
                          <td className={td}>
                            {p.published ? <Badge tone="success">{t('sitePages.internal')}</Badge> : <Badge>{t('sitePages.external')}</Badge>}
                          </td>
                          <td className={`${td} text-right whitespace-nowrap`}>
                            <IconButton icon={Pencil} label={t('sitePages.editLabel', { name: localizedText(p.title, lang) })} onClick={() => setEditing(p)} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Card>
                <Card title={t('sitePages.custom')}>
                  {custom.length === 0 ? (
                    <EmptyState>{t('sitePages.empty')}</EmptyState>
                  ) : (
                    <Table label={t('sitePages.custom')}>
                      <thead>
                        <tr>
                          <th className={th}>{t('sitePages.fields.title')}</th>
                          <th className={th}>{t('sitePages.fields.path')}</th>
                          <th className={th}>{t('sitePages.status')}</th>
                          <th className={th}>{t('sitePages.placement')}</th>
                          <th className={`${th} text-right`}>{t('table.actions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {custom.map((p) => {
                          const name = localizedText(p.title, lang);
                          return (
                            <tr key={p.id} className={tr}>
                              <td className={`${td} font-medium`}>{name}</td>
                              <td className={`${td} font-mono text-xs`}>{p.path}</td>
                              <td className={td}>
                                {p.published ? <Badge tone="success">{t('sitePages.published')}</Badge> : <Badge>{t('sitePages.draft')}</Badge>}
                              </td>
                              <td className={`${td} text-muted`}>
                                {[p.showInNav && t('sitePages.inNav'), p.showInFooter && t('sitePages.inFooter')].filter(Boolean).join(', ') || '—'}
                              </td>
                              <td className={`${td} text-right whitespace-nowrap`}>
                                <IconButton icon={Pencil} label={t('sitePages.editLabel', { name })} onClick={() => setEditing(p)} />
                                <IconButton
                                  icon={Trash2}
                                  label={t('sitePages.deleteLabel', { name })}
                                  onClick={() =>
                                    confirm.ask({
                                      title: t('sitePages.deleteTitle'),
                                      message: t('sitePages.deleteConfirm', { name }),
                                      confirmLabel: t('common:actions.delete'),
                                      action: () => remove.mutate(p),
                                    })
                                  }
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </Table>
                  )}
                </Card>
              </>
            );
          }}
        </QueryState>
        <UploadsCard />
      </div>
      {editing && <PageDialog existing={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </>
  );
}

/** Uploaded images: upload, copy the Markdown or URL, delete. */
function UploadsCard() {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const uploads = useUploads();
  const confirm = useConfirm();
  const remove = useAdminMutation((u: AdminUpload) => api.delete(`/api/admin/uploads/${encodeURIComponent(u.id)}`), {
    success: t('uploads.deleted'),
    onSuccess: () => confirm.close(),
  });
  return (
    <Card title={t('uploads.title')} actions={<UploadButton size="sm" label={t('uploads.upload')} />}>
      <p className="px-4 pt-4 text-sm text-muted sm:px-6">{t('uploads.help')}</p>
      <QueryState query={uploads}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState>{t('uploads.empty')}</EmptyState>
          ) : (
            <ul className="grid gap-4 p-4 sm:grid-cols-2 sm:p-6">
              {list.map((u) => {
                const name = u.filename ?? u.url.slice(u.url.lastIndexOf('/') + 1, u.url.lastIndexOf('/') + 13);
                return (
                  <li key={u.id} className="flex flex-col gap-3 rounded-lg border border-border p-3">
                    <div className="flex items-start gap-3">
                      <img src={u.url} alt="" width={u.width} height={u.height} loading="lazy" className="size-16 shrink-0 rounded-md border border-border bg-bg object-contain" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{name}</p>
                        <p className="text-xs text-muted">
                          {t('uploads.facts', { width: u.width, height: u.height, size: fmt.number(Math.ceil(u.size / 1024)) })}
                        </p>
                        <p className="text-xs text-muted">{fmt.dateTime(u.createdAt)}</p>
                      </div>
                      <IconButton
                        icon={Trash2}
                        label={t('uploads.deleteLabel', { name })}
                        onClick={() =>
                          confirm.ask({
                            title: t('uploads.deleteTitle'),
                            message: t('uploads.deleteConfirm', { name }),
                            confirmLabel: t('common:actions.delete'),
                            action: () => remove.mutate(u),
                          })
                        }
                      />
                    </div>
                    <CopyField label={t('uploads.url')} value={u.url} />
                    <CopyField label={t('uploads.markdown')} value={`![${t('uploads.altPlaceholder')}](${u.url})`} />
                  </li>
                );
              })}
            </ul>
          )
        }
      </QueryState>
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </Card>
  );
}

interface Values {
  slug: string;
  title: Record<PageContentLanguage, string>;
  description: Record<PageContentLanguage, string>;
  body: Record<PageContentLanguage, string>;
  published: boolean;
  showInFooter: boolean;
  showInNav: boolean;
  sortOrder: string;
}

function PageDialog({ existing, onClose }: { existing: AdminSitePage | null; onClose: () => void }) {
  const { t, i18n } = useTranslation('admin');
  const system = existing?.systemKey ?? null;
  const images = useImageSizes();
  const [lang, setLang] = useState<PageContentLanguage>(i18n.language === 'de' ? 'de' : 'en');
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const form = useForm<Values>(() => ({
    slug: existing?.slug ?? '',
    title: { en: existing?.title.en ?? '', de: existing?.title.de ?? '' },
    description: { en: existing?.description.en ?? '', de: existing?.description.de ?? '' },
    body: { en: existing?.body.en ?? '', de: existing?.body.de ?? '' },
    published: existing?.published ?? false,
    showInFooter: existing?.showInFooter ?? true,
    showInNav: existing?.showInNav ?? false,
    sortOrder: String(existing?.sortOrder ?? 10),
  }));
  const v = form.values;
  const setText = (field: 'title' | 'description' | 'body', value: string) => form.set(field, { ...v[field], [lang]: value });

  const save = useAdminMutation(
    (body: SitePageInput) =>
      existing ? api.patch<AdminSitePage>(path(existing.id), body, { ...PAGE_DOCUMENT, id: existing.id }) : api.post<AdminSitePage>('/api/admin/pages', body, PAGE_DOCUMENT),
    { success: existing ? t('sitePages.saved') : t('sitePages.created'), onSuccess: onClose, onError: form.applyServerError },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = form.validate(SitePageInput, {
      slug: v.slug.trim(),
      title: { en: v.title.en.trim(), de: v.title.de.trim() },
      description: { en: v.description.en.trim(), de: v.description.de.trim() },
      body: v.body,
      published: v.published,
      showInFooter: v.showInFooter,
      showInNav: v.showInNav,
      sortOrder: v.sortOrder.trim() === '' ? Number.NaN : Number(v.sortOrder),
    });
    if (body) save.mutate(body);
  };

  const languageLabel = LANGUAGES.find((l) => l.code === lang)?.label ?? lang;
  const title = existing ? localizedText(existing.title, i18n.language) : t('sitePages.new');

  return (
    <Dialog open wide onClose={onClose} title={existing ? t('sitePages.editTitle', { name: title }) : t('sitePages.new')}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {system ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <p className="text-sm">
              {t('sitePages.pathInfo')} <code className="font-mono text-xs">{existing!.path}</code>
            </p>
            <CheckboxField
              label={t('sitePages.fields.internal')}
              help={t(`sitePages.internalHelp.${system}`)}
              checked={v.published}
              onChecked={(x) => form.set('published', x)}
            />
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              label={t('sitePages.fields.slug')}
              value={v.slug}
              onValue={(x) => form.set('slug', x.toLowerCase())}
              error={form.error('slug')}
              help={t('sitePages.slugHelp', { path: `/pages/${v.slug || 'faq'}` })}
              required
              maxLength={64}
              spellCheck={false}
              autoFocus
            />
            <TextField
              label={t('sitePages.fields.sortOrder')}
              type="number"
              inputMode="numeric"
              min={0}
              max={10000}
              value={v.sortOrder}
              onValue={(x) => form.set('sortOrder', x)}
              error={form.error('sortOrder')}
              help={t('sitePages.sortOrderHelp')}
            />
            <CheckboxField label={t('sitePages.fields.published')} help={t('sitePages.publishedHelp')} checked={v.published} onChecked={(x) => form.set('published', x)} />
            <div className="flex flex-col gap-2">
              <CheckboxField label={t('sitePages.fields.showInNav')} checked={v.showInNav} onChecked={(x) => form.set('showInNav', x)} />
              <CheckboxField label={t('sitePages.fields.showInFooter')} checked={v.showInFooter} onChecked={(x) => form.set('showInFooter', x)} />
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            label={t('sitePages.language')}
            value={lang}
            onChange={setLang}
            options={LANGUAGES.map((l) => ({ value: l.code as PageContentLanguage, label: l.label }))}
          />
          <Segmented
            label={t('sitePages.view')}
            value={view}
            onChange={setView}
            options={[
              { value: 'edit', label: t('sitePages.edit') },
              { value: 'preview', label: t('sitePages.preview') },
            ]}
          />
        </div>

        {view === 'edit' ? (
          <div className="flex flex-col gap-4">
            <TextField
              label={t('sitePages.fields.titleIn', { language: languageLabel })}
              value={v.title[lang]}
              onValue={(x) => setText('title', x)}
              error={form.error(`title.${lang}`)}
              maxLength={120}
            />
            <TextField
              label={t('sitePages.fields.descriptionIn', { language: languageLabel })}
              value={v.description[lang]}
              onValue={(x) => setText('description', x)}
              error={form.error(`description.${lang}`)}
              help={t('sitePages.descriptionHelp')}
              maxLength={300}
            />
            <TextAreaField
              label={t('sitePages.fields.bodyIn', { language: languageLabel })}
              value={v.body[lang]}
              onValue={(x) => setText('body', x)}
              error={form.error(`body.${lang}`)}
              help={t('sitePages.bodyHelp')}
              rows={14}
              maxLength={PAGE_BODY_MAX}
              spellCheck
            />
            <div className="flex flex-wrap items-center gap-2">
              <UploadButton
                size="sm"
                label={t('uploads.insert')}
                onUploaded={(u) => setText('body', `${v.body[lang]}${v.body[lang] && !v.body[lang].endsWith('\n') ? '\n\n' : ''}![${t('uploads.altPlaceholder')}](${u.url})\n`)}
              />
              <a href="https://commonmark.org/help/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
                <ExternalLink aria-hidden className="size-4" />
                {t('sitePages.markdownHelp')}
                <span className="sr-only"> {t('privatePages.newTab')}</span>
              </a>
            </div>
          </div>
        ) : (
          <section aria-label={t('sitePages.preview')} className="rounded-lg border border-border bg-bg p-4 sm:p-6" lang={lang}>
            <p className="mb-4 text-2xl font-semibold">{v.title[lang] || v.title[lang === 'de' ? 'en' : 'de'] || '—'}</p>
            <PageMarkdown markdown={v.body[lang]} images={images} baseUrl={typeof window === 'undefined' ? undefined : window.location.origin} />
          </section>
        )}

        <FormErrorSummary errors={form.errors} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button type="submit" variant="primary" pending={save.isPending}>
            {existing ? t('common:actions.save') : t('common:actions.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
