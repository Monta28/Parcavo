import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guides utilisateur (CDC 19.2, R-19.2-07) confrontés à l'interface. Chaque libellé cité entre « » (ou entre
 * guillemets droits ou anglais) dans docs/guide-chef-de-parc.md et docs/guide-conducteur.md doit exister
 * littéralement dans les sources de l'interface (apps/web) ou dans les libellés partagés (packages/contracts).
 * Un bouton renommé, un statut retiré ou un message reformulé fait échouer le test : le guide est alors à
 * reprendre. Les liens relatifs des guides doivent pointer vers des fichiers du dépôt, et les limites
 * annoncées aux utilisateurs (pas de position en temps réel, pas d'application native ni de mode hors ligne,
 * dérogation, registre, e-mail) ne peuvent pas disparaître sans que le test le signale.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const GUIDES = ['docs/guide-chef-de-parc.md', 'docs/guide-conducteur.md'] as const;
const SOURCE_DIRS = [
  'apps/web/app',
  'apps/web/components',
  'apps/web/lib',
  'packages/contracts/src',
];

/** Sources de l'interface et des libellés partagés, tests exclus (un libellé ne vit pas que dans un test). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '.next') out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.spec\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Espaces normalisés : le formateur peut couper un texte JSX sur plusieurs lignes. */
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Code sans commentaires : un libellé cité seulement dans un commentaire n'existe pas à l'écran. */
const withoutComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

/** Prose du guide, hors blocs et fragments de code (chemins, clés de paramètres). */
const prose = (markdown: string) =>
  markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

/** Libellés cités : « … », "…" et “…”. */
function citedLabels(markdown: string): string[] {
  const labels = [...prose(markdown).matchAll(/«([^«»]+)»|"([^"\n]+)"|“([^”\n]+)”/g)].map((m) =>
    squash(m[1] ?? m[2] ?? m[3] ?? ''),
  );
  return [...new Set(labels.filter((l) => l.length > 0))];
}

/** Liens Markdown relatifs (hors URL et ancres seules). */
function relativeLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => (m[1] ?? '').split('#')[0] ?? '')
    .filter((href) => href.length > 0 && !/^[a-z]+:/i.test(href));
}

const corpus = squash(
  SOURCE_DIRS.flatMap((d) => sourceFiles(join(ROOT, d)))
    .map((f) => withoutComments(readFileSync(f, 'utf8')))
    .join('\n'),
);
const guides = Object.fromEntries(GUIDES.map((g) => [g, read(g)])) as Record<
  (typeof GUIDES)[number],
  string
>;

describe('Guides utilisateur fidèles à l’interface (CDC 19.2)', () => {
  it('les sources lues couvrent bien l’interface et les libellés partagés', () => {
    expect(corpus.length).toBeGreaterThan(500_000);
    expect(corpus).toContain('Ajouter un kilométrage');
    expect(corpus).toContain('Accorder des dérogations');
  });

  for (const guide of GUIDES) {
    it(`${guide} : chaque libellé cité existe littéralement dans apps/web ou packages/contracts`, () => {
      const labels = citedLabels(guides[guide]);
      expect(labels.length, 'nombre de libellés cités').toBeGreaterThan(
        guide.endsWith('chef-de-parc.md') ? 250 : 60,
      );
      const missing = labels.filter((label) => !corpus.includes(label));
      expect(missing, `libellés introuvables dans l’interface : ${missing.join(' | ')}`).toEqual(
        [],
      );
    });

    it(`${guide} : chaque lien relatif mène à un fichier du dépôt`, () => {
      const links = relativeLinks(guides[guide]);
      expect(links.length).toBeGreaterThan(0);
      for (const href of links)
        expect(existsSync(normalize(join(ROOT, dirname(guide), href))), `${guide} → ${href}`).toBe(
          true,
        );
    });
  }

  it('les guides se citent l’un l’autre et le README y renvoie', () => {
    expect(guides['docs/guide-chef-de-parc.md']).toContain('](guide-conducteur.md)');
    expect(guides['docs/guide-conducteur.md']).toContain('](guide-chef-de-parc.md)');
    const readme = read('README.md');
    for (const guide of GUIDES) expect(readme).toContain(guide);
  });

  it('guide du chef de parc : limites réelles annoncées et renvois aux guides thématiques', () => {
    const chef = prose(guides['docs/guide-chef-de-parc.md']);
    for (const target of [
      'guide-imports.md',
      'connecteur-telematique.md',
      'guide-utilisateur.md',
      'guide-conformite-entretien.md',
    ])
      expect(chef, target).toContain(`](${target}`);
    // Dérogation : la mention affichée à l'écran est reprise mot pour mot.
    const notice = /OVERRIDE_LEGAL_NOTICE =\s*'([^']+)'/.exec(
      read('apps/web/components/documents/override-notice.tsx'),
    )?.[1];
    expect(notice).toBeDefined();
    expect(chef).toContain(`« ${notice ?? ''} »`);
    expect(chef).toContain(
      '« Le registre ne remplace pas la comptabilité et ne calcule aucune obligation fiscale »',
    );
    expect(chef).toMatch(/aucune position en temps réel/i);
    expect(chef).toMatch(/aucune application native/i);
    expect(chef).toMatch(/serveur d’envoi \(SMTP\)/);
    expect(chef).toContain('« Ceci n’est pas une signature certifiée. »');
  });

  it('guide du conducteur : mobile par le navigateur, hors connexion décrit tel que codé, rien d’inventé', () => {
    const driver = prose(guides['docs/guide-conducteur.md']);
    for (const action of [
      'Ajouter un kilométrage',
      'Ajouter un ticket carburant',
      'Signaler un problème',
    ])
      expect(driver).toContain(`« ${action} »`);
    expect(driver).toMatch(/aucune application native/i);
    expect(driver).toMatch(/aucune position en temps réel/i);
    // Hors connexion : pas de file d'envoi ; messages réels de l'écran et du client HTTP.
    expect(driver).toContain('« Vous êtes hors connexion. »');
    expect(driver).toContain(
      '« Impossible de joindre le serveur. Vérifiez votre connexion : rien n’a été enregistré. »',
    );
    expect(read('apps/web/lib/query-client.ts')).toMatch(/networkMode: 'always'/);
    expect(driver).toMatch(/aucun envoi n’est mis en attente/i);
    // Paramètre qui ouvre les actions sur le véhicule dont le conducteur est responsable habituel.
    expect(guides['docs/guide-conducteur.md']).toContain(
      '`drivers.allowHabitualVehicleSubmissions`',
    );
  });
});
