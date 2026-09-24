'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { SessionInfo } from '@/lib/api-types';

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const expired = params.get('expire') === '1';
  const next = params.get('suite');

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const session = await api<SessionInfo>('/auth/login', { method: 'POST', body: { email, password } });
      const target = next && next.startsWith('/') && !next.startsWith('//') ? next : session.isDriverOnly ? '/mon-vehicule' : '/tableau-de-bord';
      router.replace(target);
      router.refresh();
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Connexion impossible.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connexion</CardTitle>
        <CardDescription>Accès réservé aux comptes créés par l’administrateur. Aucune inscription publique.</CardDescription>
      </CardHeader>
      <CardContent>
        {expired ? (
          <p role="status" className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            Votre session a expiré ou a été révoquée. Reconnectez-vous.
          </p>
        ) : null}
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="email">Adresse e-mail</Label>
            <Input id="email" name="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Mot de passe</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? 'Connexion…' : 'Se connecter'}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm">
          <Link href="/mot-de-passe-oublie" className="underline underline-offset-4">
            Mot de passe oublié ?
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
