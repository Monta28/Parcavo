// Point d'entrée du package @parc-auto/db : client Prisma (adaptateur pg) et utilitaires.
export { createPrismaClient, type ParcAutoPrismaClient, type PrismaClientOptions } from './client.js';
export * from './generated/prisma/client.js';
