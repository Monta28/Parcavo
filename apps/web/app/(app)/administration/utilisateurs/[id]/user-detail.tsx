'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { PERMISSION_LABELS } from '@parc-auto/contracts';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { OkResult, RevokeSessionsResult, UserView } from '@/lib/admin-types';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime, fullName } from '@/lib/format';
import { ConfirmDialog } from '../../confirm-dialog';
import { USER_STATUS_LABELS } from '../../labels';
import { AccessLinkDialog, DisableUserDialog, SetPasswordDialog } from '../account-dialogs';
import { membershipLabel } from '../membership-summary';
import { UserForm } from '../user-form';

type Pending = 'disable' | 'enable' | 'password' | 'invitation' | 'link' | 'revoke' | null;

/** Fiche d'un compte utilisateur (CDC 2.2) : identité, habilitations et actions sur le compte. */
export function UserDetail({ id }: { id: string }) {
  const { session } = useAppScope();
  const queryClient = useQueryClient();
  const user = useQuery({ queryKey: ['admin-user', id], queryFn: () => api<UserView>(`/users/${id}`) });
  const [open, setOpen] = useState<Pending>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const close = () => {
    setOpen(null);
    setFieldErrors({});
  };
  const onUserUpdated = (saved: UserView) => {
    queryClient.setQueryData(['admin-user', id], saved);
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };
  const onError = (fallback: string) => (error: unknown) => {
    if (isApiError(error)) {
      setFieldErrors(error.fieldErrors);
      toast.error(error.message);
    } else toast.error(fallback);
  };

  const disable = useMutation({
    mutationFn: (reason: string) => api<UserView>(`/users/${id}/disable`, { method: 'POST', body: { reason } }),
    onSuccess: (saved) => {
      toast.success('Compte désactivé ; ses sessions ont été révoquées.');
      onUserUpdated(saved);
      close();
    },
    onError: onError('Désactivation impossible.'),
  });
  const enable = useMutation({
    mutationFn: () => api<UserView>(`/users/${id}/enable`, { method: 'POST' }),
    onSuccess: (saved) => {
      toast.success('Compte réactivé.');
      onUserUpdated(saved);
      close();
    },
    onError: onError('Réactivation impossible.'),
  });
  const setPassword = useMutation({
    mutationFn: (password: string) => api<OkResult>(`/users/${id}/set-password`, { method: 'POST', body: { password } }),
    onSuccess: () => {
      toast.success('Mot de passe défini ; les sessions du compte ont été révoquées.');
      void queryClient.invalidateQueries({ queryKey: ['admin-user', id] });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      close();
    },
    onError: onError('Définition du mot de passe impossible.'),
  });
  const resendInvitation = useMutation({
    mutationFn: () => api<OkResult>(`/users/${id}/resend-invitation`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Invitation mise en file d’envoi par e-mail.');
      close();
    },
    onError: onError('Envoi de l’invitation impossible.'),
  });
  const revokeSessions = useMutation({
    mutationFn: () => api<RevokeSessionsResult>('/auth/revoke-sessions', { method: 'POST', body: { userId: id, keepCurrent: false } }),
    onSuccess: (result) => {
      toast.success(result.revoked === 0 ? 'Aucune session ouverte à révoquer.' : `${result.revoked} session${result.revoked > 1 ? 's' : ''} révoquée${result.revoked > 1 ? 's' : ''}.`);
      close();
    },
    onError: onError('Révocation impossible.'),
  });

  if (user.isPending) return <LoadingState label="Chargement du compte…" />;
  if (user.isError) return <ErrorState error={user.error} retry={() => void user.refetch()} />;
  const u = user.data;
  const name = fullName(u);
  const isSelf = u.id === session.userId;
  const active = u.status === 'ACTIF';

  return (
    <div>
      <PageHeader
        title={name}
        description={u.email}
        actions={
          <Button variant="outline" asChild>
            <Link href="/administration/utilisateurs">Retour à la liste</Link>
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge label={USER_STATUS_LABELS[u.status]} tone={active ? 'success' : 'neutral'} />
        {!u.hasPassword ? <StatusBadge label="Invitation en attente" tone="warning" /> : null}
        {isSelf ? <StatusBadge label="Votre compte" tone="info" /> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <UserForm key={u.version} user={u} />
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Compte</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-y-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">Créé le</dt>
                  <dd>{formatDateTime(u.createdAt, session.timezone)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Dernière connexion</dt>
                  <dd>{u.lastLoginAt ? formatDateTime(u.lastLoginAt, session.timezone) : 'Jamais'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Mot de passe</dt>
                  <dd>{u.hasPassword ? 'Défini' : 'Non défini (invitation en attente)'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Conducteur lié</dt>
                  <dd>
                    {u.driverId ? (
                      <Link href={`/conducteurs/${u.driverId}`} className="underline-offset-4 hover:underline">
                        Voir la fiche conducteur
                      </Link>
                    ) : (
                      'Aucun'
                    )}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Actions sur le compte</CardTitle>
              <CardDescription>Chaque action est journalisée.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {isSelf ? (
                <p className="text-sm text-muted-foreground">
                  Les invitations, liens d’accès, la désactivation, la définition du mot de passe et la révocation des sessions ne s’appliquent pas à votre propre compte depuis cet écran.
                </p>
              ) : null}
              {!isSelf && active && !u.hasPassword && session.emailChannelConfigured ? (
                <Button variant="outline" onClick={() => setOpen('invitation')}>
                  Renvoyer l’invitation par e-mail
                </Button>
              ) : null}
              {!isSelf && active ? (
                <Button variant="outline" onClick={() => setOpen('link')}>
                  Générer un lien d’accès
                </Button>
              ) : null}
              {!isSelf && active && !u.hasPassword && !session.emailChannelConfigured ? (
                <p className="text-xs text-muted-foreground">Canal e-mail non configuré : aucune invitation n’est envoyée par e-mail. Générez un lien d’accès et transmettez-le à l’utilisateur.</p>
              ) : null}
              {!isSelf ? (
                <Button variant="outline" onClick={() => setOpen('password')}>
                  Définir un mot de passe
                </Button>
              ) : null}
              {!isSelf && active ? (
                <Button variant="outline" onClick={() => setOpen('revoke')}>
                  Révoquer toutes les sessions
                </Button>
              ) : null}
              {!isSelf && active ? (
                <Button variant="destructive" onClick={() => setOpen('disable')}>
                  Désactiver le compte
                </Button>
              ) : null}
              {!active ? <Button onClick={() => setOpen('enable')}>Réactiver le compte</Button> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Permissions effectives</CardTitle>
              <CardDescription>Calculées par le serveur à partir du rôle et des ajustements enregistrés.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {u.memberships.length === 0 ? (
                <p className="text-muted-foreground">Aucune habilitation.</p>
              ) : (
                u.memberships.map((m) => (
                  <div key={m.id}>
                    <p className="font-medium">{membershipLabel(m)}</p>
                    {m.effectivePermissions.length === 0 ? (
                      <p className="text-muted-foreground">Aucune permission fine.</p>
                    ) : (
                      <ul className="list-disc pl-5 text-muted-foreground">
                        {m.effectivePermissions.map((p) => (
                          <li key={p}>{PERMISSION_LABELS[p]}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {open === 'disable' ? <DisableUserDialog userName={name} pending={disable.isPending} fieldErrors={fieldErrors} onOpenChange={(o) => !o && close()} onSubmit={(reason) => disable.mutate(reason)} /> : null}
      {open === 'link' ? (
        <AccessLinkDialog userId={u.id} userName={name} defaultPurpose={u.hasPassword ? 'REINITIALISATION' : 'INVITATION'} timezone={session.timezone} onOpenChange={(o) => !o && close()} />
      ) : null}
      {open === 'password' ? <SetPasswordDialog userName={name} pending={setPassword.isPending} fieldErrors={fieldErrors} onOpenChange={(o) => !o && close()} onSubmit={(password) => setPassword.mutate(password)} /> : null}

      <ConfirmDialog
        open={open === 'enable'}
        onOpenChange={(o) => !o && !enable.isPending && close()}
        title={`Réactiver le compte de ${name} ?`}
        description={<p>Le compte pourra de nouveau se connecter avec ses habilitations actuelles.</p>}
        confirmLabel="Réactiver"
        pending={enable.isPending}
        onConfirm={() => enable.mutate()}
      />
      <ConfirmDialog
        open={open === 'invitation'}
        onOpenChange={(o) => !o && !resendInvitation.isPending && close()}
        title={`Renvoyer l’invitation à ${u.email} ?`}
        description={<p>Un nouveau lien de définition du mot de passe, valable 72 heures, est envoyé à cette adresse par e-mail.</p>}
        confirmLabel="Renvoyer l’invitation"
        pending={resendInvitation.isPending}
        onConfirm={() => resendInvitation.mutate()}
      />
      <ConfirmDialog
        open={open === 'revoke'}
        onOpenChange={(o) => !o && !revokeSessions.isPending && close()}
        title={`Révoquer toutes les sessions de ${name} ?`}
        description={<p>Toutes les sessions ouvertes de ce compte sont fermées immédiatement ; l’utilisateur devra se reconnecter.</p>}
        confirmLabel="Révoquer les sessions"
        destructive
        pending={revokeSessions.isPending}
        onConfirm={() => revokeSessions.mutate()}
      />
    </div>
  );
}
