import { describe, expect, it } from 'vitest';
import { CDC_LOAD_TARGET, LOAD_PRODUCTION_REFUSAL, loadUserEmail, loadUserRole, runSeedLoadCli, volumesForScale } from './seed-load.js';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
}

describe('jeu de dimensionnement (CDC 17.2) : garde-fous de la commande et volumes', () => {
  it('refuse la production avant toute connexion à la base, même avec une URL et un mot de passe', async () => {
    const c = io();
    const code = await runSeedLoadCli([], { NODE_ENV: 'production', DATABASE_URL: 'postgresql://ne-pas-utiliser.invalid/x', LOAD_PASSWORD: 'un-mot-de-passe-long' }, c.io);
    expect(code).toBe(1);
    expect(c.err.join('')).toContain(LOAD_PRODUCTION_REFUSAL);
  });

  it('exige LOAD_PASSWORD (12 caractères) et DATABASE_URL ; arguments et échelle validés', async () => {
    const short = io();
    expect(await runSeedLoadCli([], { DATABASE_URL: 'postgresql://x.invalid/y', LOAD_PASSWORD: 'court' }, short.io)).toBe(1);
    expect(short.err.join('')).toMatch(/LOAD_PASSWORD/);
    const noUrl = io();
    expect(await runSeedLoadCli([], { LOAD_PASSWORD: 'un-mot-de-passe-long' }, noUrl.io)).toBe(1);
    expect(noUrl.err.join('')).toMatch(/DATABASE_URL/);
    const unknown = io();
    expect(await runSeedLoadCli(['--reset'], {}, unknown.io)).toBe(2);
    const scale = io();
    expect(await runSeedLoadCli(['--scale', '2'], {}, scale.io)).toBe(2);
    expect(scale.err.join('')).toMatch(/Échelle invalide/);
    const help = io();
    expect(await runSeedLoadCli(['--help'], {}, help.io)).toBe(0);
    expect(help.out.join('')).toMatch(/300 000 relevés/);
  });

  it('volumes : cible du CDC à l’échelle 1 (500 véhicules, 300 000 relevés), 50 comptes aux rôles répartis', () => {
    expect(volumesForScale(1)).toEqual({ vehicles: CDC_LOAD_TARGET.vehicles, readings: CDC_LOAD_TARGET.readings });
    expect(volumesForScale(0.1)).toEqual({ vehicles: 50, readings: 30_000 });
    expect(volumesForScale(0.001).vehicles).toBe(6);
    const roles = Array.from({ length: CDC_LOAD_TARGET.sessions }, (_, i) => loadUserRole(i + 1).role);
    expect(roles.filter((r) => r === 'ADMIN')).toHaveLength(5);
    expect(roles.filter((r) => r === 'CHEF_PARC')).toHaveLength(15);
    expect(roles.filter((r) => r === 'OPERATEUR')).toHaveLength(15);
    expect(roles.filter((r) => r === 'LECTEUR')).toHaveLength(15);
    expect(loadUserEmail(7)).toBe('charge.007@charge.parc-auto.test');
  });
});
