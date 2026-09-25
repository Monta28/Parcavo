#!/usr/bin/env node
/**
 * Test de charge de l'API (CDC 17.2) : cinquante sessions réelles sur le jeu de dimensionnement.
 *
 *   LOAD_PASSWORD=… node scripts/tests/load-test.mjs --api http://127.0.0.1:3990 --origin http://localhost:3000 \
 *     [--sessions 50] [--duration 180] [--think-min 250] [--think-max 750] [--vehicles-per-session 4] [--out resultats.json]
 *
 * Prérequis : API compilée démarrée (node apps/api/dist/main.js) sur une base chargée par
 * `node apps/api/dist/cli/seed-load.js` (comptes charge.001 à charge.050, mot de passe LOAD_PASSWORD, jamais
 * écrit dans le dépôt), limitation de débit désactivée (RATE_LIMIT_ENABLED=false, hors production),
 * APP_ORIGIN de l'API égal à --origin.
 *
 * Scénario :
 *  1. Préparation (non mesurée dans les catégories) : connexion des sessions par POST /auth/login (durées
 *     relevées à part), puis préchauffage d'un appel par liste (les statuts d'entretien matérialisés sont
 *     calculés à la première lecture du jour, comme après le recalcul nocturne du worker). Chaque session
 *     habilitée aux opérations (administrateur, chef de parc, opérateur) reçoit en propre jusqu'à
 *     --vehicles-per-session véhicules disponibles sans document bloquant, chacun avec un conducteur libre de
 *     sa société : aucune collision voulue entre sessions.
 *  2. Mesure pendant --duration secondes : chaque session enchaîne des requêtes, avec un temps de réflexion
 *     aléatoire entre --think-min et --think-max ms :
 *       lectures paginées (25 lignes) : liste des véhicules, relevés, utilisations, rapports (pages 1 à 3 sur les
 *       30 derniers jours) et tableau de bord ;
 *       mutations simples (une itération sur cinq, sessions habilitées) : relevé kilométrique, remise puis
 *       restitution d'un de ses véhicules, à tour de rôle (relevés croissants, horodatés maintenant, au plus un
 *       par véhicule et par minute : deux relevés manuels de la même minute sont le même instant, CDC 5.3).
 *  3. Résultats : p50, p95, p99 et maximum par catégorie et par requête (requêtes en échec comprises) ; réponses
 *     non 2xx par code ; refus pour concurrence (409 CONCURRENCE, l'utilisateur doit réessayer) publiés à part avec
 *     leur taux. Échec (code 1) si le p95 des lectures atteint 2 s, celui des mutations 3 s, ou si une réponse
 *     non 2xx autre qu'un refus pour concurrence est reçue.
 *
 * Aucune dépendance externe : fetch natif de Node (undici).
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';

const args = parseArgs(process.argv.slice(2));
const API = (args.api ?? process.env.LOAD_API_URL ?? 'http://127.0.0.1:3990').replace(/\/$/, '');
const ORIGIN = args.origin ?? process.env.LOAD_ORIGIN ?? 'http://localhost:3000';
const SESSIONS = Number(args.sessions ?? 50);
const DURATION_S = Number(args.duration ?? 180);
const THINK_MIN = Number(args['think-min'] ?? 250);
const THINK_MAX = Number(args['think-max'] ?? 750);
const OUT = args.out ?? null;
const PASSWORD = process.env.LOAD_PASSWORD ?? '';
const ASSETS_PER_SESSION = Number(args['vehicles-per-session'] ?? 4);
const READ_P95_LIMIT_MS = 2_000;
const MUTATION_P95_LIMIT_MS = 3_000;
const EMAIL = (n) => `charge.${String(n).padStart(3, '0')}@charge.parc-auto.test`;

if (!PASSWORD) {
  console.error('LOAD_PASSWORD est requis (mot de passe des comptes du jeu de dimensionnement).');
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--') continue;
    if (!key.startsWith('--')) throw new Error(`Argument inattendu : ${key}`);
    out[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// ---------------------------------------------------------------------------------------------
// Client HTTP d'une session : cookies de session, jeton CSRF, mesure de chaque requête
// ---------------------------------------------------------------------------------------------

const samples = [];
let measuring = false;

class Session {
  constructor(n) {
    this.n = n;
    this.email = EMAIL(n);
    this.cookies = '';
    this.csrf = '';
  }

  async login() {
    const started = performance.now();
    const res = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ email: this.email, password: PASSWORD }) });
    const body = await res.json().catch(() => ({}));
    const elapsed = performance.now() - started;
    if (res.status !== 200) throw new Error(`Connexion refusée pour ${this.email} : ${res.status} ${JSON.stringify(body)}`);
    const cookies = res.headers.getSetCookie();
    this.cookies = cookies.map((c) => c.split(';')[0]).join('; ');
    this.csrf = decodeURIComponent(cookies.find((c) => c.startsWith('pa_csrf='))?.split(';')[0].slice('pa_csrf='.length) ?? '');
    this.profile = body;
    return elapsed;
  }

  /** Requête mesurée : catégorie (lecture ou mutation), nom stable, statut, durée (corps lu compris). */
  async call(category, name, method, path, body) {
    const headers = { cookie: this.cookies, origin: ORIGIN };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = this.csrf;
      headers['idempotency-key'] = randomUUID();
    }
    const started = performance.now();
    let status = 0;
    let json = null;
    try {
      const res = await fetch(`${API}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      status = res.status;
      const text = await res.text();
      json = text ? JSON.parse(text) : null;
    } catch (error) {
      json = { error: String(error) };
    }
    const ms = performance.now() - started;
    if (measuring) samples.push({ category, name, ms, status, session: this.n, error: status >= 200 && status < 300 ? null : JSON.stringify(json).slice(0, 300) });
    return { status, json, ms };
  }
}

async function get(session, path) {
  const res = await session.call('préparation', 'préparation', 'GET', path);
  if (res.status !== 200) throw new Error(`${path} : ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

async function allPages(session, path) {
  const items = [];
  for (let page = 1; page < 200; page += 1) {
    const body = await get(session, `${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=100`);
    items.push(...body.items);
    if (body.items.length < 100) break;
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// Scénario
// ---------------------------------------------------------------------------------------------

/** Premier conducteur du lot sans blocage de départ pour ce véhicule (GET /usages/checkout-preview), -1 sinon. */
async function firstFreeDriver(session, vehicleId, drivers) {
  for (let i = 0; i < Math.min(drivers.length, 8); i += 1) {
    const at = new Date();
    const preview = await get(session, `/usages/checkout-preview?vehicleId=${vehicleId}&driverId=${drivers[i]}&at=${encodeURIComponent(at.toISOString())}&expectedReturnAt=${encodeURIComponent(new Date(at.getTime() + 7_200_000).toISOString())}`);
    if ((preview.blockers ?? []).length === 0) return i;
  }
  return -1;
}

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

function readActions(session, canReadCosts) {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86_400_000);
  const period = `&from=${isoDay(from)}&to=${isoDay(to)}`;
  const page = () => between(1, 3);
  const reports = [
    ['rapport relevés', () => `/reports/releves?vue=releves${period}&page=${page()}&pageSize=25`],
    ['rapport qualité des relevés', () => `/reports/releves?vue=qualite${period}&page=${page()}&pageSize=25`],
    ['rapport utilisations', () => `/reports/utilisations?vue=utilisations${period}&page=${page()}&pageSize=25`],
    ['rapport retards', () => `/reports/utilisations?vue=utilisations&lateOnly=true${period}&page=1&pageSize=25`],
    ['rapport carburant', () => `/reports/carburant?vue=pleins${period}&page=${page()}&pageSize=25`],
    ['rapport inventaire', () => `/reports/inventaire?vue=vehicules&page=${page()}&pageSize=25`],
    ['rapport documents', () => `/reports/documents?vue=echeances&page=${page()}&pageSize=25`],
    ['rapport immobilisations', () => `/reports/incidents-immobilisations?vue=immobilisations${period}&page=1&pageSize=25`],
    ...(canReadCosts ? [['rapport dépenses par véhicule', () => `/reports/depenses?vue=vehicule${period}&page=${page()}&pageSize=25`]] : []),
  ];
  return [
    ['liste véhicules', 3, () => `/vehicles?page=${between(1, 8)}&pageSize=25`],
    ['liste relevés', 3, () => `/readings?page=${between(1, 20)}&pageSize=25`],
    ['relevés d’un véhicule', 1, () => (session.vehicleIds.length ? `/vehicles/${pick(session.vehicleIds)}/readings?page=1&pageSize=25` : `/readings?page=1&pageSize=25`)],
    ['liste utilisations', 3, () => `/usages?page=${between(1, 20)}&pageSize=25`],
    ['tableau de bord', 1, () => '/dashboard'],
    ...reports.map(([name, path]) => [name, 3 / reports.length, path]),
  ];
}

function weighted(actions) {
  const total = actions.reduce((s, a) => s + a[1], 0);
  let r = Math.random() * total;
  for (const a of actions) {
    r -= a[1];
    if (r <= 0) return a;
  }
  return actions[actions.length - 1];
}

/**
 * Prochaine mutation de la session : sur un de ses véhicules dont le dernier relevé ne date pas de la minute
 * en cours (deux relevés manuels de la même minute désignent le même instant : CONFLIT_MEME_INSTANT, 5.3).
 * Aucun véhicule libre pour cette minute : null (la session fait une lecture à la place).
 */
async function mutate(session, force = false) {
  const minute = Math.floor(Date.now() / 60_000);
  const asset = force ? session.assets.find((a) => a.step === 2) : session.assets.find((a) => a.lastMinute !== minute);
  if (!asset) return null;
  if (force && asset.lastMinute === minute) await sleep(61_000 - (Date.now() % 60_000));
  asset.lastMinute = Math.floor(Date.now() / 60_000);
  const now = new Date();
  asset.km += between(8, 60);
  if (asset.step === 0) {
    const res = await session.call('mutation', 'relevé kilométrique', 'POST', `/vehicles/${asset.vehicleId}/readings`, { physicalKm: String(asset.km), observedAt: now.toISOString() });
    asset.step = 1;
    return res;
  }
  if (asset.step === 1) {
    const res = await session.call('mutation', 'remise', 'POST', '/usages/checkout', {
      vehicleId: asset.vehicleId,
      driverId: asset.driverId,
      checkedOutAt: now.toISOString(),
      expectedReturnAt: new Date(now.getTime() + 2 * 3_600_000).toISOString(),
      purpose: 'Test de charge — tournée',
      reading: { physicalKm: String(asset.km) },
      location: { placeLabel: 'Parking du siège' },
    });
    if (res.status === 201) {
      asset.usageId = res.json.id;
      asset.usageVersion = res.json.version;
      asset.step = 2;
    }
    return res;
  }
  const res = await session.call('mutation', 'restitution', 'POST', `/usages/${asset.usageId}/return`, { returnedAt: now.toISOString(), expectedVersion: asset.usageVersion, reading: { physicalKm: String(asset.km) }, location: { placeLabel: 'Parking du siège' } });
  if (res.status === 200) asset.step = 0;
  return res;
}

async function runSession(session, deadline) {
  const actions = readActions(session, session.canReadCosts);
  while (performance.now() < deadline) {
    if (session.assets.length > 0 && Math.random() < 0.2 && (await mutate(session)) !== null) {
      // mutation effectuée
    } else {
      const [name, , path] = weighted(actions);
      await session.call('lecture', name, 'GET', path());
    }
    await sleep(between(THINK_MIN, THINK_MAX));
  }
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
  const round = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return { n: sorted.length, p50: round(q(50)), p95: round(q(95)), p99: round(q(99)), max: round(sorted.at(-1) ?? null), mean: round(sorted.reduce((s, v) => s + v, 0) / (sorted.length || 1)) };
}

async function main() {
  console.log(`API ${API} — ${SESSIONS} sessions, ${DURATION_S} s de mesure, réflexion ${THINK_MIN}–${THINK_MAX} ms.`);
  const sessions = Array.from({ length: SESSIONS }, (_, i) => new Session(i + 1));
  const loginMs = [];
  for (let i = 0; i < sessions.length; i += 10) loginMs.push(...(await Promise.all(sessions.slice(i, i + 10).map((s) => s.login()))));
  console.log(`Connexions : ${sessions.length} sessions ouvertes (${JSON.stringify(stats(loginMs))} ms).`);

  // Préparation : catalogue (droits de coût), ressources propres à chaque session habilitée aux opérations.
  const admin = sessions[0];
  for (const s of sessions) s.canReadCosts = Boolean((await get(s, '/reports')).canReadCosts);
  const companies = (await get(admin, '/companies?pageSize=100')).items ?? [];
  const busyDrivers = new Set((await allPages(admin, '/usages?status=EN_COURS')).map((u) => u.driverId));
  const pools = new Map();
  for (const c of companies) {
    const vehicles = (await allPages(admin, `/vehicles?companyId=${c.id}&operationalStatus=DISPONIBLE&blockingDocuments=false`)).map((v) => v.id);
    const drivers = (await allPages(admin, `/drivers?companyId=${c.id}&status=ACTIF`)).map((d) => d.id).filter((id) => !busyDrivers.has(id));
    pools.set(c.id, { vehicles, drivers });
  }
  // Sessions habilitées aux opérations d'après le profil renvoyé à la connexion : administrateur, ou chef de
  // parc / opérateur d'une société (le lecteur ne fait que lire).
  const operationalCompanies = (s) => (s.profile.isAdmin ? companies.map((c) => c.id) : (s.profile.grants ?? []).filter((g) => ['CHEF_PARC', 'OPERATEUR'].includes(g.role)).map((g) => g.companyId));
  const operational = sessions.filter((s) => operationalCompanies(s).length > 0);
  for (const s of sessions) s.assets = [];
  for (let round = 0; round < ASSETS_PER_SESSION; round += 1) {
    for (const s of operational) {
      const candidates = operationalCompanies(s);
      const companyId = candidates.find((id) => (pools.get(id)?.vehicles.length ?? 0) > 0 && (pools.get(id)?.drivers.length ?? 0) > 0);
      if (!companyId) continue;
      const pool = pools.get(companyId);
      const vehicleId = pool.vehicles.shift();
      const odometer = await get(s, `/vehicles/${vehicleId}/odometer`);
      // Compteur jamais initialisé : écarté (un relevé simple suppose un compteur existant).
      if (!odometer.reading?.physicalKm) continue;
      // Couple retenu seulement sans blocage de départ (permis couvrant la catégorie, documents) : contrôles du serveur.
      const driverIndex = await firstFreeDriver(s, vehicleId, pool.drivers);
      if (driverIndex < 0) continue;
      const [driverId] = pool.drivers.splice(driverIndex, 1);
      s.assets.push({ vehicleId, driverId, km: Math.ceil(Number(odometer.reading.physicalKm)), step: s.assets.length % 2, usageId: null, lastMinute: Math.floor(Date.parse(odometer.reading.observedAt) / 60_000) });
    }
  }
  if (operational.some((s) => s.assets.length === 0)) throw new Error('Plus de véhicule disponible ou de conducteur libre pour une session habilitée.');
  // Véhicules visibles par chaque session (historique d'un véhicule de son périmètre).
  for (const s of sessions) s.vehicleIds = (await get(s, '/vehicles?page=1&pageSize=100')).items.map((v) => v.id);
  console.log(`Préparation : ${operational.length} sessions habilitées aux opérations, ${operational.reduce((n, s) => n + s.assets.length, 0)} couples véhicule/conducteur réservés (jusqu’à ${ASSETS_PER_SESSION} par session).`);

  // Préchauffage (non mesuré) : une lecture de chaque liste.
  for (const [, , path] of readActions(admin, admin.canReadCosts)) await admin.call('préchauffage', 'préchauffage', 'GET', path());

  console.log(`Mesure : ${DURATION_S} s à partir de ${new Date().toISOString()}.`);
  measuring = true;
  const startedAt = new Date();
  const deadline = performance.now() + DURATION_S * 1000;
  // Charge de la machine pendant la mesure (le générateur tourne sur la même machine que l'API et PostgreSQL).
  const loads = [];
  const sampler = setInterval(() => loads.push(loadavg()[0]), 5_000);
  await Promise.all(sessions.map((s) => runSession(s, deadline)));
  clearInterval(sampler);
  measuring = false;
  const endedAt = new Date();

  // Utilisations restées ouvertes à la fin : restituées (hors mesure) pour laisser la base cohérente.
  // Trois tentatives au plus par utilisation ; celles qui restent ouvertes sont signalées.
  await Promise.all(operational.map(async (s) => {
    for (let attempt = 0; attempt < 3 && s.assets.some((a) => a.step === 2); attempt += 1) await mutate(s, true);
  }));
  const leftOpen = operational.reduce((n, s) => n + s.assets.filter((a) => a.step === 2).length, 0);
  if (leftOpen > 0) console.log(`Attention : ${leftOpen} utilisation(s) du test restée(s) ouverte(s) après trois tentatives de restitution.`);

  const byCategory = {};
  const byName = {};
  for (const cat of ['lecture', 'mutation']) byCategory[cat] = stats(samples.filter((x) => x.category === cat).map((x) => x.ms));
  for (const name of [...new Set(samples.map((x) => `${x.category} · ${x.name}`))].sort()) byName[name] = stats(samples.filter((x) => `${x.category} · ${x.name}` === name).map((x) => x.ms));
  const errors = samples.filter((x) => x.error !== null);
  // Refus pour concurrence (409 CONCURRENCE : conflit de sérialisation après les reprises du serveur) : l'opération
  // n'a pas eu lieu et l'utilisateur est invité à réessayer ; compté et publié à part, jamais comme un succès.
  const conflicts = errors.filter((x) => x.status === 409 && (x.error ?? '').includes('"CONCURRENCE"'));
  const unexpected = errors.filter((x) => !conflicts.includes(x));
  const seconds = (endedAt.getTime() - startedAt.getTime()) / 1000;
  const result = {
    api: API,
    sessions: SESSIONS,
    durationSeconds: DURATION_S,
    thinkMs: [THINK_MIN, THINK_MAX],
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    requests: samples.length,
    throughputPerSecond: Math.round((samples.length / seconds) * 10) / 10,
    login: stats(loginMs),
    byCategory,
    byName,
    errors: { count: errors.length, byStatus: Object.fromEntries([...new Set(errors.map((e) => e.status))].map((s) => [s, errors.filter((e) => e.status === s).length])), first: errors.slice(0, 5) },
    concurrencyRefusals: { count: conflicts.length, byName: Object.fromEntries([...new Set(conflicts.map((e) => e.name))].map((n) => [n, `${conflicts.filter((e) => e.name === n).length}/${samples.filter((x) => x.name === n).length}`])) },
    unexpectedErrors: { count: unexpected.length, first: unexpected.slice(0, 5) },
    limits: { readP95Ms: READ_P95_LIMIT_MS, mutationP95Ms: MUTATION_P95_LIMIT_MS },
    machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model ?? null, totalMemoryMiB: Math.round(totalmem() / 1_048_576), freeMemoryMiB: Math.round(freemem() / 1_048_576), loadAverage1m: { mean: Math.round((loads.reduce((a, b) => a + b, 0) / (loads.length || 1)) * 100) / 100, max: Math.max(0, ...loads) } },
  };
  const readOk = (byCategory.lecture.p95 ?? Infinity) < READ_P95_LIMIT_MS;
  const mutationOk = (byCategory.mutation.p95 ?? Infinity) < MUTATION_P95_LIMIT_MS;
  result.verdict = { readOk, mutationOk, noUnexpectedError: unexpected.length === 0, ok: readOk && mutationOk && unexpected.length === 0 };

  console.log(`\n${samples.length} requêtes mesurées en ${seconds.toFixed(0)} s (${result.throughputPerSecond} req/s).`);
  console.log('Catégorie / requête'.padEnd(52), 'n'.padStart(6), 'p50'.padStart(8), 'p95'.padStart(8), 'p99'.padStart(8), 'max'.padStart(8), '(ms)');
  const line = (label, s) => console.log(label.padEnd(52), String(s.n).padStart(6), String(s.p50).padStart(8), String(s.p95).padStart(8), String(s.p99).padStart(8), String(s.max).padStart(8));
  for (const [cat, s] of Object.entries(byCategory)) line(`[${cat}]`, s);
  for (const [name, s] of Object.entries(byName)) line(`  ${name}`, s);
  console.log(`Machine : ${result.machine.cpus} processeurs logiques, charge moyenne (1 min) ${result.machine.loadAverage1m.mean} pendant la mesure (max ${result.machine.loadAverage1m.max}).`);
  console.log(`Réponses non 2xx : ${errors.length}${errors.length ? ` ${JSON.stringify(result.errors.byStatus)}` : ''} ; dont refus pour concurrence (409 CONCURRENCE) : ${conflicts.length} ${JSON.stringify(result.concurrencyRefusals.byName)} ; autres : ${unexpected.length}${unexpected.length ? ` — ${unexpected[0].name} : ${unexpected[0].error}` : ''}`);
  console.log(`Verdict : lectures p95 ${byCategory.lecture.p95} ms (< ${READ_P95_LIMIT_MS}) ${readOk ? 'OK' : 'ÉCHEC'} ; mutations p95 ${byCategory.mutation.p95} ms (< ${MUTATION_P95_LIMIT_MS}) ${mutationOk ? 'OK' : 'ÉCHEC'}.`);
  if (OUT) writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.verdict.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(`Test de charge interrompu : ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
