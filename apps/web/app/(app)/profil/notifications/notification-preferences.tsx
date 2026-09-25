'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, MailCheck, MailX } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { ALERT_SEVERITY_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { ALERT_SEVERITY_ORDER, type AlertSeverity } from '@/lib/alerts-types';
import type { NotificationPreferences } from '@/lib/notifications-types';

const QUERY_KEY = ['me', 'notification-preferences'] as const;

/**
 * Préférences de notification de l'utilisateur connecté (GET/PUT /me/notification-preferences, CDC 9.4,
 * D-245, D-262) et état honnête du canal e-mail : sans SMTP, « Canal e-mail non configuré » et aucun
 * envoi n'est simulé. Enregistrement versionné (expectedVersion) et audité par l'API.
 */
export function NotificationPreferencesView() {
  const { session } = useAppScope();
  const prefs = useQuery({ queryKey: QUERY_KEY, queryFn: () => api<NotificationPreferences>('/me/notification-preferences'), enabled: !session.isDriverOnly });

  if (session.isDriverOnly) {
    return (
      <div>
        <PageHeader title="Mes notifications" />
        <div role="alert" className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <Lock className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">Notifications réservées au personnel de gestion</p>
          <p className="max-w-md text-sm text-muted-foreground">Les comptes conducteur ne reçoivent pas d’e-mails d’alerte : l’état de vos soumissions est affiché dans « Mon véhicule ».</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Mes notifications"
        description="E-mails immédiats des alertes et récapitulatif quotidien. Le centre d’alertes fonctionne dans tous les cas, avec ou sans e-mail."
        actions={
          session.isAdmin ? (
            <Button variant="outline" asChild>
              <Link href="/administration/notifications">Supervision des envois</Link>
            </Button>
          ) : null
        }
      />
      {prefs.isPending ? (
        <LoadingState label="Chargement de vos préférences…" />
      ) : prefs.isError ? (
        <ErrorState error={prefs.error} retry={() => void prefs.refetch()} />
      ) : (
        <PreferencesForm key={prefs.data.version} prefs={prefs.data} />
      )}
    </div>
  );
}

function PreferencesForm({ prefs }: { prefs: NotificationPreferences }) {
  const queryClient = useQueryClient();
  const [emailCritical, setEmailCritical] = useState(prefs.emailCritical);
  const [emailDailyDigest, setEmailDailyDigest] = useState(prefs.emailDailyDigest);
  const [minimumSeverity, setMinimumSeverity] = useState<AlertSeverity>(prefs.minimumSeverity);
  const dirty = emailCritical !== prefs.emailCritical || emailDailyDigest !== prefs.emailDailyDigest || minimumSeverity !== prefs.minimumSeverity;

  const save = useMutation({
    mutationFn: () => api<NotificationPreferences>('/me/notification-preferences', { method: 'PUT', body: { emailCritical, emailDailyDigest, minimumSeverity, expectedVersion: prefs.version } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(QUERY_KEY, updated);
      toast.success('Préférences de notification enregistrées.');
    },
    onError: (error) => {
      // Version obsolète : les préférences sont rechargées (le formulaire est alors remonté avec la version
      // à jour) ; le message de l'API est conservé dans une notification, sinon il disparaîtrait avec lui.
      if (isApiError(error) && error.status === 409) {
        toast.error(`${error.message} Vos préférences ont été rechargées : vérifiez-les puis enregistrez de nouveau.`);
        void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      }
    },
  });
  const errors = isApiError(save.error) ? save.error.fieldErrors : {};
  const immediate = prefs.immediateSeverities.map((s) => ALERT_SEVERITY_LABELS[s] ?? s);

  return (
    <div className="space-y-4">
      {prefs.emailChannelConfigured ? (
        <Alert>
          <MailCheck aria-hidden="true" />
          <AlertTitle>Canal e-mail configuré</AlertTitle>
          <AlertDescription>Les e-mails sont mis en file puis envoyés par le serveur du groupe ; vos droits sont revérifiés juste avant chaque envoi.</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive">
          <MailX aria-hidden="true" />
          <AlertTitle>Canal e-mail non configuré</AlertTitle>
          <AlertDescription>Aucun e-mail n’est envoyé ni mis en file tant que l’administrateur n’a pas configuré le serveur d’envoi. Vos préférences sont conservées et le centre d’alertes reste disponible.</AlertDescription>
        </Alert>
      )}
      {!prefs.receivesEmails ? (
        <Alert>
          <AlertTitle>Votre rôle ne reçoit pas d’e-mails d’alerte</AlertTitle>
          <AlertDescription>Seuls les chefs de parc et l’administrateur groupe reçoivent les e-mails d’alerte et le récapitulatif. Vos préférences sont enregistrées et s’appliqueront si votre rôle change.</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Préférences</CardTitle>
          <CardDescription>
            {prefs.isDefault ? <StatusBadge label="Préférences par défaut (jamais enregistrées)" tone="info" /> : `Version enregistrée : ${prefs.version}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-6"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="flex items-start gap-3">
              <Switch id="pref-immediate" checked={emailCritical} onCheckedChange={setEmailCritical} aria-describedby="pref-immediate-hint" />
              <div className="space-y-1">
                <Label htmlFor="pref-immediate">Recevoir immédiatement les alertes par e-mail</Label>
                <p id="pref-immediate-hint" className="text-xs text-muted-foreground">
                  Un e-mail à la création ou à l’aggravation d’une alerte de gravité au moins égale au seuil choisi, sauf si vous l’avez reportée.
                </p>
                <FieldError errors={errors} name="emailCritical" />
              </div>
            </div>
            <div className="max-w-sm space-y-2">
              <Label htmlFor="pref-severity">Gravité minimale d’un e-mail immédiat</Label>
              <Select value={minimumSeverity} onValueChange={(v) => setMinimumSeverity(v as AlertSeverity)}>
                <SelectTrigger id="pref-severity" className="w-full" aria-describedby="pref-severity-hint">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALERT_SEVERITY_ORDER.map((s) => (
                    <SelectItem key={s} value={s}>
                      {ALERT_SEVERITY_LABELS[s]}
                      {s === 'CRITIQUE' ? ' (seules les alertes critiques)' : ' et plus grave'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p id="pref-severity-hint" className="text-xs text-muted-foreground">
                Gravités envoyées immédiatement selon vos préférences enregistrées : {immediate.length > 0 ? immediate.join(', ') : 'aucune (e-mail immédiat désactivé)'}.
              </p>
              <FieldError errors={errors} name="minimumSeverity" />
            </div>
            <div className="flex items-start gap-3">
              <Switch id="pref-digest" checked={emailDailyDigest} onCheckedChange={setEmailDailyDigest} aria-describedby="pref-digest-hint" />
              <div className="space-y-1">
                <Label htmlFor="pref-digest">Recevoir le récapitulatif quotidien</Label>
                <p id="pref-digest-hint" className="text-xs text-muted-foreground">
                  Chaque jour à {prefs.dailyDigestLocalTime} (heure locale du groupe) : alertes actives non reportées, retours attendus et soumissions en attente. Aucun envoi si le récapitulatif est vide.
                </p>
                <FieldError errors={errors} name="emailDailyDigest" />
              </div>
            </div>
            <ApiErrorAlert error={save.error} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={save.isPending || (!dirty && !prefs.isDefault)}>
                {save.isPending ? 'Enregistrement…' : 'Enregistrer mes préférences'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={save.isPending || !dirty}
                onClick={() => {
                  setEmailCritical(prefs.emailCritical);
                  setEmailDailyDigest(prefs.emailDailyDigest);
                  setMinimumSeverity(prefs.minimumSeverity);
                }}
              >
                Rétablir
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
