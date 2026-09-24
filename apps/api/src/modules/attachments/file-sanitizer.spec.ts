import { describe, expect, it } from 'vitest';
import { pdfHasActiveContent, stripJpegMetadata, stripPngMetadata } from './file-sanitizer.js';

function jpegWithExif(): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const exifPayload = Buffer.from('Exif\0\0GPS-secret');
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.alloc(2), exifPayload]);
  app1.writeUInt16BE(exifPayload.length + 2, 2);
  const dqtPayload = Buffer.alloc(65, 1);
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb]), Buffer.alloc(2), dqtPayload]);
  dqt.writeUInt16BE(dqtPayload.length + 2, 2);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0x00, 0xaa, 0xbb, 0xff, 0xd9]);
  return Buffer.concat([soi, app1, dqt, sos]);
}

describe('assainissement des fichiers (CDC 16.2)', () => {
  it('retire les segments EXIF d’un JPEG et conserve les segments utiles', () => {
    const input = jpegWithExif();
    const output = stripJpegMetadata(input);
    expect(input.toString('latin1')).toContain('GPS-secret');
    expect(output.toString('latin1')).not.toContain('GPS-secret');
    expect(output[0]).toBe(0xff);
    expect(output[1]).toBe(0xd8);
    expect(output.indexOf(Buffer.from([0xff, 0xdb]))).toBeGreaterThan(0);
    expect(output.subarray(output.length - 2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  it('retire les chunks textuels d’un PNG et conserve IHDR/IDAT/IEND', () => {
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const text = Buffer.from('Comment\0position secrete');
    const chunk = Buffer.concat([Buffer.alloc(4), Buffer.from('tEXt'), text, Buffer.alloc(4)]);
    chunk.writeUInt32BE(text.length, 0);
    const iendIndex = png1x1.indexOf(Buffer.from('IEND')) - 4;
    const withText = Buffer.concat([png1x1.subarray(0, iendIndex), chunk, png1x1.subarray(iendIndex)]);
    const output = stripPngMetadata(withText);
    expect(withText.toString('latin1')).toContain('position secrete');
    expect(output.toString('latin1')).not.toContain('position secrete');
    expect(output.equals(png1x1)).toBe(true);
  });

  it('détecte le contenu actif d’un PDF', () => {
    expect(pdfHasActiveContent(Buffer.from('%PDF-1.4 1 0 obj <</Type/Catalog/OpenAction 2 0 R>> endobj'))).toBe(true);
    expect(pdfHasActiveContent(Buffer.from('%PDF-1.4 1 0 obj <</S/JavaScript/JS(app.alert(1))>> endobj'))).toBe(true);
    expect(pdfHasActiveContent(Buffer.from('%PDF-1.4 1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj'))).toBe(false);
  });
});
