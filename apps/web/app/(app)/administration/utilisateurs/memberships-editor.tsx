'use client';

import { Plus, Trash2 } from 'lucide-react';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_LABELS, PERMISSIONS, ROLE_LABELS, ROLES, type PermissionKey, type RoleKey } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CompanyView, MembershipInput, MembershipView } from '@/lib/admin-types';
import { collectErrors } from '../field-errors';

export interface MembershipDraft extends MembershipInput {
  key: string;
}

let draftCounter = 0;
function nextKey(): string {
  draftCounter += 1;
  return `habilitation-${draftCounter}`;
}

export function draftsFromMemberships(memberships: MembershipView[]): MembershipDraft[] {
  return memberships.map((m) => ({ key: m.id, companyId: m.companyId, role: m.role, grantedPermissions: [...m.grantedPermissions], revokedPermissions: [...m.revokedPermissions] }));
}

/** Habilitations au format attendu par POST/PATCH /users (le rôle ADMIN ne porte ni société ni ajustement). */
export function toMembershipInputs(drafts: MembershipDraft[]): MembershipInput[] {
  return drafts.map((d) =>
    d.role === 'ADMIN'
      ? { companyId: null, role: d.role, grantedPermissions: [], revokedPermissions: [] }
      : { companyId: d.companyId || null, role: d.role, grantedPermissions: [...d.grantedPermissions].sort(), revokedPermissions: [...d.revokedPermissions].sort() },
  );
}

function without(list: PermissionKey[], p: PermissionKey): PermissionKey[] {
  return list.filter((x) => x !== p);
}

/**
 * Éditeur d'habilitations (CDC 2.2) : un rôle par société, ou le rôle ADMIN au niveau groupe.
 * Les cases reflètent les permissions par défaut du rôle (contrats partagés) ajustées par
 * les permissions accordées ou retirées ; seules ces deux listes sont envoyées à l'API.
 */
export function MembershipsEditor({
  value,
  onChange,
  companies,
  preferredCompanyId,
  fieldErrors,
}: {
  value: MembershipDraft[];
  onChange: (next: MembershipDraft[]) => void;
  companies: CompanyView[];
  /** Société courante du sélecteur d'en-tête, proposée en premier lorsqu'elle est libre. */
  preferredCompanyId: string | null;
  fieldErrors: Record<string, string[]>;
}) {
  const hasGroupAdmin = value.some((m) => m.role === 'ADMIN');
  const updateAt = (index: number, patch: Partial<MembershipDraft>) => onChange(value.map((m, i) => (i === index ? { ...m, ...patch } : m)));

  const addMembership = () => {
    const used = new Set(value.map((m) => m.companyId));
    const free = companies.filter((c) => c.status === 'ACTIF' && !used.has(c.id));
    const firstFree = free.find((c) => c.id === preferredCompanyId) ?? free[0];
    onChange([...value, { key: nextKey(), companyId: firstFree?.id ?? null, role: 'LECTEUR', grantedPermissions: [], revokedPermissions: [] }]);
  };

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Habilitations *</legend>
      <p className="text-xs text-muted-foreground">
        Le rôle Administrateur groupe s’applique à toutes les sociétés, sans société associée. Les autres rôles s’appliquent à une seule société ; une seule habilitation par société.
      </p>
      <FieldError errors={fieldErrors} name="memberships" />
      {value.length === 0 ? <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Aucune habilitation : ajoutez-en au moins une.</p> : null}
      {value.map((m, index) => {
        const base = `membership-${m.key}`;
        const defaults = DEFAULT_ROLE_PERMISSIONS[m.role];
        const usedElsewhere = new Set(value.filter((_, i) => i !== index).map((x) => x.companyId));
        const companyOptions = companies.filter((c) => c.id === m.companyId || (c.status === 'ACTIF' && !usedElsewhere.has(c.id)));
        const rowErrors = collectErrors(fieldErrors, `memberships.${index}`);
        return (
          <div key={m.key} className="space-y-4 rounded-md border p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium">Habilitation {index + 1}</p>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(value.filter((_, i) => i !== index))} aria-label={`Retirer l’habilitation ${index + 1}`}>
                <Trash2 className="size-4" />
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`${base}-role`}>Rôle</Label>
                <Select
                  value={m.role}
                  onValueChange={(v) => {
                    const role = v as RoleKey;
                    if (role === 'ADMIN') updateAt(index, { role, companyId: null, grantedPermissions: [], revokedPermissions: [] });
                    else {
                      const free = m.companyId ?? companies.find((c) => c.status === 'ACTIF' && !usedElsewhere.has(c.id))?.id ?? null;
                      updateAt(index, { role, companyId: free, grantedPermissions: [], revokedPermissions: [] });
                    }
                  }}
                >
                  <SelectTrigger id={`${base}-role`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r} value={r} disabled={r === 'ADMIN' && hasGroupAdmin && m.role !== 'ADMIN'}>
                        {ROLE_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${base}-company`}>Société</Label>
                {m.role === 'ADMIN' ? (
                  <Input id={`${base}-company`} value="Niveau groupe (toutes les sociétés)" readOnly disabled />
                ) : (
                  <Select value={m.companyId ?? ''} onValueChange={(v) => updateAt(index, { companyId: v })}>
                    <SelectTrigger id={`${base}-company`} className="w-full">
                      <SelectValue placeholder="Choisir une société" />
                    </SelectTrigger>
                    <SelectContent>
                      {companyOptions.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.code} · {c.legalName}
                          {c.status === 'ARCHIVE' ? ' (archivée)' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Permissions fines</legend>
              {m.role === 'ADMIN' ? (
                <p className="text-xs text-muted-foreground">L’administrateur groupe dispose de toutes les permissions ; elles ne sont pas ajustables.</p>
              ) : (
                <p className="text-xs text-muted-foreground">Cochées par défaut selon le rôle ; décochez pour retirer une permission, cochez pour en accorder une supplémentaire.</p>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                {PERMISSIONS.map((p) => {
                  const isDefault = defaults.includes(p);
                  const granted = m.grantedPermissions.includes(p);
                  const revoked = m.revokedPermissions.includes(p);
                  const checked = m.role === 'ADMIN' || (isDefault && !revoked) || granted;
                  const note = m.role === 'ADMIN' ? null : isDefault ? (revoked ? 'retirée' : 'par défaut') : granted ? 'accordée' : null;
                  const id = `${base}-perm-${p}`;
                  return (
                    <div key={p} className="flex items-start gap-2">
                      <Checkbox
                        id={id}
                        checked={checked}
                        disabled={m.role === 'ADMIN'}
                        onCheckedChange={(state) => {
                          const on = state === true;
                          if (isDefault) {
                            updateAt(index, { revokedPermissions: on ? without(m.revokedPermissions, p) : [...without(m.revokedPermissions, p), p], grantedPermissions: without(m.grantedPermissions, p) });
                          } else {
                            updateAt(index, { grantedPermissions: on ? [...without(m.grantedPermissions, p), p] : without(m.grantedPermissions, p), revokedPermissions: without(m.revokedPermissions, p) });
                          }
                        }}
                      />
                      <Label htmlFor={id} className="text-sm leading-tight font-normal">
                        {PERMISSION_LABELS[p]}
                        {note ? <span className="ml-1 text-xs text-muted-foreground">({note})</span> : null}
                      </Label>
                    </div>
                  );
                })}
              </div>
            </fieldset>
            <FieldError errors={rowErrors} name={`memberships.${index}`} />
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" onClick={addMembership}>
        <Plus className="size-4" /> Ajouter une habilitation
      </Button>
    </fieldset>
  );
}
