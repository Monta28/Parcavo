// Sonde de scripts/tests/restart-persistence.sh (CDC 17.2, R-17.2-07), exécutée DANS le conteneur api
// (`node --input-type=module - <mode>` sur l'entrée standard) contre l'API réelle http://127.0.0.1:3001.
//
//   seed   : connexion de l'administrateur de contrôle, création d'une société, d'une catégorie, d'un
//            véhicule, d'une déclaration de localisation et d'une pièce jointe PDF ; écrit l'état sur la
//            sortie standard (JSON : identifiants, empreinte, cookies de session — lu par le script hôte
//            dans un fichier temporaire privé, jamais affiché).
//   verify : relit cet état (PROBE_STATE, JSON) après l'arrêt et le redémarrage de la pile : la session
//            ouverte avant l'arrêt est toujours valide, le véhicule, sa localisation et la pièce jointe (même
//            empreinte SHA-256) sont intacts.
//
// Variables : PROBE_EMAIL, PROBE_PASSWORD (seed), PROBE_STATE (verify), APP_ORIGIN (environnement du
// conteneur, contrôle d'origine des mutations), PROBE_API_URL (facultative, défaut : API du conteneur).
// Aucune valeur secrète n'est écrite sur la sortie d'erreur.
import { createHash, randomUUID } from 'node:crypto';

const API = process.env.PROBE_API_URL ?? 'http://127.0.0.1:3001/api/v1';
const ORIGIN = process.env.APP_ORIGIN ?? '';
const mode = process.argv[2];

function fail(message) {
  process.stderr.write(`[sonde] ÉCHEC : ${message}\n`);
  process.exit(1);
}

function cookieHeader(setCookies) {
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

async function call(session, method, path, body, extra = {}) {
  const headers = { Origin: ORIGIN, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), ...extra };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  return res;
}

async function json(res, what, expected) {
  const text = await res.text();
  if (res.status !== expected) fail(`${what} : HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const PDF = Buffer.from(`%PDF-1.4\n% Contrôle de persistance ${randomUUID()}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF`, 'latin1');
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function seed() {
  const email = process.env.PROBE_EMAIL;
  const password = process.env.PROBE_PASSWORD;
  if (!email || !password || !ORIGIN) fail('PROBE_EMAIL, PROBE_PASSWORD et APP_ORIGIN sont requis');
  const login = await call(null, 'POST', '/auth/login', { email, password });
  await json(login, 'connexion', 200);
  const setCookies = login.headers.getSetCookie();
  const csrf = setCookies.find((c) => c.startsWith('pa_csrf='))?.split(';')[0]?.slice('pa_csrf='.length) ?? '';
  const session = { cookie: cookieHeader(setCookies), csrf };
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const company = await json(await call(session, 'POST', '/companies', { code: `PERS-${suffix}`, legalName: 'Société du contrôle de persistance' }), 'création de la société', 201);
  const category = await json(await call(session, 'POST', '/vehicle-categories', { code: `PERS-${suffix}`, label: 'Catégorie du contrôle de persistance' }), 'création de la catégorie', 201);
  const vehicle = await json(
    await call(session, 'POST', '/vehicles', { companyId: company.id, code: `PERS-${suffix}`, registration: `${suffix.slice(0, 3)} TU ${Math.floor(1000 + Math.random() * 8999)}`, make: 'Contrôle', model: 'Persistance', categoryId: category.id }),
    'création du véhicule',
    201,
  );
  const location = await json(
    await call(session, 'POST', `/vehicles/${vehicle.id}/location-reports`, { placeLabel: 'Parking du contrôle de persistance', observedAt: new Date(Date.now() - 60_000).toISOString() }),
    'déclaration de localisation',
    201,
  );
  const form = new FormData();
  form.append('companyId', company.id);
  form.append('file', new Blob([PDF], { type: 'application/pdf' }), 'controle-persistance.pdf');
  const attachment = await json(await call(session, 'POST', '/attachments', form), 'téléversement de la pièce jointe', 201);
  process.stdout.write(
    JSON.stringify({ session, companyId: company.id, vehicleId: vehicle.id, vehicleCode: vehicle.code, registration: vehicle.registration, locationId: location.id, attachmentId: attachment.id, attachmentSha256: sha256(PDF) }),
  );
}

async function verify() {
  let state;
  try {
    state = JSON.parse(process.env.PROBE_STATE ?? '');
  } catch {
    fail('PROBE_STATE illisible');
  }
  const me = await call(state.session, 'GET', '/auth/session');
  await json(me, 'session ouverte avant l’arrêt', 200);
  const vehicle = await json(await call(state.session, 'GET', `/vehicles/${state.vehicleId}`), 'lecture du véhicule', 200);
  if (vehicle.code !== state.vehicleCode || vehicle.registration !== state.registration || vehicle.companyId !== state.companyId) fail('véhicule modifié après redémarrage');
  const synthesis = await json(await call(state.session, 'GET', `/vehicles/${state.vehicleId}/synthesis`), 'synthèse du véhicule', 200);
  if (synthesis.lastLocation?.placeLabel !== 'Parking du contrôle de persistance') fail('dernière localisation déclarée perdue');
  const file = await call(state.session, 'GET', `/attachments/${state.attachmentId}/download`);
  if (file.status !== 200) fail(`téléchargement de la pièce jointe : HTTP ${file.status}`);
  const digest = sha256(Buffer.from(await file.arrayBuffer()));
  if (digest !== state.attachmentSha256) fail('pièce jointe altérée (empreinte différente)');
  process.stdout.write(`session valide ; véhicule ${vehicle.code} (${vehicle.registration}) et sa localisation intacts ; pièce jointe identique (SHA-256 ${digest.slice(0, 16)}…)\n`);
}

if (mode === 'seed') await seed();
else if (mode === 'verify') await verify();
else fail(`mode inconnu « ${mode} » (seed ou verify)`);
