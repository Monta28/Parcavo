'use client';

import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useAppScope } from '@/components/layout/session-context';
import { api } from '@/lib/api-client';
import type { EffectiveSettingView } from '@/lib/usages-types';

function formatMegabytes(bytes: number): string {
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} Mo`;
}

function numericSetting(settings: EffectiveSettingView[] | undefined, key: string): number | null {
  const value = settings?.find((s) => s.key === key)?.value;
  return typeof value === 'number' ? value : null;
}

/**
 * Texte d'aide unique sur les formats acceptés (D-278) ; il reprend la feuille « Aide » du modèle XLSX.
 * Les limites de taille et de lignes sont les paramètres effectifs de l'organisation (GET /settings).
 */
export function ImportFormatsHelp() {
  const { session } = useAppScope();
  const settings = useQuery({ queryKey: ['settings', 'effective', null], queryFn: () => api<EffectiveSettingView[]>('/settings') });
  const maxBytes = numericSetting(settings.data, 'imports.maxSizeBytes');
  const maxRows = numericSetting(settings.data, 'imports.maxRows');
  return (
    <section aria-labelledby="import-formats-title" className="rounded-lg border bg-muted/30 p-4 text-sm">
      <h3 id="import-formats-title" className="mb-2 flex items-center gap-2 font-medium">
        <Info className="size-4" aria-hidden="true" /> Formats acceptés
      </h3>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        <li>Fichier CSV encodé en UTF-8 (séparateur « ; » ou « , » détecté) ou classeur XLSX : la feuille « Données », sinon la première feuille. Les formules sans valeur calculée et les cellules fusionnées sont refusées.</li>
        <li>Dates : AAAA-MM-JJ ou JJ/MM/AAAA (jour en premier, année sur 4 chiffres) ou cellule date XLSX. Années à 2 chiffres et mois en lettres refusés.</li>
        <li>
          Horodatages : AAAA-MM-JJ HH:mm[:ss], JJ/MM/AAAA HH:mm[:ss] ou ISO avec décalage ; sans décalage, l’heure est locale au groupe ({session.timezone}). Une date seule vaut 00:00, avec l’avertissement « heure non fournie ».
        </li>
        <li>Kilomètres : nombres entiers sans séparateur (45230 ; « 45.230 », « 45,230 » ou « 45 230 » sont refusés).</li>
        <li>Nombres décimaux (capacité du réservoir) : point décimal, trois décimales au plus (52.5).</li>
        <li>Oui/non : oui/non, true/false, 1/0, actif/inactif ou vrai/faux.</li>
        <li>
          Limites :{' '}
          {maxBytes !== null && maxRows !== null
            ? `${formatMegabytes(maxBytes)} et ${new Intl.NumberFormat('fr-FR').format(maxRows)} lignes de données par fichier.`
            : 'taille et nombre de lignes fixés par les paramètres de l’organisation.'}
        </li>
        <li>Ordre conseillé : sociétés et sites (créés dans l’administration), véhicules, conducteurs, relevés, puis bases d’entretien. Les documents numérisés se chargent dans leurs fiches, pas dans le fichier.</li>
      </ul>
    </section>
  );
}

/** Rappel des garanties du lot (CDC 12.1, D-277), affiché avant la confirmation. */
export function ImportGuaranteesReminder() {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
      <li>Aucune ligne n’est écrite avant la confirmation.</li>
      <li>Le lot est importé en entier ou pas du tout : la confirmation revérifie chaque ligne et refuse le lot au moindre écart.</li>
      <li>L’import crée de nouveaux dossiers et ajoute des relevés ; il ne modifie jamais une fiche existante.</li>
    </ul>
  );
}
