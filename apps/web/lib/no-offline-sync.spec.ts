import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CDC 1.3 : pas d'application native ni de fonctionnement hors ligne avec synchronisation ; tout accès, y
 * compris le mobile conducteur, passe par le navigateur. Vérification sur les sources et les dépendances du
 * web : aucun service worker, manifeste d'application installable, stockage IndexedDB, file d'envoi différé
 * ni bibliothèque hors ligne ; seuls les brouillons du relevé et du ticket carburant vivent en sessionStorage
 * (onglet courant), jamais présentés comme enregistrés (D-267). Les mutations échouent hors connexion au lieu d'être rejouées (lib/query-client.ts).
 */
const root = path.resolve(import.meta.dirname, '..');
const SOURCE_DIRS = ['app', 'components', 'lib'];
const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  { label: 'service worker', pattern: /serviceWorker|navigator\.serviceWorker|ServiceWorkerRegistration|self\.skipWaiting/ },
  { label: 'stockage IndexedDB', pattern: /\bindexedDB\b|\bIDBDatabase\b|\bidb-keyval\b|\bdexie\b|\blocalforage\b/i },
  { label: 'synchronisation en arrière-plan', pattern: /BackgroundSync|\bsyncManager\b|registration\.sync/ },
  { label: 'rejeu des envois différés', pattern: /resumePausedMutations|persistQueryClient|PersistQueryClientProvider|networkMode:\s*['"]offlineFirst['"]/ },
  { label: 'stockage persistant localStorage', pattern: /\blocalStorage\.(setItem|getItem)/ },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx?|mjs|js)$/.test(entry) && !/\.spec\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('aucun fonctionnement hors ligne avec synchronisation ni application native (CDC 1.3)', () => {
  it('aucun service worker, IndexedDB, synchronisation différée ni rejeu d’envois dans l’interface', () => {
    const files = SOURCE_DIRS.flatMap((d) => sourceFiles(path.join(root, d)));
    expect(files.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const { label, pattern } of FORBIDDEN) if (pattern.test(text)) hits.push(`${path.relative(root, file)} : ${label}`);
    }
    expect(hits).toEqual([]);
  });

  it('le mode réseau des envois n’est fixé qu’une fois, dans lib/query-client.ts : aucun envoi ne peut repasser en pause puis être rejoué', () => {
    const files = SOURCE_DIRS.flatMap((d) => sourceFiles(path.join(root, d)));
    const overriding = files.filter((f) => /\bnetworkMode\b/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
    expect(overriding).toEqual(['lib/query-client.ts']);
  });

  it('aucun manifeste d’application installable ni dépendance hors ligne ; brouillons en sessionStorage limités au relevé et au ticket', () => {
    for (const candidate of ['public/manifest.json', 'public/manifest.webmanifest', 'app/manifest.ts', 'app/manifest.json', 'public/sw.js', 'public/service-worker.js']) {
      expect(existsSync(path.join(root, candidate)), candidate).toBe(false);
    }
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /pwa|workbox|serwist|offline|persist-client|idb|dexie|localforage|capacitor|cordova|react-native|expo/i.test(d))).toEqual([]);
    const session = SOURCE_DIRS.flatMap((d) => sourceFiles(path.join(root, d))).filter((f) => /sessionStorage/.test(readFileSync(f, 'utf8')));
    expect(session.map((f) => path.relative(root, f)).sort()).toEqual(['app/(app)/mon-vehicule/fuel-ticket.tsx', 'app/(app)/mon-vehicule/reading-form.tsx']);
  });
});
