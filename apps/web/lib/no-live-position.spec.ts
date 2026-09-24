import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CDC 1.3 et 3.4 : aucune carte, aucun suivi de position temps réel, aucun géofencing, et jamais le libellé
 * « Position actuelle » ni un marqueur simulant une position. Vérification sur l'ensemble des sources de
 * l'interface (écrans, composants, bibliothèques) et des dépendances du web.
 */
const root = path.resolve(import.meta.dirname, '..');
// Écrans, composants et bibliothèques du web, plus les libellés partagés (@parc-auto/contracts) qu'ils affichent.
const SOURCE_DIRS = ['app', 'components', 'lib', '../../packages/contracts/src'];
const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  { label: '« Position actuelle »', pattern: /position\s+actuelle/i },
  { label: 'coordonnées GPS', pattern: /\b(latitude|longitude|lat\s*:\s*-?\d|lng\s*:\s*-?\d)\b/i },
  { label: 'géofencing', pattern: /g[ée]o-?fenc|geofence/i },
  { label: 'suivi en temps réel', pattern: /suivi\s+(de\s+position\s+)?en\s+temps\s+r[ée]el|position\s+en\s+direct|live\s*tracking/i },
  { label: 'bibliothèque cartographique', pattern: /\b(leaflet|mapbox|maplibre|google\.maps|openlayers|react-map-gl)\b/i },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx?|css)$/.test(entry) && !/\.spec\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('aucune position temps réel ni carte dans l’interface (CDC 1.3, 3.4)', () => {
  const files = SOURCE_DIRS.flatMap((d) => sourceFiles(path.join(root, d)));

  it('aucun écran ni composant n’affiche « Position actuelle », des coordonnées, une carte ou un géofencing', () => {
    expect(files.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(text)) hits.push(`${path.relative(root, file)} : ${label}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('aucune dépendance cartographique dans le web', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /leaflet|mapbox|maplibre|google-maps|@react-google-maps|openlayers|^ol$|react-map-gl/i.test(d))).toEqual([]);
  });

  it('la localisation est présentée comme « Dernière localisation déclarée » (fiche véhicule et Mon véhicule)', () => {
    const labelled = files.filter((f) => readFileSync(f, 'utf8').includes('Dernière localisation déclarée')).map((f) => path.relative(root, f));
    expect(labelled).toEqual(expect.arrayContaining([expect.stringMatching(/^app\/\(app\)\/vehicules\/\[id\]\//)]));
  });
});
