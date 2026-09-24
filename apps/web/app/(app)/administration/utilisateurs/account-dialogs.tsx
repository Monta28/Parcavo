'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import type { AccessLink, AccessLinkPurpose } from '@/lib/admin-types';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';

/** Désactivation d'un compte : motif obligatoire, sessions révoquées immédiatement par l'API. */
export function DisableUserDialog({
  userName,
  pending,
  fieldErrors,
  onOpenChange,
  onSubmit,
}: {
  userName: string;
  pending: boolean;
  fieldErrors: Record<string, string[]>;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const valid = reason.trim().length >= 3;
  return (
    <Dialog open onOpenChange={(open) => !pending && onOpenChange(open)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Désactiver le compte de {userName}</DialogTitle>
          <DialogDescription>Le compte ne pourra plus se connecter et ses sessions ouvertes sont révoquées immédiatement. L’historique est conservé ; le compte peut être réactivé.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onSubmit(reason.trim());
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="disable-reason">Motif (obligatoire)</Label>
            <Textarea
              id="disable-reason"
              required
              minLength={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={fieldErrors.reason ? true : undefined}
              aria-describedby="disable-reason-hint reason-error"
            />
            <p id="disable-reason-hint" className="text-xs text-muted-foreground">
              3 à 500 caractères. Le motif est enregistré dans le journal d’audit.
            </p>
            <FieldError errors={fieldErrors} name="reason" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="destructive" disabled={pending || !valid}>
              {pending ? 'Désactivation…' : 'Désactiver le compte'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Définition d'un mot de passe par l'administrateur : les sessions du compte sont révoquées. */
export function SetPasswordDialog({
  userName,
  pending,
  fieldErrors,
  onOpenChange,
  onSubmit,
}: {
  userName: string;
  pending: boolean;
  fieldErrors: Record<string, string[]>;
  onOpenChange: (open: boolean) => void;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const mismatch = confirmation.length > 0 && confirmation !== password;
  return (
    <Dialog open onOpenChange={(open) => !pending && onOpenChange(open)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Définir le mot de passe de {userName}</DialogTitle>
          <DialogDescription>Le nouveau mot de passe remplace l’actuel et toutes les sessions ouvertes du compte sont révoquées. Communiquez-le par un canal sûr.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (password && !mismatch) onSubmit(password);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="set-password">Nouveau mot de passe</Label>
            <Input
              id="set-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={fieldErrors.password ? true : undefined}
              aria-describedby="set-password-hint password-error"
            />
            <p id="set-password-hint" className="text-xs text-muted-foreground">
              12 caractères minimum, avec minuscules, majuscules et chiffres.
            </p>
            <FieldError errors={fieldErrors} name="password" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="set-password-confirmation">Confirmation</Label>
            <Input
              id="set-password-confirmation"
              type="password"
              autoComplete="new-password"
              required
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              aria-invalid={mismatch ? true : undefined}
              aria-describedby={mismatch ? 'set-password-confirmation-error' : undefined}
            />
            {mismatch ? (
              <p id="set-password-confirmation-error" role="alert" className="text-sm text-destructive">
                Les deux saisies ne correspondent pas.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={pending || !password || confirmation !== password}>
              {pending ? 'Enregistrement…' : 'Définir le mot de passe'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const PURPOSES: Array<{ value: AccessLinkPurpose; label: string; hint: string }> = [
  { value: 'INVITATION', label: 'Invitation', hint: 'Premier accès : l’utilisateur définit son mot de passe. Lien valable 72 heures.' },
  { value: 'REINITIALISATION', label: 'Réinitialisation du mot de passe', hint: 'Remplacement d’un mot de passe oublié. Lien valable 30 minutes.' },
];

/**
 * Lien d'accès à usage unique généré par l'administrateur (POST /users/:id/access-link), sans e-mail :
 * affiché une seule fois, à transmettre par un canal sûr ; les liens encore valides sont invalidés.
 */
export function AccessLinkDialog({
  userId,
  userName,
  defaultPurpose,
  timezone,
  onOpenChange,
}: {
  userId: string;
  userName: string;
  defaultPurpose: AccessLinkPurpose;
  timezone: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [purpose, setPurpose] = useState<AccessLinkPurpose>(defaultPurpose);
  const generate = useMutation({
    mutationFn: () => api<AccessLink>(`/users/${userId}/access-link`, { method: 'POST', body: { purpose } }),
    onSuccess: () => toast.success('Lien d’accès généré.'),
    onError: (error) => toast.error(isApiError(error) ? error.message : 'Génération du lien impossible.'),
  });
  const result = generate.data;

  const copy = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Lien copié dans le presse-papiers.');
    } catch {
      toast.error('Copie impossible : sélectionnez le lien et copiez-le manuellement.');
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !generate.isPending && onOpenChange(open)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Lien d’accès pour {userName}</DialogTitle>
          <DialogDescription>
            Le lien est à usage unique et n’est affiché qu’une seule fois. Générer un nouveau lien invalide ceux encore valides pour ce compte. Transmettez-le par un canal sûr.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="access-link">Lien à transmettre</Label>
              <Input id="access-link" readOnly value={result.link} onFocus={(e) => e.currentTarget.select()} aria-describedby="access-link-expiry" />
              <p id="access-link-expiry" className="text-xs text-muted-foreground">
                Valable jusqu’au {formatDateTime(result.expiresAt, timezone)}. Il ne sera plus affiché après la fermeture de cette fenêtre.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => void copy(result.link)}>
                Copier le lien
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Fermer
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              generate.mutate();
            }}
          >
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Objet du lien</legend>
              <RadioGroup value={purpose} onValueChange={(v) => setPurpose(v === 'REINITIALISATION' ? 'REINITIALISATION' : 'INVITATION')}>
                {PURPOSES.map((p) => (
                  <div key={p.value} className="flex items-start gap-2">
                    <RadioGroupItem id={`access-link-${p.value}`} value={p.value} aria-describedby={`access-link-${p.value}-hint`} className="mt-0.5" />
                    <div className="space-y-0.5">
                      <Label htmlFor={`access-link-${p.value}`} className="font-normal">
                        {p.label}
                      </Label>
                      <p id={`access-link-${p.value}-hint`} className="text-xs text-muted-foreground">
                        {p.hint}
                      </p>
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </fieldset>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={generate.isPending} onClick={() => onOpenChange(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={generate.isPending}>
                {generate.isPending ? 'Génération…' : 'Générer le lien'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
