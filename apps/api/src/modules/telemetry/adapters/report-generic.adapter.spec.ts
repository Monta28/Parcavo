import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readTable } from '../../imports/parsers/tabular.js';
import { ProviderError } from '../telemetry-provider.interface.js';
import { DiagnosticsCollector } from './adapter-support.js';
import { ReportGenericAdapter, parseReportDecimal, parseReportSettings, parseReportTable, parseReportTimestamp, sshHostKeyFingerprint } from './report-generic.adapter.js';

const FINGERPRINT = `SHA256:${'A'.repeat(43)}`;
const SETTINGS = {
  source: 'SFTP',
  sftp: { host: 'sftp.example.com', directory: '/rapports', hostKeySha256: FINGERPRINT },
  columns: {
    unit: 'Unité',
    label: 'Nom',
    registration: 'Immatriculation',
    timestamp: 'Date',
    odometer: 'Compteur (km)',
    fuelLiters: 'Carburant (L)',
    engine: 'Moteur',
    speed: 'Vitesse',
    reference: 'N°',
  },
  timestampFormat: 'dd/MM/yyyy HH:mm:ss',
  timezone: 'Africa/Tunis',
  decimalSeparator: ',',
  odometerUnit: 'km',
  odometerKind: 'COMPTEUR_CAN',
  fuelKind: 'NIVEAU_SONDE',
};

const CSV = [
  'N°;Unité;Nom;Immatriculation;Date;Compteur (km);Carburant (L);Moteur;Vitesse',
  '1001;U-17;Camion 17;123 TU 4567;24/09/2026 08:15:00;80450,125;62,5;off;0',
  '1002;U-17;Camion 17;123 TU 4567;24/09/2026 08:20:00;80450,125;37,5;OFF;0',
  '1003;U-18;;;24/09/2026 25:00:00;1000;;on;10',
  '1004;;;;24/09/2026 08:00:00;1000;;;',
  '1005;U-18;;;24/09/2026 08:30:00;80.450,5;abc;peut-être;-3',
  '1006;U-18;;;24/09/2026 08:40:00;;;;',
  '1007;U-18;;;24/09/2026 08:50:00;1200,4;10;on;12,5',
].join('\r\n');

