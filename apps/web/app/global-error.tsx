'use client';

import './globals.css';
import { UnexpectedError } from '@/components/unexpected-error';

/**
 * Erreur de la mise en page racine : Next.js remplace alors tout le document, d'où les balises html et body
 * (lang="fr") ; message français au lieu de « Application error » (CDC 10.1).
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">
        <title>Erreur · Parc Auto</title>
        <UnexpectedError digest={error.digest} retry={retry} />
      </body>
    </html>
  );
}
