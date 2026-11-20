/**
 * Building blocks of the email subscription pages: form controls in the
 * public page style, the scope picker with the grouped service checklist and
 * centered result states.
 */
import { SUBSCRIPTION_LOCALES, type SubscriptionLocale } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { Unlink } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { LANGUAGES } from '../../lib/languages';
import { selectionState, setSelected, type ServiceSection } from '../utils/subscription';
import { Card } from './ui';

export const fieldClass = clsx(
  'block w-full rounded-xl border border-border-strong bg-bg px-3.5 py-2.5 text-sm text-fg placeholder:text-muted',
  'focus:border-accent focus:outline-2 focus:outline-offset-1 focus:outline-focus',
  'aria-[invalid=true]:border-status-major-outage',
);

export const primaryButton = clsx(
  'inline-flex items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-medium shadow-sm',
  'bg-[color:var(--osp-accent-solid,var(--accent))] text-[color:var(--osp-accent-solid-fg,var(--accent-fg))]',
  'hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
  'disabled:cursor-not-allowed disabled:opacity-60',
);

export const secondaryButton = clsx(
  'inline-flex items-center justify-center gap-2 rounded-full border border-border bg-surface px-5 py-2 text-sm font-medium',
  'hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
  'disabled:cursor-not-allowed disabled:opacity-60',
);

export const dangerButton = clsx(
  'inline-flex items-center justify-center gap-2 rounded-full border border-status-major-outage/40 px-5 py-2 text-sm font-medium text-status-major-outage-text',
  'hover:bg-status-major-outage/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-status-major-outage',
  'disabled:cursor-not-allowed disabled:opacity-60',
);

const checkboxClass = 'size-4 shrink-0 accent-[color:var(--osp-accent-solid,var(--accent))]';

/** Error line below a field. */
export function FieldError({ id, children }: { id: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} className="text-sm text-status-major-outage-text">
      {children}
    </p>
  );
}

