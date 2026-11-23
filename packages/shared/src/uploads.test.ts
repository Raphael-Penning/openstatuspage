import { describe, expect, it } from 'vitest';
import { parseUploadFile, sniffImage, uploadPath } from './uploads.js';

/** A minimal PNG header (signature + IHDR) of the given size. */
function pngBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(45);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(b.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return b;
}

function jpegBytes(width: number, height: number): Uint8Array {
  // SOI, APP0 (length 16), SOF0 (length 17) with height and width.
  const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

function webpLossless(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  b.set([...'WEBPVP8L'].map((c) => c.charCodeAt(0)), 8);
  b[20] = 0x2f;
  new DataView(b.buffer).setUint32(21, ((width - 1) | ((height - 1) << 14)) >>> 0, true);
  return b;
}

function icoBytes(size: number): Uint8Array {
  const b = new Uint8Array(22 + 40);
  b.set([0, 0, 1, 0, 1, 0, size % 256, size % 256, 0, 0, 1, 0, 32, 0]);
  const view = new DataView(b.buffer);
  view.setUint32(14, 40, true);
  view.setUint32(18, 22, true);
  return b;
}

const text = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe('sniffImage', () => {
  it('recognizes PNG, JPEG, WebP and ICO with their size', () => {
    expect(sniffImage(pngBytes(320, 64))).toEqual({ extension: 'png', contentType: 'image/png', width: 320, height: 64 });
    expect(sniffImage(jpegBytes(640, 480))).toEqual({ extension: 'jpg', contentType: 'image/jpeg', width: 640, height: 480 });
    expect(sniffImage(webpLossless(100, 50))).toEqual({ extension: 'webp', contentType: 'image/webp', width: 100, height: 50 });
    expect(sniffImage(icoBytes(32))).toEqual({ extension: 'ico', contentType: 'image/x-icon', width: 32, height: 32 });
    expect(sniffImage(icoBytes(256))?.width).toBe(256);
  });

  it('rejects SVG, HTML, scripts and truncated or oversized images', () => {
    for (const bad of [
      text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      text('<?xml version="1.0"?><svg/>'),
      text('<!doctype html><html><script>alert(1)</script>'),
      text('GIF89a'),
      new Uint8Array(0),
      pngBytes(320, 64).subarray(0, 20),
      pngBytes(0, 64),
      pngBytes(20_000, 10),
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    ]) {
      expect(sniffImage(bad)).toBeNull();
    }
  });

  it('does not trust an ICO directory that points outside the file', () => {
    const b = icoBytes(16);
    new DataView(b.buffer).setUint32(14, 4096, true);
    expect(sniffImage(b)).toBeNull();
  });
});

describe('upload paths', () => {
  const hash = 'a'.repeat(64);
  it('round-trip', () => {
    expect(uploadPath(hash, 'png')).toBe(`/uploads/${hash}.png`);
    expect(parseUploadFile(`${hash}.webp`)).toEqual({ hash, extension: 'webp' });
  });
  it('reject anything else', () => {
    for (const file of [`${hash}.svg`, `${hash}.PNG`, `${'A'.repeat(64)}.png`, `${hash}.png.html`, 'x.png', `${hash}`]) {
      expect(parseUploadFile(file), file).toBeNull();
    }
  });
});
