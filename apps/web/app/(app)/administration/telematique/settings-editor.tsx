'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { getPath, setPath } from '@/lib/settings-path';
import type { KindSettingsSpec, SettingField } from './provider-settings';

type Settings = Record<string, unknown>;
const DEFAULT = '__defaut__';

function fieldId(path: string): string {
  return `settings-${path.replace(/[^a-zA-Z0-9]/g, '-')}`;
}

function stringify(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

/**
 * Paramètres non secrets d'un fournisseur : formulaire des paramètres documentés du type, ou JSON
 * complet (les clés non décrites sont conservées). Aucun secret ici : l'API refuse toute clé évoquant
 * un jeton ou un mot de passe (SECRET_DANS_PARAMETRES) ; les secrets se déposent à part, en écriture seule.
 */
export function SettingsEditor({
  spec,
  value,
  onChange,
  errors,
  onValidityChange,
}: {
  spec: KindSettingsSpec;
  value: Settings;
  onChange: (next: Settings) => void;
  errors: Record<string, string[]>;
  onValidityChange: (valid: boolean) => void;
}) {
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState(() => stringify(value));
  const [jsonError, setJsonError] = useState<string | null>(null);
  // Texte en cours de saisie des champs JSON (un JSON partiel n'est pas encore une valeur).
  const [drafts, setDrafts] = useState<Record<string, { text: string; error: string | null }>>({});

  const updateValidity = (nextDrafts: typeof drafts, nextJsonError: string | null) => onValidityChange(nextJsonError === null && Object.values(nextDrafts).every((d) => d.error === null));

  const switchTo = (next: 'form' | 'json') => {
    if (next === mode) return;
    if (next === 'json') {
      setJsonText(stringify(value));
      setJsonError(null);
      setDrafts({});
      updateValidity({}, null);
    } else if (jsonError) {
      return;
    }
    setMode(next);
  };

  const onJsonText = (text: string) => {
    setJsonText(text);
    try {
      const parsed: unknown = text.trim() === '' ? {} : JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('objet attendu');
      setJsonError(null);
      updateValidity(drafts, null);
      onChange(parsed as Settings);
    } catch {
      const message = 'JSON invalide : un objet { … } est attendu.';
      setJsonError(message);
      updateValidity(drafts, message);
    }
  };

  /** Champ saisi en texte libre : liste séparée par des virgules, ou valeur JSON. */
  const setDraft = (field: SettingField, text: string) => {
    let error: string | null = null;
    if (text.trim() === '') onChange(setPath(value, field.path, undefined));
    else if (field.type === 'list') {
      onChange(setPath(value, field.path, text.split(',').map((v) => v.trim()).filter((v) => v !== '')));
    } else {
      try {
        onChange(setPath(value, field.path, JSON.parse(text) as unknown));
      } catch {
        error = 'JSON invalide.';
      }
    }
    const path = field.path;
    const next = { ...drafts, [path]: { text, error } };
    setDrafts(next);
    updateValidity(next, jsonError);
  };

  const settingsErrors = Object.entries(errors).filter(([key]) => key === 'settings' || key.startsWith('settings.'));

  return (
    <fieldset className="space-y-4 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">Paramètres non secrets</legend>
      <p className="text-xs text-muted-foreground">{spec.intro}</p>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Mode de saisie des paramètres" className="inline-flex rounded-md border p-0.5">
          <Button type="button" size="sm" variant={mode === 'form' ? 'secondary' : 'ghost'} aria-pressed={mode === 'form'} disabled={mode === 'json' && jsonError !== null} onClick={() => switchTo('form')}>
            Formulaire
          </Button>
          <Button type="button" size="sm" variant={mode === 'json' ? 'secondary' : 'ghost'} aria-pressed={mode === 'json'} onClick={() => switchTo('json')}>
            JSON complet
          </Button>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            onChange(spec.example);
            setJsonText(stringify(spec.example));
            setJsonError(null);
            setDrafts({});
            updateValidity({}, null);
          }}
        >
          Partir de l’exemple documenté
        </Button>
      </div>

      {settingsErrors.length > 0 ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">
          {settingsErrors.map(([key, messages]) => (
            <p key={key}>
              {key !== 'settings' ? <span className="font-mono text-xs">{key.slice('settings.'.length)} : </span> : null}
              {messages.join(' ')}
            </p>
          ))}
        </div>
      ) : null}

      {mode === 'json' ? (
        <div className="space-y-2">
          <Label htmlFor="settings-json">Paramètres (JSON)</Label>
          <Textarea id="settings-json" rows={14} className="font-mono text-xs" value={jsonText} onChange={(e) => onJsonText(e.target.value)} aria-invalid={jsonError ? true : undefined} aria-describedby="settings-json-error" spellCheck={false} />
          {jsonError ? (
            <p id="settings-json-error" role="alert" className="text-sm text-destructive">
              {jsonError}
            </p>
          ) : null}
        </div>
      ) : (
        spec.groups.map((group) => {
          const visible = group.fields.filter((f) => !f.visibleWhen || f.visibleWhen(value));
          if (visible.length === 0) return null;
          return (
            <div key={group.title} className="space-y-3">
              <p className="text-sm font-medium">{group.title}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {visible.map((field) => (
                  <SettingInput key={field.path} field={field} settings={value} onChange={onChange} draft={drafts[field.path]} onDraft={(text) => setDraft(field, text)} />
                ))}
              </div>
            </div>
          );
        })
      )}
    </fieldset>
  );
}

