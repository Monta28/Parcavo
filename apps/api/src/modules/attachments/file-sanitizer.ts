/**
 * Assainissement des fichiers acceptés (CDC 16.2) :
 *  - JPEG : suppression des segments APP1 à APP15 (EXIF, XMP, ICC...) et des commentaires ;
 *  - PNG : suppression des chunks textuels et de métadonnées (tEXt, zTXt, iTXt, eXIf, tIME) ;
 *  - PDF : refus des documents contenant du contenu actif (/JavaScript, /JS, /OpenAction, /AA, /Launch).
 * Les données image utiles sont conservées telles quelles (aucun réencodage).
 */

export function stripJpegMetadata(input: Buffer): Buffer {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return input;
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let offset = 2;
  while (offset + 4 <= input.length) {
    if (input[offset] !== 0xff) break;
    const marker = input[offset + 1] as number;
    if (marker === 0xda) {
      // Start Of Scan : le reste est la donnée image, copié intégralement.
      out.push(input.subarray(offset));
      return Buffer.concat(out);
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(input.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    const length = input.readUInt16BE(offset + 2);
    const segment = input.subarray(offset, offset + 2 + length);
    const isMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) out.push(segment);
    offset += 2 + length;
  }
  out.push(input.subarray(offset));
  return Buffer.concat(out);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

export function stripPngMetadata(input: Buffer): Buffer {
  if (input.length < 8 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) return input;
  const out: Buffer[] = [PNG_SIGNATURE];
  let offset = 8;
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.subarray(offset + 4, offset + 8).toString('latin1');
    const end = offset + 12 + length;
    if (end > input.length) break;
    if (!PNG_DROP.has(type)) out.push(input.subarray(offset, end));
    offset = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

const PDF_ACTIVE = /\/(JavaScript|JS|OpenAction|AA|Launch|EmbeddedFile|RichMedia)\b/;

export function pdfHasActiveContent(input: Buffer): boolean {
  return PDF_ACTIVE.test(input.toString('latin1'));
}

export function sanitizeUpload(mime: string, input: Buffer): { buffer: Buffer; rejected?: string } {
  switch (mime) {
    case 'image/jpeg':
      return { buffer: stripJpegMetadata(input) };
    case 'image/png':
      return { buffer: stripPngMetadata(input) };
    case 'application/pdf':
      return pdfHasActiveContent(input) ? { buffer: input, rejected: 'Le PDF contient du contenu actif (script, action automatique ou fichier embarqué) et est refusé.' } : { buffer: input };
    default:
      return { buffer: input };
  }
}
