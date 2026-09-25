/**
 * Contenu du QR code interne d'un véhicule (CDC 10.3) : uniquement le lien vers /qr/<jeton>, où le jeton
 * est l'identifiant opaque fourni par l'API (aléatoire, régénérable). Aucune donnée du véhicule (code,
 * immatriculation, société) ni aucun paramètre d'accès n'y figure : la fiche s'ouvre après connexion,
 * selon les permissions, et le scan n'affecte aucun conducteur.
 */
export function vehicleQrLink(origin: string, qrToken: string): string {
  return `${origin.replace(/\/+$/, '')}/qr/${encodeURIComponent(qrToken)}`;
}
