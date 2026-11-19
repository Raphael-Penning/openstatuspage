/**
 * Check bundles (admin only): several checks, usually the same target watched
 * by Uptime Kuma instances in different places, vote with a weight on one
 * state. A bundle is down only when more than half of the votes of the
 * reporting members say so. Each bundle is a check that can be linked to
 * services like any other check.
 */
import {
  CheckBundleInput,
  CONFIGURABLE_SOURCE_TYPES,
  MAX_BUNDLE_MEMBER_VOTES,
  type AdminCheckBundle,
  type BundleCandidateSource,
  type ConfigurableSourceType,
} from '@openstatuspage/shared';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { ConfirmDialog, Dialog, useConfirm } from '../../components/Dialog';
import { FormErrorSummary, inputClass, SelectField, TextAreaField, TextField } from '../../components/fields';
import { Badge, Button, Card, CheckStateBadge, EmptyState, IconButton, PageHeader, QueryState, Spinner, Table, td, th, tr } from '../../components/ui';
import { useFormat } from '../../lib/format';
import {
  bundleFormToPayload,
  bundleToForm,
  majorityThreshold,
  totalVotes as sumVotes,
  type BundleFormValues,
  type BundleMemberRow as MemberRow,
} from '../../lib/bundle-form';
import { useAdminMutation, useBundleCandidates, useBundles } from '../../lib/queries';
import { useForm } from '../../lib/useForm';

/** Uptime Kuma is the typical case; the filter can show every source type. */
const DEFAULT_TYPE: ConfigurableSourceType = 'uptimekuma';

