/**
 * Form model of a monitoring source. Secrets are never shown: the server
 * returns SECRET_MASK and the form keeps that value until the user types a
 * new secret.
 */
import { SECRET_MASK, type AdminMonitorSource, type MonitorSourceType } from '@openstatuspage/shared';

export interface SourceFormValues {
  name: string;
  type: MonitorSourceType;
  enabled: boolean;
  pollIntervalSeconds: string;
  baseUrl: string;
  username: string;
  /** '' = keep stored secret (when `storedSecrets` is true) */
  password: string;
  apiKey: string;
  filter: string;
  includeHosts: boolean;
  verifyTls: boolean;
}

export const PULL_TYPES: MonitorSourceType[] = ['icinga2', 'uptimekuma', 'openitcockpit'];
export const isPullType = (type: MonitorSourceType) => PULL_TYPES.includes(type);

export const emptySourceForm = (): SourceFormValues => ({
  name: '',
  type: 'icinga2',
  enabled: true,
  pollIntervalSeconds: '60',
  baseUrl: '',
  username: '',
  password: '',
  apiKey: '',
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
    type: s.type,
    enabled: s.enabled,
    pollIntervalSeconds: String(s.pollIntervalSeconds),
    baseUrl: str(c.baseUrl),
    username: str(c.username),
    password: str(c.password) === SECRET_MASK ? '' : str(c.password),
    apiKey: str(c.apiKey) === SECRET_MASK ? '' : str(c.apiKey),
    filter: str(c.filter),
    includeHosts: bool(c.includeHosts, true),
    verifyTls: bool(c.verifyTls, true),
  };
}

/** Whether the stored source has a secret for `key` that is kept when the input stays empty. */
export function hasStoredSecret(source: AdminMonitorSource | undefined, key: 'password' | 'apiKey', type: MonitorSourceType): boolean {
  return Boolean(source && source.type === type && source.config[key] === SECRET_MASK);
}

/** MonitorSourceInput payload. Empty secret inputs send SECRET_MASK when a stored secret exists. */
export function sourceFormToPayload(v: SourceFormValues, source?: AdminMonitorSource) {
  const secret = (key: 'password' | 'apiKey') =>
    v[key] === '' && hasStoredSecret(source, key, v.type) ? SECRET_MASK : v[key];
  const interval = Number(v.pollIntervalSeconds);
  const common = {
    name: v.name.trim(),
    enabled: v.enabled,
    pollIntervalSeconds: Number.isFinite(interval) && v.pollIntervalSeconds.trim() !== '' ? interval : Number.NaN,
  };
  const baseUrl = v.baseUrl.trim();
  switch (v.type) {
    case 'icinga2':
      return {
        ...common,
        type: v.type,
        config: {
          baseUrl,
          username: v.username.trim(),
          password: secret('password'),
          filter: v.filter.trim() || null,
          includeHosts: v.includeHosts,
          verifyTls: v.verifyTls,
        },
      };
    case 'uptimekuma':
      return { ...common, type: v.type, config: { baseUrl, apiKey: secret('apiKey'), verifyTls: v.verifyTls } };
    case 'openitcockpit':
      return {
        ...common,
        type: v.type,
        config: { baseUrl, apiKey: secret('apiKey'), includeHosts: v.includeHosts, verifyTls: v.verifyTls },
      };
    case 'webhook':
      // Webhook sources only receive pushes; the interval is ignored but must stay valid.
      return { ...common, pollIntervalSeconds: Number.isNaN(common.pollIntervalSeconds) ? 60 : common.pollIntervalSeconds, type: v.type, config: {} };
  }
}
