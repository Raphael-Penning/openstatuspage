import {
  CORRECTION_MAX_DAYS,
  CorrectionInput,
  CorrectionListQuery,
  CorrectionPatchInput,
  ServiceHistoryQuery,
  type AdminCorrection,
  type AdminServiceHistory,
  type HistorySegment,
} from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { IdParams, offsetOf, paginated, parse, unique } from '../../lib/http.js';
import { nowIso, toIso } from '../../lib/time.js';
import { actorUserId } from '../../plugins/auth.js';
import { loadCorrectionLayers, loadCorrections } from '../../services/corrections.js';
import { applyCorrections, type CorrectedSegment } from '../../services/history-corrections.js';
import { loadSegments } from '../../services/public-catalog.js';
import { averageUptime, type StatusSegment } from '../../services/uptime.js';
import { assertExist, auditRequest, editor } from './util.js';

/** Tolerated clock difference for an end time "now" entered in a form. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

async function getCorrection(db: DB, id: string): Promise<AdminCorrection> {
  const [c] = await loadCorrections(db, [id]);
  if (!c) throw notFound('Correction');
  return c;
}

/** Corrections only change the past: end times up to a few minutes ahead are clamped to now. */
function clampEnd(endsAt: string, now: string): string {
  const end = toIso(endsAt);
  if (new Date(end).getTime() - new Date(now).getTime() > FUTURE_TOLERANCE_MS) {
    throw badRequest('endsAt must not be in the future');
  }
  return end > now ? now : end;
}

/**
 * Creation time of a new correction, strictly after every existing one: it
 * decides precedence of overlapping corrections ("created last wins").
 */
async function nextCreatedAt(db: DB): Promise<string> {
  const now = nowIso();
  const last = await db
    .selectFrom('status_corrections')
    .select((eb) => eb.fn.max('created_at').as('latest'))
    .executeTakeFirst();
  const latest = last?.latest ?? null;
  if (latest === null || latest < now) return now;
  return new Date(new Date(latest).getTime() + 1).toISOString();
}

async function replaceServices(trx: DB, correctionId: string, serviceIds: string[]) {
  await trx.deleteFrom('status_correction_services').where('correction_id', '=', correctionId).execute();
  const ids = unique(serviceIds);
  if (ids.length > 0) {
    await trx
      .insertInto('status_correction_services')
      .values(ids.map((service_id) => ({ correction_id: correctionId, service_id })))
      .execute();
  }
}

/** Clips history segments to [from, to); `open` segments stay open when `to` is in the future. */
function clip(
  segments: (StatusSegment | CorrectedSegment)[],
  from: string,
  to: string,
  now: string,
): HistorySegment[] {
  const out: HistorySegment[] = [];
  for (const s of segments) {
    const end = s.ended_at ?? now;
    if (end <= from || s.started_at >= to) continue;
    const keepOpen = s.ended_at === null && to >= now;
    out.push({
      status: s.status,
      startedAt: s.started_at < from ? from : s.started_at,
      endedAt: keepOpen ? null : end > to ? to : end,
      source: 'source' in s ? s.source : 'measured',
      sourceId: 'source' in s ? s.sourceId : null,
    });
  }
  return out;
}

/**
 * /api/admin/corrections (editor): status overrides for past time ranges, and
 * GET /api/admin/services/:id/history: measured vs corrected history.
 */
