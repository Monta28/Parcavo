'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { UserForm } from '../user-form';

export function NewUser() {
  return (
    <div>
      <PageHeader
        title="Nouvel utilisateur"
        description="Crée un compte et ses habilitations. Toutes les opérations sont journalisées."
        actions={
          <Button variant="outline" asChild>
            <Link href="/administration/utilisateurs">Retour à la liste</Link>
          </Button>
        }
      />
      <UserForm />
    </div>
  );
}
