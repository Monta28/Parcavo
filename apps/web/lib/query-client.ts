import { QueryClient } from '@tanstack/react-query';

/**
 * Client TanStack Query de l'application. Les mutations partent toujours sur le réseau (networkMode
 * « always ») : hors connexion, l'envoi échoue aussitôt avec l'erreur explicite « rien n'a été
 * enregistré » (CDC 10.3) au lieu d'être mis en pause puis rejoué automatiquement au retour du réseau,
 * ce qui reviendrait à une synchronisation hors ligne que la V1 exclut (CDC 1.3). Les lectures restent
 * en pause hors connexion (données affichées signalées comme possiblement anciennes).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: false },
      mutations: { networkMode: 'always', retry: false },
    },
  });
}
