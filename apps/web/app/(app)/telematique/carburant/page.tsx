import { redirect } from 'next/navigation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lien d'action des alertes carburant F11 (actionPath « /telematique/carburant?evenement=… » fourni par
 * l'API) : ouvre l'onglet Événements carburant de /telematique sur l'événement signalé.
 */
export default async function TelemetryFuelEventLink({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { evenement } = await searchParams;
  const id = typeof evenement === 'string' && UUID.test(evenement) ? evenement : null;
  redirect(id ? `/telematique?onglet=carburant&evenement=${id}` : '/telematique?onglet=carburant');
}
