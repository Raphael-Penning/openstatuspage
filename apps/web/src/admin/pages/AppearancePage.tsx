/**
 * Settings → Appearance: the themes of the public pages (docs/themes.md).
 * Lists the built-in, folder and uploaded themes, previews their tokens live
 * (light and dark) and on the public page (?theme=<id>, signed-in admins
 * only), activates, imports, exports, edits and deletes themes. Contrast
 * results come from the same checker the server uses; a theme that fails
 * WCAG 2.2 AA is only activated after an explicit confirmation.
 */
import {
  checkExtraCss,
  cssColorToHex,
  THEME_DENSITIES,
  THEME_PREVIEW_QUERY,
  THEME_STATUSES,
  themeContrastFailures,
  ThemeFile,
  themeModeVariables,
  type AdminTheme,
  type ContrastCheck,
  type ThemeMode,
  type ThemeModeTokens,
} from '@openstatuspage/shared';
import { Check, Copy, Download, ExternalLink, Eye, Pencil, Plus, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../../lib/api';
import { ConfirmDialog, Dialog, useConfirm } from '../components/Dialog';
import { inputClass, SelectField, TextAreaField, TextField } from '../components/fields';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader, QueryState, Table, td, th, tr } from '../components/ui';
import { THEME_DOCUMENT } from '../lib/documents';
import { apiErrorMessage } from '../lib/errors';
import { useAdminMutation, useSettings, useThemes } from '../lib/queries';

const path = (id: string) => `/api/admin/themes/${encodeURIComponent(id)}`;

/** The failed checks of a 409 contrast_failures answer. */
function contrastFailuresOf(error: unknown): ContrastCheck[] | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const first = error.errors[0];
  if (first?.code !== 'contrast_failures') return null;
  const failures = (first.meta as { failures?: ContrastCheck[] } | undefined)?.failures;
  return Array.isArray(failures) ? failures : [];
}

