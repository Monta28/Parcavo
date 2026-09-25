'use client';

import { useState } from 'react';
import { FieldError } from '@/components/forms/field-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface PeriodFilterProps {
  /** Bornes proposées à l'ouverture : celles de l'URL, sinon la période renvoyée par l'API. */
  initialFrom: string;
  initialTo: string;
  /** Une période choisie est présente dans l'URL (sinon : mois civil en cours, déterminé par l'API). */
  custom: boolean;
  /** Erreurs de l'API sur les champs from / to (PERIODE_INCOMPLETE, PERIODE_INVALIDE, format). */
  errors: Record<string, string[]> | undefined;
  onApply: (from: string, to: string) => void;
  onReset: () => void;
}

/**
 * Période des indicateurs de flux (dates civiles incluses), conservée dans l'URL (du, au). Les deux
 * bornes sont validées par l'API ; sans période, l'API retient le mois civil local en cours.
 */
export function PeriodFilter({ initialFrom, initialTo, custom, errors, onApply, onReset }: PeriodFilterProps) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const fromError = Boolean(errors?.from?.length);
  const toError = Boolean(errors?.to?.length);

  return (
    <form
      className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start"
      aria-label="Période des flux"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(from, to);
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="periode-du" className="text-xs text-muted-foreground">
          Du
        </Label>
        <Input
          id="periode-du"
          type="date"
          required
          value={from}
          max={to || undefined}
          onChange={(e) => setFrom(e.target.value)}
          aria-invalid={fromError}
          aria-describedby={fromError ? 'from-error' : undefined}
        />
        <FieldError errors={errors} name="from" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="periode-au" className="text-xs text-muted-foreground">
          Au
        </Label>
        <Input
          id="periode-au"
          type="date"
          required
          value={to}
          min={from || undefined}
          onChange={(e) => setTo(e.target.value)}
          aria-invalid={toError}
          aria-describedby={toError ? 'to-error' : undefined}
        />
        <FieldError errors={errors} name="to" />
      </div>
      <div className="flex gap-2 sm:mt-5">
        <Button type="submit">Appliquer</Button>
        <Button type="button" variant="outline" disabled={!custom} onClick={onReset}>
          Mois en cours
        </Button>
      </div>
    </form>
  );
}
