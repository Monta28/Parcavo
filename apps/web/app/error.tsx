'use client';

import { UnexpectedError } from '@/components/unexpected-error';

/** Erreur d'une page sous la mise en page racine : message français au lieu de l'écran anglais par défaut de Next.js. */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <UnexpectedError digest={error.digest} retry={retry} />;
}