describe('Canal RAPPORT — lecture des fichiers (14.3 canal 2)', () => {
  it('CSV : kilométrage et carburant normalisés, heure locale convertie en UTC, valeurs invalides écartées et comptées', async () => {
    const settings = parseReportSettings(SETTINGS);
    const table = await readTable(Buffer.from(CSV, 'utf8'), 'rapport.csv', 1000);
    const diag = new DiagnosticsCollector();
    const parsed = parseReportTable(table, 'rapport.csv', settings, 'Africa/Tunis', diag);
    if (typeof parsed === 'string') throw new Error(parsed);
    expect(parsed.rows).toBe(7);
    expect(parsed.odometer).toEqual([
      { unitExternalId: 'U-17', kind: 'COMPTEUR_CAN', valueKm: '80450.125', observedAt: new Date('2026-09-24T07:15:00Z'), sourceReference: '1001:COMPTEUR_CAN' },
      { unitExternalId: 'U-17', kind: 'COMPTEUR_CAN', valueKm: '80450.125', observedAt: new Date('2026-09-24T07:20:00Z'), sourceReference: '1002:COMPTEUR_CAN' },
      { unitExternalId: 'U-18', kind: 'COMPTEUR_CAN', valueKm: '1200.400', observedAt: new Date('2026-09-24T07:50:00Z'), sourceReference: '1007:COMPTEUR_CAN' },
    ]);
    expect(parsed.fuel).toEqual([
      { unitExternalId: 'U-17', kind: 'NIVEAU_SONDE', liters: '62.500', percent: null, engineOn: false, speedKmh: '0.000', observedAt: new Date('2026-09-24T07:15:00Z'), sourceReference: '1001' },
      { unitExternalId: 'U-17', kind: 'NIVEAU_SONDE', liters: '37.500', percent: null, engineOn: false, speedKmh: '0.000', observedAt: new Date('2026-09-24T07:20:00Z'), sourceReference: '1002' },
      { unitExternalId: 'U-18', kind: 'NIVEAU_SONDE', liters: '10.000', percent: null, engineOn: true, speedKmh: '12.500', observedAt: new Date('2026-09-24T07:50:00Z'), sourceReference: '1007' },
    ]);
    expect([...parsed.units.values()]).toEqual([
      { externalId: 'U-17', label: 'Camion 17', declaredRegistration: '123 TU 4567', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: ['NIVEAU_SONDE'] },
      { externalId: 'U-18', label: 'U-18', declaredRegistration: null, odometerKinds: ['COMPTEUR_CAN'], fuelKinds: ['NIVEAU_SONDE'] },
    ]);
    expect(diag.snapshot().rejected).toEqual({
      'horodatage invalide ou sans heure': 1,
      'ligne sans identifiant d’unité': 1,
      'kilométrage invalide': 1,
      'carburant (L) invalide': 1,
    });
  });

  it('XLSX : cellule date-heure lue en heure murale du fuseau, date sans heure refusée, nombre XLSX exact', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Rapport');
    sheet.addRow(['Unité', 'Date', 'Distance (m)']);
    const withTime = sheet.addRow(['U-1', new Date(Date.UTC(2026, 8, 24, 8, 15, 30)), 80450125.4]);
    withTime.getCell(2).numFmt = 'dd/mm/yyyy hh:mm:ss';
    const midnight = sheet.addRow(['U-1', new Date(Date.UTC(2026, 8, 25, 0, 0, 0)), 80460000]);
    midnight.getCell(2).numFmt = 'yyyy-mm-dd hh:mm';
    const dateOnly = sheet.addRow(['U-1', new Date(Date.UTC(2026, 8, 26)), 80470000]);
    dateOnly.getCell(2).numFmt = 'dd/mm/yyyy';
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const settings = parseReportSettings({
      ...SETTINGS,
      columns: { unit: 'Unité', timestamp: 'Date', odometer: 'Distance (m)' },
      timestampFormat: 'ISO',
      odometerUnit: 'm',
      odometerKind: 'DISTANCE_GPS',
      fuelKind: undefined,
      decimalSeparator: ',',
    });
    const diag = new DiagnosticsCollector();
    const parsed = parseReportTable(await readTable(buffer, 'rapport.xlsx', 100), 'rapport.xlsx', settings, 'Africa/Tunis', diag);
    if (typeof parsed === 'string') throw new Error(parsed);
    expect(parsed.odometer.map((s) => [s.valueKm, s.observedAt.toISOString(), s.kind, s.sourceReference])).toEqual([
      ['80450.125', '2026-09-24T07:15:30.000Z', 'DISTANCE_GPS', null],
      ['80460.000', '2026-09-24T23:00:00.000Z', 'DISTANCE_GPS', null],
    ]);
    expect(diag.snapshot().rejected).toEqual({ 'horodatage invalide ou sans heure': 1 });
  });

  it('colonne configurée absente : fichier refusé avec motif', async () => {
    const settings = parseReportSettings(SETTINGS);
    const table = await readTable(Buffer.from('Unité;Date\nU1;24/09/2026 08:00:00', 'utf8'), 'r.csv', 10);
    expect(parseReportTable(table, 'r.csv', settings, 'Africa/Tunis', new DiagnosticsCollector())).toBe('colonne absente « Nom »');
  });

  it('horodatages : formats ISO, époque, Luxon ; heure inexistante (passage à l’heure d’été) refusée', () => {
    expect(parseReportTimestamp('2026-09-24T08:15:00', 'ISO', 'Africa/Tunis')?.toISOString()).toBe('2026-09-24T07:15:00.000Z');
    expect(parseReportTimestamp('2026-09-24T08:15:00+02:00', 'ISO', 'Africa/Tunis')?.toISOString()).toBe('2026-09-24T06:15:00.000Z');
    expect(parseReportTimestamp('2026-09-24', 'ISO', 'Africa/Tunis')).toBeNull();
    expect(parseReportTimestamp('1790237400', 'EPOCH_S', 'UTC')?.toISOString()).toBe('2026-09-24T08:10:00.000Z');
    expect(parseReportTimestamp('1790237400000', 'EPOCH_MS', 'UTC')?.toISOString()).toBe('2026-09-24T08:10:00.000Z');
    expect(parseReportTimestamp('29/03/2026 02:30:00', 'dd/MM/yyyy HH:mm:ss', 'Europe/Paris')).toBeNull();
    expect(parseReportTimestamp('29/03/2026 03:30:00', 'dd/MM/yyyy HH:mm:ss', 'Europe/Paris')?.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(parseReportTimestamp('31/02/2026 10:00:00', 'dd/MM/yyyy HH:mm:ss', 'UTC')).toBeNull();
    expect(parseReportTimestamp({ date: '2026-09-24' }, 'ISO', 'UTC')).toBeNull();
  });

  it('décimaux stricts : séparateur configuré, point admis pour une cellule XLSX, séparateur de milliers refusé', () => {
    expect(parseReportDecimal('80450,125', ',', false)?.toString()).toBe('80450.125');
    expect(parseReportDecimal('80450.125', ',', false)).toBeNull();
    expect(parseReportDecimal('80450.125', ',', true)?.toString()).toBe('80450.125');
    expect(parseReportDecimal('80 450', '.', false)).toBeNull();
    expect(parseReportDecimal('-3', '.', false)).toBeNull();
    expect(parseReportDecimal('1e+21', '.', true)).toBeNull();
    expect(parseReportDecimal('', '.', false)).toBe('vide');
  });

  it('paramètres : source, empreinte SSH, colonnes de mesure, format avec heure, fuseau, IMAP non chiffré distant refusés', () => {
    const invalid: Array<Record<string, unknown>> = [
      { ...SETTINGS, source: 'FTP' },
      { ...SETTINGS, sftp: { ...SETTINGS.sftp, hostKeySha256: 'abc' } },
      { ...SETTINGS, columns: { unit: 'Unité', timestamp: 'Date' } },
      { ...SETTINGS, timestampFormat: 'dd/MM/yyyy' },
      { ...SETTINGS, timezone: 'Mars/Olympus' },
      { ...SETTINGS, odometerUnit: 'miles' },
      { ...SETTINGS, fuelKind: 'ESTIMATION' },
      { ...SETTINGS, source: 'IMAP', imap: { host: 'mail.example.com', tls: 'aucun' } },
      { ...SETTINGS, source: 'IMAP', imap: { host: 'mail.example.com', afterProcessing: 'deplacer' } },
      { ...SETTINGS, sftp: { ...SETTINGS.sftp, processedDirectory: '/rapports' } },
    ];
    for (const s of invalid) expect(() => parseReportSettings(s)).toThrow(ProviderError);
    expect(parseReportSettings(SETTINGS).sftp).toMatchObject({ port: 22, processedDirectory: '/rapports/traites', hostKeySha256: 'A'.repeat(43) });
    expect(parseReportSettings({ ...SETTINGS, sftp: { ...SETTINGS.sftp, afterProcessing: 'laisser' } }).sftp?.processedDirectory).toBeNull();
    expect(parseReportSettings({ ...SETTINGS, source: 'IMAP', imap: { host: 'localhost', tls: 'aucun', port: 3143 } }).imap).toMatchObject({ mailbox: 'INBOX', processedMailbox: null });
  });

  it('adaptateur : registre obligatoire, secret « identifiant:motdepasse » exigé, liste d’unités partielle', async () => {
    const base = { providerId: 'p', baseUrl: null, settings: SETTINGS, secrets: {}, timeoutMs: 1000, timezone: 'Africa/Tunis' };
    expect(() => new ReportGenericAdapter(base)).toThrow(/reportLedger/);
    const ledger = { isProcessed: async () => false, markProcessed: async () => undefined };
    const adapter = new ReportGenericAdapter({ ...base, reportLedger: ledger });
    expect(adapter.partialUnitList).toBe(true);
    await expect(adapter.listUnits()).rejects.toMatchObject({ kind: 'CONFIGURATION' });
    expect((await adapter.healthCheck()).ok).toBe(false);
    await expect(adapter.acknowledge()).resolves.toBeUndefined();
  });

  it('empreinte de clé d’hôte au format OpenSSH (SHA256 en base64 sans remplissage)', () => {
    expect(sshHostKeyFingerprint(Buffer.from('cle'))).toMatch(/^[A-Za-z0-9+/]{43}$/);
  });
});