/** Language of the notification emails. */
export function LocaleSelect({ value, onChange }: { value: SubscriptionLocale; onChange: (v: SubscriptionLocale) => void }) {
  const { t } = useTranslation('public');
  const id = useId();
  const options = LANGUAGES.filter((l) => (SUBSCRIPTION_LOCALES as readonly string[]).includes(l.code));
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {t('subscription.language')}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as SubscriptionLocale)} className={fieldClass}>
        {options.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Checkbox with an indeterminate state (some services of a group selected). */
function TriStateCheckbox({
  state,
  onChange,
  label,
  hint,
}: {
  state: 'all' | 'some' | 'none';
  onChange: (on: boolean) => void;
  label: string;
  hint?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <div className="flex items-center gap-2.5">
      <input
        ref={ref}
        id={id}
        type="checkbox"
        checked={state === 'all'}
        aria-checked={state === 'some' ? 'mixed' : state === 'all'}
        onChange={(e) => onChange(e.target.checked)}
        className={checkboxClass}
      />
      <label htmlFor={id} className="min-w-0 flex-1 text-sm font-semibold">
        {label}
      </label>
      {hint && <span className="shrink-0 text-xs text-muted">{hint}</span>}
    </div>
  );
}

interface ScopeValue {
  allServices: boolean;
  serviceIds: string[];
}

/** "All updates" vs. "selected services" with a checklist grouped like the status page. */
export function ScopePicker({
  value,
  onChange,
  sections,
  error,
  ref,
}: {
  value: ScopeValue;
  onChange: (v: ScopeValue) => void;
  sections: ServiceSection[];
  error?: string;
  /** Receives focus when the selection is invalid on submit (WCAG 3.3.1). */
  ref?: Ref<HTMLFieldSetElement>;
}) {
  const { t } = useTranslation('public');
  const name = useId();
  const errorId = useId();
  const total = sections.reduce((n, s) => n + s.services.length, 0);
  const selectedCount = sections.reduce((n, s) => n + s.services.filter((x) => value.serviceIds.includes(x.id)).length, 0);
  const allIds = sections.flatMap((s) => s.services.map((x) => x.id));
  const setIds = (serviceIds: string[]) => onChange({ ...value, serviceIds });

  const radio = (all: boolean, label: string, help: string) => (
    <label
      className={clsx(
        'flex cursor-pointer gap-3 rounded-xl border p-3.5 focus-within:outline-2 focus-within:outline-focus',
        value.allServices === all ? 'border-accent bg-surface-2' : 'border-border hover:border-accent/60',
      )}
    >
      <input
        type="radio"
        name={name}
        checked={value.allServices === all}
        onChange={() => onChange({ ...value, allServices: all })}
        className={clsx(checkboxClass, 'mt-0.5')}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted">{help}</span>
      </span>
    </label>
  );

  return (
    <fieldset
      ref={ref}
      tabIndex={-1}
      className="flex flex-col gap-3 rounded-xl focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus"
      aria-describedby={error ? errorId : undefined}
      aria-invalid={error ? true : undefined}
    >
      <legend className="mb-1.5 text-sm font-medium">{t('subscription.scope.label')}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {radio(true, t('subscription.scope.all'), t('subscription.scope.allHelp'))}
        {radio(false, t('subscription.scope.selected'), t('subscription.scope.selectedHelp'))}
      </div>

      {!value.allServices &&
        (total === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted">{t('subscription.services.empty')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted" aria-live="polite">
                {t('subscription.services.selectedCount', { count: selectedCount, total })}
              </p>
              <div className="flex gap-3 text-sm font-medium">
                <button
                  type="button"
                  className="min-h-6 text-[color:var(--osp-accent-text,var(--accent))] hover:underline disabled:opacity-50 disabled:no-underline"
                  disabled={selectedCount === total}
                  onClick={() => setIds(setSelected(value.serviceIds, allIds, true))}
                >
                  {t('subscription.services.selectAll')}
                </button>
                <button
                  type="button"
                  className="min-h-6 text-[color:var(--osp-accent-text,var(--accent))] hover:underline disabled:opacity-50 disabled:no-underline"
                  disabled={selectedCount === 0}
                  onClick={() => setIds([])}
                >
                  {t('subscription.services.clear')}
                </button>
              </div>
            </div>
            {sections.map((section) => {
              const ids = section.services.map((s) => s.id);
              const count = ids.filter((id) => value.serviceIds.includes(id)).length;
              return (
                <div key={section.id ?? 'ungrouped'} className="rounded-xl border border-border">
                  <div className="border-b border-border bg-surface-2/60 px-3.5 py-2.5">
                    <TriStateCheckbox
                      label={section.name ?? t('subscription.services.other')}
                      hint={`${count}/${ids.length}`}
                      state={selectionState(value.serviceIds, ids)}
                      onChange={(on) => setIds(setSelected(value.serviceIds, ids, on))}
                    />
                  </div>
                  <ul className="grid gap-x-4 px-3.5 py-2 sm:grid-cols-2">
                    {section.services.map((s) => {
                      const id = `${name}-${s.id}`;
                      return (
                        <li key={s.id} className="flex items-center gap-2.5 py-1.5">
                          <input
                            id={id}
                            type="checkbox"
                            checked={value.serviceIds.includes(s.id)}
                            onChange={(e) => setIds(setSelected(value.serviceIds, [s.id], e.target.checked))}
                            className={checkboxClass}
                          />
                          <label htmlFor={id} className="min-w-0 text-sm break-words">
                            {s.name}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        ))}
      <FieldError id={errorId}>{error}</FieldError>
    </fieldset>
  );
}

/**
 * Centered card for the outcome of a step (inbox check, confirmed, invalid
 * link). The heading receives focus so screen readers announce the new state.
 */
export function ResultState({
  icon,
  title,
  children,
  actions,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <Card className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-10 text-center">
      {icon}
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold text-balance focus:outline-none">
        {title}
      </h1>
      {children && <div className="flex flex-col gap-2 text-muted">{children}</div>}
      {actions && <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div>}
    </Card>
  );
}

/** State for confirmation / manage links that are malformed, unknown or expired. */
export function InvalidLinkState() {
  const { t } = useTranslation('public');
  return (
    <ResultState
      icon={<Unlink aria-hidden className="size-10 text-muted" />}
      title={t('subscription.invalidLink.title')}
      actions={
        <>
          <Link to="/subscribe" className={primaryButton}>
            {t('subscription.invalidLink.subscribe')}
          </Link>
          <Link to="/" className={secondaryButton}>
            {t('subscription.backHome')}
          </Link>
        </>
      }
    >
      <p>{t('subscription.invalidLink.description')}</p>
    </ResultState>
  );
}

/** Links carry secrets: never send them as referrer to other sites. */
export function NoReferrer() {
  return <meta name="referrer" content="no-referrer" />;
}
