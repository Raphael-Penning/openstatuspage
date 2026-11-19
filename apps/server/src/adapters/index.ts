/**
 * Adapter registry: which monitoring source types can be polled and which
 * native push payloads they accept.
 */
import {
  Icinga2Config,
  OpenItCockpitConfig,
  UptimeKumaConfig,
  WebhookConfig,
  type MonitorSourceType,
} from '@openstatuspage/shared';
import { z } from 'zod';
import { genericPushParser } from './generic.js';
import { icinga2PollAdapter, icinga2PushParser } from './icinga2.js';
import { openItCockpitPollAdapter, openItCockpitPushParser } from './openitcockpit.js';
import type { PollAdapter, PushParser } from './types.js';
import { uptimeKumaPollAdapter, uptimeKumaPushParser } from './uptimekuma.js';

export interface AdapterDefinition {
  /** Validates the decrypted source config (applies defaults). */
  configSchema: z.ZodType;
  /** Present when the source can be polled. Receives the config validated by `configSchema`. */
  poll?: PollAdapter<any>;
  /** Native push format, served at `/api/ingest/:sourceId/<type>`. */
  push?: PushParser;
  /** Config keys holding secrets (redacted from error messages). */
  secretKeys: readonly string[];
}

export const adapters: Record<MonitorSourceType, AdapterDefinition> = {
  icinga2: {
    configSchema: Icinga2Config,
    poll: icinga2PollAdapter,
    push: icinga2PushParser,
    secretKeys: ['password', 'icingaDbUrl'],
  },
  uptimekuma: {
    configSchema: UptimeKumaConfig,
    poll: uptimeKumaPollAdapter,
    push: uptimeKumaPushParser,
    secretKeys: ['apiKey', 'historyPassword'],
  },
  openitcockpit: {
    configSchema: OpenItCockpitConfig,
    poll: openItCockpitPollAdapter,
    push: openItCockpitPushParser,
    secretKeys: ['apiKey'],
  },
  webhook: {
    configSchema: WebhookConfig,
    secretKeys: [],
  },
  // Virtual source of the check bundles: states are computed, never polled or pushed.
  bundle: {
    configSchema: z.object({}),
    secretKeys: [],
  },
};

/** Generic push parser, accepted for every source type. */
export { genericPushParser };

export function getAdapter(type: string): AdapterDefinition | undefined {
  return Object.hasOwn(adapters, type) ? adapters[type as MonitorSourceType] : undefined;
}

export function isPollable(type: string): boolean {
  return getAdapter(type)?.poll !== undefined;
}
