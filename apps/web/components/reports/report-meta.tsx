'use client';

import { formatDate, formatDateTime } from '@/lib/format';
import { formatDecimalText } from '@/lib/report-format';
import type { CostColumnsVisibility, ReportMeta } from '@/lib/reports-types';

const COST_COLUMNS_TEXT: Record<Exclude<CostColumnsVisibility, 'sans_objet'>, string> = {
  toutes: 'Affichées.',
  partielles: 'Affichées pour les lignes des sociétés où vous détenez la permission costs.read, masquées pour les autres.',
  aucune: 'Non affichées : permission costs.read requise.',
};

/**
 * Bloc « Filtres, fuseau et date de génération » (CDC 11.2, D-270) : repris tel quel des métadonnées de
 * l'API (rapport, vue, génération, auteur, périmètre calculé par le serveur, période résolue, filtres
 * appliqués, unités, colonnes de coût, totaux et remarques). Les mêmes éléments figurent dans l'export.
 */
export function ReportMetaBlock({ meta, total, titleId = 'rapport-meta' }: { meta: ReportMeta; total: number; titleId?: string }) {
  const filters = meta.filters.filter((f) => f.key !== 'vue');
  return (
    <section aria-labelledby={titleId} className="report-meta space-y-3 rounded-md border p-4 text-sm">
      <h2 id={titleId} className="text-base font-semibold">
        Filtres, fuseau et date de génération
      </h2>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
        <MetaItem label="Rapport" value={`${meta.label} — ${meta.view.label}`} />
        <MetaItem label="Généré le" value={`${formatDateTime(meta.generatedAt, meta.timezone)} (heure locale)`} />
        <MetaItem label="Fuseau horaire" value={meta.timezone} />
        <MetaItem label="Auteur" value={meta.author} />
        <MetaItem label="Périmètre" value={meta.scope.length === 0 ? 'Aucune société' : meta.scope.map((c) => `${c.code} — ${c.legalName}`).join(', ')} />
        {meta.period ? <MetaItem label="Période" value={`du ${formatDate(meta.period.from)} au ${formatDate(meta.period.to)} (dates locales incluses)`} /> : null}
        <MetaItem label="Lignes" value={formatDecimalText(total)} />
        {meta.costColumns !== 'sans_objet' ? <MetaItem label="Colonnes de coût" value={COST_COLUMNS_TEXT[meta.costColumns]} /> : null}
        <div className="sm:col-span-2 xl:col-span-3">
          <dt className="text-muted-foreground">Filtres appliqués</dt>
          <dd>
            {filters.length === 0 ? (
              'Aucun'
            ) : (
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {filters.map((f) => (
                  <li key={f.key}>
                    <span className="text-muted-foreground">{f.label} :</span> <span className="font-medium">{f.display}</span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        {meta.units.length > 0 ? (
          <div className="sm:col-span-2 xl:col-span-3">
            <dt className="text-muted-foreground">Unités</dt>
            <dd>{meta.units.join(' ')}</dd>
          </div>
        ) : null}
      </dl>
      {meta.summary.length > 0 ? (
        <div>
          <h3 className="font-medium">Totaux de la sélection</h3>
          <dl className="mt-1 grid gap-x-6 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
            {meta.summary.map((s) => (
              <MetaItem key={s.label} label={s.label} value={s.value === null ? 'N/D' : `${formatDecimalText(s.value)}${s.unit ? ` ${s.unit}` : ''}`} numeric />
            ))}
          </dl>
        </div>
      ) : null}
      {meta.notes.length > 0 ? (
        <div>
          <h3 className="font-medium">Remarques</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
            {meta.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function MetaItem({ label, value, numeric }: { label: string; value: string; numeric?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={numeric ? 'font-medium tabular-nums' : 'font-medium'}>{value}</dd>
    </div>
  );
}