export async function registerCorrectionRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

  app.get('/api/admin/corrections', editor, async (req) => {
    const q = parse(CorrectionListQuery, req.query);
    let base = db.selectFrom('status_corrections');
    if (q.serviceId) {
      const serviceId = q.serviceId;
      base = base.where((eb) =>
        eb.exists(
          eb
            .selectFrom('status_correction_services')
            .select('status_correction_services.correction_id')
            .whereRef('status_correction_services.correction_id', '=', 'status_corrections.id')
            .where('status_correction_services.service_id', '=', serviceId),
        ),
      );
    }
    if (q.from) base = base.where('status_corrections.ends_at', '>', toIso(q.from));
    if (q.to) base = base.where('status_corrections.starts_at', '<', toIso(q.to));
    const [total, rows] = await Promise.all([
      base
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .executeTakeFirstOrThrow()
        .then((r) => Number(r.n)),
      base
        .select('status_corrections.id')
        .orderBy('status_corrections.starts_at', 'desc')
        .orderBy('status_corrections.id')
        .limit(q.pageSize)
        .offset(offsetOf(q))
        .execute(),
    ]);
    const items = await loadCorrections(
      db,
      rows.map((r) => r.id),
    );
    return paginated(items, total, q);
  });

  app.get('/api/admin/corrections/:id', editor, async (req) => getCorrection(db, parse(IdParams, req.params).id));

  app.post('/api/admin/corrections', editor, async (req, reply) => {
    const input = parse(CorrectionInput, req.body);
    const serviceIds = await assertExist(db, 'services', input.serviceIds, 'service');
    const now = await nextCreatedAt(db);
    const start = toIso(input.startsAt);
    const end = clampEnd(input.endsAt, now);
    if (end <= start) throw badRequest('startsAt must be in the past');
    const id = newId();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('status_corrections')
        .values({
          id,
          starts_at: start,
          ends_at: end,
          status: input.status,
          reason: input.reason,
          show_public: input.showPublic ? 1 : 0,
          public_note: input.publicNote || null,
          created_by: actorUserId(req),
          created_at: now,
          updated_at: now,
        })
        .execute();
      await replaceServices(trx, id, serviceIds);
    });
    await auditRequest(db, req, 'correction.create', 'correction', id, {
      serviceIds,
      startsAt: start,
      endsAt: end,
      status: input.status,
      reason: input.reason,
      showPublic: input.showPublic,
    });
    return reply.status(201).send(await getCorrection(db, id));
  });

  app.patch('/api/admin/corrections/:id', editor, async (req) => {
    const { id } = parse(IdParams, req.params);
    const input = parse(CorrectionPatchInput, req.body);
    const current = await db.selectFrom('status_corrections').selectAll().where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Correction');
    if (input.serviceIds) await assertExist(db, 'services', input.serviceIds, 'service');
    const now = nowIso();
    const start = input.startsAt ? toIso(input.startsAt) : current.starts_at;
    const end = input.endsAt ? clampEnd(input.endsAt, now) : current.ends_at;
    if (end <= start) throw badRequest('endsAt must be after startsAt');
    if (new Date(end).getTime() - new Date(start).getTime() > CORRECTION_MAX_DAYS * DAY_MS) {
      throw badRequest(`A correction may span at most ${CORRECTION_MAX_DAYS} days`);
    }
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('status_corrections')
        .set({
          starts_at: start,
          ends_at: end,
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.showPublic !== undefined ? { show_public: input.showPublic ? 1 : 0 } : {}),
          ...(input.publicNote !== undefined ? { public_note: input.publicNote || null } : {}),
          updated_at: now,
        })
        .where('id', '=', id)
        .execute();
      if (input.serviceIds) await replaceServices(trx, id, input.serviceIds);
    });
    await auditRequest(db, req, 'correction.update', 'correction', id, {
      fields: Object.keys(input),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      startsAt: start,
      endsAt: end,
    });
    return getCorrection(db, id);
  });

  app.delete('/api/admin/corrections/:id', editor, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const [current] = await loadCorrections(db, [id]);
    if (!current) throw notFound('Correction');
    await db.deleteFrom('status_corrections').where('id', '=', id).execute();
    await auditRequest(db, req, 'correction.delete', 'correction', id, {
      serviceIds: current.services.map((s) => s.id),
      startsAt: current.startsAt,
      endsAt: current.endsAt,
      status: current.status,
      reason: current.reason,
    });
    return reply.status(204).send();
  });

  app.get('/api/admin/services/:id/history', editor, async (req): Promise<AdminServiceHistory> => {
    const { id } = parse(IdParams, req.params);
    const q = parse(ServiceHistoryQuery, req.query);
    const service = await db.selectFrom('services').select('id').where('id', '=', id).executeTakeFirst();
    if (!service) throw notFound('Service');
    const now = new Date();
    const nowStr = now.toISOString();
    const from = toIso(q.from);
    const to = toIso(q.to);
    const until = to < nowStr ? to : nowStr;

    const [segments, layers] = await Promise.all([
      loadSegments(db, [id], new Date(from), new Date(to)),
      loadCorrectionLayers(db, [id], from, to),
    ]);
    const measured = segments.get(id) ?? [];
    const own = layers.get(id)?.layers ?? [];
    const corrected = applyCorrections(measured, own, now);

    const correctionIds = unique(own.filter((l) => l.kind === 'correction').map((l) => l.id));
    const maintenanceIds = unique(own.filter((l) => l.kind === 'maintenance').map((l) => l.id));
    const [corrections, maintenances] = await Promise.all([
      loadCorrections(db, correctionIds),
      maintenanceIds.length
        ? db.selectFrom('maintenances').select(['id', 'title']).where('id', 'in', maintenanceIds).execute()
        : Promise.resolve([]),
    ]);
    const titles = new Map(maintenances.map((m) => [m.id, m.title]));

    return {
      from,
      to,
      measured: clip(measured, from, to, nowStr),
      corrected: clip(corrected, from, to, nowStr),
      measuredUptime: until > from ? averageUptime(measured, new Date(from), new Date(until)) : null,
      correctedUptime: until > from ? averageUptime(corrected, new Date(from), new Date(until)) : null,
      corrections: corrections.sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1)),
      maintenances: own
        .filter((l) => l.kind === 'maintenance')
        .map((l) => ({ id: l.id, title: titles.get(l.id) ?? '', start: l.start, end: l.end ?? nowStr })),
    };
  });
}
