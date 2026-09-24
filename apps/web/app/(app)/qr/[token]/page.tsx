import { redirect } from 'next/navigation';
import { apiServer } from '@/lib/api-server';
import { ApiRequestError } from '@/lib/api-error';
import { ErrorState } from '@/components/states';

/** Résolution d'un QR code après authentification : redirige vers la fiche si elle est dans le périmètre. */
export default async function QrPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const resolved = await apiServer<{ vehicleId: string }>(`/vehicles/qr/${encodeURIComponent(token)}`);
    redirect(`/vehicules/${resolved.vehicleId}`);
  } catch (error) {
    if (error instanceof ApiRequestError) return <ErrorState error={error} />;
    throw error;
  }
}
