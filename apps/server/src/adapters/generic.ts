/**
 * Generic push format (`POST /api/ingest/:sourceId`), accepted for every source type.
 * See `GenericIngestPayload` in packages/shared.
 */
import { GenericIngestPayload } from '@openstatuspage/shared';
import { serviceState } from './states.js';
import type { PushParser } from './types.js';

export const genericPushParser: PushParser = {
  parse(body) {
    const payload = GenericIngestPayload.parse(body);
    return {
      full: payload.full,
      checks: payload.checks.map((c) => ({
        externalId: c.id,
        name: c.name?.trim() || c.id,
        host: c.host?.trim() || null,
        // Numeric states follow the Nagios convention: 0 ok, 1 warning, 2 critical, 3 unknown.
        state: typeof c.state === 'number' ? serviceState(c.state) : c.state,
        output: c.output ?? null,
        checkedAt: c.timestamp ?? null,
      })),
    };
  },
};
