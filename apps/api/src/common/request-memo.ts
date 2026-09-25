import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@parc-auto/db';

/**
 * Mémoïsation par requête HTTP (CDC 17.2) : une valeur de référence relue plusieurs fois pendant une même
 * requête (paramètre versionné, fuseau du groupe) n'est lue qu'une fois. La mémoire vit le temps de la
 * requête (RequestMemoInterceptor) et n'existe pas hors requête (worker, tâches différées) : chaque lecture
 * y reste directe. Toute écriture de ces valeurs invalide la mémoire de la requête qui l'opère (invalidate),
 * les autres requêtes ne la partagent jamais.
 */
const storage = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

export const RequestMemo = {
  /** Exécute `fn` avec une mémoire neuve, propre à cette requête. */
  run<T>(fn: () => T): T {
    return storage.run(new Map(), fn);
  },

  /** Valeur mémoïsée pour `key` dans la requête courante ; lecture directe hors requête. Un échec n'est pas retenu. */
  async get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const store = storage.getStore();
    if (!store) return load();
    const known = store.get(key) as Promise<T> | undefined;
    if (known) return known;
    const pending = load();
    store.set(key, pending);
    pending.catch(() => {
      if (store.get(key) === pending) store.delete(key);
    });
    return pending;
  },

  /** Oublie les valeurs dont la clé commence par `prefix` (écriture de ces valeurs dans la requête courante). */
  invalidate(prefix: string): void {
    const store = storage.getStore();
    if (!store) return;
    for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key);
  },
};

/** Clé des paramètres d'une organisation (préfixe d'invalidation). */
export function settingMemoPrefix(organizationId: string): string {
  return `parametre:${organizationId}:`;
}

/** Clé du fuseau d'une organisation (invalidée par la modification de l'organisation). */
export function timezoneMemoKey(organizationId: string): string {
  return `fuseau:${organizationId}`;
}

/** Fuseau horaire du groupe, lu une fois par requête HTTP (organisation inexistante : erreur de lecture). */
export function organizationTimezone(db: Pick<Prisma.TransactionClient, 'organization'>, organizationId: string): Promise<string> {
  return RequestMemo.get(timezoneMemoKey(organizationId), async () => (await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } })).timezone);
}
