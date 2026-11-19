/**
 * Service builder: links internal monitoring checks to a public service and
 * maps each check state to a service status. Check details never leave the
 * admin area.
 */
import { CHECK_STATES, type AdminMonitorCheck, type CheckState, type ImpactStatus, type ServiceCheckLinkInput } from '@openstatuspage/shared';
import { Link2, Lock, Plus, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../lib/format';
import { useChecks, useSources } from '../lib/queries';
import { useDebounced } from '../lib/useDebounced';
import { CheckboxField, InlineSelect, inputClass } from './fields';
import { Badge, Button, CheckStateBadge, IconButton, Spinner } from './ui';

export type CheckLink = ServiceCheckLinkInput & { check?: AdminMonitorCheck };

const IGNORE = 'ignore';
type MappingValue = ImpactStatus | typeof IGNORE;
const MAPPING_KEYS = ['warningStatus', 'criticalStatus', 'unknownStatus'] as const;
const RESULT_LIMIT = 100;

export const DEFAULT_LINK: Omit<ServiceCheckLinkInput, 'checkId'> = {
  warningStatus: 'degraded',
  criticalStatus: 'major_outage',
  unknownStatus: null,
};

export function CheckLinksEditor({
  links,
  onChange,
  readOnly,
  error,
}: {
  links: CheckLink[];
  onChange: (links: CheckLink[]) => void;
  readOnly?: boolean;
  error?: string;
}) {
  const { t } = useTranslation('admin');
  const [pickerOpen, setPickerOpen] = useState(false);

  const mappingOptions = useMemo(
    () => [
      { value: IGNORE as MappingValue, label: t('checkLinks.ignore') },
      { value: 'degraded' as MappingValue, label: t('common:status.degraded') },
      { value: 'partial_outage' as MappingValue, label: t('common:status.partial_outage') },
      { value: 'major_outage' as MappingValue, label: t('common:status.major_outage') },
    ],
    [t],
  );

  const update = (checkId: string, patch: Partial<CheckLink>) =>
    onChange(links.map((l) => (l.checkId === checkId ? { ...l, ...patch } : l)));

  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
        <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        {t('checkLinks.internalNotice')}
      </p>

      {links.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted">{t('checkLinks.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {links.map((link) => {
            const check = link.check;
            const name = check ? check.name : link.checkId;
            return (
              <li key={link.checkId} className="flex flex-col gap-2 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium break-words">
                      {check?.host && <span className="text-muted">{check.host} · </span>}
                      {name}
                    </p>
                    <p className="text-xs text-muted">{check ? check.sourceName : t('checkLinks.unknownCheck')}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {check && <CheckStateBadge state={check.state} />}
                    {!readOnly && (
                      <IconButton
                        icon={X}
                        label={t('checkLinks.remove', { name })}
                        onClick={() => onChange(links.filter((l) => l.checkId !== link.checkId))}
                      />
                    )}
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  {MAPPING_KEYS.map((key) => (
                    <label key={key} className="flex flex-col gap-1 text-xs text-muted">
                      {t(`checkLinks.when.${key}`)}
                      <InlineSelect<MappingValue>
                        label={t('checkLinks.mappingFor', { state: t(`checkLinks.when.${key}`), name })}
                        value={link[key] ?? IGNORE}
                        options={mappingOptions}
                        disabled={readOnly}
                        onValue={(v) => update(link.checkId, { [key]: v === IGNORE ? null : v })}
                      />
                    </label>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="text-xs text-status-major-outage-text">{error}</p>}

      {!readOnly &&
        (pickerOpen ? (
          <CheckPicker
            linkedIds={new Set(links.map((l) => l.checkId))}
            onAdd={(check) => onChange([...links, { checkId: check.id, ...DEFAULT_LINK, check }])}
            onClose={() => setPickerOpen(false)}
          />
        ) : (
          <div>
            <Button icon={Plus} onClick={() => setPickerOpen(true)}>
              {t('checkLinks.add')}
            </Button>
          </div>
        ))}
    </div>
  );
}

function CheckPicker({
  linkedIds,
  onAdd,
  onClose,
}: {
  linkedIds: Set<string>;
  onAdd: (check: AdminMonitorCheck) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const [q, setQ] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [state, setState] = useState<CheckState | ''>('');
  const [unlinked, setUnlinked] = useState(false);
  const debouncedQ = useDebounced(q.trim(), 250);
  const sources = useSources();
  const checks = useChecks({ q: debouncedQ || undefined, sourceId: sourceId || undefined, state: state || undefined, unlinked });
  const results = checks.data ?? [];

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-accent/40 bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t('checkLinks.pickerTitle')}</p>
        <IconButton icon={X} label={t('common:actions.close')} onClick={onClose} />
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('checkLinks.searchPlaceholder')}
            aria-label={t('checkLinks.search')}
            className={`${inputClass} pl-8`}
            autoFocus
          />
        </div>
        <InlineSelect
          label={t('checks.filterSource')}
          value={sourceId}
          onValue={setSourceId}
          options={[{ value: '', label: t('checks.allSources') }, ...(sources.data ?? []).map((s) => ({ value: s.id, label: s.name }))]}
        />
        <InlineSelect<CheckState | ''>
          label={t('checks.filterState')}
          value={state}
          onValue={setState}
          options={[{ value: '', label: t('checks.allStates') }, ...CHECK_STATES.map((s) => ({ value: s, label: t(`common:checkState.${s}`) }))]}
        />
      </div>
      <CheckboxField label={t('checks.onlyUnlinked')} checked={unlinked} onChecked={setUnlinked} />
      <div className="max-h-80 overflow-y-auto rounded-lg border border-border" aria-busy={checks.isFetching}>
        {checks.isPending ? (
          <div className="flex justify-center p-4">
            <Spinner />
          </div>
        ) : results.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted">{t('checks.empty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {results.slice(0, RESULT_LIMIT).map((c) => {
              const linked = linkedIds.has(c.id);
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm break-words">
                      {c.host && <span className="text-muted">{c.host} · </span>}
                      {c.name}
                    </p>
                    <p className="text-xs text-muted">
                      {c.sourceName} · {t('checks.lastCheck')}: {fmt.relative(c.lastCheckAt)}
                      {c.serviceCount > 0 && <> · {t('checks.linkedTo', { count: c.serviceCount })}</>}
                    </p>
                  </div>
                  <CheckStateBadge state={c.state} />
                  {linked ? (
                    <Badge tone="accent">{t('checkLinks.linked')}</Badge>
                  ) : (
                    <Button size="sm" icon={Link2} onClick={() => onAdd(c)}>
                      {t('checkLinks.link')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {results.length > RESULT_LIMIT && (
        <p className="text-xs text-muted">{t('checkLinks.moreResults', { shown: RESULT_LIMIT, total: results.length })}</p>
      )}
    </div>
  );
}
