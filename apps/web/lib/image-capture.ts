'use client';

/**
 * Préparation des photos prises sur mobile (D-267, D-313) : réencodage côté navigateur en JPEG de
 * 2 560 px et 2 Mo au plus avant téléversement. L'API n'accepte que JPEG, PNG et PDF (type réel
 * vérifié) et supprime les métadonnées EXIF ; le réencodage rend aussi utilisables les captures HEIC
 * quand le navigateur sait les décoder.
 */
const MAX_DIMENSION = 2560;
const MAX_BYTES = 2 * 1024 * 1024;
const QUALITIES = [0.85, 0.75, 0.65, 0.55];
const PASSTHROUGH_TYPES = new Set(['image/jpeg', 'image/png']);

export class PhotoPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoPreparationError';
  }
}

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void };

async function decode(file: File): Promise<Decoded | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Repli sur l'élément image ci-dessous.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function jpegName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'photo';
  return `${base}.jpg`;
}

/** Réencode une photo en JPEG borné ; renvoie le fichier d'origine s'il est déjà conforme et non décodable. */
export async function prepareCameraPhoto(file: File): Promise<File> {
  const decoded = await decode(file);
  if (!decoded) {
    if (PASSTHROUGH_TYPES.has(file.type) && file.size <= MAX_BYTES) return file;
    throw new PhotoPreparationError('Format de photo non pris en charge par ce navigateur : choisissez une photo JPEG ou PNG.');
  }
  try {
    let scale = Math.min(1, MAX_DIMENSION / Math.max(decoded.width, decoded.height, 1));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(decoded.width * scale));
      canvas.height = Math.max(1, Math.round(decoded.height * scale));
      const context = canvas.getContext('2d');
      if (!context) break;
      context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
      for (const quality of QUALITIES) {
        const blob = await toJpeg(canvas, quality);
        if (blob && blob.size <= MAX_BYTES) return new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: Date.now() });
      }
      scale *= 0.75;
    }
  } finally {
    decoded.release();
  }
  if (PASSTHROUGH_TYPES.has(file.type) && file.size <= MAX_BYTES) return file;
  throw new PhotoPreparationError('Impossible de réduire cette photo sous 2 Mo : reprenez-la ou choisissez-en une autre.');
}