function SettingInput({
  field,
  settings,
  onChange,
  draft,
  onDraft,
}: {
  field: SettingField;
  settings: Settings;
  onChange: (next: Settings) => void;
  draft: { text: string; error: string | null } | undefined;
  onDraft: (text: string) => void;
}) {
  const id = fieldId(field.path);
  const current = getPath(settings, field.path);
  const set = (v: unknown) => onChange(setPath(settings, field.path, v));
  const label = (
    <Label htmlFor={id}>
      {field.label}
      {field.required ? ' *' : ''}
    </Label>
  );
  const help = field.help ? (
    <p id={`${id}-help`} className="text-xs text-muted-foreground">
      {field.help}
    </p>
  ) : null;
  const describedBy = field.help ? `${id}-help` : undefined;

  switch (field.type) {
    case 'text':
      return (
        <div className="space-y-1">
          {label}
          <Input id={id} value={typeof current === 'string' ? current : current === undefined ? '' : JSON.stringify(current)} placeholder={field.placeholder} onChange={(e) => set(e.target.value === '' ? undefined : e.target.value)} aria-describedby={describedBy} autoComplete="off" />
          {help}
        </div>
      );
    case 'integer':
      return (
        <div className="space-y-1">
          {label}
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={field.min}
            max={field.max}
            step={1}
            value={typeof current === 'number' || typeof current === 'string' ? String(current) : ''}
            placeholder={field.placeholder}
            onChange={(e) => set(e.target.value === '' ? undefined : Number(e.target.value))}
            aria-describedby={describedBy}
          />
          {help}
        </div>
      );
    case 'select':
      return (
        <div className="space-y-1">
          {label}
          <Select value={typeof current === 'string' && current !== '' ? current : DEFAULT} onValueChange={(v) => set(v === DEFAULT ? undefined : v)}>
            <SelectTrigger id={id} aria-describedby={describedBy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{field.defaultLabel}</SelectItem>
              {field.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {help}
        </div>
      );
    case 'boolean':
      return (
        <div className="flex items-start gap-2 sm:col-span-2">
          <Checkbox id={id} checked={current === true} onCheckedChange={(v) => set(v === true ? true : undefined)} aria-describedby={describedBy} />
          <div className="space-y-1">
            {label}
            {help}
          </div>
        </div>
      );
    case 'nullable-text': {
      const disabled = current === null;
      return (
        <div className="space-y-1">
          {label}
          <Input id={id} value={typeof current === 'string' ? current : ''} placeholder={field.placeholder} disabled={disabled} onChange={(e) => set(e.target.value === '' ? undefined : e.target.value)} aria-describedby={describedBy} autoComplete="off" />
          <div className="flex items-center gap-2">
            <Checkbox id={`${id}-null`} checked={disabled} onCheckedChange={(v) => set(v === true ? null : undefined)} />
            <Label htmlFor={`${id}-null`} className="text-xs font-normal">
              {field.disabledLabel}
            </Label>
          </div>
          {help}
        </div>
      );
    }
    case 'list':
      return (
        <div className="space-y-1">
          {label}
          <Input id={id} value={draft?.text ?? (Array.isArray(current) ? current.join(', ') : '')} placeholder={field.placeholder} onChange={(e) => onDraft(e.target.value)} aria-describedby={describedBy} />
          {help}
        </div>
      );
    case 'json': {
      const text = draft?.text ?? stringify(current);
      return (
        <div className="space-y-1 sm:col-span-2">
          {label}
          <Textarea id={id} rows={field.rows ?? 3} className="font-mono text-xs" value={text} placeholder={field.placeholder} onChange={(e) => onDraft(e.target.value)} aria-invalid={draft?.error ? true : undefined} aria-describedby={describedBy} spellCheck={false} />
          {draft?.error ? (
            <p role="alert" className="text-sm text-destructive">
              {draft.error}
            </p>
          ) : null}
          {help}
        </div>
      );
    }
  }
}

