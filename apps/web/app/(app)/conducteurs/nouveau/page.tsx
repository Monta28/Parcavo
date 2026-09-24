import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { DriverForm } from '../driver-form';

export const metadata: Metadata = { title: 'Nouveau conducteur' };

export default function NewDriverPage() {
  return (
    <div>
      <PageHeader title="Nouveau conducteur" description="Champs obligatoires : société, identifiant interne, nom et prénom. Le permis se renseigne ensuite depuis la fiche du conducteur." />
      <DriverForm />
    </div>
  );
}
