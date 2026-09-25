import { SUPPLIER_CATEGORY_LABELS } from '@parc-auto/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTBOX_DEFAULT_MAX_ATTEMPTS, OUTBOX_LOCK_MS, OUTBOX_RETRY_DELAYS_MINUTES } from './domain/outbox-retry.js';

/**
 * Documents du lot D confrontés au dépôt (CDC 8.1, 8.4, 9.4, 19.1, 19.2) : plan de réalisation, guide
 * utilisateur et procédure d'exploitation. Une mention retirée, un chemin cité absent ou une valeur
 * documentée qui ne correspond plus au code fait échouer le test.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const GUIDE = read('docs/guide-utilisateur.md');
const EXPLOITATION = read('docs/exploitation.md');
const SCREENS = 'apps/web/app/(app)';

describe('Documents du lot D fidèles au dépôt', () => {
  it('guide utilisateur (8.4) : le registre ne remplace pas la comptabilité ; la même mention figure à l’écran /depenses', () => {
    const mention = 'Le registre ne remplace pas la comptabilité et ne calcule aucune obligation fiscale';
    expect(GUIDE).toContain(mention);
    expect(read(`${SCREENS}/depenses/expense-summary.tsx`)).toContain(mention);
    // Aucune notion comptable ou fiscale n'est modélisée : ni TVA, ni écriture, ni déclaration.
    const schema = read('packages/db/prisma/schema.prisma');
    expect(schema).not.toMatch(/^model (Tax|Vat|Tva|Ledger|JournalEntry|AccountingEntry|Declaration)\b/m);
    expect(schema).not.toMatch(/\b(vatAmount|taxAmount|tvaRate|amountHt)\b/i);
  });

  it('guide utilisateur (8.1) : répertoire seulement — ni commandes, ni stock, ni comptes fournisseurs, dans le guide comme dans le code', () => {
    expect(GUIDE).toContain('Aucune gestion des commandes, du stock ni des comptes fournisseurs n\'est livrée en V1 : le module se limite au répertoire.');
    // Catégories du guide = liste fermée partagée par l'API et le web.
    expect(GUIDE).toContain(`catégorie (${Object.values(SUPPLIER_CATEGORY_LABELS).map((l) => l.toLowerCase()).join(', ')} — liste fermée)`);
    const schema = read('packages/db/prisma/schema.prisma');
    expect(schema).not.toMatch(/^model (PurchaseOrder|Order|SupplierOrder|Stock|StockMovement|Inventory|SupplierAccount|SupplierPayment|Payment)\b/m);
    // Routes du module : répertoire (liste, fiche, création, modification, archivage, réactivation, copie).
    const controller = read('apps/api/src/modules/suppliers/suppliers.controller.ts');
    const routes = [...controller.matchAll(/@(Get|Post|Patch|Put|Delete)\(([^)]*)\)/g)].map((m) => `${m[1]} ${m[2] || "''"}`).sort();
    expect(routes).toEqual(["Get ''", "Get ':id'", "Patch ':id'", "Post ''", "Post ':id/archive'", "Post ':id/copy'", "Post ':id/restore'"].sort());
  });

  it('exploitation (9.4) : double livraison exceptionnelle documentée ; délais, tentatives et verrou conformes au code', () => {
    const section = EXPLOITATION.slice(EXPLOITATION.indexOf('## Outbox e-mail'), EXPLOITATION.indexOf('## Contrôles utiles'));
    expect(section).toContain('**Double livraison exceptionnelle**');
    expect(section).toMatch(/le serveur SMTP a accepté un message et que le worker s'arrête avant d'enregistrer `ENVOYE`.*livré une seconde fois/);
    const distinct = [...new Set(OUTBOX_RETRY_DELAYS_MINUTES)];
    expect(section).toContain(`Reprises** : ${distinct.slice(0, -1).join(', ')} puis ${distinct.at(-1)} minutes entre les tentatives`);
    expect(section).toContain(`\`ABANDONNE\` après ${OUTBOX_DEFAULT_MAX_ATTEMPTS} tentatives`);
    expect(section).toContain(`verrou de ${OUTBOX_LOCK_MS / 60_000} min`);
    // Le guide renvoie à cette procédure.
    expect(GUIDE).toContain('Un e-mail peut exceptionnellement être reçu deux fois (voir docs/exploitation.md)');
  });
});
