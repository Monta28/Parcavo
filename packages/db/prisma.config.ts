import { defineConfig } from 'prisma/config';

// La variable DATABASE_URL est fournie par l'environnement (docker-compose, .env chargé par
// l'application). Aucune valeur par défaut contenant un secret n'est écrite ici.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