export default function BundlesPage() {
  const { t } = useTranslation('admin');
  const bundles = useBundles();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<AdminCheckBundle | 'new' | null>(null);
  const remove = useAdminMutation((id: string) => api.delete(`/api/admin/check-bundles/${id}`), {
    success: t('bundles.deleted'),
    onSuccess: () => confirm.close(),
  });

  return (
    <>
      <PageHeader
        title={t('bundles.title')}
        description={t('bundles.description')}
        back={{ to: '/admin/monitoring', label: t('sources.title') }}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
            {t('bundles.new')}
          </Button>
        }
      />
      <QueryState query={bundles}>
        {(list) =>
          list.length === 0 ? (
            <Card>
              <EmptyState>{t('bundles.empty')}</EmptyState>
            </Card>
          ) : (
            <ul className="flex flex-col gap-4">
              {list.map((b) => (
                <li key={b.id}>
                  <BundleCard
                    bundle={b}
                    onEdit={() => setEditing(b)}
                    onDelete={() =>
                      confirm.ask({
                        title: t('bundles.deleteTitle'),
                        message: t('bundles.deleteConfirm', { name: b.name, count: b.serviceCount }),
                        action: () => remove.mutate(b.id),
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          )
        }
      </QueryState>
      {editing && <BundleDialog bundle={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </>
  );
}

function BundleCard({ bundle, onEdit, onDelete }: { bundle: AdminCheckBundle; onEdit: () => void; onDelete: () => void }) {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const headingId = useId();
  const v = bundle.vote;
  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 id={headingId} className="flex flex-wrap items-center gap-2 text-base font-semibold">
            <span className="break-words">{bundle.name}</span>
            <CheckStateBadge state={v.state} />
          </h2>
          {bundle.description && <p className="mt-1 text-sm text-muted">{bundle.description}</p>}
          <p className="mt-1 text-sm">
            {v.reportingVotes === 0
              ? t('bundles.noneReporting', { total: v.totalVotes })
              : t('bundles.voteSummary', {
                  down: v.criticalVotes,
                  warning: v.warningVotes,
                  reporting: v.reportingVotes,
                  total: v.totalVotes,
                })}
          </p>
          <p className="text-xs text-muted">{t('bundles.usedBy', { count: bundle.serviceCount })}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton icon={Pencil} label={t('bundles.editNamed', { name: bundle.name })} onClick={onEdit} />
          <IconButton icon={Trash2} label={t('bundles.deleteNamed', { name: bundle.name })} onClick={onDelete} />
        </div>
      </div>
      {bundle.members.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted">{t('bundles.noMembers')}</p>
      ) : (
        <Table label={t('bundles.breakdownLabel', { name: bundle.name })}>
          <thead>
            <tr>
              <th scope="col" className={th}>{t('bundles.node')}</th>
              <th scope="col" className={th}>{t('bundles.check')}</th>
              <th scope="col" className={`${th} text-right`}>{t('bundles.votes')}</th>
              <th scope="col" className={th}>{t('bundles.state')}</th>
              <th scope="col" className={th}>{t('bundles.inVote')}</th>
            </tr>
          </thead>
          <tbody>
            {bundle.members.map((m) => (
              <tr key={m.checkId} className={tr}>
                <td className={td}>
                  <span className="font-medium">{m.sourceName}</span>
                  <div className="text-xs text-muted">{t(`sources.types.${m.sourceType}`)}</div>
                </td>
                <td className={td}>
                  <span className="break-words">
                    {m.host && <span className="text-muted">{m.host} · </span>}
                    {m.checkName}
                  </span>
                  <div className="text-xs text-muted">
                    {t('checks.lastCheck')}: {fmt.relative(m.lastCheckAt)}
                  </div>
                </td>
                <td className={`${td} text-right tabular-nums`}>{m.votes}</td>
                <td className={td}>
                  <CheckStateBadge state={m.state} />
                </td>
                <td className={td}>
                  {m.reporting ? (
                    <Badge tone="success">{t('bundles.reason.reporting')}</Badge>
                  ) : (
                    <Badge tone="warning">{t(`bundles.reason.${m.reason}`)}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

function BundleDialog({ bundle, onClose }: { bundle?: AdminCheckBundle; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const form = useForm<BundleFormValues>(() => bundleToForm(bundle));
  const v = form.values;
  // Members of other source types stay visible when editing such a bundle.
  const [type, setType] = useState<ConfigurableSourceType | ''>(() =>
    !bundle || bundle.members.every((m) => m.sourceType === DEFAULT_TYPE) ? DEFAULT_TYPE : '',
  );
  const candidates = useBundleCandidates(type);

  const save = useAdminMutation(
    (body: CheckBundleInput) =>
      bundle ? api.patch(`/api/admin/check-bundles/${bundle.id}`, body, { id: bundle.id }) : api.post('/api/admin/check-bundles', body),
    { success: bundle ? t('bundles.saved') : t('bundles.created'), onSuccess: onClose, onError: form.applyServerError },
  );

  const setMembers = (members: MemberRow[]) => form.set('members', members);
  const totalVotes = sumVotes(v.members);
  const visibleSources = new Set((candidates.data ?? []).map((s) => s.id));
  const hiddenCount = candidates.data ? v.members.filter((m) => !visibleSources.has(m.sourceId)).length : 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = form.validate(CheckBundleInput, bundleFormToPayload(v));
    if (body) save.mutate(body);
  };

  const typeOptions = useMemo(
    () => [
      { value: '' as const, label: t('bundles.allSourceTypes') },
      ...CONFIGURABLE_SOURCE_TYPES.map((x) => ({ value: x, label: t(`sources.types.${x}`) })),
    ],
    [t],
  );

  return (
    <Dialog open onClose={onClose} wide title={bundle ? t('bundles.editTitle') : t('bundles.new')}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <TextField
          label={t('bundles.fields.name')}
          value={v.name}
          onValue={(x) => form.set('name', x)}
          error={form.error('name')}
          help={t('bundles.nameHelp')}
          required
          autoFocus
        />
        <TextAreaField
          label={t('bundles.fields.description')}
          value={v.description}
          onValue={(x) => form.set('description', x)}
          error={form.error('description')}
          rows={2}
        />

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">{t('bundles.membersTitle')}</legend>
          <p className="text-xs text-muted">{t('bundles.membersHelp')}</p>
          <SelectField<ConfigurableSourceType | ''>
            label={t('bundles.sourceTypeFilter')}
            value={type}
            onValue={setType}
            options={typeOptions}
          />
          {candidates.isPending ? (
            <div className="flex justify-center p-4">
              <Spinner />
            </div>
          ) : (candidates.data ?? []).length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
              {t('bundles.noCandidates')}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {(candidates.data ?? []).map((source) => (
                <li key={source.id}>
                  <SourceMembers
                    source={source}
                    members={v.members}
                    onChange={setMembers}
                    error={(index) => form.error(`members.${index}`)}
                  />
                </li>
              ))}
            </ul>
          )}
          {hiddenCount > 0 && (
            <p className="text-xs text-muted" role="note">
              {t('bundles.hiddenMembers', { count: hiddenCount })}
            </p>
          )}
          <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm" aria-live="polite">
            {totalVotes === 0
              ? t('bundles.majorityNone')
              : t('bundles.majorityHint', { needed: majorityThreshold(totalVotes), total: totalVotes })}
          </p>
          {form.error('members') && !v.members.some((_, i) => form.error(`members.${i}`)) && (
            <p className="text-xs text-status-major-outage">{form.error('members')}</p>
          )}
        </fieldset>

        <FormErrorSummary errors={form.errors} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button type="submit" variant="primary" pending={save.isPending}>
            {bundle ? t('common:actions.save') : t('common:actions.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Checks of one source (node) in the bundle: chosen members with votes, plus a picker for more. */
function SourceMembers({
  source,
  members,
  onChange,
  error,
}: {
  source: BundleCandidateSource;
  members: MemberRow[];
  onChange: (members: MemberRow[]) => void;
  error: (index: number) => string | undefined;
}) {
  const { t } = useTranslation('admin');
  const addId = useId();
  const [pick, setPick] = useState('');
  const chosen = new Set(members.map((m) => m.checkId));
  const byId = new Map(source.checks.map((c) => [c.id, c]));
  const label = (c: { host: string | null; name: string }) => (c.host ? `${c.host} · ${c.name}` : c.name);
  const available = source.checks.filter((c) => !chosen.has(c.id));
  const rows = members.map((m, index) => ({ m, index })).filter(({ m }) => m.sourceId === source.id);

  const update = (index: number, patch: Partial<MemberRow>) =>
    onChange(members.map((m, i) => (i === index ? { ...m, ...patch } : m)));

  return (
    <fieldset className="rounded-lg border border-border p-3">
      <legend className="flex flex-wrap items-center gap-2 px-1">
        <span className="text-sm font-medium">{source.name}</span>
        <Badge tone="accent">{t(`sources.types.${source.sourceType}`)}</Badge>
        {!source.enabled && <Badge tone="warning">{t('sources.disabled')}</Badge>}
      </legend>
      {rows.length > 0 && (
        <ul className="mb-2 flex flex-col gap-2">
          {rows.map(({ m, index }) => {
            const check = byId.get(m.checkId);
            const name = check ? label(check) : m.checkId;
            const err = error(index);
            const votesId = `${addId}-votes-${index}`;
            return (
              <li key={m.checkId} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 text-sm break-words">{name}</span>
                {check && <CheckStateBadge state={check.state} />}
                <label htmlFor={votesId} className="text-xs text-muted">
                  {t('bundles.votes')}
                </label>
                <input
                  id={votesId}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_BUNDLE_MEMBER_VOTES}
                  step={1}
                  value={m.votes}
                  onChange={(e) => update(index, { votes: e.target.value })}
                  aria-label={t('bundles.votesFor', { name })}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={err ? `${votesId}-error` : undefined}
                  className={`${inputClass} w-24 py-1.5`}
                />
                <IconButton
                  icon={X}
                  label={t('bundles.removeMember', { name })}
                  onClick={() => onChange(members.filter((_, i) => i !== index))}
                />
                {err && (
                  <p id={`${votesId}-error`} className="w-full text-xs text-status-major-outage">
                    {err}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {available.length > 0 ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={addId} className="text-xs text-muted">
            {rows.length === 0 ? t('bundles.pickCheck') : t('bundles.pickAnother')}
          </label>
          <div className="flex gap-2">
            <select
              id={addId}
              className={`${inputClass} py-1.5`}
              value={available.some((c) => c.id === pick) ? pick : ''}
              onChange={(e) => setPick(e.target.value)}
            >
              <option value="">{t('bundles.selectCheck')}</option>
              {available.map((c) => (
                <option key={c.id} value={c.id}>
                  {label(c)}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              icon={Plus}
              aria-label={t('bundles.addMemberFrom', { source: source.name })}
              disabled={!available.some((c) => c.id === pick)}
              onClick={() => {
                onChange([...members, { checkId: pick, sourceId: source.id, votes: '1' }]);
                setPick('');
              }}
            >
              {t('bundles.addMember')}
            </Button>
          </div>
        </div>
      ) : (
        rows.length === 0 && <p className="text-xs text-muted">{t('bundles.sourceHasNoChecks')}</p>
      )}
    </fieldset>
  );
}
