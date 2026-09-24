import Link from 'next/link';

/**
 * Erreur inattendue d'affichage d'une page (CDC 10.1 : message en français). Le texte technique de l'erreur
 * n'est jamais montré ; seule la référence (digest) permet de retrouver la trace côté serveur.
 */
export function UnexpectedError({ digest, retry }: { digest?: string | undefined; retry: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      <div role="alert" className="flex flex-col items-center gap-3">
        <h1 className="text-2xl font-semibold">Une erreur est survenue</h1>
        <p className="text-sm text-muted-foreground">La page n’a pas pu être affichée. Réessayez ; si le problème persiste, transmettez la référence ci-dessous à l’administrateur.</p>
        {digest ? <p className="text-xs text-muted-foreground">Référence : {digest}</p> : null}
      </div>
      <div className="flex items-center gap-4">
        <button type="button" onClick={retry} className="text-sm font-medium underline underline-offset-4">
          Réessayer
        </button>
        <Link href="/" className="text-sm underline underline-offset-4">
          Retour à l’accueil
        </Link>
      </div>
    </main>
  );
}
