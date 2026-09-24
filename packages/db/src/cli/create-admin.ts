/**
 * Création sécurisée du premier administrateur (CDC 19.2) sur un environnement vierge.
 * Usage : DATABASE_URL=... pnpm --filter @parc-auto/db create-admin --org-code GROUPE --org-name "Mon groupe" --email admin@exemple.tn --first-name Prénom --last-name Nom
 * Le mot de passe est lu dans la variable ADMIN_PASSWORD ou demandé de manière interactive (jamais en argument de ligne de commande).
 * Refuse de s'exécuter si un administrateur existe déjà dans l'organisation ciblée.
 */
import { hash } from '@node-rs/argon2';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createPrismaClient } from '../client.js';

interface Args {
  orgCode: string;
  orgName: string;
  email: string;
  firstName: string;
  lastName: string;
  timezone: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback?: string): string => {
    const i = argv.indexOf(`--${name}`);
    const value = i >= 0 ? argv[i + 1] : undefined;
    if (value === undefined || value.startsWith('--')) {
      if (fallback !== undefined) return fallback;
      throw new Error(`Argument --${name} manquant.`);
    }
    return value;
  };
  return {
    orgCode: get('org-code'),
    orgName: get('org-name'),
    email: get('email').trim().toLowerCase(),
    firstName: get('first-name'),
    lastName: get('last-name'),
    timezone: get('timezone', 'Africa/Tunis'),
  };
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env['ADMIN_PASSWORD'];
  if (fromEnv) return fromEnv;
  if (!stdin.isTTY) throw new Error('Fournissez ADMIN_PASSWORD (aucun terminal interactif détecté).');
  const rl = createInterface({ input: stdin, output: stdout });
  const password = await rl.question('Mot de passe du premier administrateur : ');
  rl.close();
  return password;
}

function validatePassword(p: string): void {
  if (p.length < 12 || !/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/[0-9]/.test(p)) {
    throw new Error('Mot de passe refusé : 12 caractères minimum avec minuscules, majuscules et chiffres.');
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.email)) throw new Error('Adresse e-mail invalide.');
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL est obligatoire.');
  const password = await readPassword();
  validatePassword(password);
  const prisma = createPrismaClient({ databaseUrl, log: ['error'] });
  try {
    const result = await prisma.$transaction(async (tx) => {
      const org =
        (await tx.organization.findUnique({ where: { code: args.orgCode } })) ??
        (await tx.organization.create({ data: { code: args.orgCode, name: args.orgName, timezone: args.timezone } }));
      const existingAdmin = await tx.membership.findFirst({ where: { organizationId: org.id, companyId: null, role: 'ADMIN' } });
      if (existingAdmin) {
        throw new Error(`Un administrateur existe déjà pour l'organisation ${org.code} : utilisez l'interface d'administration.`);
      }
      const existingUser = await tx.user.findFirst({ where: { organizationId: org.id, email: args.email } });
      if (existingUser) throw new Error('Cette adresse e-mail est déjà utilisée dans l’organisation.');
      const passwordHash = await hash(password, { algorithm: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 });
      const user = await tx.user.create({
        data: {
          organizationId: org.id,
          email: args.email,
          firstName: args.firstName,
          lastName: args.lastName,
          passwordHash,
          memberships: { create: [{ companyId: null, role: 'ADMIN' }] },
        },
      });
      await tx.auditEvent.create({
        data: { organizationId: org.id, actorType: 'SYSTEME', action: 'cli.premier_administrateur', objectType: 'User', objectId: user.id, after: { email: user.email, organizationCode: org.code } },
      });
      return { orgCode: org.code, userId: user.id };
    });
    stdout.write(`Administrateur créé pour l'organisation ${result.orgCode} (utilisateur ${result.userId}).\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Erreur : ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
