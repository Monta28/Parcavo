import { History, Pencil, Undo2 } from 'lucide-react';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SETTING_SOURCE_LABELS, descriptorOf, formatSettingValue, type EffectiveSetting } from '@/lib/settings-admin';

export interface SettingsTableProps {
  groups: Array<{ label: string; items: EffectiveSetting[] }>;
  /** Société affichée (surcharges) ; null pour la valeur groupe. */
  companyId: string | null;
  companyLabel: string | null;
  onEdit: (setting: EffectiveSetting) => void;
  onHistory: (setting: EffectiveSetting) => void;
  onClearOverride: (setting: EffectiveSetting) => void;
}

function sourceTone(source: EffectiveSetting['source']): 'neutral' | 'info' | 'warning' {
  return source === 'societe' ? 'warning' : source === 'groupe' ? 'info' : 'neutral';
}

/**
 * Tableau des paramètres effectifs par rubrique : valeur, origine (défaut, groupe, surcharge société) et
 * version ; actions selon ce que l'API accepte (valeur fixe non modifiable, surcharge société seulement
 * pour les paramètres qui l'autorisent). Les droits restent contrôlés par l'API.
 */
export function SettingsTable({ groups, companyId, companyLabel, onEdit, onHistory, onClearOverride }: SettingsTableProps) {
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label} className="space-y-2">
          <h2 className="text-base font-semibold">{group.label}</h2>
          <div className="overflow-x-auto rounded-md border">
            <Table aria-label={`Paramètres : ${group.label}`}>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40%]">Paramètre</TableHead>
                  <TableHead>Valeur {companyId ? `pour ${companyLabel ?? 'la société'}` : 'groupe'}</TableHead>
                  <TableHead>Origine</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.items.map((setting) => (
                  <SettingRow key={setting.key} setting={setting} companyId={companyId} onEdit={onEdit} onHistory={onHistory} onClearOverride={onClearOverride} />
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ))}
    </div>
  );
}

function SettingRow({
  setting,
  companyId,
  onEdit,
  onHistory,
  onClearOverride,
}: {
  setting: EffectiveSetting;
  companyId: string | null;
  onEdit: (setting: EffectiveSetting) => void;
  onHistory: (setting: EffectiveSetting) => void;
  onClearOverride: (setting: EffectiveSetting) => void;
}) {
  const fixed = descriptorOf(setting.key)?.fixed;
  const groupOnly = companyId !== null && !setting.companyOverride;
  // Vue société sans surcharge en vigueur : l'action crée la surcharge (nom accessible = texte visible).
  const verb = companyId && setting.source !== 'societe' ? 'Surcharger' : 'Modifier';
  return (
    <TableRow>
      <TableCell className="align-top whitespace-normal">
        <span className="font-medium">{setting.label}</span>
        <span className="block font-mono text-xs text-muted-foreground">{setting.key}</span>
        {!setting.editable && fixed ? <span className="mt-1 block text-xs text-muted-foreground">{fixed}</span> : null}
        {setting.editable && groupOnly ? <span className="mt-1 block text-xs text-muted-foreground">Valeur groupe uniquement : ce paramètre ne se surcharge pas par société.</span> : null}
      </TableCell>
      <TableCell className="align-top whitespace-normal">{formatSettingValue(setting.key, setting.value)}</TableCell>
      <TableCell className="align-top">
        {setting.editable ? (
          <span className="flex flex-wrap items-center gap-1">
            <StatusBadge label={SETTING_SOURCE_LABELS[setting.source]} tone={sourceTone(setting.source)} />
            {setting.settingVersion !== null ? <span className="text-xs text-muted-foreground">version {setting.settingVersion}</span> : null}
          </span>
        ) : (
          <StatusBadge label="Valeur fixe" tone="neutral" />
        )}
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-wrap justify-end gap-1">
          {setting.editable && !groupOnly ? (
            <Button type="button" size="sm" variant="outline" onClick={() => onEdit(setting)} aria-label={`${verb} « ${setting.label} »`}>
              <Pencil aria-hidden="true" /> {verb}
            </Button>
          ) : null}
          {companyId && setting.source === 'societe' ? (
            <Button type="button" size="sm" variant="outline" onClick={() => onClearOverride(setting)} aria-label={`Retirer la surcharge de « ${setting.label} »`}>
              <Undo2 aria-hidden="true" /> Retirer la surcharge
            </Button>
          ) : null}
          {setting.editable ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onHistory(setting)} aria-label={`Historique de « ${setting.label} »`}>
              <History aria-hidden="true" /> Historique
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">Non modifiable</span>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
