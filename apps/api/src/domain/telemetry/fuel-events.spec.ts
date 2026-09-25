import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { detectFuelEpisodes, episodeDedupeKey, matchTicket, type FuelPoint } from './fuel-events.js';

const d = (v: number) => new Decimal(v);
const start = new Date('2026-09-24T20:00:00Z').getTime();
const pt = (minute: number, liters: number, engineOn = false, speed = 0): FuelPoint => ({ observedAt: new Date(start + minute * 60_000), liters: d(liters), percent: null, engineOn, speedKmh: d(speed) });
const options = { drop: { liters: 10, percent: 5, windowMinutes: 30 }, refill: { liters: 10, percent: 10, windowMinutes: 30 }, capacityLiters: d(80) };

describe('Événements carburant (CDC 8.5 — T43)', () => {
  it('T43 — sonde : baisse de 25 L moteur coupé en 20 min → une baisse anormale', () => {
    const series = [pt(0, 60), pt(5, 60), pt(10, 52), pt(15, 45), pt(20, 38), pt(25, 35), pt(30, 35), pt(35, 35)];
    const r = detectFuelEpisodes(series, 'NIVEAU_SONDE', options);
    const drops = r.episodes.filter((e) => e.type === 'BAISSE_ANORMALE');
    expect(drops).toHaveLength(1);
    expect(drops[0]?.liters?.toString()).toBe('25');
  });

  it('T43 — remplissage de 40 L → un remplissage détecté ; sans ticket, écart à qualifier', () => {
    const series = [pt(0, 20, true, 0), pt(5, 20, false), pt(10, 20, false), pt(15, 45, false), pt(20, 60, false), pt(25, 60, false), pt(30, 60, false)];
    const r = detectFuelEpisodes(series, 'NIVEAU_SONDE', options);
    const fills = r.episodes.filter((e) => e.type === 'REMPLISSAGE_DETECTE');
    expect(fills).toHaveLength(1);
    expect(fills[0]?.liters?.toString()).toBe('40');
    expect(r.episodes.filter((e) => e.type === 'BAISSE_ANORMALE')).toHaveLength(0);
    expect(matchTicket({ detectedAt: fills[0]!.startAt, liters: fills[0]!.liters }, [])).toEqual({ matched: false, reason: 'ABSENCE_TICKET', differenceLiters: null, nearestTicketId: null });
  });

  it('une baisse en roulant n’est pas une baisse anormale ; sans données de contact, la détection est indisponible', () => {
    const rolling = [pt(0, 60, true, 80), pt(10, 50, true, 80), pt(20, 40, true, 80)];
    expect(detectFuelEpisodes(rolling, 'NIVEAU_SONDE', options).episodes).toHaveLength(0);
    const noIgnition: FuelPoint[] = [0, 10, 20].map((m, i) => ({ observedAt: new Date(start + m * 60_000), liters: d(60 - i * 12), percent: null, engineOn: null, speedKmh: null }));
    const r = detectFuelEpisodes(noIgnition, 'NIVEAU_SONDE', options);
    expect(r.episodes.filter((e) => e.type === 'BAISSE_ANORMALE')).toHaveLength(0);
    expect(r.dropDetectionUnavailable).toBe(true);
  });

  it('jauge CAN : jamais de baisse anormale, seuils de remplissage doublés ; CONSOMMATION_CAN : aucun événement', () => {
    const can = [pt(0, 60), pt(10, 30), pt(20, 30)];
    expect(detectFuelEpisodes(can, 'NIVEAU_CAN', options).episodes).toHaveLength(0);
    const smallFill = [pt(0, 20), pt(5, 20), pt(10, 35), pt(15, 35), pt(20, 35)];
    expect(detectFuelEpisodes(smallFill, 'NIVEAU_SONDE', options).episodes).toHaveLength(1);
    expect(detectFuelEpisodes(smallFill, 'NIVEAU_CAN', options).episodes).toHaveLength(0);
    expect(detectFuelEpisodes(can, 'CONSOMMATION_CAN', options).episodes).toHaveLength(0);
  });

  it('seuil en pourcentage converti seulement si la capacité est connue', () => {
    const pct: FuelPoint[] = [0, 10, 20].map((m, i) => ({ observedAt: new Date(start + m * 60_000), liters: null, percent: d(50 - i * 4), engineOn: false, speedKmh: d(0) }));
    expect(detectFuelEpisodes(pct, 'NIVEAU_SONDE', { ...options, capacityLiters: null }).episodes.map((e) => e.type)).toEqual(['BAISSE_ANORMALE']);
  });

  it('rapprochement ticket : fenêtre de 2 h et tolérance max(5 L, 10 %) ; clé de déduplication stable', () => {
    const at = new Date('2026-09-24T20:15:00Z');
    const tickets = [{ id: 't1', filledAt: new Date('2026-09-24T19:00:00Z'), liters: d(38) }];
    expect(matchTicket({ detectedAt: at, liters: d(40) }, tickets)).toMatchObject({ matched: true, ticketId: 't1' });
    expect(matchTicket({ detectedAt: at, liters: d(60) }, tickets)).toMatchObject({ matched: false, reason: 'ECART_LITRES' });
    expect(matchTicket({ detectedAt: new Date('2026-09-24T23:30:00Z'), liters: d(40) }, tickets)).toMatchObject({ matched: false, reason: 'ABSENCE_TICKET' });
    expect(episodeDedupeKey('v1', 'REMPLISSAGE_DETECTE', new Date('2026-09-24T20:07:31Z'))).toBe('v1:REMPLISSAGE_DETECTE:2026-09-24T20:05:00.000Z');
  });
});