/** Field problems of a 400 answer as readable lines. */
function issueLines(error: unknown): string[] {
  if (!(error instanceof ApiError) || error.status !== 400) return [];
  return error.errors.map((e) => {
    const pointer = e.source?.pointer?.replace(/^\/data\/attributes\//, '').replace(/\//g, '.');
    return pointer ? `${pointer}: ${e.detail ?? e.title ?? ''}` : (e.detail ?? e.title ?? '');
  });
}

/** Saves a file the server answers (theme export) with the name from Content-Disposition. */
async function download(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, null);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

export default function AppearancePage() {
  const { t } = useTranslation('admin');
  const themes = useThemes();
  const settings = useSettings();
  const accentOverride = settings.data?.accentColor ?? null;
  const confirm = useConfirm();
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ theme: AdminTheme | null; copyOf?: AdminTheme } | null>(null);
  const [importing, setImporting] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const activate = useAdminMutation(
    ({ theme, accept }: { theme: AdminTheme; accept: boolean }) =>
      api.post<AdminTheme>(`${path(theme.id)}/activate`, { acceptContrastFailures: accept }, THEME_DOCUMENT),
    {
      success: (saved) => t('appearance.activated', { name: saved.name }),
      onSuccess: () => confirm.close(),
    },
  );
  const remove = useAdminMutation((theme: AdminTheme) => api.delete(path(theme.id)), {
    success: t('appearance.deleted'),
    onSuccess: () => confirm.close(),
  });

  const askActivate = (theme: AdminTheme) => {
    if (theme.contrastFailures.length === 0) {
      activate.mutate({ theme, accept: false });
      return;
    }
    confirm.ask({
      title: t('appearance.failingTitle'),
      message: (
        <div className="flex flex-col gap-3">
          <p>{t('appearance.failingMessage', { name: theme.name, count: theme.contrastFailures.length })}</p>
          <ContrastList failures={theme.contrastFailures} />
        </div>
      ),
      confirmLabel: t('appearance.activateAnyway'),
      action: () => activate.mutate({ theme, accept: true }),
    });
  };

  const exportFile = async (theme: AdminTheme, kind: 'json' | 'css') => {
    setDownloadError(null);
    try {
      await download(`${path(theme.id)}/${kind === 'json' ? 'export' : 'export-css'}`, `${theme.id}.${kind}`);
    } catch (err) {
      setDownloadError(apiErrorMessage(err, t));
    }
  };

  return (
    <>
      <PageHeader
        title={t('appearance.title')}
        description={t('appearance.description')}
        actions={
          <Button variant="primary" icon={Upload} onClick={() => setImporting(true)}>
            {t('appearance.import')}
          </Button>
        }
      />
      {accentOverride && (
        <p className="mb-4 rounded-lg bg-status-maintenance/10 px-3 py-2 text-sm">
          {t('appearance.accentOverride', { color: accentOverride })}
        </p>
      )}
      <div role="status" aria-live="polite">
        {downloadError && <p className="mb-4 rounded-lg bg-status-major-outage/10 px-3 py-2 text-sm text-status-major-outage-text">{downloadError}</p>}
      </div>
      <Card>
        <QueryState query={themes}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState>{t('appearance.empty')}</EmptyState>
            ) : (
              <Table label={t('appearance.title')}>
                <thead>
                  <tr>
                    <th className={th}>{t('appearance.fields.name')}</th>
                    <th className={th}>{t('appearance.fields.source')}</th>
                    <th className={th}>{t('appearance.fields.contrast')}</th>
                    <th className={`${th} text-right`}>{t('table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((theme) => (
                    <tr key={theme.id} className={tr}>
                      <td className={td}>
                        <span className="flex flex-wrap items-center gap-2 font-medium">
                          <Swatches theme={theme} />
                          {theme.name}
                          {theme.active && <Badge tone="success">{t('appearance.active')}</Badge>}
                        </span>
                        <span className="block font-mono text-xs text-muted">{theme.id}</span>
                        {theme.description && <span className="block text-xs text-muted">{theme.description}</span>}
                      </td>
                      <td className={td}>
                        <Badge tone={theme.source === 'database' ? 'info' : 'neutral'}>{t(`appearance.sources.${theme.source}`)}</Badge>
                      </td>
                      <td className={td}>
                        {theme.contrastFailures.length === 0 ? (
                          <Badge tone="success">{t('appearance.passesAA')}</Badge>
                        ) : (
                          <Badge tone="danger">{t('appearance.failsAA', { count: theme.contrastFailures.length })}</Badge>
                        )}
                      </td>
                      <td className={`${td} text-right whitespace-nowrap`}>
                        {!theme.active && (
                          <Button size="sm" icon={Check} onClick={() => askActivate(theme)} pending={activate.isPending && activate.variables?.theme.id === theme.id}>
                            {t('appearance.activate')}
                          </Button>
                        )}
                        <IconButton
                          icon={Eye}
                          label={t('appearance.previewLabel', { name: theme.name })}
                          onClick={() => setPreviewing(previewing === theme.id ? null : theme.id)}
                        />
                        <a
                          href={`/?${THEME_PREVIEW_QUERY}=${encodeURIComponent(theme.id)}`}
                          target="_blank"
                          rel="noopener"
                          className="inline-grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
                          aria-label={t('appearance.previewPublicLabel', { name: theme.name })}
                          title={t('appearance.previewPublicLabel', { name: theme.name })}
                        >
                          <ExternalLink aria-hidden className="size-4" />
                        </a>
                        <IconButton icon={Download} label={t('appearance.exportLabel', { name: theme.name })} onClick={() => void exportFile(theme, 'json')} />
                        {theme.cssBytes > 0 && (
                          <Button size="sm" variant="ghost" onClick={() => void exportFile(theme, 'css')} aria-label={t('appearance.exportCssLabel', { name: theme.name })}>
                            CSS
                          </Button>
                        )}
                        {theme.readOnly ? (
                          <IconButton icon={Copy} label={t('appearance.copyLabel', { name: theme.name })} onClick={() => setEditing({ theme: null, copyOf: theme })} />
                        ) : (
                          <>
                            <IconButton icon={Pencil} label={t('appearance.editLabel', { name: theme.name })} onClick={() => setEditing({ theme })} />
                            {!theme.active && (
                              <IconButton
                                icon={Trash2}
                                label={t('appearance.deleteLabel', { name: theme.name })}
                                onClick={() =>
                                  confirm.ask({
                                    title: t('appearance.deleteTitle'),
                                    message: t('appearance.deleteConfirm', { name: theme.name }),
                                    confirmLabel: t('common:actions.delete'),
                                    action: () => remove.mutate(theme),
                                  })
                                }
                              />
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryState>
      </Card>
      {previewing && themes.data && (() => {
        const theme = themes.data.find((x) => x.id === previewing);
        return theme ? (
          <Card className="mt-6" title={t('appearance.livePreview', { name: theme.name })}>
            <div className="p-4 sm:p-6">
              <ThemePreview definition={theme.definition} accentOverride={accentOverride} />
            </div>
          </Card>
        ) : null;
      })()}
      {editing && (
        <ThemeEditor
          existing={editing.theme}
          copyOf={editing.copyOf}
          accentOverride={accentOverride}
          takenIds={themes.data?.map((x) => x.id) ?? []}
          onClose={() => setEditing(null)}
        />
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      <ConfirmDialog {...confirm.dialogProps(activate.isPending || remove.isPending)} />
    </>
  );
}

function Swatches({ theme }: { theme: AdminTheme }) {
  const colors = [theme.definition.light.background, theme.definition.light.accent, theme.definition.dark.background, theme.definition.dark.accent];
  return (
    <span aria-hidden className="inline-flex overflow-hidden rounded border border-border">
      {colors.map((c, i) => (
        <span key={i} className="block size-4" style={{ background: cssColorToHex(c) ?? undefined }} />
      ))}
    </span>
  );
}

/** The failed contrast checks as a list. */
function ContrastList({ failures }: { failures: ContrastCheck[] }) {
  const { t } = useTranslation('admin');
  return (
    <ul className="max-h-60 list-disc overflow-y-auto pl-5 text-xs">
      {failures.map((f) => (
        <li key={`${f.mode}-${f.foreground}-${f.background}`}>
          {t('appearance.contrastLine', {
            mode: t(`appearance.modes.${f.mode}`),
            foreground: f.foreground,
            background: f.background,
            ratio: f.ratio.toFixed(2),
            required: f.required,
          })}
        </li>
      ))}
    </ul>
  );
}

/** A small mock of the public page drawn with the theme's tokens, light and dark side by side. */
function ThemePreview({ definition, accentOverride }: { definition: ThemeFile; accentOverride: string | null }) {
  const { t } = useTranslation('admin');
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {(['light', 'dark'] as const).map((mode) => {
        const vars = themeModeVariables(definition[mode], mode, accentOverride);
        const style = Object.fromEntries(
          Object.entries(vars).map(([k, v]) => (k === 'color-scheme' ? ['colorScheme', v] : [`--${k}`, v])),
        ) as CSSProperties;
        const radius = definition.radius ?? '0.5rem';
        return (
          <div key={mode} style={{ ...style, borderRadius: radius }} className="flex flex-col gap-3 border border-border bg-bg p-4 text-fg">
            <p className="text-xs font-medium text-muted">{t(`appearance.modes.${mode}`)}</p>
            <div style={{ borderRadius: radius }} className="flex flex-col gap-2 border border-border bg-surface p-3">
              <p className="font-semibold">{t('appearance.sample.title')}</p>
              <p className="text-sm text-muted">{t('appearance.sample.muted')}</p>
              <div className="flex gap-0.5" aria-hidden>
                {(['operational', 'operational', 'degraded', 'operational', 'partial-outage', 'major-outage', 'maintenance', 'operational'] as const).map((s, i) => (
                  <span key={i} className="h-6 flex-1 rounded-sm" style={{ background: `var(--status-${s})` }} />
                ))}
              </div>
              <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium">
                {THEME_STATUSES.map((s) => (
                  <li key={s} style={{ color: `var(--status-${s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}-text)` }}>
                    {t(`appearance.statuses.${s}`)}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-3 bg-surface-2 p-2" style={{ borderRadius: radius }}>
                <span
                  className="inline-flex h-8 items-center px-3 text-sm font-medium"
                  style={{ background: 'var(--osp-accent-solid)', color: 'var(--osp-accent-solid-fg)', borderRadius: radius }}
                >
                  {t('settings.previewButton')}
                </span>
                <span className="text-sm font-medium underline" style={{ color: 'var(--osp-accent-text)' }}>
                  {t('settings.previewLink')}
                </span>
                <span className="inline-block h-8 w-24 border bg-bg" style={{ borderColor: 'var(--border-strong)', borderRadius: radius }} />
                <span className="inline-block h-8 w-8 outline-2 outline-offset-2" style={{ outlineStyle: 'solid', outlineColor: 'var(--focus)', borderRadius: radius }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const MODE_FIELDS = ['background', 'surface', 'surfaceAlt', 'border', 'borderStrong', 'text', 'muted', 'accent', 'focus'] as const;
type ModeField = (typeof MODE_FIELDS)[number];

/** A colour token: a colour picker (hex) and the text value (any theme syntax). */
function ColorField({ label, value, onValue, optional }: { label: string; value: string; onValue: (v: string) => void; optional?: boolean }) {
  const { t } = useTranslation('admin');
  const id = useId();
  const hex = cssColorToHex(value);
  const invalid = value.trim() !== '' && !hex;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
        {optional && <span className="font-normal text-muted"> ({t('appearance.optional')})</span>}
      </label>
      <div className="flex gap-1.5">
        <input
          type="color"
          aria-label={t('appearance.pickColor', { name: label })}
          value={hex ?? '#000000'}
          onChange={(e) => onValue(e.target.value)}
          className="h-9 w-10 shrink-0 cursor-pointer rounded-lg border border-border bg-bg p-1"
        />
        <input
          id={id}
          className={`${inputClass} font-mono text-xs`}
          value={value}
          onChange={(e) => onValue(e.target.value)}
          aria-invalid={invalid ? true : undefined}
          maxLength={64}
          spellCheck={false}
        />
      </div>
    </div>
  );
}

type Draft = ThemeFile & { css: string };

const blankTokens = (tokens: ThemeModeTokens): ThemeModeTokens => JSON.parse(JSON.stringify(tokens)) as ThemeModeTokens;

/** The draft as a theme file: optional fields left empty are dropped. */
function toDefinition(draft: Draft): unknown {
  const { css: _css, ...theme } = draft;
  const clean = (tokens: ThemeModeTokens) => {
    const out: Record<string, unknown> = { ...tokens };
    if (!tokens.focus?.trim()) delete out.focus;
    if (tokens.statusText && Object.values(tokens.statusText).every((v) => !v.trim())) delete out.statusText;
    return out;
  };
  const fonts = { ...(theme.fonts?.sans?.trim() ? { sans: theme.fonts.sans } : {}), ...(theme.fonts?.mono?.trim() ? { mono: theme.fonts.mono } : {}) };
  return {
    ...theme,
    author: theme.author?.trim() || undefined,
    description: theme.description?.trim() || undefined,
    radius: theme.radius?.trim() || undefined,
    fonts: Object.keys(fonts).length > 0 ? fonts : undefined,
    light: clean(theme.light),
    dark: clean(theme.dark),
  };
}

function ThemeEditor({
  existing,
  copyOf,
  accentOverride,
  takenIds,
  onClose,
}: {
  existing: AdminTheme | null;
  copyOf?: AdminTheme;
  accentOverride: string | null;
  takenIds: string[];
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const source = existing ?? copyOf;
  const [draft, setDraft] = useState<Draft>(() => {
    const base = source!.definition;
    let id = base.id;
    if (!existing) {
      for (let n = 1; takenIds.includes(id); n++) id = `${base.id}-copy${n > 1 ? `-${n}` : ''}`;
    }
    return {
      ...base,
      id,
      name: existing ? base.name : t('appearance.copyName', { name: base.name }),
      light: blankTokens(base.light),
      dark: blankTokens(base.dark),
      css: '',
    };
  });
  const [submitError, setSubmitError] = useState<string[]>([]);
  const confirm = useConfirm();

  // The extra CSS of the theme: the list has none.
  const sourceId = source?.id;
  useEffect(() => {
    if (!sourceId) return;
    let active = true;
    api
      .get<AdminTheme>(path(sourceId))
      .then((full) => {
        if (active) setDraft((d) => ({ ...d, css: full.css ?? '' }));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [sourceId]);

  const parsed = useMemo(() => ThemeFile.safeParse(toDefinition(draft)), [draft]);
  const failures = parsed.success ? themeContrastFailures(parsed.data, accentOverride) : [];
  const cssIssues = useMemo(() => (draft.css.trim() ? checkExtraCss(draft.css) : []), [draft.css]);

  const save = useAdminMutation(
    ({ accept }: { accept: boolean }) => {
      const definition = toDefinition(draft);
      const css = draft.css.trim() ? draft.css : null;
      return existing
        ? api.patch<AdminTheme>(path(existing.id), { definition, css, acceptContrastFailures: accept }, { ...THEME_DOCUMENT, id: existing.id })
        : api.post<AdminTheme>('/api/admin/themes', { definition, css }, THEME_DOCUMENT);
    },
    {
      success: t('appearance.saved'),
      onSuccess: () => {
        confirm.close();
        onClose();
      },
      onError: (err) => {
        const contrast = contrastFailuresOf(err);
        if (contrast) {
          confirm.ask({
            title: t('appearance.failingTitle'),
            message: (
              <div className="flex flex-col gap-3">
                <p>{t('appearance.failingActiveMessage', { count: contrast.length })}</p>
                <ContrastList failures={contrast} />
              </div>
            ),
            confirmLabel: t('appearance.saveAnyway'),
            action: () => save.mutate({ accept: true }),
          });
          return true;
        }
        const lines = issueLines(err);
        if (lines.length > 0) {
          setSubmitError(lines);
          return true;
        }
        return false;
      },
    },
  );

  const setMode = (mode: ThemeMode, field: ModeField, value: string) =>
    setDraft((d) => ({ ...d, [mode]: { ...d[mode], [field]: value } }));
  const setStatus = (mode: ThemeMode, group: 'status' | 'statusText', key: string, value: string) =>
    setDraft((d) => {
      const current = (d[mode][group] ?? Object.fromEntries(THEME_STATUSES.map((s) => [s, '']))) as Record<string, string>;
      return { ...d, [mode]: { ...d[mode], [group]: { ...current, [key]: value } } };
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitError([]);
    if (!parsed.success) {
      setSubmitError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
      return;
    }
    if (cssIssues.length > 0) {
      setSubmitError(cssIssues.map((i) => `css: ${i.message}`));
      return;
    }
    save.mutate({ accept: false });
  };

  const formId = useId();
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={existing ? t('appearance.editTitle', { name: existing.name }) : t('appearance.newTitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button variant="primary" type="submit" form={formId} pending={save.isPending}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-5">
        {submitError.length > 0 && (
          <div role="alert" className="rounded-lg bg-status-major-outage/10 px-3 py-2 text-sm text-status-major-outage-text">
            <p className="font-medium">{t('appearance.invalid')}</p>
            <ul className="list-disc pl-5 text-xs">
              {submitError.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t('appearance.fields.id')}
            value={draft.id}
            onValue={(v) => setDraft((d) => ({ ...d, id: v }))}
            disabled={existing !== null}
            help={t('appearance.idHelp')}
            required
            maxLength={48}
          />
          <TextField label={t('appearance.fields.name')} value={draft.name} onValue={(v) => setDraft((d) => ({ ...d, name: v }))} required maxLength={80} />
          <TextField label={t('appearance.fields.author')} value={draft.author ?? ''} onValue={(v) => setDraft((d) => ({ ...d, author: v }))} maxLength={120} />
          <TextField
            label={t('appearance.fields.radius')}
            value={draft.radius ?? ''}
            onValue={(v) => setDraft((d) => ({ ...d, radius: v }))}
            help={t('appearance.radiusHelp')}
            maxLength={10}
          />
          <TextField
            label={t('appearance.fields.fontSans')}
            value={draft.fonts?.sans ?? ''}
            onValue={(v) => setDraft((d) => ({ ...d, fonts: { ...d.fonts, sans: v } }))}
            help={t('appearance.fontHelp')}
            maxLength={300}
          />
          <TextField
            label={t('appearance.fields.fontMono')}
            value={draft.fonts?.mono ?? ''}
            onValue={(v) => setDraft((d) => ({ ...d, fonts: { ...d.fonts, mono: v } }))}
            maxLength={300}
          />
          <SelectField
            label={t('appearance.fields.density')}
            value={draft.density ?? 'comfortable'}
            onValue={(v) => setDraft((d) => ({ ...d, density: v }))}
            options={THEME_DENSITIES.map((v) => ({ value: v, label: t(`appearance.densities.${v}`) }))}
          />
          <TextField
            label={t('appearance.fields.description')}
            value={draft.description ?? ''}
            onValue={(v) => setDraft((d) => ({ ...d, description: v }))}
            maxLength={500}
          />
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          {(['light', 'dark'] as const).map((mode) => (
            <fieldset key={mode} className="flex flex-col gap-3 rounded-xl border border-border p-4">
              <legend className="px-1 text-sm font-semibold">{t(`appearance.modes.${mode}`)}</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {MODE_FIELDS.map((field) => (
                  <ColorField
                    key={field}
                    label={t(`appearance.tokens.${field}`)}
                    value={draft[mode][field] ?? ''}
                    onValue={(v) => setMode(mode, field, v)}
                    optional={field === 'focus'}
                  />
                ))}
              </div>
              <Group title={t('appearance.statusFills')}>
                {[...THEME_STATUSES, 'noData' as const].map((s) => (
                  <ColorField key={s} label={t(`appearance.statuses.${s}`)} value={draft[mode].status[s]} onValue={(v) => setStatus(mode, 'status', s, v)} />
                ))}
              </Group>
              <Group title={t('appearance.statusTexts')} help={t('appearance.statusTextHelp')}>
                {THEME_STATUSES.map((s) => (
                  <ColorField
                    key={s}
                    optional
                    label={t(`appearance.statuses.${s}`)}
                    value={draft[mode].statusText?.[s] ?? ''}
                    onValue={(v) => setStatus(mode, 'statusText', s, v)}
                  />
                ))}
              </Group>
            </fieldset>
          ))}
        </div>
        <TextAreaField
          label={t('appearance.fields.css')}
          value={draft.css}
          onValue={(v) => setDraft((d) => ({ ...d, css: v }))}
          help={t('appearance.cssHelp')}
          error={cssIssues.length > 0 ? cssIssues.map((i) => (i.excerpt ? `${i.message}: ${i.excerpt}` : i.message)).join(' · ') : undefined}
          rows={6}
          className="[&_textarea]:font-mono"
          spellCheck={false}
        />
        <section aria-labelledby={`${formId}-contrast`} className="flex flex-col gap-2">
          <h3 id={`${formId}-contrast`} className="text-sm font-semibold">
            {t('appearance.contrastTitle')}
          </h3>
          <div role="status" aria-live="polite">
            {!parsed.success ? (
              <p className="text-sm text-muted">{t('appearance.contrastPending')}</p>
            ) : failures.length === 0 ? (
              <p className="flex items-center gap-1.5 text-sm text-status-operational-text">
                <Check aria-hidden className="size-4" />
                {t('appearance.contrastOk')}
              </p>
            ) : (
              <div className="flex flex-col gap-1 rounded-lg bg-status-major-outage/10 px-3 py-2 text-sm text-status-major-outage-text">
                <p className="flex items-center gap-1.5 font-medium">
                  <TriangleAlert aria-hidden className="size-4" />
                  {t('appearance.failsAA', { count: failures.length })}
                </p>
                <ContrastList failures={failures} />
              </div>
            )}
          </div>
          {parsed.success && <ThemePreview definition={parsed.data} accentOverride={accentOverride} />}
        </section>
      </form>
      <ConfirmDialog {...confirm.dialogProps(save.isPending)} />
    </Dialog>
  );
}

function Group({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold text-muted uppercase">{title}</p>
      {help && <p className="text-xs text-muted">{help}</p>}
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </div>
  );
}

/** Import of a theme file (`<id>.json`) and its optional extra CSS (`<id>.css`). */
function ImportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('admin');
  const formId = useId();
  const jsonId = useId();
  const cssId = useId();
  const [json, setJson] = useState<File | null>(null);
  const [css, setCss] = useState<File | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const save = useAdminMutation((body: { definition: unknown; css: string | null }) => api.post<AdminTheme>('/api/admin/themes', body, THEME_DOCUMENT), {
    success: (saved) => t('appearance.imported', { name: saved.name }),
    onSuccess: onClose,
    onError: (err) => {
      const lines = issueLines(err);
      if (lines.length === 0) return false;
      setErrors(lines);
      return true;
    },
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors([]);
    if (!json) {
      setErrors([t('appearance.importNoFile')]);
      return;
    }
    let definition: unknown;
    try {
      definition = JSON.parse(await json.text());
    } catch {
      setErrors([t('appearance.importNotJson')]);
      return;
    }
    const cssText = css ? await css.text() : null;
    const cssProblems = cssText ? checkExtraCss(cssText) : [];
    if (cssProblems.length > 0) {
      setErrors(cssProblems.map((i) => `css: ${i.message}`));
      return;
    }
    save.mutate({ definition, css: cssText });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('appearance.importTitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button variant="primary" type="submit" form={formId} icon={Plus} pending={save.isPending}>
            {t('appearance.import')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t('appearance.importHelp')}</p>
        {errors.length > 0 && (
          <div role="alert" className="rounded-lg bg-status-major-outage/10 px-3 py-2 text-sm text-status-major-outage-text">
            <ul className="list-disc pl-5 text-xs">
              {errors.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={jsonId} className="text-sm font-medium">
            {t('appearance.importJson')}
          </label>
          <input id={jsonId} type="file" accept=".json,application/json" onChange={(e) => setJson(e.target.files?.[0] ?? null)} className="text-sm" />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={cssId} className="text-sm font-medium">
            {t('appearance.importCss')}
          </label>
          <input id={cssId} type="file" accept=".css,text/css" onChange={(e) => setCss(e.target.files?.[0] ?? null)} className="text-sm" />
        </div>
      </form>
    </Dialog>
  );
}
