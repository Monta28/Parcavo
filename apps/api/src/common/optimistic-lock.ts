import { ConflictError, ErrorCodes } from './errors.js';

/**
 * Verrou optimiste par version (CDC 13.1, 15.3) : le client envoie expectedVersion ; une
 * différence avec la version courante signifie qu'une modification concurrente a eu lieu.
 */
export function assertExpectedVersion(current: { version: number }, expectedVersion: number, objectLabel = 'objet'): void {
  if (current.version !== expectedVersion) {
    throw new ConflictError(
      ErrorCodes.VERSION_OBSOLETE,
      `L'${objectLabel} a été modifié entre-temps (version ${current.version}, attendue ${expectedVersion}). Rechargez puis réessayez.`,
      { currentVersion: current.version, expectedVersion },
    );
  }
}

/** Clause where { id, version } et incrément de version pour une mise à jour conditionnelle. */
export function versionedUpdate(id: string, expectedVersion: number): { where: { id: string; version: number }; bump: { version: { increment: number } } } {
  return { where: { id, version: expectedVersion }, bump: { version: { increment: 1 } } };
}
