/**
 * Form model of a monitoring source. Secrets are never shown: the server
 * returns SECRET_MASK and the form keeps that value until the user types a
 * new secret.
 */
import {
  BUNDLE_SOURCE_TYPE,
  SECRET_MASK,
  type AdminMonitorSource,
  type ConfigurableSourceType,
  type MonitorSourceType,
} from '@openstatuspage/shared';

export interface SourceFormValues {
  name: string;
  sourceType: ConfigurableSourceType;
  enabled: boolean;
  pollIntervalSeconds: string;
  baseUrl: string;
  username: string;
  /** '' = keep stored secret (when `storedSecrets` is true) */
  password: string;
  apiKey: string;
  /** Icinga DB connection string for history imports ('' = keep stored / none). */
  icingaDbUrl: string;
  /** Uptime Kuma login for history imports. */
  historyUsername: string;
  historyPassword: string;
  filter: string;
  includeHosts: boolean;
  verifyTls: boolean;
}

export const PULL_TYPES: MonitorSourceType[] = ['icinga2', 'uptimekuma', 'openitcockpit'];
export const isPullType = (type: MonitorSourceType) => PULL_TYPES.includes(type);
/** The built-in source holding the check bundles: managed by the server, not editable. */
export const isBundleSource = (s: Pick<AdminMonitorSource, 'sourceType'>) => s.sourceType === BUNDLE_SOURCE_TYPE;

export const emptySourceForm = (): SourceFormValues => ({
  name: '',
  sourceType: 'icinga2',
  enabled: true,
  pollIntervalSeconds: '60',
  baseUrl: '',
  username: '',
  password: '',
  apiKey: '',
  icingaDbUrl: '',
  historyUsername: '',
  historyPassword: '',
  filter: '',
  includeHosts: true,
  verifyTls: true,
});

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

/** Form values from a stored source. Masked secrets become '' (= unchanged). */
export function sourceToForm(s: AdminMonitorSource): SourceFormValues {
  const c = s.config;
  return {
    name: s.name,
    // The bundle source is never edited in this form.
    sourceType: s.sourceType === BUNDLE_SOURCE_TYPE ? 'webhook' : s.sourceType,
    enabled: s.enabled,
    pollIntervalSeconds: String(s.pollIntervalSeconds),
    baseUrl: str(c.baseUrl),
    username: str(c.username),
    password: str(c.password) === SECRET_MASK ? '' : str(c.password),
    apiKey: str(c.apiKey) === SECRET_MASK ? '' : str(c.apiKey),
    icingaDbUrl: str(c.icingaDbUrl) === SECRET_MASK ? '' : str(c.icingaDbUrl),
    historyUsername: str(c.historyUsername),
    historyPassword: str(c.historyPassword) === SECRET_MASK ? '' : str(c.historyPassword),
    filter: str(c.filter),
    includeHosts: bool(c.includeHosts, true),
    verifyTls: bool(c.verifyTls, true),
  };
}

/** Whether the stored source has a secret for `key` that is kept when the input stays empty. */
export type SecretKey = 'password' | 'apiKey' | 'icingaDbUrl' | 'historyPassword';
/** Secrets that are optional: empty without a stored value sends null. */
const OPTIONAL_SECRETS: readonly SecretKey[] = ['icingaDbUrl', 'historyPassword'];

export function hasStoredSecret(source: AdminMonitorSource | undefined, key: SecretKey, type: ConfigurableSourceType): boolean {
  return Boolean(source && source.sourceType === type && source.config[key] === SECRET_MASK);
}

/** MonitorSourceInput payload. Empty secret inputs send SECRET_MASK when a stored secret exists. */
export function sourceFormToPayload(v: SourceFormValues, source?: AdminMonitorSource) {
  const secret = (key: SecretKey) => {
    if (v[key] !== '') return key === 'icingaDbUrl' ? v[key].trim() : v[key];
    if (hasStoredSecret(source, key, v.sourceType)) return SECRET_MASK;
    return OPTIONAL_SECRETS.includes(key) ? null : '';
  };
  const interval = Number(v.pollIntervalSeconds);
  const common = {
    name: v.name.trim(),
    enabled: v.enabled,
    pollIntervalSeconds: Number.isFinite(interval) && v.pollIntervalSeconds.trim() !== '' ? interval : Number.NaN,
  };
  const baseUrl = v.baseUrl.trim();
  switch (v.sourceType) {
    case 'icinga2':
      return {
        ...common,
        sourceType: v.sourceType,
        config: {
          baseUrl,
          username: v.username.trim(),
          password: secret('password'),
          filter: v.filter.trim() || null,
          includeHosts: v.includeHosts,
          verifyTls: v.verifyTls,
          icingaDbUrl: secret('icingaDbUrl'),
        },
      };
    case 'uptimekuma':
      return {
        ...common,
        sourceType: v.sourceType,
        config: {
          baseUrl,
          apiKey: secret('apiKey'),
          verifyTls: v.verifyTls,
          historyUsername: v.historyUsername.trim() || null,
          historyPassword: secret('historyPassword'),
        },
      };
    case 'openitcockpit':
      return {
        ...common,
        sourceType: v.sourceType,
        config: { baseUrl, apiKey: secret('apiKey'), includeHosts: v.includeHosts, verifyTls: v.verifyTls },
      };
    case 'webhook':
      // Webhook sources only receive pushes; the interval is ignored but must stay valid.
      return { ...common, pollIntervalSeconds: Number.isNaN(common.pollIntervalSeconds) ? 60 : common.pollIntervalSeconds, sourceType: v.sourceType, config: {} };
  }
}
