import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { VehicleForm } from '../vehicle-form';

export const metadata: Metadata = { title: 'Nouveau véhicule' };

export default function NewVehiclePage() {
  return (
    <div>
      <PageHeader title="Nouveau véhicule" description="Champs obligatoires : code interne, société, immatriculation ou identifiant provisoire, marque, modèle et catégorie. Le kilométrage initial se saisit ensuite depuis l’onglet Kilométrage." />
      <VehicleForm />
    </div>
  );
}
