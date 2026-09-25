import { redirect } from 'next/navigation';

/**
 * Lien d'action des alertes « unité GPS non mappée » (actionPath « /telematique/unites » fourni par
 * l'API) : ouvre la liste des unités non associées de /telematique.
 */
export default function TelemetryUnmappedUnitsLink() {
  redirect('/telematique?onglet=associations&categorie=NON_ASSOCIEES');
}
