'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PASSWORD_RESET_LINK_TTL_MINUTES } from '@parc-auto/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: { email } });
      setDone(true);
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Demande impossible.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Réinitialiser le mot de passe</CardTitle>
        <CardDescription>Si un compte actif existe pour cette adresse, un lien de réinitialisation valable {PASSWORD_RESET_LINK_TTL_MINUTES} minutes lui est envoyé lorsque le canal e-mail est configuré.</CardDescription>
      </CardHeader>
      <CardContent>
        {done ? (
          <p role="status" className="text-sm">
            Demande enregistrée. Si le canal e-mail n’est pas configuré, contactez votre administrateur pour obtenir un nouveau mot de passe.
          </p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="email">Adresse e-mail</Label>
              <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? 'Envoi…' : 'Envoyer le lien'}
            </Button>
          </form>
        )}
        <p className="mt-4 text-center text-sm">
          <Link href="/login" className="underline underline-offset-4">
            Retour à la connexion
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
