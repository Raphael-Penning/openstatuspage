/**
 * Images uploaded in the management UI (logo, favicon, images of the content
 * pages), stored in the database and served at `/uploads/<sha256>.<ext>`.
 *
 * Only raster formats are accepted, recognized by their magic bytes (never by
 * the file name or the declared type): PNG, JPEG, WebP and ICO, at most 1 MiB.
 * SVG is rejected: it can carry scripts, event handlers, foreign objects and
 * external references, and sanitizing it safely needs a full XML sanitizer.
 */

/** Largest upload in bytes (1 MiB). */
export const UPLOAD_MAX_BYTES = 1024 * 1024;
/** Largest width or height in pixels. */
export const UPLOAD_MAX_DIMENSION = 10_000;
/** Path prefix of the uploads. */
export const UPLOAD_PATH_PREFIX = '/uploads/';

export const UPLOAD_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
} as const;
export type UploadExtension = keyof typeof UPLOAD_TYPES;

/** `/uploads/<sha256>.<ext>`: the content hash makes the URL immutable. */
export function uploadPath(hash: string, extension: UploadExtension): string {
  return `${UPLOAD_PATH_PREFIX}${hash}.${extension}`;
}

/** `<sha256>.<ext>` of an upload path segment; null for anything else. */
export function parseUploadFile(file: string): { hash: string; extension: UploadExtension } | null {
  const match = /^([0-9a-f]{64})\.(png|jpg|webp|ico)$/.exec(file);
  return match ? { hash: match[1]!, extension: match[2] as UploadExtension } : null;
}

/** An upload as the management API returns it. */
export interface AdminUpload {
  id: string;
  /** Path on this site (`/uploads/<sha256>.<ext>`), usable as logo or favicon URL and in Markdown. */
  url: string;
  contentType: string;
  /** Size in bytes. */
  size: number;
  width: number;
  height: number;
  /** File name as uploaded (display only). */
  filename: string | null;
  createdAt: string;
}

export interface SniffedImage {
  extension: UploadExtension;
  contentType: string;
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) + ((b[i + 3]! << 24) >>> 0);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
const starts = (b: Uint8Array, bytes: number[]) => bytes.every((v, i) => b[i] === v);

function png(b: Uint8Array): [number, number] | null {
  if (b.length < 33 || !starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  // The first chunk is IHDR (length 13): width and height as big-endian 32-bit.
  if (u32be(b, 8) !== 13 || ascii(b, 12, 4) !== 'IHDR') return null;
  return [u32be(b, 16), u32be(b, 20)];
}

function jpeg(b: Uint8Array): [number, number] | null {
  if (b.length < 4 || !starts(b, [0xff, 0xd8, 0xff])) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    // Fill bytes and markers without a length.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    // Start of frame (baseline, progressive, ...), not DHT (c4), JPG (c8) or DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [u16be(b, i + 7), u16be(b, i + 5)];
    }
    // Start of scan or end of image before a frame header.
    if (marker === 0xda || marker === 0xd9) return null;
    i += 2 + length;
  }
  return null;
}

function webp(b: Uint8Array): [number, number] | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    // Key frame start code, then 14-bit width and height.
    if (!(b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)) return null;
    return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff];
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = u32le(b, 21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (chunk === 'VP8X') return [u24le(b, 24) + 1, u24le(b, 27) + 1];
  return null;
}

function ico(b: Uint8Array): [number, number] | null {
  if (b.length < 22 || !starts(b, [0x00, 0x00, 0x01, 0x00])) return null;
  const count = u16le(b, 4);
  if (count < 1 || count > 64 || b.length < 6 + count * 16) return null;
  let best: [number, number] | null = null;
  for (let n = 0; n < count; n++) {
    const entry = 6 + n * 16;
    const size = u32le(b, entry + 8);
    const offset = u32le(b, entry + 12);
    // Every image must lie inside the file.
    if (size === 0 || offset < 6 + count * 16 || offset + size > b.length) return null;
    // 0 means 256 pixels.
    const width = b[entry]! || 256;
    const height = b[entry + 1]! || 256;
    if (!best || width * height > best[0] * best[1]) best = [width, height];
  }
  return best;
}

/**
 * The image format and size of `bytes` from their magic bytes and headers; null
 * when they are no PNG, JPEG, WebP or ICO (SVG, HTML, anything else), or the
 * size is 0 or above {@link UPLOAD_MAX_DIMENSION}.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const found: [UploadExtension, [number, number] | null][] = [
    ['png', png(bytes)],
    ['jpg', jpeg(bytes)],
    ['webp', webp(bytes)],
    ['ico', ico(bytes)],
  ];
  for (const [extension, size] of found) {
    if (!size) continue;
    const [width, height] = size;
    if (width < 1 || height < 1 || width > UPLOAD_MAX_DIMENSION || height > UPLOAD_MAX_DIMENSION) return null;
    return { extension, contentType: UPLOAD_TYPES[extension], width, height };
  }
  return null;
}
