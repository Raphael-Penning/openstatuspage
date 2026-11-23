/**
 * Uploaded images (migration 0014_site_pages_uploads, packages/shared/src/uploads.ts):
 * stored in the database with their SHA-256 and their size in pixels, served
 * at /uploads/<sha256>.<ext> (routes/uploads.ts).
 *
 * Public reads select only the columns of the view osp_public.uploads (not the
 * original file name, not created_by).
 */
import { createHash } from 'node:crypto';
import {
  parseUploadFile,
  sniffImage,
  UPLOAD_MAX_BYTES,
  uploadPath,
  type AdminUpload,
  type ImageSize,
  type UploadExtension,
} from '@openstatuspage/shared';
import type { DB } from '../db/index.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';

/** Original file name for display: no path, no control characters, at most 120 characters. */
export function cleanFilename(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const base = value.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f"<>]/g, '').trim().slice(0, 120);
  return clean || null;
}

interface UploadRow {
  id: string;
  hash: string;
  extension: string;
  content_type: string;
  byte_size: number;
  width: number;
  height: number;
  filename: string | null;
  created_at: string;
}

const ADMIN_COLUMNS = ['id', 'hash', 'extension', 'content_type', 'byte_size', 'width', 'height', 'filename', 'created_at'] as const;

export function toAdminUpload(row: UploadRow): AdminUpload {
  return {
    id: row.id,
    url: uploadPath(row.hash, row.extension as UploadExtension),
    contentType: row.content_type,
    size: Number(row.byte_size),
    width: Number(row.width),
    height: Number(row.height),
    filename: row.filename,
    createdAt: row.created_at,
  };
}

export async function loadAdminUploads(db: DB, id?: string): Promise<AdminUpload[]> {
  let query = db.selectFrom('uploads').select(ADMIN_COLUMNS);
  if (id) query = query.where('id', '=', id);
  const rows = await query.orderBy('created_at', 'desc').orderBy('id').execute();
  return rows.map(toAdminUpload);
}

/**
 * Stores an image: checks size and type by its bytes (never by name or declared
 * type). The same bytes uploaded again return the existing upload.
 */
export async function storeUpload(db: DB, bytes: Buffer, filename: string | null, userId: string | null): Promise<{ upload: AdminUpload; created: boolean }> {
  if (bytes.length === 0) throw badRequest('The file is empty');
  if (bytes.length > UPLOAD_MAX_BYTES) throw new HttpError(413, 'payload_too_large', 'Images may be at most 1 MiB');
  const image = sniffImage(bytes);
  if (!image) {
    throw new HttpError(415, 'unsupported_media_type', 'Only PNG, JPEG, WebP and ICO images are accepted (no SVG)');
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  const existing = await db.selectFrom('uploads').select(ADMIN_COLUMNS).where('hash', '=', hash).executeTakeFirst();
  if (existing) return { upload: toAdminUpload(existing), created: false };
  const row = {
    id: newId(),
    hash,
    extension: image.extension,
    content_type: image.contentType,
    byte_size: bytes.length,
    width: image.width,
    height: image.height,
    filename,
    created_at: nowIso(),
  };
  await db.insertInto('uploads').values({ ...row, data: bytes, created_by: userId }).execute();
  return { upload: toAdminUpload(row), created: true };
}

/** An upload by its file name (`<sha256>.<ext>`) with its bytes; null when there is none. */
export async function loadUploadFile(
  db: DB,
  file: string,
): Promise<{ hash: string; contentType: string; data: Buffer } | null> {
  const parsed = parseUploadFile(file);
  if (!parsed) return null;
  const row = await db
    .selectFrom('uploads')
    .select(['hash', 'extension', 'content_type', 'data'])
    .where('hash', '=', parsed.hash)
    .executeTakeFirst();
  if (!row || row.extension !== parsed.extension) return null;
  return { hash: row.hash, contentType: row.content_type, data: Buffer.from(row.data) };
}

/** Sizes of the uploads at `paths` (`/uploads/<sha256>.<ext>`), by path; unknown ones are left out. */
export async function uploadSizes(db: DB, paths: string[]): Promise<Record<string, ImageSize>> {
  const wanted = new Map<string, string>();
  for (const path of paths) {
    const parsed = parseUploadFile(path.slice(path.lastIndexOf('/') + 1));
    if (parsed && path === uploadPath(parsed.hash, parsed.extension)) wanted.set(parsed.hash, path);
  }
  if (wanted.size === 0) return {};
  const rows = await db
    .selectFrom('uploads')
    .select(['hash', 'extension', 'width', 'height'])
    .where('hash', 'in', [...wanted.keys()].slice(0, 100))
    .execute();
  const out: Record<string, ImageSize> = {};
  for (const r of rows) {
    const path = wanted.get(r.hash);
    if (path && path === uploadPath(r.hash, r.extension as UploadExtension)) out[path] = { width: Number(r.width), height: Number(r.height) };
  }
  return out;
}
