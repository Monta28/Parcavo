'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CompanyView, UserView } from '@/lib/admin-types';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { DriverPicker } from './driver-picker';
import { draftsFromMemberships, MembershipsEditor, toMembershipInputs, type MembershipDraft } from './memberships-editor';

interface FormState {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  driverId: string | null;
  memberships: MembershipDraft[];
}

function initial(user: UserView | undefined): FormState {
  return {
    firstName: user?.firstName ?? '',
    lastName: user?.lastName ?? '',
    email: user?.email ?? '',
    password: '',
    driverId: user?.driverId ?? null,
    memberships: user ? draftsFromMemberships(user.memberships) : [],
  };
}

/** Création (POST /users) ou modification (PATCH /users/:id) d'un compte et de ses habilitations. */
export function UserForm({ user }: { user?: UserView }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session, companyId: scopeCompanyId } = useAppScope();
  const [form, setForm] = useState<FormState>(() => initial(user));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const companies = useQuery({ queryKey: ['companies', 'options'], queryFn: () => api<Page<CompanyView>>(`/companies${toQuery({ pageSize: 100, sort: 'code' })}`) });

  const membershipsInput = toMembershipInputs(form.memberships);
  const membershipsChanged = !user || JSON.stringify(membershipsInput) !== JSON.stringify(toMembershipInputs(draftsFromMemberships(user.memberships)));
  const dirty =
    !user ||
    form.firstName !== user.firstName ||
    form.lastName !== user.lastName ||
    form.email !== user.email ||
    form.driverId !== user.driverId ||
    membershipsChanged;

  const save = useMutation({
    mutationFn: () => {
      if (user) {
        return api<UserView>(`/users/${user.id}`, {
          method: 'PATCH',
          body: {
            ...(form.firstName !== user.firstName ? { firstName: form.firstName } : {}),
            ...(form.lastName !== user.lastName ? { lastName: form.lastName } : {}),
            ...(form.email !== user.email ? { email: form.email } : {}),
            ...(membershipsChanged ? { memberships: membershipsInput } : {}),
            ...(form.driverId !== user.driverId ? { driverId: form.driverId } : {}),
            expectedVersion: user.version,
          },
        });
      }
      return api<UserView>('/users', {
        method: 'POST',
        body: {
          email: form.email,
          firstName: form.firstName,
          lastName: form.lastName,
          password: form.password || undefined,
          memberships: membershipsInput,
          driverId: form.driverId ?? undefined,
        },
      });
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      // La liaison conducteur modifie aussi la fiche conducteur (userId, version).
      if (saved.driverId !== (user?.driverId ?? null)) {
        void queryClient.invalidateQueries({ queryKey: ['drivers'] });
        void queryClient.invalidateQueries({ queryKey: ['driver'] });
        void queryClient.invalidateQueries({ queryKey: ['admin'] });
      }
      queryClient.setQueryData(['admin-user', saved.id], saved);
      if (user) {
        toast.success('Utilisateur mis à jour.');
        if (saved.id === session.userId) router.refresh();
      } else {
        toast.success(
          form.password
            ? 'Utilisateur créé.'
            : session.emailChannelConfigured
              ? 'Utilisateur créé : invitation mise en file d’envoi par e-mail.'
              : 'Utilisateur créé. Canal e-mail non configuré : générez un lien d’accès depuis sa fiche.',
        );
        router.push(`/administration/utilisateurs/${saved.id}`);
      }
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        if (error.status === 409 && user) void queryClient.invalidateQueries({ queryKey: ['admin-user', user.id] });
      } else toast.error('Enregistrement impossible.');
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{user ? 'Identité et habilitations' : 'Nouveau compte'}</CardTitle>
        <CardDescription>
          {user
            ? 'Les habilitations enregistrées remplacent l’ensemble des habilitations actuelles. Une version obsolète est refusée.'
            : session.emailChannelConfigured
              ? 'Sans mot de passe initial, une invitation est envoyée par e-mail (lien valable 72 heures).'
              : 'Sans mot de passe initial, aucun e-mail n’est envoyé (canal e-mail non configuré) : générez ensuite un lien d’accès depuis la fiche du compte.'}
        </CardDescription>
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
            <Label htmlFor="user-firstName">Prénom *</Label>
            <Input
              id="user-firstName"
              required
              autoComplete="off"
              value={form.firstName}
              onChange={(e) => update({ firstName: e.target.value })}
              aria-invalid={fieldErrors.firstName ? true : undefined}
              aria-describedby="firstName-error"
            />
            <FieldError errors={fieldErrors} name="firstName" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="user-lastName">Nom *</Label>
            <Input
              id="user-lastName"
              required
              autoComplete="off"
              value={form.lastName}
              onChange={(e) => update({ lastName: e.target.value })}
              aria-invalid={fieldErrors.lastName ? true : undefined}
              aria-describedby="lastName-error"
            />
            <FieldError errors={fieldErrors} name="lastName" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="user-email">E-mail *</Label>
            <Input
              id="user-email"
              type="email"
              required
              autoComplete="off"
              value={form.email}
              onChange={(e) => update({ email: e.target.value })}
              aria-invalid={fieldErrors.email ? true : undefined}
              aria-describedby="email-error"
            />
            <FieldError errors={fieldErrors} name="email" />
          </div>
          {!user ? (
            <div className="space-y-2">
              <Label htmlFor="user-password">Mot de passe initial</Label>
              <Input
                id="user-password"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => update({ password: e.target.value })}
                aria-invalid={fieldErrors.password ? true : undefined}
                aria-describedby="user-password-hint password-error"
              />
              <p id="user-password-hint" className="text-xs text-muted-foreground">
                Facultatif. 12 caractères minimum, avec minuscules, majuscules et chiffres.
                {session.emailChannelConfigured ? ' Laisser vide pour envoyer une invitation par e-mail.' : ' Laisser vide pour transmettre ensuite un lien d’accès généré depuis la fiche du compte.'}
              </p>
              <FieldError errors={fieldErrors} name="password" />
            </div>
          ) : null}
          <div className="md:col-span-2">
            <DriverPicker value={form.driverId} onChange={(driverId) => update({ driverId })} userId={user?.id ?? null} errorId="driverId-error" />
            <FieldError errors={fieldErrors} name="driverId" />
          </div>
          <div className="md:col-span-2">
            {companies.isPending ? (
              <LoadingState label="Chargement des sociétés…" />
            ) : companies.isError ? (
              <ErrorState error={companies.error} retry={() => void companies.refetch()} />
            ) : (
              <MembershipsEditor
                value={form.memberships}
                onChange={(memberships) => update({ memberships })}
                companies={companies.data.items}
                preferredCompanyId={scopeCompanyId}
                fieldErrors={fieldErrors}
              />
            )}
          </div>
          <div className="flex flex-wrap gap-2 md:col-span-2">
            <Button type="submit" disabled={save.isPending || !dirty}>
              {save.isPending ? 'Enregistrement…' : user ? 'Enregistrer' : 'Créer l’utilisateur'}
            </Button>
            {user ? (
              <Button
                type="button"
                variant="outline"
                disabled={save.isPending || !dirty}
                onClick={() => {
                  setForm(initial(user));
                  setFieldErrors({});
                }}
              >
                Annuler les modifications
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={() => router.push('/administration/utilisateurs')}>
                Annuler
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
