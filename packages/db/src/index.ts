// Point d'entrée du package @parc-auto/db : client Prisma (adaptateur pg) et utilitaires.
export { DEFAULT_CONNECTION_TIMEOUT_MS, createPrismaClient, type ParcAutoPrismaClient, type PrismaClientOptions } from './client.js';
export * from './generated/prisma/client.js';
