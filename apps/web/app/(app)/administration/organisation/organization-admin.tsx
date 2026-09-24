'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { PageHeader } from '@/components/page-header';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { OrganizationView } from '@/lib/admin-types';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';

/** Paramètres de l'organisation (CDC 2.1) : nom affiché et fuseau horaire de référence. */
export function OrganizationAdmin() {
  const organization = useQuery({ queryKey: ['organization'], queryFn: () => api<OrganizationView>('/organization') });

  return (
    <div>
      <PageHeader title="Organisation" description="Nom du groupe et fuseau horaire utilisé pour l’affichage des dates et le calcul des échéances." />
      {organization.isPending ? (
        <LoadingState />
      ) : organization.isError ? (
        <ErrorState error={organization.error} retry={() => void organization.refetch()} />
      ) : (
        <OrganizationForm key={organization.data.version} organization={organization.data} />
      )}
    </div>
  );
}

function timezoneSuggestions(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
  try {
    return intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : [];
  } catch {
    return [];
  }
}

function OrganizationForm({ organization }: { organization: OrganizationView }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState(organization.name);
  const [timezone, setTimezone] = useState(organization.timezone);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [zones] = useState(timezoneSuggestions);
  const dirty = name !== organization.name || timezone !== organization.timezone;

  const save = useMutation({
    mutationFn: () =>
      api<OrganizationView>('/organization', {
        method: 'PATCH',
        body: {
          ...(name !== organization.name ? { name } : {}),
          ...(timezone !== organization.timezone ? { timezone } : {}),
          expectedVersion: organization.version,
        },
      }),
    onSuccess: (saved) => {
      toast.success('Organisation mise à jour.');
      queryClient.setQueryData(['organization'], saved);
      // Nom et fuseau sont portés par la session serveur (en-tête, formats de date).
      router.refresh();
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        if (error.status === 409) void queryClient.invalidateQueries({ queryKey: ['organization'] });
      } else toast.error('Enregistrement impossible.');
    },
  });

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Paramètres généraux</CardTitle>
          <CardDescription>Les modifications sont journalisées ; une version obsolète est refusée.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 md:grid-cols-2"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setFieldErrors({});
              save.mutate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="org-name">Nom de l’organisation *</Label>
              <Input id="org-name" required value={name} onChange={(e) => setName(e.target.value)} aria-invalid={fieldErrors.name ? true : undefined} aria-describedby="name-error" />
              <FieldError errors={fieldErrors} name="name" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-timezone">Fuseau horaire *</Label>
              <Input
                id="org-timezone"
                required
                list="org-timezones"
                autoComplete="off"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                aria-invalid={fieldErrors.timezone ? true : undefined}
                aria-describedby="org-timezone-hint timezone-error"
              />
              <datalist id="org-timezones">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
              <p id="org-timezone-hint" className="text-xs text-muted-foreground">
                Identifiant IANA, par exemple Africa/Tunis.
              </p>
              <FieldError errors={fieldErrors} name="timezone" />
            </div>
            <div className="flex gap-2 md:col-span-2">
              <Button type="submit" disabled={save.isPending || !dirty}>
                {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={save.isPending || !dirty}
                onClick={() => {
                  setName(organization.name);
                  setTimezone(organization.timezone);
                  setFieldErrors({});
                }}
              >
                Annuler les modifications
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Référence</CardTitle>
          <CardDescription>Valeurs fixées à l’installation, non modifiables ici.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-y-2 text-sm">
            <div>
              <dt className="text-muted-foreground">Code</dt>
              <dd className="font-medium">{organization.code}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Devise</dt>
              <dd className="font-medium">{organization.currency}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Décimales monétaires</dt>
              <dd className="font-medium">{organization.currencyDecimals}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
