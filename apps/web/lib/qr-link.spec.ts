import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { vehicleQrLink } from './qr-link';

const TOKEN = '3f2b8c1e-4a5d-4c6e-9f70-1a2b3c4d5e6f';

describe('contenu du QR code interne (CDC 10.3)', () => {
  it('seulement le lien /qr/<identifiant opaque>, sans donnée du véhicule ni paramètre', () => {
    const link = vehicleQrLink('https://parc.example.tn', TOKEN);
    expect(link).toBe(`https://parc.example.tn/qr/${TOKEN}`);
    const url = new URL(link);
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(url.pathname.split('/').filter(Boolean)).toEqual(['qr', TOKEN]);
    expect(vehicleQrLink('https://parc.example.tn/', TOKEN)).toBe(link);
  });

  it('le jeton est encodé tel quel (aucune interprétation) et le QR produit porte exactement ce texte', async () => {
    expect(vehicleQrLink('http://localhost:3000', 'a/b?c')).toBe('http://localhost:3000/qr/a%2Fb%3Fc');
    const qr = QRCode.create(vehicleQrLink('https://parc.example.tn', TOKEN), { errorCorrectionLevel: 'M' });
    const bytes = qr.segments.map((s) => (s as unknown as { data: Uint8Array }).data);
    expect(Buffer.concat(bytes.map((b) => Buffer.from(b))).toString('utf8')).toBe(`https://parc.example.tn/qr/${TOKEN}`);
  });
});
