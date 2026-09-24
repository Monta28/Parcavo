import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Page introuvable' };

/**
 * Adresse inconnue (CDC 10.1 : interface entièrement en français) : remplace la page 404 anglaise par
 * défaut de Next.js. L'accueil redirige chacun vers sa page d'entrée (connexion, tableau de bord ou
 * véhicule du conducteur).
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      <p className="text-sm font-medium text-muted-foreground">Erreur 404</p>
      <h1 className="text-2xl font-semibold">Page introuvable</h1>
      <p className="text-sm text-muted-foreground">Cette adresse ne correspond à aucune page de l’application. Vérifiez le lien ou revenez à l’accueil.</p>
      <Link href="/" className="text-sm font-medium underline underline-offset-4">
        Retour à l’accueil
      </Link>
    </main>
  );
}
