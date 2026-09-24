# Décisions et ambiguïtés tranchées

Chaque entrée note l'ambiguïté du cahier des charges (CDC v1.1), l'option retenue et sa justification. Les décisions marquées **à confirmer** n'ont pas bloqué le développement mais méritent une validation client ; aucune n'est irréversible sans migration documentée.

## D-000 — Canal télématique (module F11)

- **Ambiguïté** : le contexte de réalisation laisse le canal du fournisseur GPS « à compléter » (API / RAPPORT / RPA / inconnu). L'annexe A n'a pas encore été qualifiée.
- **Décision** : canal traité comme **inconnu**. Livraison : interface `TelemetryProvider` unique, adaptateurs API **Traccar** (OpenAPI officiel 6.15.3) et **Wialon** (Remote API documentée sur help.wialon.com), canal **RAPPORT** générique (CSV/XLSX lus par IMAP ou SFTP avec mapping de colonnes paramétrable), **simulateur** de test non activable en production, canal **RPA** livré comme interface documentée et non activable. Aucun connecteur n'apparaît comme opérationnel avant activation et test de santé réussi.
- **Justification** : section 14.3 (ordre de préférence API > RAPPORT > RPA) et 21 (décision après qualification). Rien n'est inventé : seuls les endpoints présents dans la documentation officielle consultée sont appelés.

## D-001 — Socle et versions

- **Ambiguïté** : le CDC impose la pile mais pas les versions.
- **Décision** : Node.js 24.21.0 (LTS active), pnpm 10.34.5, TypeScript 5.9.3 (compatible simultanément avec Next 16, NestJS 12, Prisma 7 et typescript-eslint 8 ; TypeScript 6 est refusé par typescript-eslint ≥ 6.1 et non validé par Next), Next.js 16.3.6, React 19.2.8 (version épinglée par `create-next-app`), NestJS 12.1.0 en ESM, Prisma 7.10.0 avec adaptateur `pg`, PostgreSQL 16 (image `postgres:16-alpine` épinglée par digest), Vitest 4.1.11, Playwright 1.63.0, ESLint 9.39.5.
- **Justification** : versions stables publiées et vérifiées sur le registre npm le 24 septembre 2026 ; les versions 8.0.0-rc de Prisma et 5.0 de Vitest (publiées la veille) sont écartées car non éprouvées.

## D-002 — Identifiants UUID v7

- **Décision** : `uuid(7)` Prisma pour tous les identifiants métier (ordonnés dans le temps, index B-tree efficaces), UUID v4 aléatoires pour les jetons opaques (QR, clés de stockage).
- **Justification** : 13.1 impose des UUID ; v7 réduit la fragmentation des index sur 300 000 relevés et plus (17.2).

## D-003 — Contraintes non représentables dans Prisma

- **Décision** : les contraintes d'exclusion (réservations `[début, fin[` par véhicule et conducteur, responsable habituel), les `CHECK`, le trigger d'immuabilité de l'audit, les tables partitionnées et les fonctions de gestion des partitions vivent dans la migration SQL initiale (`packages/db/prisma/migrations/20260924120000_init/migration.sql`). Les index uniques partiels utilisent la fonctionnalité `partialIndexes` de Prisma (validée : aucune dérive détectée par `prisma migrate diff`).
- **Justification** : 13.3 exige des contraintes en base livrées par migration versionnée ; le contrôle `pnpm --filter @parc-auto/db migrate:diff` vide est exécuté en recette.

## D-004 — Unicité d'un job de traitement

- **Ambiguïté** : la déduplication des jobs « logiques » (T19) n'indique pas la clé.
- **Décision** : index unique partiel sur `Job.dedupeKey` tant que `finishedAt` est nul (un prédicat `status IN (...)` est réécrit par PostgreSQL et provoque une fausse dérive Prisma).

## D-005 — Sessions et CSRF

- **Décision** : jeton de session opaque (32 octets) en cookie `pa_session` HttpOnly/SameSite=Lax/Secure en production, seule l'empreinte SHA-256 est stockée ; jeton CSRF (cookie `pa_csrf` lisible par le script) lié à la session par empreinte et renvoyé dans `X-CSRF-Token` sur toute mutation ; contrôle d'origine (`Origin`/`Referer` = `APP_ORIGIN`). Durée 12 h (17.1), révocation immédiate à la désactivation du compte (T32).
- **Justification** : 16.1 (session serveur révocable, CSRF, aucun jeton en localStorage).

## D-006 — Limitation de débit

- **Décision** : deux niveaux : verrouillage persistant en base (`LoginAttempt` : 5 échecs par adresse e-mail ou 30 par IP sur 15 minutes → 429) et limitation en mémoire par IP (`@nestjs/throttler`, 300 requêtes/min globales, 10 connexions/min). La limitation en mémoire est propre à chaque instance d'API (une instance en V1) et peut être désactivée uniquement hors production pour les tests automatisés.

## D-007 — Mots de passe

- **Décision** : Argon2id (`@node-rs/argon2`, binaires précompilés, 64 Mio / 3 itérations), 12 caractères minimum avec minuscules, majuscules et chiffres. Les comptes créés sans mot de passe reçoivent une invitation (jeton 72 h) via l'outbox ; sans SMTP, l'administrateur peut définir un mot de passe initial.

## D-008 — Pièces jointes

- **Décision** : téléversement en zone temporaire (sans propriétaire), rattachement explicite par le module métier dans sa transaction, téléchargement après décision d'accès du propriétaire métier (`OwnerAuthorizationService`). Type réel contrôlé par signature (`file-type`) : PDF, JPEG, PNG uniquement ; 10 Mo ; clé de stockage aléatoire de 48 caractères hexadécimaux ; fichiers temporaires purgés après 24 h.

## D-009 — Comptes uniquement conducteurs

- **Ambiguïté** : périmètre exact d'un conducteur (2.3).
- **Décision** : un compte dont toutes les habilitations sont `CONDUCTEUR` est « conducteur seul » : accès refusé (403) aux listes de gestion, accès à sa propre fiche, au véhicule de son utilisation en cours ou dont il est responsable habituel, à ses propres relevés, tickets et incidents. Toute autre fiche renvoie 404.

## D-010 — Statut manuel et utilisation ouverte

- **Décision** : le passage en `HORS_SERVICE` reste possible pendant une utilisation (panne en mission) mais l'utilisation ouverte reste affichée et bloque l'archivage/cession ; archivage et cession exigent l'absence d'utilisation, d'immobilisation active, d'intervention non terminée et de réservation future confirmée (3.2, 2.4).

## D-011 — Sélecteur de société côté web

- **Décision** : la société courante est un simple filtre d'affichage mémorisé dans un cookie non sensible (`pa_company`) ; la vue « Toutes mes sociétés » est proposée aux administrateurs et aux utilisateurs habilités sur plusieurs sociétés. Le serveur recoupe toujours le filtre avec les habilitations (10.1, 2.3).

## D-012 — Consommation des paquets partagés

- **Décision** : `@parc-auto/db` et `@parc-auto/contracts` sont compilés vers `dist/` (tsc, ESM) et consommés ainsi par l'API, le worker, le web et les tests ; `pnpm install` déclenche `packages:build`. Motif : Node 24 charge les modules ESM avec extensions explicites et ne réécrit pas `.js` vers `.ts`.

## D-013 — Tests d'intégration

- **Décision** : base PostgreSQL de test réelle (`docker compose` service `postgres-test`, données en tmpfs), migrations appliquées par `prisma migrate deploy`, application complète démarrée en mémoire avec une horloge fixe contrôlable ; les tables sont vidées entre les tests. Les tests de concurrence envoient de vraies requêtes HTTP parallèles.

## D-014 — Rôles opérationnels

- **Ambiguïté** : le CDC liste des droits « principaux » sans matrice exhaustive.
- **Décision** : matrice appliquée côté serveur : création/modification des dossiers (véhicules, conducteurs, sites, services) par `OPERATEUR`, `CHEF_PARC` et `ADMIN` ; cycle de vie, désactivation de conducteur, dérogations, corrections et validations par `CHEF_PARC` et `ADMIN` (ou permission fine correspondante) ; sociétés, catégories, utilisateurs, transferts et fournisseurs télématiques par `ADMIN` seul ; `LECTEUR` en lecture, coûts et export sous permissions explicites. Les permissions fines par défaut par rôle sont dans `packages/contracts/src/index.ts`.

## D-015 — Écarts assumés entre l'analyse détaillée et l'implémentation du lot A

L'analyse systématique (section suivante, D-100 et au-delà) propose parfois une variante plus lourde que celle retenue. Les écarts suivants sont volontaires et documentés :

| Sujet | Analyse | Implémentation retenue | Motif |
| --- | --- | --- | --- |
| Responsable d'un site | `Site.responsibleUserId` (compte habilité) | `managerName` en texte libre | Le CDC (2.1) parle d'un responsable facultatif sans imposer un compte ; un responsable de site n'a pas forcément d'accès à l'application. |
| Longueur du code société | 2 à 12 caractères | 1 à 20 caractères `[A-Z0-9_-]`, immuable | Compatibilité avec des codes comptables existants ; l'immuabilité est respectée (aucun champ `code` dans la mise à jour). |
| Compte « conducteur » | Compte sans habilitation, lié à une fiche | Habilitation explicite `CONDUCTEUR` sur la société + fiche liée | Rend le périmètre société explicite dans `Membership` et réutilise le même mécanisme d'autorisation ; un compte peut cumuler `CONDUCTEUR` et un rôle de gestion. |
| Filtre `companyId` hors périmètre | 403 `PERIMETRE_INTERDIT` | 404 identique à un objet inexistant | Ne révèle jamais l'existence d'une société (15.1) ; vérifié par T01. |
| Préfixe de cookie `__Host-` | Recommandé | Cookie `pa_session` avec `Secure` en production | Le préfixe `__Host-` est rejeté par les navigateurs en HTTP local ; `Secure` + `HttpOnly` + `SameSite=Lax` + `Path=/` apportent la même protection derrière le reverse proxy HTTPS. |
| Rejeu idempotent d'une réponse 422 | Mémoriser 2xx et 422 | Mémoriser uniquement les succès | Une requête refusée en 422 rejouée à l'identique est refusée de nouveau par les mêmes règles ; libérer la clé permet de corriger le corps sans en changer. |
| Passage `HORS_SERVICE` pendant une utilisation | Refusé (409) | Autorisé, utilisation conservée et visible (D-010) | Une panne en mission doit pouvoir être enregistrée immédiatement ; le retour reste toujours possible et l'utilisation n'est jamais masquée. |
| Unicité d'immatriculation | Index partiel excluant les véhicules cédés/archivés | Unicité stricte par organisation | Lecture littérale de 3.1 ; un véhicule racheté est réactivé plutôt que recréé. L'équivalence « تونس » → « TU » est appliquée à la normalisation. |
| Jeton de réinitialisation | 30 minutes | 30 minutes (aligné) | — |
| Verrouillage par adresse IP | 20 échecs / 15 min | 20 échecs / 15 min (aligné) | — |
| Fichiers images | Réencodage JPEG côté client et suppression EXIF côté serveur | Suppression des métadonnées EXIF/XMP (JPEG) et des chunks textuels (PNG) côté serveur ; PDF avec contenu actif refusé ; PDF servi en `attachment` sous CSP `sandbox` | Même objectif de confidentialité sans dépendre du client. |
| Permis de conduire (D-133) | Extension d'une `DocumentVersion` de type PERMIS | Entité `DriverPermit` distincte (numéro, catégories, dates, justificatif), une seule par conducteur, modifiée par `PUT /drivers/:id/permit` | Une seule source de vérité est conservée (aucun doublon avec les documents) ; le contrôle des catégories au départ lit `DriverPermit`. Le versionnement des renouvellements de permis n'est pas conservé en V1 : l'audit garde l'avant/après de chaque modification. |
| Invitation sans SMTP (D-263) | Lien copié par l'administrateur | `POST /users/:id/access-link` : lien à usage unique (invitation 72 h, réinitialisation 30 min), affiché une fois, empreinte seule en base ; sans SMTP, aucune ligne d'outbox n'est créée et `/mot-de-passe-oublie` invite à contacter l'administrateur | Aligné sur D-263 et 16.1 ; aucun faux succès d'envoi. |

## D-016 — Écarts assumés et arbitrages entre décisions (lots B à F)

Plusieurs décisions de l'analyse détaillée se contredisent ou s'écartent du texte du CDC. Le CDC prime ; entre deux décisions, la plus spécifique au sujet est appliquée. Les arbitrages suivants sont volontaires :

| Sujet | Décisions en présence | Implémentation retenue | Motif |
| --- | --- | --- | --- |
| Initialisation du compteur | D-127 (initialisation explicite par chef et opérateur, 422 sans segment) / D-167 (segment automatique au premier relevé accepté, initialisation explicite par chef et administrateur) | D-167 : le premier relevé accepté du personnel crée le segment 1 (physique = cumulé) ; l'initialisation explicite (base cumulée différente, cumul incomplet) est réservée au chef et à l'administrateur | D-167 est la décision dédiée au premier segment ; elle ne fabrique aucune distance. |
| Justificatif d'un remplacement de compteur | D-166 (facultatif, signalé « sans justificatif ») | Obligatoire | Le CDC 5.4 décrit le segment « avec date, dernière distance cumulée validée, nouvelle valeur physique et justificatif ». |
| « Même instant » d'un relevé | D-149 | Fenêtre à la minute (MANUAL, IMPORT) ou à la seconde (TELEMATICS) ; un relevé identique encore EN_ATTENTE est aussi renvoyé sans doublon | Même opération = même compteur, source, contexte, valeur et instant, quel que soit l'état du premier relevé. |
| Réservation ou remise d'un véhicule non ACTIF | R-3.2-X01 (409) / première implémentation (422 RESERVATION_BLOQUEE, 422 DEPART_BLOQUE) | 409 VEHICULE_NON_ACTIF à la confirmation ou à la modification d'une réservation et à la remise (contrôle refait au départ, sous verrou) ; la restitution d'une utilisation ouverte reste toujours possible | CDC 15.1 : 409 pour un conflit d'état ; le cycle de vie HORS_SERVICE, CEDE ou ARCHIVE est l'état du véhicule qui interdit l'opération, comme VEHICULE_IMMOBILISE (409) à la réservation. Les autres blocages (conducteur, permis, documents) restent des règles métier en 422. |
| Modification d'une affectation habituelle | CDC 15.2 (« modifier ») / 4.1 et T08 (historique conservé) | PATCH /responsible-assignments/:id, motif et expectedVersion : affectation à venir entièrement modifiable ; en cours, seules la fin prévue (future ou aucune) et les notes ; terminée, non modifiable (409) ; un autre responsable passe par un remplacement explicite | Une période déjà écoulée n'est jamais réécrite ; terminer à une date passée reste l'action « terminer » avec son motif de fin. |
| Régularisation d'une distance non validée | CDC 4.4 (« distance non validée jusqu'à régularisation ») | POST /usages/:id/return-reading (exceptions.override) : relevé accepté, nouveau ou existant, observé entre le retour et la remise suivante du véhicule ; un relevé de retour en attente se traite dans la file de validation ; après un départ sans relevé, la distance reste indéterminée | Aucune distance n'est fabriquée : entre le retour et la remise suivante, le compteur n'a pas bougé. |
| Correction de la date d'un relevé rattaché | CDC 5.3 (bloquer ou exiger une régularisation) | La correction d'un relevé de remise, de restitution, de plein ou d'intervention ne change que sa valeur ; déplacer sa date est bloqué (422 CORRECTION_BLOQUEE, DATE_LIEE_A_UN_EVENEMENT) | La date appartient à l'événement ; la modifier rendrait la remise, le plein ou l'intervention incohérents. |
| Relevés d'un compteur remplacé | CDC 5.3 (bloquer ou exiger une régularisation), 5.4 (base = dernière distance cumulée validée) | La valeur du relevé qui a fixé la base cumulée du compteur suivant ne se corrige pas (422 CORRECTION_BLOQUEE, BASE_COMPTEUR_SUIVANT) ; la base du compteur suivant borne tout relevé rétroactif, validation ou correction de l'ancien compteur (CHRONOLOGIE_SUIVANT) | Pas de recalcul en cascade du compteur suivant (cumuls, entretiens, distances) : il fausserait des données déjà validées ; le cumul du véhicule reste croissant et recalculable. |
| Clé d'idempotence et transaction métier | D-286 | L'enregistrement de la clé vit hors de la transaction métier ; les doublons restent empêchés par les contraintes uniques et les verrous de version | Limite documentée : une panne entre la validation métier et l'écriture de la réponse libère la clé. |
| Compte mixte (gestionnaire dans A, conducteur dans B) | D-009 (comptes uniquement conducteurs seulement) | Une habilitation CONDUCTEUR ne donne aucun accès de gestion à sa société : listes, fiches, agrégats, rapports et exports ne portent que sur les sociétés où l'utilisateur a un rôle de gestion ou de lecture | CDC 2.3 : un conducteur ne voit que ses propres données ; un rôle de gestion ailleurs ne l'étend pas. |

<!-- AMBIGUITES:DEBUT -->

## Ambiguïtés relevées à l'analyse du CDC

Liste issue de l'analyse systématique du cahier des charges (huit lectures parallèles puis critique de complétude). Chaque entrée indique l'option retenue ; les entrées **irréversible** ou **contradiction-cdc** sont signalées au client avant toute mise en production des données concernées.

### D-100 — [1.1 / 5.6 (T31, T41)] Fournisseur injoignable ou « source GPS muette »

- **Ambiguïté** : T31 attend l'alerte « source GPS muette » quand le fournisseur est injoignable, alors que 5.6 la définit par unité, après 24 h sans donnée. Le CDC ne dit pas si ce délai part du dernier échantillon ou de la dernière synchronisation réussie, ni s'il faut une alerte au niveau du fournisseur.
- **Options** : Délai calculé par unité depuis le dernier échantillon ; état du fournisseur à part / Alerte immédiate dès l'échec d'une synchronisation / Alerte unique au niveau du fournisseur
- **Décision** : Source muette, pour chaque mapping actif : maintenant − lastSampleObservedAt (TelemetryUnitState) > silentSourceHours (24). Ce calcul ne dépend pas du succès des synchronisations : un fournisseur injoignable déclenche donc l'alerte pour chaque unité au bout de 24 h (T31, reproduit avec l'horloge contrôlable). Les échecs de synchronisation produisent un TelemetrySyncRun en échec et un indicateur d'état du fournisseur visible par le chef et l'administrateur, et non un nouveau type d'alerte métier. L'alerte se résout au premier échantillon reçu. Aucun parcours manuel ne dépend de l'état du fournisseur. Fichiers : apps/worker/src/jobs/telemetry-sync.job.ts, apps/worker/src/jobs/alert-catch-up.job.ts, apps/api/src/modules/telemetry/telemetry.service.ts, apps/api/test/integration/telemetry.int.spec.ts.
- **Justification** : Garde la définition de 5.6 et les 24 h de 17.1, satisfait T31 et T41, et ne crée aucun type d'alerte hors de la liste de 9.1.

### D-101 — [1.2 / 1.4 / 5.6 / 14.3] Activation puis désactivation de F11 pour une société

- **Ambiguïté** : telemetryEnabled s'active société par société, mais le CDC ne dit pas ce qu'une désactivation ou une réactivation fait aux mappings, aux relevés TELEMATICS déjà acceptés, aux alertes F11 ouvertes ni à la fraîcheur. L'expression « retombe dans le régime manuel » n'est pas définie en termes de fonctionnement.
- **Options** : Conserver les données, suspendre la synchro et résoudre les alertes F11 / Clore tous les mappings et rejeter les relevés TELEMATICS / Interdire la désactivation dès qu'un relevé a été ingéré
- **Décision** : À la désactivation : les jobs de synchro de la société s'arrêtent (le drapeau est relu au début de chaque exécution). Les mappings sont suspendus, pas clôturés, pour permettre une réactivation. Les relevés TELEMATICS historiques sont conservés et restent ACCEPTE : ils comptent toujours pour le compteur courant et la fraîcheur. Les alertes F11 actives (source muette, dérive, unité non mappée, carburant) sont résolues avec le motif « module désactivé ». Le « régime manuel » n'est pas un basculement : la fraîcheur se dégrade d'elle-même faute d'observation et l'interface retire le badge « source GPS ». À la réactivation, la synchro reprend depuis TelemetryUnitState ; l'historique n'est rechargé que sur demande de l'administrateur. Le changement est audité. Fichiers : apps/api/src/modules/settings/settings.service.ts, apps/api/src/modules/telemetry/telemetry.service.ts, apps/worker/src/jobs/telemetry-sync.job.ts, apps/api/test/integration/telemetry.int.spec.ts (T31).
- **Justification** : Principe de 1.1 : le connecteur accélère la collecte sans la conditionner. Les données validées ne sont pas détruites (13.3) et aucune dépendance externe n'existe sans activation (17.1).

### D-102 — [1.4 / 2.1 / 13.1] Organisation = groupe, une seule organisation en V1 — **irreversible**

- **Ambiguïté** : Le CDC emploie « groupe » (1.4, 9.3) et « Organisation » (2.1, 13.1) sans dire si ce sont la même chose. Il ne dit pas non plus comment une organisation est créée, puisqu'il n'existe pas de portail d'inscription. L'administrateur groupe agit « sur son organisation », mais le nombre d'organisations en V1 n'est pas fixé.
- **Options** : Organisation = groupe ; une seule organisation par déploiement, créée par la commande de bootstrap / Plusieurs organisations créées depuis l'interface par un super-administrateur / Pas d'entité Organisation, organisation_id constant
- **Décision** : Organisation = groupe. Une vraie table organizations ; organization_id NOT NULL sur toute table métier ; clés composites (organization_id, id) sur companies, vehicles et drivers pour interdire toute relation entre organisations. En V1, une seule organisation par déploiement, créée en même temps que le premier administrateur par la commande sécurisée de bootstrap ; aucune route de création d'organisation. L'administrateur groupe est une habilitation de niveau organisation (et non une ligne par société) : il couvre automatiquement les sociétés créées ensuite. Fichiers : packages/db/prisma/schema.prisma, apps/api/src/modules/organizations/organizations.service.ts, apps/api/src/modules/auth/auth.service.ts (bootstrap), docs/installation.md.
- **Justification** : Conforme à 1.4 (un identifiant d'organisation pour une extension future, sans SaaS multi-clients) et à 13.1 (organisation_id partout), sans construire une console multi-clients.

### D-103 — [2.1 / 3.1 / 3.3] Relation entre site et service — **irreversible**

- **Ambiguïté** : « Société > Site / service » ne dit pas si le service est un sous-niveau du site ou une dimension indépendante. Le type du « responsable facultatif » d'un site n'est pas précisé (utilisateur, conducteur ou texte libre).
- **Options** : Service rattaché à la société, indépendant du site / Service enfant d'un site / Une seule entité « unité » qui fusionne site et service
- **Décision** : Site et Service sont deux référentiels distincts rattachés à la société (company_id + organization_id), tous deux archivables. Vehicle et Driver portent site_id et service_id facultatifs ; une contrainte composite garantit qu'ils appartiennent à la même société. Site.responsible_user_id est facultatif et doit désigner un utilisateur habilité sur la société ; un champ contact libre facultatif s'y ajoute. L'adresse est un texte libre, sans coordonnées. Fichiers : packages/db/prisma/schema.prisma, apps/api/src/modules/organizations/organizations.service.ts, apps/api/src/modules/organizations/dto/create-site.dto.ts, apps/api/src/modules/organizations/dto/create-service.dto.ts, apps/web/app/(app)/administration/page.tsx.
- **Justification** : Un service (commercial, technique) couvre souvent plusieurs sites. En faire une dimension indépendante évite la duplication et permet de filtrer les rapports par site comme par service.

### D-104 — [2.1 / 12.2] Code société et archivage d'une société

- **Ambiguïté** : Le format du code unique d'une société n'est pas défini, ni s'il peut changer, alors que les imports s'appuient dessus (company_code). Le CDC ne décrit pas les effets de l'archivage sur les véhicules, conducteurs, habilitations et sélecteurs, et ne prévoit pas de réactivation.
- **Options** : Code immuable ; archivage refusé tant que la société a des objets actifs / Code modifiable ; archivage en cascade / Archivage libre, les objets restant actifs
- **Décision** : Code : 2 à 12 caractères [A-Z0-9_-], mis en majuscules, unique par organisation et immuable après création. L'archivage est réservé à l'administrateur. Il est refusé (409 COMPANY_HAS_ACTIVE_OBJECTS) tant que la société a des véhicules ACTIF ou HORS_SERVICE, des conducteurs actifs, ou des utilisations, réservations, immobilisations ou interventions ouvertes. Une société archivée passe en lecture seule (historique, rapports, exports) et disparaît des sélecteurs de création ; les habilitations restent valables en lecture. Réactivation par l'administrateur, motivée et auditée. Fichiers : apps/api/src/modules/organizations/organizations.service.ts, apps/api/src/modules/organizations/dto/*.ts, apps/api/test/integration/organizations.int.spec.ts.
- **Justification** : Les imports et exports reposent sur company_code. L'archivage ne doit pas laisser de véhicules ou de conducteurs actifs sans société exploitable (3.2 : archivage refusé avec des opérations ouvertes).

### D-105 — [2.2] Le chef « ne peut pas accorder de droits supérieurs » alors que seul l'administrateur gère les utilisateurs

- **Ambiguïté** : Deux phrases se contredisent en partie : la règle sur les droits accordés par le chef suppose qu'il peut en accorder, alors que « la gestion des utilisateurs reste à l'administrateur en V1 ».
- **Options** : Octroi réservé à l'administrateur, invariant codé pour plus tard / Délégation partielle au chef dès la V1 / Ignorer la règle sur le chef
- **Décision** : En V1, seul le détenteur de users.manage (l'administrateur) crée, invite et désactive les comptes et modifie memberships et permissions ; le chef n'a aucune route d'octroi. L'invariant est tout de même codé dans access-control : on ne peut accorder qu'une permission que l'on possède dans la même société, et dans le plafond du rôle cible. Il s'applique déjà à l'administrateur via les plafonds et sera prêt si la délégation est ouverte plus tard. Fichiers : apps/api/src/modules/users/users.service.ts, apps/api/src/modules/access-control/access-control.service.ts, apps/api/test/integration/access-control.int.spec.ts.
- **Justification** : Respecte les deux phrases sans ouvrir de délégation que la V1 exclut.

### D-106 — [2.2] Matrice des permissions par défaut et plafonds par rôle

- **Ambiguïté** : Les permissions fines sont listées sans correspondance rôle → défaut. Le CDC dit seulement que corrections et dérogations reviennent par défaut au chef et à l'administrateur, et que le lecteur n'accède aux coûts et à l'export que par permission explicite. Il ne dit pas si l'opérateur a costs.*, documents.manage, maintenance.complete ou readings.approve, ce qu'on peut ajouter à un lecteur sans casser la « lecture seule », ni si une permission peut retirer un droit du rôle.
- **Options** : Modèle additif avec défauts et plafonds par rôle / Permissions entièrement libres par utilisateur / Rôles figés, sans permissions additionnelles
- **Décision** : Modèle additif : les permissions s'ajoutent au rôle, elles n'en retirent jamais rien. Défauts : ADMIN_GROUPE = toutes les permissions ; CHEF_PARC = costs.read, costs.write, reports.export, readings.approve, readings.correct (y compris le remplacement de compteur), maintenance.complete, documents.manage, exceptions.override ; OPERATEUR = costs.read, costs.write, documents.manage ; LECTEUR et CONDUCTEUR = aucune. Plafonds de ce qu'on peut ajouter : OPERATEUR peut recevoir reports.export, readings.approve, maintenance.complete, readings.correct et exceptions.override ; LECTEUR seulement costs.read et reports.export ; CONDUCTEUR rien ; users.manage reste à l'administrateur en V1. Les actions de base sont fixées dans une table d'actions : création de fiches, remise, retour, réservations, affectations, immobilisations et localisations pour CHEF et OPERATEUR ; cycle de vie et archivage pour CHEF ; transfert pour ADMIN. La matrice est publiée et testée ligne par ligne. Fichiers : apps/api/src/modules/access-control/access-control.service.ts, packages/contracts (libellés FR), apps/api/test/integration/access-control.int.spec.ts, docs/permissions.md.
- **Justification** : Reprend les exclusions explicites de l'opérateur (gestion des droits, transfert, correction historique validée) et la lecture seule du lecteur. Approbations, corrections et dérogations restent au chef par défaut.

### D-107 — [2.2 / 2.3 / 3.3] Rôle Conducteur et fiche conducteur liée — **irreversible**

- **Ambiguïté** : Le rôle Conducteur porte sur « ses propres utilisations », mais le lien entre compte utilisateur et fiche Driver n'est pas défini : cardinalité, société, cumul avec un rôle chef ou opérateur qui conduit aussi. Le CDC ne dit pas non plus ce que devient l'accès quand la fiche change de société ou devient inactive.
- **Options** : Rôle CONDUCTEUR attribué comme un membership par société / Périmètre conducteur déduit du lien User.driver_id, cumulable avec un membership / Comptes distincts pour la gestion et la conduite
- **Décision** : User.driver_id est facultatif et unique : un compte correspond à au plus une fiche conducteur dans l'organisation. Le périmètre conducteur découle de ce lien et non d'un membership ; il s'applique dans la société courante de la fiche. Un compte peut cumuler un membership (par exemple chef en A) et ce périmètre conducteur. Le « rôle Conducteur » seul désigne un compte sans membership mais lié à une fiche. Fiche inactive : consultation de son propre historique uniquement, plus de nouvelle soumission. Si la fiche change de société, le périmètre suit automatiquement. Fichiers : packages/db/prisma/schema.prisma, apps/api/src/modules/access-control/access-control.service.ts, apps/api/src/modules/drivers/drivers.service.ts, apps/web/app/(app)/mon-vehicule/page.tsx.
- **Justification** : Un conducteur peut exister sans compte (2.3), et un chef qui conduit doit pouvoir utiliser /mon-vehicule. Une seule source de vérité : Driver.company_id.

### D-108 — [2.2 / 2.3 / 11.2] Masquage des coûts sans costs.read

- **Ambiguïté** : Pour un utilisateur sans costs.read, le CDC ne dit pas si les écrans carburant, intervention et tableau de bord disparaissent entièrement ou si seuls les montants sont masqués, ni comment l'API le représente.
- **Options** : Masquage champ par champ dans les DTO / Écrans entiers interdits / Montants masqués par le frontend seulement
- **Décision** : Masquage champ par champ côté API. Sans costs.read dans la société de l'objet, les DTO omettent montant, prix unitaire, lignes de coût, total, fournisseur facturant et justificatifs de dépense, et portent costMasked: true. /expenses et les rapports de coûts répondent 403 ; les KPI de coût ne sont pas renvoyés. Les données techniques (litres, km, dates, opérations réalisées) restent visibles. Les exports passent par le même mappeur de DTO. Fichiers : apps/api/src/modules/fuel/dto/*.ts, apps/api/src/modules/interventions/dto/*.ts, apps/api/src/modules/expenses/expenses.controller.ts, apps/api/src/modules/reports/reports.service.ts, apps/api/test/integration/access-control.int.spec.ts.
- **Justification** : Un filtre dans l'interface ne suffit pas (2.3), et un export ne doit pas montrer plus que l'écran (11.2).

### D-109 — [2.2 / 3.1 / 16.1] Accès au journal d'audit et à l'onglet Historique

- **Ambiguïté** : « Consolidation et audit » figure dans les droits de l'administrateur. Pour l'onglet Historique du dossier véhicule et pour /audit, le CDC ne dit pas ce que voient le chef, l'opérateur et le lecteur, alors que les valeurs avant/après peuvent contenir des données personnelles.
- **Options** : Chronologie métier filtrée pour tous ; audit brut pour l'administrateur et, limité à ses sociétés, pour le chef / Audit brut visible par tous les rôles de la société / Audit réservé à l'administrateur, pas d'onglet Historique
- **Décision** : L'onglet Historique est une chronologie métier tirée des événements (remises, relevés, transferts, entretiens, documents). Il suit les règles de visibilité habituelles et s'ouvre à tout rôle qui a accès au véhicule. /audit (AuditEvent brut, valeurs avant/après expurgées) : l'administrateur voit toute l'organisation, le chef lit uniquement les objets de ses sociétés ; opérateur, lecteur et conducteur n'y ont pas accès. Fichiers : apps/api/src/modules/audit/audit.service.ts, apps/api/src/modules/audit/audit.controller.ts, apps/api/src/modules/vehicles/vehicles.service.ts, apps/web/app/(app)/administration/page.tsx.
- **Justification** : Garde l'onglet Historique de 3.1 utile, tout en réservant les valeurs avant/après aux rôles de contrôle et en limitant l'exposition des données personnelles.

### D-110 — [2.2 / 5 / 6 / 7] Matrice des permissions par défaut pour les opérations des sections 5 à 7

- **Ambiguïté** : 2.2 cite les permissions fines sans les attribuer par défaut aux opérations. Le CDC ne dit pas si l'opérateur peut clôturer une intervention, gérer les documents ou immobiliser.
- **Options** : Tout réservé au chef / Opérateur pour les opérations courantes, chef pour les validations
- **Décision** : Attribution par défaut dans access-control, surchargeable, sans jamais dépasser les droits du chef :
- Relevés : saisie par l'administrateur, le chef et l'opérateur ; le conducteur saisit en attente.
- readings.approve et readings.correct (dont les segments) : administrateur et chef.
- Plans et modèles : administrateur et chef.
- Interventions : création, planification et démarrage par l'opérateur ; maintenance.complete à l'administrateur et au chef, attribuable à un opérateur ; réouverture par le chef.
- costs.write : administrateur et chef.
- documents.manage : administrateur et chef, attribuable à un opérateur.
- exceptions.override : administrateur et chef.
- Immobilisations : opérateur et au-delà.
- Télématique : l'administrateur configure ; le chef confirme les mappings et qualifie les anomalies.
- Lecteur : lecture seule, sans coûts sauf costs.read.
- **Justification** : Reste fidèle à 2.2 : l'opérateur fait les opérations courantes ; corrections et dérogations reviennent au chef et à l'administrateur.

### D-111 — [2.2 / 10.1 / 13.2] Rôle par société (Membership) et vue « Toutes mes sociétés » — **irreversible**

- **Ambiguïté** : Le tableau des rôles suggère un rôle unique par utilisateur, appliqué à ses « sociétés attribuées ». Or 13.2 prévoit des « rôles par société ». Un utilisateur peut-il être chef en A et lecteur en B ? Le CDC ne dit pas qui a droit à la vue « Toutes mes sociétés », ni comment la révocation prend effet.
- **Options** : Rôle global + liste de sociétés / Membership (utilisateur, société, rôle, permissions additionnelles) ; administrateur au niveau organisation / Plusieurs rôles cumulés par société
- **Décision** : Membership(user_id, company_id, role ∈ {CHEF_PARC, OPERATEUR, LECTEUR}, extra_permissions[]), unique par (utilisateur, société) : un seul rôle par société, des rôles différents possibles d'une société à l'autre. ADMIN_GROUPE est une habilitation de niveau organisation (OrganizationAdmin). Les droits s'évaluent société par société : droits(utilisateur, société) = défauts du rôle ∪ extra_permissions. « Toutes mes sociétés » s'affiche dès que l'utilisateur a au moins deux memberships. Chaque agrégat y reste filtré société par société selon la permission requise : par exemple, les coûts ne portent que sur les sociétés où il a costs.read. Les habilitations sont rechargées à chaque requête (pas de cache entre requêtes en V1), si bien qu'une révocation ou une désactivation s'applique tout de suite (T32). Fichiers : packages/db/prisma/schema.prisma, apps/api/src/modules/access-control/access-control.service.ts, apps/api/src/common/request-context.ts, apps/api/test/integration/access-control.int.spec.ts.
- **Justification** : Réconcilie le tableau 2.2 avec 13.2. Chaque agrégat applique les habilitations côté serveur (2.3).

### D-112 — [2.2 / 14.6 / 15.2] Permissions F11 par rôle

- **Ambiguïté** : Le CDC dit seulement que l'administrateur configure et que le chef consulte et confirme. Rien n'est dit de l'opérateur, du lecteur, de la synchro manuelle ni de la qualification des événements carburant.
- **Options** : Tout réserver à l'administrateur / Matrice détaillée par rôle
- **Décision** : Option 2 :
- Administrateur : tout.
- Chef : mappings de ses sociétés et choix de odometerKind, synchro manuelle, runs sans configuration, qualification carburant, arbitrage des relevés.
- Opérateur et lecteur : lecture de l'état.
- Conducteur : aucun accès.
Fichiers prévus : apps/api/src/modules/access-control/permissions.ts, apps/api/src/modules/telemetry/telemetry.controller.ts, apps/api/test/integration/telemetry-permissions.int.spec.ts.
- **Justification** : Déduit de 14.5, 14.6 et 8.5.

### D-113 — [2.2 / 15.2] Matrice des permissions fines par défaut

- **Ambiguïté** : Les valeurs par défaut des permissions fines par rôle ne sont pas explicitées. « Le chef ne peut pas accorder des droits supérieurs aux siens » semble contredire « la gestion des utilisateurs reste à l'administrateur ». On ignore aussi qui fait les remises et restitutions.
- **Options** : Chef avec users.manage borné / users.manage réservé à l'administrateur en V1
- **Décision** : Option 2 :
- Administrateur : toutes les permissions.
- Chef : toutes sauf users.manage.
- Opérateur : costs.read, costs.write, documents.manage, maintenance.complete.
- Lecteur : aucune par défaut, octroi explicite possible.
- Conducteur : aucune.
- Remise et restitution : opérateur, chef, administrateur.
- Exceptions : exceptions.override.
Fichiers prévus : apps/api/src/modules/access-control/role-defaults.ts, apps/api/src/modules/users/users.service.ts, apps/api/test/integration/permissions.int.spec.ts.
- **Justification** : Déduit des rôles de 2.2.

### D-114 — [2.3] Point unique d'application du cloisonnement

- **Ambiguïté** : Le CDC exige des contrôles « au point d'accès aux données » pour lectures, recherches, agrégats, exports, fichiers et traitements différés, sans choisir de mécanisme : guard NestJS, couche d'accès aux données ou RLS PostgreSQL. Il ne dit pas non plus comment un job du worker ou le cache Next.js porte le contexte.
- **Options** : Guards de contrôleur uniquement / Couche d'accès aux données alimentée par un AccessContext obligatoire / RLS PostgreSQL avec SET LOCAL par transaction
- **Décision** : Couche d'accès aux données. L'AccessContext (userId, organizationId, sociétés et permissions effectives, driverId) est construit par request-context à partir de la session, jamais à partir du corps de la requête. access-control fournit scopeWhere(ressource, action, ctx), que tous les services utilisent pour find, count, aggregate, search et export ; le companyId envoyé par le navigateur n'est qu'un filtre, croisé avec ce périmètre. Les jobs du worker stockent organizationId, companyId et requestedByUserId, et reconstruisent le contexte à l'exécution puis au téléchargement. Côté web, les appels API authentifiés sont en cache: 'no-store' : aucune donnée métier dans le cache partagé de Next.js. Pas de RLS en V1, documentée comme durcissement possible. Garde-fous : un test générique appelle chaque route avec un chef de A sur des identifiants de B (T01), et une règle lint interdit PrismaClient dans les contrôleurs. Fichiers : apps/api/src/common/request-context.ts, apps/api/src/modules/access-control/access-control.service.ts, apps/worker/src/jobs/report-export.job.ts, apps/api/test/integration/access-control.int.spec.ts.
- **Justification** : Suit [R1] (couche d'accès aux données). Les compteurs et recherches ne laissent rien fuir, car ils passent par le même filtre.

### D-115 — [2.3 / 3.3] Données personnelles des conducteurs selon le rôle

- **Ambiguïté** : Le CDC protège les données personnelles face aux conducteurs et après un transfert, mais ne dit pas ce que voient l'opérateur et le lecteur : téléphone, e-mail, numéro et scan du permis.
- **Options** : Classement des champs, masquage pour le lecteur / Tout visible dans la société / Données personnelles réservées au chef
- **Décision** : Classement des champs. IDENTITE (nom, prénom, code, société, service, statut) : visible par tout rôle de la société. CONTACT (téléphone, e-mail) et PERMIS (numéro, catégories, dates, justificatif) : visibles par ADMIN, CHEF et OPERATEUR de la société courante du conducteur. Le LECTEUR ne voit que l'état du permis (valide, à renouveler, expiré, manquant). Télécharger le justificatif du permis exige documents.manage, ou d'être le conducteur lui-même. Les exports appliquent le même classement. Fichiers : apps/api/src/modules/drivers/dto/driver-response.dto.ts, apps/api/src/modules/drivers/drivers.service.ts, apps/api/src/modules/files/files.service.ts.
- **Justification** : Minimisation (3.3) ; le lecteur reste en lecture seule sans accès aux pièces personnelles.

### D-116 — [2.3 / 7.3 / 10.3] Ce que voit un conducteur et délais de soumission

- **Ambiguïté** : « Les seules informations utiles à son utilisation en cours » n'est pas détaillé : documents du véhicule, dernier relevé, réservations à venir, nom du responsable habituel, historique des utilisations terminées. Le CDC ne dit pas non plus si un conducteur peut soumettre un ticket carburant ou un incident juste après la restitution.
- **Options** : Liste fermée de champs visibles, plus une fenêtre de soumission après retour / Accès à la fiche complète du véhicule en cours / Utilisation en cours uniquement, aucune soumission après retour
- **Décision** : Le conducteur voit : ses utilisations (en cours et terminées, avec relevés de départ et de retour et statut de distance), ses réservations futures (véhicule et créneau) et ses soumissions avec leur statut. Pour le véhicule de l'utilisation EN_COURS uniquement : code, immatriculation, marque et modèle, dernier relevé accepté (valeur et date), dernière localisation déclarée (sans auteur), et les documents véhicule dont le DocumentType est marqué visibleConducteur (par défaut carte grise et assurance). Il ne voit jamais le nom des autres conducteurs ni du responsable habituel, les coûts, les dépenses nées de ses tickets, les incidents des autres ou les plans d'entretien. Soumissions : un relevé uniquement sur l'utilisation EN_COURS. Un ticket ou un incident sur l'utilisation EN_COURS ou sur une utilisation terminée depuis moins de 72 h (paramètre driverLateSubmissionHours), à condition que la date de l'événement tombe dans l'utilisation. En V1, le conducteur ne crée ni réservation, ni remise, ni restitution. Fichiers : apps/api/src/modules/access-control/access-control.service.ts, apps/api/src/modules/usages/usages.service.ts, apps/api/src/modules/documents/documents.service.ts, apps/web/app/(app)/mon-vehicule/page.tsx, apps/api/test/integration/driver-scope.int.spec.ts (T03), tests/e2e/mobile-conducteur.spec.ts.
- **Justification** : Respecte 2.3 (ni les autres conducteurs, ni les factures, ni les justificatifs d'autrui) et les trois actions mobiles de 10.3. Un ticket oublié ou un dommage découvert juste après le retour reste déclarable.

### D-117 — [2.3 / 10.3 / 18 (T03)] Périmètre exact du conducteur

- **Ambiguïté** : « Les seules informations utiles à son utilisation en cours » n'est pas détaillé, pas plus que le droit de soumettre quelque chose sans utilisation ouverte.
- **Options** : Autoriser les soumissions sur le véhicule dont il est responsable habituel / Soumissions limitées au véhicule de l'utilisation EN_COURS
- **Décision** : Option 2. Le conducteur voit son utilisation en cours et son historique, un sous-ensemble du véhicule (immatriculation, modèle, dernier relevé validé, blocages) et ses propres soumissions. Il ne voit ni timeline ni anciens utilisateurs. Le QR code renvoie 404 s'il n'est pas habilité. Un compte sans fiche conducteur est refusé. Fichiers prévus : apps/api/src/modules/access-control/driver-scope.ts, apps/web/app/(app)/mon-vehicule/page.tsx, tests/e2e/mobile-conducteur.spec.ts.
- **Justification** : Conforme à 2.3 et à T03.

### D-118 — [2.3 / 15.1] 404 ou 403 selon le périmètre

- **Ambiguïté** : Le CDC prévoit 403 pour une action interdite et 404 pour un objet inaccessible. T01 et T03 attendent un « refus cohérent » qui ne révèle pas l'existence du dossier, mais la frontière n'est pas tracée : un lecteur qui modifie un véhicule qu'il voit, un conducteur qui ouvre la fiche d'un autre, un identifiant hors périmètre placé dans un corps de requête.
- **Options** : 404 hors du périmètre de lecture, 403 si l'objet est lisible mais l'action interdite / 403 partout / 404 partout
- **Décision** : Objet hors du périmètre de lecture : 404 NOT_FOUND, avec le même corps que pour un identifiant inexistant. Objet lisible mais action non permise : 403 FORBIDDEN_ACTION, avec la permission manquante. Listes et recherches : filtrage silencieux, total calculé sur le périmètre. Référence hors périmètre dans un corps de requête (vehicleId, driverId, siteId, supplierId) : 422 avec fieldErrors « référence invalide », identique au cas inexistant. Fichiers : apps/api/src/common/errors.ts, apps/api/src/modules/access-control/access-control.service.ts, apps/api/test/integration/access-control.int.spec.ts.
- **Justification** : Applique 15.1 (« ne pas révéler l'existence d'un dossier hors périmètre ») tout en gardant un 403 utile quand l'objet est lisible.

### D-119 — [2.4] Opérations qui bloquent un transfert — **contradiction-cdc**

- **Ambiguïté** : « Réservation future non traitée » et « intervention ouverte » ne sont pas définies : quels statuts, et quid d'une réservation dont le créneau a commencé sans conversion ? Les relevés EN_ATTENTE, les brouillons carburant et les incidents ouverts ne sont pas cités. Or, après le transfert, l'ancienne société n'a plus accès au véhicule pour les traiter.
- **Options** : Liste stricte du CDC uniquement / Liste du CDC plus les relevés en attente et les brouillons carburant / Annuler automatiquement les objets bloquants
- **Décision** : Bloquent le transfert (409 TRANSFER_BLOCKED, avec liste typée et liens) : une utilisation EN_COURS ; une immobilisation active ou planifiée non clôturée ; une intervention BROUILLON, PLANIFIEE ou EN_COURS ; une réservation CONFIRMEE dont la fin est postérieure à maintenant. S'y ajoutent les relevés EN_ATTENTE et les soumissions carburant non validées du véhicule, que l'assistant propose à l'administrateur d'approuver ou de rejeter. Les incidents ouverts ne bloquent pas : ils sont signalés et restent dans leur société historique. Rien n'est annulé automatiquement ; l'assistant propose des actions explicites (annuler avec motif, clore l'immobilisation). Fichiers : apps/api/src/modules/vehicles/vehicles.service.ts, apps/api/src/modules/vehicles/dto/transfer-vehicle.dto.ts, apps/api/test/integration/vehicle-transfer.int.spec.ts (T26).
- **Justification** : Après le transfert, la validation d'un relevé ou d'un plein par l'ancienne société deviendrait impossible, puisqu'elle ne voit plus le véhicule. Les traiter avant garde le bon rattachement historique.

### D-120 — [2.4] « Réexamen explicite » des affectations et des plans au transfert

- **Ambiguïté** : Le CDC exige que les affectations habituelles et les plans d'entretien soient « explicitement réexaminés », sans dire ce que ce réexamen produit. Il ne traite pas non plus le site et le service (qui appartiennent à l'ancienne société), les responsables de plan, le mapping télématique, les alertes actives, la date d'effet, ni la possibilité de changer la société par une simple modification de fiche.
- **Options** : Assistant qui exige une décision par objet, avec effet immédiat / Report automatique de tout vers la nouvelle société / Clôture automatique de tout
- **Décision** : Le transfert passe par POST /vehicles/:id/transfer, avec Idempotency-Key, et prend effet à l'heure du serveur (pas d'antidatage en V1). Il est transactionnel et verrouille la ligne du véhicule. company_id n'est jamais modifiable par PATCH. Le corps doit contenir une décision pour chaque objet listé par GET /vehicles/:id/transfer-preview, sinon 422. Affectation habituelle active : clôturée à transferAt, avec un nouveau responsable facultatif choisi dans la société cible. Chaque plan actif : KEEP (bases et échéances conservées, nouveau responsable de la société cible ou aucun) ou DEACTIVATE. Site et service : identifiants de la société cible ou null. Mapping télématique : conservé si le fournisseur couvre la société cible et que telemetryEnabled y est actif, sinon clôturé. Les alertes actives de l'ancienne société sont résolues (motif TRANSFERT) puis recalculées pour la nouvelle. VehicleCompanyHistory enregistre origine, destination, transferAt, auteur, motif et un instantané technique (compteur, segments, statuts des plans, documents partagés). Fichiers : apps/api/src/modules/vehicles/vehicles.service.ts, apps/api/src/modules/vehicles/dto/transfer-vehicle.dto.ts, packages/db/prisma/schema.prisma, apps/web/app/(app)/vehicules/[id]/page.tsx, apps/api/test/integration/vehicle-transfer.int.spec.ts.
- **Justification** : Transforme « réexaminer » en décisions enregistrées. Aucun objet de la société cible ne pointe vers un site, un service ou un utilisateur d'une autre société (13.1).

### D-121 — [2.4 / 5.1 / 11.3] Relevé de transfert et saisies rétroactives après transfert

- **Ambiguïté** : 11.3 réclame un « relevé de transfert » pour répartir les distances entre sociétés, mais le contexte TRANSFERT n'existe pas dans 5.1. Le CDC ne dit pas à quelle société rattacher un relevé pris à l'instant même du transfert, ni une saisie rétroactive (observedAt antérieur au transfert) faite par la nouvelle société.
- **Options** : Ajouter un contexte TRANSFERT ; la société d'un événement est fixée par sa date d'observation / Utiliser le contexte « relevé libre » / Rattacher toute saisie à la société courante
- **Décision** : Ajouter TRANSFERT à l'énumération des contextes de relevé. L'assistant propose, sans l'imposer, un relevé physique. Il est ingéré par le service unique juste avant la bascule, avec observedAt = transferAt et company_id = société d'origine, et borne les distances des deux sociétés. Sans ce relevé, la distance entre le dernier relevé de A et le premier de B est marquée « non ventilable ». Règle générale : un événement daté (relevé, plein, dépense, incident) appartient à la société propriétaire du véhicule à sa date, d'après VehicleCompanyHistory (intervalle [from, to[). Un utilisateur ne peut créer un tel événement que sur une période où il est habilité pour cette société, sinon 422 PERIOD_OUT_OF_SCOPE ; l'administrateur peut tout saisir. Fichiers : packages/db/prisma/schema.prisma (enum ReadingContext), apps/api/src/modules/odometer/odometer.service.ts, apps/api/src/modules/vehicles/vehicles.service.ts, apps/api/src/domain/odometer-rules.ts, apps/api/test/integration/vehicle-transfer.int.spec.ts.
- **Justification** : Rend applicables 11.3 (relevé de transfert, sinon « non ventilable ») et 2.4 (société historique), et empêche d'écrire dans l'historique d'une autre société.

### D-122 — [2.4 / 5 / 6 / 7] Visibilité des relevés, plans, interventions, documents, incidents et immobilisations après transfert — **irreversible**

- **Ambiguïté** : « Le destinataire voit l'état technique courant et les documents partagés, pas les anciens coûts ni les données personnelles. » Ce qui relève de l'« état technique » n'est pas précisé, objet par objet. Le sort des plans « réexaminés », des incidents ouverts (non bloquants selon 2.4) et du mapping télématique n'est pas tranché.
- **Options** : Masquer tout l'historique de la société A / Partage technique sélectif, objet par objet / Tout rendre visible sauf les montants
- **Décision** : Règle « objet technique partagé » implémentée dans apps/api/src/modules/access-control. Visible pour B :
- Relevés de A : valeurs, dates, source et nature ; auteur masqué (« Société d'origine ») et pièces jointes invisibles.
- Plans d'entretien : l'administrateur choisit pour chaque plan de le garder (companyId = B, responsable réaffecté) ou de le désactiver.
- Interventions de A : historique réduit (type, date, km, opérations), sans montant, lignes, fournisseur ni pièces jointes.
- Documents : les versions sélectionnées dans sharedWithCompanyIds, avec présélection des versions valides ou futures.
- Incidents et immobilisations de A : non visibles, sauf un indicateur « incident ouvert dans la société d'origine ». Un incident ouvert donne un avertissement au transfert, pas un blocage.
- Mapping F11 : clôturé à la date du transfert, rouvert pour B si F11 est actif chez B.

L'administrateur voit tout.
- **Justification** : Donne à B ce qu'il faut pour les contrôles de chronologie, les échéances et le statut documentaire, sans exposer les coûts ni les personnes. C'est le modèle de portée des requêtes.

### D-123 — [2.4 / 11.3 / 13.1] Ce que voit la société destinataire après un transfert — **irreversible**

- **Ambiguïté** : « État technique courant » et « documents véhicule partagés lors du transfert » ne sont pas détaillés. Le CDC ne dit pas si la destinataire voit l'historique des relevés, les entretiens passés sans leur coût, les anciennes utilisations, les incidents ou les pleins, ni comment calculer consommation et distances qui enjambent la date du transfert.
- **Options** : Liste fermée de données techniques partagées, documents cochés un par un / Tout l'historique du véhicule visible / Rien avant la date du transfert
- **Décision** : Chaque donnée d'événement porte son company_id historique. Pour les périodes antérieures au transfert, un utilisateur de la société cible voit seulement : la fiche véhicule et ses photos ; les segments de compteur et l'historique des relevés (valeur, date, source, statut), l'auteur étant remplacé par « Société précédente » ; les interventions terminées réduites à date, km, type et opérations réalisées (sans lignes de coût, fournisseur, pièces jointes ni diagnostic) ; la dernière localisation déclarée, sans auteur ; les versions de documents véhicule cochées dans l'assistant. Par défaut sont cochées les versions courantes et futures des types véhicule (carte grise, assurance, visite technique), jamais les documents conducteur ; la table DocumentShare(documentVersionId, companyId, sharedAt, sharedBy) les enregistre. Restent invisibles : utilisations, réservations, incidents, pleins, dépenses, alertes et commentaires. Consommation et coût/km sur une période qui traverse le transfert : N/D (« période traversant un transfert ») pour un utilisateur de société ; l'administrateur voit tout. Fichiers : packages/db/prisma/schema.prisma, apps/api/src/modules/access-control/access-control.service.ts, apps/api/src/modules/vehicles/vehicles.service.ts, apps/api/src/modules/documents/documents.service.ts, apps/api/src/domain/consumption.ts, apps/api/test/integration/vehicle-transfer.int.spec.ts.
- **Justification** : Applique 2.4 : état technique courant et documents partagés, mais ni les anciens coûts ni les données personnelles. 11.3 interdit d'attribuer au propriétaire courant ce qui revient à l'ancien.

### D-124 — [2.4 / 11.3 / 14.5 / 18 (T26)] Transfert d'un véhicule équipé : mapping et relevé de transfert

- **Ambiguïté** : La liste des éléments « réexaminés » lors d'un transfert (2.4) omet le mapping télématique. La société destinataire peut ne pas être couverte ou avoir F11 désactivé. Le relevé de transfert exigé par 11.3 n'apparaît pas dans la route transfer.
- **Options** : Conserver le mapping tel quel / Clore le mapping, en reproposer un dans la destination, et demander un relevé de transfert
- **Décision** : Option 2. Le transfert clôt le mapping à sa date. Si la société destinataire est couverte et activée, une proposition PROPOSE y est créée, à confirmer par son chef. Le formulaire de transfert demande un relevé (contexte TRANSFERT) ; sans relevé, un motif est obligatoire et les distances de la période sont marquées « non ventilables ». Les relevés conservent la companyId en vigueur au moment de l'observation. Fichiers prévus : apps/api/src/modules/vehicles/vehicle-transfer.service.ts, apps/api/src/modules/vehicles/dto/transfer-vehicle.dto.ts, apps/api/src/modules/telemetry/telemetry.service.ts, apps/api/test/integration/transfer.int.spec.ts.
- **Justification** : Même logique que pour les affectations et les plans. Cela répond aussi à 11.3 sur la ventilation des distances.

### D-125 — [2.4 / 18 (T26, T01)] Visibilité des données et opérations bloquantes après transfert

- **Ambiguïté** : Plusieurs notions ne sont pas définies : « état technique courant », « documents véhicule partagés lors du transfert », « réservation future non traitée ». On ignore si l'historique des relevés, entretiens, incidents et utilisations de l'ancienne société reste visible pour la destination, et ce que voit ensuite l'ancienne société.
- **Options** : Tout l'historique visible par la destination / Un instantané technique, des documents choisis, et des événements filtrés par leur société historique
- **Décision** : Option 2.
- Transfert refusé tant qu'existe : une utilisation EN_COURS, une immobilisation active, une intervention BROUILLON, PLANIFIEE ou EN_COURS, ou une réservation CONFIRMEE dont endAt est postérieur à maintenant.
- Les incidents ouverts et les soumissions en attente sont affichés comme avertissements à acquitter.
- Un instantané est figé (VehicleCompanyHistory) : compteur et segment courants, bases et prochaines échéances des plans (date et km, sans coût ni fournisseur), statut documentaire.
- L'administrateur coche les versions de documents partagées ; par défaut, les versions valides à la date sont présélectionnées.
- La destination voit la fiche, l'instantané, les documents partagés et tout ce qui est créé après le transfert.
- Les événements restent filtrés par leur companyId historique. L'ancienne société garde la lecture de ses propres événements, avec le libellé du véhicule, mais n'a plus accès à la fiche courante.
- Les contrôles de chronologie côté serveur utilisent tout l'historique.
Fichiers prévus : apps/api/src/modules/vehicles/vehicle-transfer.service.ts, apps/api/src/modules/access-control/scope.service.ts, packages/db/prisma/schema.prisma, apps/api/test/integration/transfer.int.spec.ts.
- **Justification** : Cette règle applique littéralement 2.4 (pas d'anciens coûts ni de données personnelles hors habilitations) sans casser l'intégrité des contrôles.

### D-126 — [3.1 / 3.3 / 7.2] Catégorie de véhicule et catégories de permis exigées

- **Ambiguïté** : La catégorie de véhicule est obligatoire mais sans type défini (texte libre ou référentiel). Les « catégories de permis exigées », paramétrées par l'organisation, ne sont rattachées à rien, et le CDC ne dit pas si leur absence bloque la remise ou ne fait qu'avertir.
- **Options** : Référentiel de catégories portant les permis requis / Texte libre sans contrôle / Permis requis saisi véhicule par véhicule
- **Décision** : Référentiel VehicleCategory par organisation : code, libellé, requiredPermitCategories[] facultatif (par exemple VL → B). À la confirmation d'une réservation et à la remise : si la catégorie exige des permis, le conducteur doit avoir, à la date de départ, une version valide du document PERMIS couvrant l'une de ces catégories. Sinon, refus 422 DRIVER_PERMIT_MISSING quand le type PERMIS est paramétré bloquant, simple avertissement dans le cas contraire. Dérogation possible avec exceptions.override, motivée et auditée. Aucune règle juridique codée en dur. Fichiers : packages/db/prisma/schema.prisma, apps/api/src/modules/settings/settings.service.ts, apps/api/src/modules/usages/usages.service.ts, apps/api/src/modules/reservations/reservations.service.ts, apps/api/src/domain/document-status.ts.
- **Justification** : Paramétrage par l'organisation, sans règle juridique inventée (3.3). Le caractère bloquant vient du type de document (7.1, 7.2).

### D-127 — [3.1 / 5.4 / 12.2] Initialisation du compteur d'un véhicule sans historique

- **Ambiguïté** : Le kilométrage inconnu vaut NULL, mais le CDC ne dit pas quand le premier OdometerSegment est créé (à la création de la fiche, au premier relevé ou à la première remise), qui peut l'initialiser, ni comment distinguer « cumul = compteur » d'un cumul inconnu.
- **Options** : Initialisation explicite, proposable pendant la remise / Création automatique à la première saisie / Compteur obligatoire à la création de la fiche
- **Décision** : Créer une fiche ne crée ni segment ni relevé : compteur courant NULL, fraîcheur INCONNU. POST /vehicles/:id/odometer-segments {mode: INITIAL}, ouvert au chef et à l'opérateur ainsi qu'à l'import des relevés initiaux, crée le premier segment avec physicalStart, startedAt et cumulativeStart. Si « compteur d'origine » est coché, cumulativeStart = physicalStart. Sinon, l'utilisateur saisit une base cumulée validée ou laisse cumulIncomplet = true, et les échéances en km affichent « cumul incomplet ». Tout relevé ou remise sur un véhicule sans segment reçoit 422 ODOMETER_NOT_INITIALIZED ; le formulaire de remise propose alors d'initialiser dans la même transaction, avec les mêmes règles. Jamais d'initialisation implicite à 0. Fichiers : apps/api/src/modules/odometer/odometer.service.ts, apps/api/src/modules/odometer/dto/init-segment.dto.ts, apps/api/src/domain/odometer-rules.ts, apps/api/src/modules/usages/usages.service.ts, apps/api/test/integration/odometer.int.spec.ts.
- **Justification** : Respecte « aucun compteur implicite », « ne pas fabriquer une distance » (5.4) et « base clairement spécifiée » (12.2) sans bloquer la première remise.

### D-128 — [3.1 / 12.2 / 14.5] Normalisation de l'immatriculation, identifiant provisoire, VIN et portée de l'unicité — **irreversible**

- **Ambiguïté** : Seuls les espaces et la casse sont cités. Tirets, points et graphie arabe ou latine (« تونس » ou « TU ») ne sont pas traités. Le CDC ne dit pas si l'unicité vaut aussi pour les véhicules cédés ou archivés (réimmatriculation, identifiant provisoire réutilisé) ni quelles règles s'appliquent au VIN.
- **Options** : Normalisation étendue avec table d'équivalences ; unicité sur les véhicules en service / Espaces et casse seulement ; unicité sur tous les véhicules / Pas d'unicité, simple avertissement
- **Décision** : normalizeRegistration applique NFKC, passe en majuscules et retire espaces, tirets, points et barres obliques. Une table d'équivalences configurable par organisation (pré-remplie avec « تونس » → « TU ») s'applique avant la comparaison. La valeur saisie reste affichée telle quelle. registration_kind ∈ {DEFINITIVE, PROVISOIRE, ETRANGERE}. L'unicité (organization_id, registration_normalized) passe par un index unique partiel sur les véhicules ni CEDE ni ARCHIVE ; si la valeur existe sur un dossier cédé ou archivé, simple avertissement. Le code interne est unique sur tous les véhicules, archivés compris, et jamais réutilisé. VIN : majuscules sans espaces, unique par organisation quand il est renseigné ; avertissement si sa longueur n'est pas 17 ou s'il contient I, O ou Q. Imports et rapprochement télématique utilisent la même fonction. Fichiers : apps/api/src/modules/vehicles/vehicles.service.ts (normalizeRegistration exportée), apps/api/src/modules/imports/imports.service.ts, apps/api/src/modules/telemetry/telemetry.service.ts, packages/db/prisma/migrations/*_vehicle_unique_indexes/migration.sql, apps/api/test/integration/vehicles.int.spec.ts.
- **Justification** : Détecte les doublons sans détruire la valeur affichée et reste compatible avec les plaques non tunisiennes et provisoires (3.1). Une seule fonction garantit que import et mapping (14.5) trouvent les mêmes correspondances.

### D-129 — [3.2] Transitions du cycle de vie et suppression

- **Ambiguïté** : ACTIF, HORS_SERVICE, CEDE et ARCHIVE sont listés sans transitions ni rôles. Le CDC ne dit pas si l'on peut passer HORS_SERVICE pendant une utilisation (« ne doit pas masquer »), ni si un dossier sans historique peut être supprimé. Les « opérations ouvertes » qui bloquent archivage et cession ne sont pas énumérées.
- **Options** : Graphe de transitions explicite, sortie d'ACTIF refusée pendant une utilisation / Transitions libres, avec affichage des deux statuts / Cycle de vie modifiable seulement par l'administrateur
- **Décision** : Transitions autorisées : ACTIF ↔ HORS_SERVICE ; ACTIF ou HORS_SERVICE → CEDE (date et motif) ; ACTIF, HORS_SERVICE ou CEDE → ARCHIVE ; ARCHIVE → ACTIF par l'administrateur seul, avec motif ; CEDE est définitif, sauf correction auditée par l'administrateur. Rôles : CHEF et ADMIN. Toute sortie d'ACTIF est refusée (409) pendant une utilisation EN_COURS : on enregistre d'abord le retour, qui est toujours possible. CEDE et ARCHIVE sont refusés tant qu'existe un blocage de transfert ; pour ARCHIVE, un incident OUVERT ou EN_TRAITEMENT bloque aussi. Au passage en CEDE ou ARCHIVE : plans désactivés, affectation habituelle et mapping télématique clôturés, alertes résolues (« véhicule sorti du parc »). HORS_SERVICE bloque confirmations et départs, et signale les réservations futures comme compromises. Suppression physique (administrateur, auditée) seulement si aucun relevé, événement, pièce jointe ou réservation n'est lié ; sinon, archivage. La fin de contrat de location portée par la fiche est informative : l'alerte d'échéance vient d'un document « contrat de location » avec expiration. Fichiers : apps/api/src/modules/vehicles/vehicles.service.ts, apps/api/src/modules/vehicles/dto/change-lifecycle.dto.ts, apps/api/src/domain/vehicle-status.ts, apps/api/test/integration/vehicles.int.spec.ts.
- **Justification** : Un statut saisi à la main ne masque jamais une utilisation ouverte, et archivage ou cession restent refusés tant que des opérations sont en cours (3.2). Aucune alerte n'est inventée pour la fin de contrat.

### D-130 — [3.2 / 4.4 / 11.1 / 14.2] Calcul du statut opérationnel et non-conformité documentaire

- **Ambiguïté** : 4.4 dit que le véhicule redevient disponible « seulement si aucun autre blocage n'existe ». Or 3.2 fait de la non-conformité documentaire un indicateur distinct et 11.1 exige des groupes exclusifs. Le CDC ne dit pas si le statut est calculé à la lecture ou stocké (un calcul en SQL plus un en TS créerait une double implémentation, contraire à 14.2), ni comment une immobilisation planifiée devient active.
- **Options** : Statut stocké, recalculé par une seule fonction TS dans la transaction et par le job de rattrapage / Calcul SQL à chaque lecture / Calcul TS à chaque lecture, sans filtre SQL
- **Décision** : vehicle-status.ts est la seule règle. Pour un véhicule ACTIF : IMMOBILISE si une immobilisation a commencé (start ≤ maintenant) sans fin réelle ; sinon EN_UTILISATION si une utilisation est EN_COURS ; sinon DISPONIBLE. Hors ACTIF, pas de statut opérationnel : on affiche le cycle de vie. Un indicateur séparé departureBlocked, avec ses raisons (document bloquant, permis, HORS_SERVICE), s'y ajoute : un véhicule non conforme reste compté « disponible », avec le badge « départ bloqué », et figure dans l'indicateur « documents expirés ». Le statut est stocké (operational_status, departure_blocked). Le même code le recalcule dans la transaction de chaque mutation concernée, et alert-catch-up le recalcule toutes les 15 min pour les bascules liées au temps (début d'immobilisation planifiée, expiration de document). Aucune requête SQL ne réécrit la règle. Fichiers : apps/api/src/domain/vehicle-status.ts, apps/api/src/domain/vehicle-status.spec.ts, apps/api/src/modules/vehicles/vehicles.service.ts, apps/worker/src/jobs/alert-catch-up.job.ts, packages/db/prisma/schema.prisma.
- **Justification** : Garde les groupes exclusifs de 11.1 et l'indicateur distinct de 3.2. Une valeur stockée reste recalculable (13.3) et la règle n'existe qu'à un endroit (14.2).

### D-131 — [3.3] Désactivation d'un conducteur qui a des opérations ouvertes

- **Ambiguïté** : « Ses utilisations ouvertes doivent être traitées explicitement » : faut-il refuser la désactivation, ou l'accepter en laissant l'utilisation ouverte ? Réservations futures, affectation habituelle et compte de connexion lié ne sont pas évoqués.
- **Options** : Refus avec utilisation ouverte ; annulation explicite des réservations dans la même requête / Désactivation acceptée, utilisation laissée ouverte avec un drapeau / Tout clôturer automatiquement
- **Décision** : Désactivation refusée (409 DRIVER_HAS_OPEN_USAGE) tant qu'une utilisation est EN_COURS : il faut enregistrer le retour, toujours possible, y compris sous forme de constat par le chef. Pour les réservations CONFIRMEE futures, la requête doit contenir cancelFutureReservations=true et un motif ; elles sont alors annulées dans la même transaction, avec trace. Sinon, 409 avec leur liste. L'affectation habituelle active est clôturée à la date de désactivation. Le compte lié n'est pas désactivé automatiquement (c'est une action distincte de l'administrateur), mais il ne peut plus rien soumettre. Réactivation possible par le chef ou l'administrateur ; les réservations annulées ne sont pas restaurées. Fichiers : apps/api/src/modules/drivers/drivers.service.ts, apps/api/src/modules/drivers/dto/deactivate-driver.dto.ts, apps/api/test/integration/drivers.int.spec.ts.
- **Justification** : « Traitement explicite » plutôt qu'une clôture automatique (4.5 : un retard ne clôture rien automatiquement).

### D-132 — [3.3 / 2.4 / 12.2] Unicité du code conducteur et changement de société d'un conducteur — **irreversible**

- **Ambiguïté** : Le CDC ne dit pas si l'identifiant interne du conducteur est unique par société ou par organisation. Il parle de la « société courante » du conducteur sans décrire son changement : droits, historique, réservations et affectations en cours, visibilité pour l'ancienne société.
- **Options** : Code unique par organisation, changement de société réservé à l'administrateur / Code unique par société ; changement = nouvelle fiche / Pas de changement de société
- **Décision** : driver_code est unique par organisation, puisque le conducteur peut changer de société. Un numéro de permis déjà présent sur une autre fiche déclenche un avertissement. Le changement de société est réservé à l'administrateur et refusé tant qu'existe une utilisation EN_COURS ou une réservation CONFIRMEE future ; l'affectation habituelle active est clôturée à la date d'effet. L'historique est tracé dans DriverCompanyHistory (from, to, date, auteur, motif). Les événements passés gardent leur company_id. L'ancienne société continue de voir le nom du conducteur sur ses propres événements, mais sa fiche lui renvoie désormais 404. Fichiers : packages/db/prisma/schema.prisma, apps/api/src/modules/drivers/drivers.service.ts, apps/api/src/modules/drivers/dto/change-driver-company.dto.ts, apps/api/test/integration/drivers.int.spec.ts.
- **Justification** : Donne un sens à « sa société courante » (2.4) tout en conservant la société historique des événements.

### D-133 — [3.3 / 7.1 / 13.2] Permis : DriverPermit ou version de document — **irreversible**

- **Ambiguïté** : Le permis apparaît à la fois comme données de la fiche (numéro, catégories, dates, justificatif), comme type de document versionné (7.1 : « permis ») et comme entité DriverPermit (13.2). Cela crée deux sources de vérité possibles pour l'expiration et le blocage.
- **Options** : Le permis est une DocumentVersion de type PERMIS, avec des catégories rattachées / Entité DriverPermit indépendante, plus un document justificatif / Champs directement sur Driver
- **Décision** : Une seule source de vérité. DriverPermit est une extension d'une DocumentVersion de type PERMIS (objet conducteur) : la version porte le numéro, la date de délivrance, la validité et le fichier. DriverPermitCategory(documentVersionId, catégorie, obtainedAt, expiresAt nullable) porte les catégories. Un renouvellement crée une nouvelle version, selon les règles de 7.1 : on retient la version valable à une date donnée, et une version future ne remplace pas la version en cours. Statut et caractère bloquant sont calculés par document-status.ts. Fichiers : packages/db/prisma/schema.prisma, apps/api/src/modules/drivers/drivers.service.ts, apps/api/src/modules/documents/documents.service.ts, apps/api/src/domain/document-status.ts.
- **Justification** : Évite deux calculs d'expiration divergents et réutilise le versionnement et les préavis de 7.1.

### D-134 — [3.4] Règles de la localisation déclarative

- **Ambiguïté** : Le CDC ne précise pas : si « site ou lieu libre » est exclusif ou cumulable ; si « dernière » se juge sur la date d'observation ou de saisie ; qui peut déclarer (le conducteur ?) ; si la déclaration à la remise, à la restitution ou à l'entrée au garage est automatique (« peut produire ») ; si le site peut appartenir à une autre société.
- **Options** : Site ou texte exclusif, tri par date d'observation, création automatique aux remises et retours / Saisie libre, tri par date de saisie / Déclaration uniquement manuelle
- **Décision** : Soit un siteId (site actif de la société propriétaire à la date d'observation), soit un texte libre de 200 caractères au plus, exclusivement ; commentaire facultatif. observedAt n'est pas dans le futur (à la tolérance d'horloge près). « Dernière localisation déclarée » = observedAt le plus récent, puis createdAt, et jamais simplement la dernière saisie. Peuvent déclarer : chef, opérateur, administrateur ; pas le conducteur en V1. Le lieu est obligatoire à la remise et à la restitution : un VehicleLocationReport (contexte REMISE ou RESTITUTION, observedAt = checkedOutAt ou returnedAt) est créé dans la même transaction. Le début d'une immobilisation avec garage ou site crée un report de contexte GARAGE. Libellé toujours « Dernière localisation déclarée — <lieu>, le <date>, par <auteur> », jamais « position actuelle ». Fichiers : apps/api/src/modules/vehicles/vehicles.service.ts, apps/api/src/modules/vehicles/dto/create-location-report.dto.ts, apps/api/src/modules/usages/usages.service.ts, apps/web/app/(app)/vehicules/[id]/page.tsx.
- **Justification** : Reprend la logique de date d'observation du compteur (5.3) et interdit tout faux temps réel (3.4, 1.3).

### D-135 — [4.1 / 4.3 / 4.5] Véhicule de fonction utilisé en continu et prolongation du retour prévu

- **Ambiguïté** : Un responsable habituel qui conduit chaque jour doit-il faire une remise quotidienne ? Le retour prévu est obligatoire à la remise, mais aucune opération de prolongation n'existe, et /usages interdit la clôture par PATCH de statut.
- **Options** : Utilisation longue durée plus action de prolongation motivée / Retour prévu facultatif pour le responsable habituel / Remise quotidienne obligatoire
- **Décision** : Pas de remise quotidienne : la détention continue est une utilisation EN_COURS de longue durée. expectedReturnAt reste obligatoire ; l'interface propose la fin de l'affectation habituelle ou une date choisie. Nouvelle action POST /usages/:id/extend {expectedReturnAt, reason, expectedVersion}, ouverte au chef et à l'opérateur. Elle est refusée (409, avec la liste) si le nouveau créneau chevauche une réservation CONFIRMEE d'un autre conducteur. Elle est auditée et résout l'alerte de retard si la nouvelle échéance est future. Le conducteur ne peut pas prolonger. Le seuil de fraîcheur de 7 jours pousse aux relevés du conducteur pendant la détention. Fichiers : apps/api/src/modules/usages/usages.controller.ts, apps/api/src/modules/usages/usages.service.ts, apps/api/src/modules/usages/dto/extend-usage.dto.ts, apps/api/test/integration/usages.int.spec.ts.
- **Justification** : Garde la distinction de 4.1, le retour prévu obligatoire de 15.3 et l'alerte de retard, tout en évitant des remises artificielles.

### D-136 — [4.1 / 13.2] Modèle de l'affectation habituelle — **irreversible**

- **Ambiguïté** : Le CDC ne définit pas : si deux responsables peuvent se chevaucher ; la granularité (date civile ou horodatage) ; la nature du responsable (conducteur ou utilisateur) ; si un conducteur peut être responsable de plusieurs véhicules ; les saisies rétroactives et les droits.
- **Options** : Un seul responsable à la fois, contrainte d'exclusion sur tstzrange / Plusieurs responsables simultanés / Dates civiles sans contrainte en base
- **Décision** : VehicleResponsibleAssignment(véhicule, conducteur, période tstzrange [start, end[ avec end null = en cours, motif, auteur). Au plus un responsable par véhicule à un instant donné, garanti par une contrainte d'exclusion GiST (vehicle_id WITH =, period WITH &&) créée par migration SQL. Un conducteur peut être responsable de plusieurs véhicules. Le responsable est un conducteur actif de la société propriétaire au début de la période. Saisie rétroactive permise (chef, opérateur) sans chevauchement ; fin ≥ début ; modifications et clôtures motivées et auditées. Une affectation ne crée ni utilisation ni droit du conducteur sur le véhicule. Fichiers : packages/db/prisma/schema.prisma, packages/db/prisma/migrations/*_assignment_exclusion/migration.sql, apps/api/src/modules/assignments/assignments.service.ts, apps/api/src/modules/assignments/dto/*.ts, apps/api/test/integration/assignments.int.spec.ts (T08).
- **Justification** : « Responsable principal sur une période », sans preuve de conduite (4.1). Les contraintes non exprimables dans Prisma passent par des migrations SQL (13.3).

### D-137 — [4.2] Cycle de vie des réservations (NON_HONOREE, modification, création)

- **Ambiguïté** : Aucune règle ne fait passer une réservation en NON_HONOREE. Il n'y a pas de statut brouillon (la création vaut-elle confirmation ?). Le CDC ne dit pas qui peut créer (le conducteur ?), si un créneau passé est accepté, ni ce qui reste modifiable après le début.
- **Options** : Passage automatique en NON_HONOREE à la fin du créneau, ou manuel après un délai de grâce / Passage automatique au début plus un délai de grâce / Passage uniquement manuel
- **Décision** : La création vaut confirmation : statut initial CONFIRMEE après contrôles, par le chef, l'opérateur ou l'administrateur ; pas de réservation par le conducteur en V1. company_id est déduit du véhicule, jamais fourni par le client. start ≥ maintenant − 15 min, end > start, bornes tronquées à la minute. Modification (véhicule, conducteur, créneau, motif) seulement en CONFIRMEE, avec expectedVersion, motif obligatoire et contrôle complet ; une fois start passé, seule la fin reste modifiable. CONVERTIE, ANNULEE et NON_HONOREE sont définitifs. NON_HONOREE est appliqué automatiquement par alert-catch-up quand end est passée sans conversion (de façon idempotente). Il peut aussi être posé manuellement par le chef ou l'opérateur à partir de start + reservationNoShowGraceMinutes (60 par défaut), avec motif, ce qui libère le créneau. Chaque transition enregistre auteur, date et motif (en colonnes et dans AuditEvent). Fichiers : apps/api/src/modules/reservations/reservations.service.ts, apps/api/src/modules/reservations/reservations.controller.ts, apps/api/src/modules/reservations/dto/*.ts, apps/worker/src/jobs/alert-catch-up.job.ts, apps/api/test/integration/reservations.int.spec.ts.
- **Justification** : Jusqu'à la fin du créneau, une remise peut encore convertir la réservation. La libération manuelle couvre le vrai no-show. Auteur, date et motif sont conservés (4.2).

### D-138 — [4.2 / 4.5 / 13.3] Réservations converties, contrainte d'exclusion et utilisations — **irreversible**

- **Ambiguïté** : 13.3 propose une contrainte d'exclusion sur les réservations « adaptée aux statuts », sans dire si CONVERTIE en fait partie. Si oui, le créneau prévu (et non le réel) reste bloqué après un retour anticipé. Si non, rien en base n'empêche une nouvelle réservation de chevaucher l'utilisation issue de la conversion, surtout en cas de retard. Par ailleurs, l'unicité de l'utilisation ouverte n'empêche pas deux utilisations saisies rétroactivement de se chevaucher.
- **Options** : Exclusion limitée aux CONFIRMEE, exclusion sur les utilisations et verrou de ligne pour les croisements entre tables / Exclusion sur CONFIRMEE et CONVERTIE avec le créneau prévu / Table d'occupation unique alimentée par des triggers
- **Décision** : 1) Réservations : deux contraintes EXCLUDE USING gist, (vehicle_id WITH =, slot WITH &&) et (driver_id WITH =, slot WITH &&), WHERE status = 'CONFIRMEE', avec slot tstzrange '[)' (extension btree_gist, migration SQL). CONVERTIE, ANNULEE et NON_HONOREE n'y participent pas. 2) Utilisations : EXCLUDE (vehicle_id WITH =, tstzrange(checked_out_at, coalesce(returned_at, 'infinity'), '[)') WITH &&), et de même sur driver_id, WHERE status <> 'ANNULEE'. On obtient une seule utilisation ouverte et aucun chevauchement historique ; des index uniques partiels WHERE status = 'EN_COURS' s'y ajoutent. 3) Chevauchement réservation ↔ utilisation (deux tables) : création ou modification de réservation, remise, prolongation, retour et transfert verrouillent d'abord la ligne vehicles puis la ligne drivers (ordre constant, SELECT … FOR UPDATE, READ COMMITTED). Ils vérifient ensuite que le créneau ne chevauche pas [checkedOutAt, greatest(expectedReturnAt, now())[ de l'utilisation ouverte. Les erreurs 23P01, 23505 et P2034 deviennent des 409 lisibles (USAGE_CONFLICT, RESERVATION_OVERLAP). Fichiers : packages/db/prisma/migrations/*_reservation_usage_exclusion/migration.sql, packages/db/prisma/schema.prisma, apps/api/src/modules/reservations/reservations.service.ts, apps/api/src/modules/usages/usages.service.ts, apps/api/src/common/errors.ts, apps/api/test/integration/reservations.int.spec.ts (T06), apps/api/test/integration/usages.int.spec.ts (T04, T05).
- **Justification** : Conflits réglés en base par contraintes et verrous (4.5, 13.3, [R2, R3]). Un retour anticipé libère le créneau, et une utilisation en retard bloque toujours le départ suivant (T07).

### D-139 — [4.2 / 4.5 / 13.3] Réservations converties, utilisations en cours et contrainte d'exclusion — **irreversible**

- **Ambiguïté** : La migration n'exclut que les réservations CONFIRMEE. Une réservation CONVERTIE sort donc de la contrainte : une nouvelle réservation peut chevaucher une utilisation en cours, ou une utilisation sans réservation. Le passage à NON_HONOREE n'est pas défini.
- **Options** : Contrainte limitée à CONFIRMEE (existant) / CONFIRMEE + CONVERTIE avec une fin effective / Contrôle applicatif seul
- **Décision** : Contrainte EXCLUDE sur tstzrange(startAt, blockingEndAt) WHERE status IN (CONFIRMEE, CONVERTIE), par véhicule et par conducteur. blockingEndAt = endAt, puis max(startAt, returnedAt) après restitution.

À la confirmation, sous verrou véhicule, contrôle applicatif du chevauchement avec les utilisations EN_COURS sur [checkedOutAt, max(expectedReturnAt, maintenant)[.

NON_HONOREE : posé par le worker à endAt sans conversion, ou plus tôt par le chef.
- **Justification** : Empêche la double affectation (T04, T06) tout en libérant le créneau après un retour anticipé. La contrainte est une migration structurante.

### D-140 — [4.2 / 4.5 / 13.3 / 18 (T06, T07)] Réservations converties vs contrainte d'exclusion — **irreversible**

- **Ambiguïté** : La contrainte d'exclusion ne porte que sur les réservations CONFIRMEE. Une fois CONVERTIE, le créneau n'est plus protégé en base alors que l'utilisation continue. À l'inverse, inclure CONVERTIE bloquerait un créneau libéré par un retour anticipé et ne couvrirait pas un retour tardif. Plusieurs points manquent : la fenêtre de conversion (départ anticipé ou tardif), le passage en NON_HONOREE, et un départ dont le retour prévu chevauche la réservation d'un autre conducteur.
- **Options** : Inclure CONVERTIE dans la contrainte d'exclusion / Exclusion sur CONFIRMEE seulement, et occupation réelle contrôlée en transaction à partir de l'utilisation EN_COURS
- **Décision** : Option 2 :
- Exclusion gist [début, fin[ sur CONFIRMEE, par véhicule et par conducteur.
- Occupation réelle = utilisation EN_COURS sur [checkedOutAt, max(expectedReturnAt, now)[. Elle est vérifiée en transaction, sous verrou FOR UPDATE sur Vehicle et Driver, à la création ou modification d'une réservation et au départ.
- Conversion si le même couple part dans [startAt − 120 min, endAt[ (reservations.conversionEarlyMinutes).
- Un départ qui chevauche la réservation CONFIRMEE d'autrui reçoit un 409 RESERVATION_CONFLIT.
- Passage en NON_HONOREE automatique à endAt par le rattrapage, ou manuel après startAt avec auteur et motif. ANNULEE et NON_HONOREE libèrent le créneau.
Fichiers prévus : packages/db/prisma/migrations/<ts>_reservation_rules/migration.sql, apps/api/src/modules/reservations/reservations.service.ts, apps/api/src/modules/usages/usages.service.ts, apps/worker/src/jobs/alert-catch-up.job.ts, apps/api/test/integration/reservations.int.spec.ts.
- **Justification** : [R3] recommande d'adapter la contrainte aux statuts. L'utilisation réelle prime sur le prévu (4.5).

### D-141 — [4.2 / 7.2] Contrôles à la confirmation et « blocages connus »

- **Ambiguïté** : « Habilitations » et « blocages connus » ne sont pas définis. Un document qui expirera avant le départ, une immobilisation planifiée ou un véhicule HORS_SERVICE doivent-ils refuser la réservation ou seulement avertir ? La dérogation de 7.2 s'applique-t-elle à la réservation ?
- **Options** : Refus des blocages certains ; reconnaissance possible des blocages documentaires avec exceptions.override / Simple avertissement pour tout / Refus strict, sans dérogation
- **Décision** : Refus (422 ou 409) si : le créateur n'a pas le droit d'écriture sur la société ; le conducteur appartient à une autre société ou est inactif ; le véhicule n'est pas ACTIF ; le créneau chevauche une autre réservation du véhicule ou du conducteur ; une immobilisation est active sans fin prévue, ou son intervalle [début, fin prévue[ chevauche le créneau. Blocage documentaire (document bloquant manquant ou expiré à la date de début, permis requis absent) : refus avec le code KNOWN_BLOCKER, sauf si l'appelant a exceptions.override et envoie acknowledgeBlockers avec un motif. Cette reconnaissance est tracée mais ne vaut pas dérogation au départ, qui refait tous les contrôles. Un document qui expire en cours de créneau ne produit qu'un avertissement, puisque le retour reste autorisé. Fichiers : apps/api/src/modules/reservations/reservations.service.ts, apps/api/src/domain/document-status.ts, apps/api/src/domain/vehicle-status.ts, apps/api/test/integration/reservations.int.spec.ts.
- **Justification** : « La vérification est refaite au départ » (4.2). La dérogation de 7.2 reste liée au départ réel.

### D-142 — [4.3 / 4.2] Quelle réservation la remise convertit

- **Ambiguïté** : « Le cas échéant, convertit la réservation » : laquelle, si aucun identifiant n'est fourni ? Une remise anticipée, avant le début du créneau, est-elle permise ? Que faire si le véhicule est remis à un autre conducteur que celui de la réservation, ou si le retour prévu empiète sur la réservation suivante ?
- **Options** : Rapprochement serveur sur (véhicule, conducteur) avec une fenêtre d'avance, refus en cas d'empiètement / reservationId obligatoire / Aucune conversion automatique
- **Décision** : reservationId est facultatif dans le contrat checkout. S'il est absent, le serveur convertit l'unique réservation CONFIRMEE du même couple (véhicule, conducteur) vérifiant start − earlyCheckoutMinutes (120 par défaut) ≤ checkedOutAt < end. S'il est fourni, il doit correspondre à ce couple et à cette fenêtre, sinon 422. La réservation passe CONVERTIE, avec usage_id. L'intervalle [checkedOutAt, expectedReturnAt[ ne doit chevaucher aucune autre réservation CONFIRMEE du véhicule ou du conducteur, sinon 409 avec la liste : le chef ajuste le retour prévu, ou modifie ou annule la réservation. Remettre à Y un véhicule réservé par X oblige donc à traiter d'abord la réservation de X. Fichiers : apps/api/src/modules/usages/usages.service.ts, apps/api/src/modules/usages/dto/checkout.dto.ts, apps/api/src/modules/reservations/reservations.service.ts, apps/api/test/integration/usages.int.spec.ts.
- **Justification** : Les contrôles sont refaits au départ (4.2) sans substitution silencieuse de conducteur.

### D-143 — [4.3 / 4.4] Annulation d'une remise saisie par erreur

- **Ambiguïté** : Seuls les statuts EN_COURS et TERMINEE sont évoqués. Rien ne permet de corriger une remise erronée (mauvais véhicule ou mauvais conducteur), alors que la clôture par PATCH de statut est interdite et qu'on ne supprime jamais de données.
- **Options** : Statut ANNULEE et action motivée réservée au chef / Retour immédiat avec une distance de zéro / Suppression physique
- **Décision** : Ajouter le statut ANNULEE et l'action POST /usages/:id/cancel {reason, expectedVersion}, réservée aux détenteurs de readings.correct (chef, administrateur). Elle n'est possible que si aucun plein, incident ou relevé ultérieur n'est rattaché à l'utilisation. Effets, dans une seule transaction : l'utilisation passe ANNULEE (exclue des contraintes et des rapports, conservée pour l'audit) ; la réservation convertie redevient CONFIRMEE si sa fin est future, sinon NON_HONOREE ; le relevé de départ passe par le parcours de correction (gardé s'il est exact, sinon remplacé ou annulé par readings.correct) ; la déclaration de lieu est conservée, avec une mention. Fichiers : packages/db/prisma/schema.prisma (enum UsageStatus), apps/api/src/modules/usages/usages.service.ts, apps/api/src/modules/usages/dto/cancel-usage.dto.ts, apps/api/test/integration/usages.int.spec.ts.
- **Justification** : Un retour fictif fausserait distances et rapports. L'annulation motivée conserve l'historique (3.2) et reste réservée à ceux qui peuvent corriger (2.2).

### D-144 — [4.3 / 4.4] Checklist, niveau de carburant, photos, confirmation nominative et dommages

- **Ambiguïté** : Le CDC ne définit pas : le contenu de la checklist (fixe ou paramétrable) ; l'unité du « niveau de carburant approximatif » ; le nombre de photos ; la forme de la « confirmation nominative » ; le lien entre le retour et l'ouverture d'un incident.
- **Options** : Modèle de checklist par société, niveau en huitièmes, incident créé dans la même transaction / Checklist fixe codée en dur / Champs de texte libre uniquement
- **Décision** : Modèle de checklist paramétrable par société (éléments : code, libellé, obligatoire). À la remise et au retour, un instantané JSON (code, libellé, présent oui ou non, commentaire) est figé dans l'utilisation ; les écarts entre départ et retour apparaissent en « réserves » sur la fiche imprimable. Niveau de carburant en huitièmes (0 à 8, nullable), affiché en fraction, sans conversion en litres. Photos : pièces jointes privées, 10 au maximum par événement, 10 Mo chacune. Confirmation nominative : nom saisi, case « Je confirme la remise » ou « le retour », horodatage serveur et compte connecté s'il y en a un ; elle porte le libellé « confirmation non certifiée ». Au retour, une section « dommage constaté » crée dans la même transaction un Incident DOMMAGE OUVERT lié à l'utilisation, que le retour ne clôture pas. Fichiers : apps/api/src/modules/usages/dto/checkout.dto.ts, apps/api/src/modules/usages/dto/return.dto.ts, apps/api/src/modules/settings/settings.service.ts, apps/api/src/modules/incidents/incidents.service.ts, apps/web/app/(app)/utilisations/[id]/page.tsx.
- **Justification** : Reprend les éléments de 4.3 et 4.4 (réserves, pas de signature certifiée, incident non clôturé par le retour) et les limites de fichiers de 16.2.

### D-145 — [4.3 / 4.4] Départ sans relevé, retour constaté et statut de distance

- **Ambiguïté** : Le départ sans relevé est réservé « au chef ou à l'administrateur », sans permission désignée, et l'« alerte persistante » n'a pas de règle de résolution. Au retour, un « relevé absent ou contesté » permet au chef de constater le retour, mais le CDC ne dit pas si l'opérateur peut restituer quand le relevé passe en anomalie. Le statut de l'utilisation, la « régularisation » et le cas d'un relevé de retour inférieur au départ ne sont pas précisés.
- **Options** : Statut de distance distinct du statut de l'utilisation, régularisation explicite / Statut supplémentaire RETOUR_CONSTATE / Retour refusé tant que le relevé n'est pas validé
- **Décision** : Départ sans relevé et retour sans relevé exigent exceptions.override et un motif. VehicleUsage.distanceStatus ∈ {VALIDEE, NON_VALIDEE, INDETERMINEE}, distinct du statut EN_COURS ou TERMINEE. Retour avec relevé accepté (et relevé de départ accepté) : TERMINEE et VALIDEE. Retour avec relevé EN_ATTENTE (anomalie) : n'importe quel utilisateur autorisé à restituer, opérateur compris, enregistre le retour ; résultat TERMINEE et NON_VALIDEE, avec une alerte « relevé à valider ». Relevé absent ou refusé (diminution) : seul un détenteur d'exceptions.override peut constater le retour, avec motif ; résultat TERMINEE et NON_VALIDEE. Départ sans relevé : INDETERMINEE et alerte DEPARTURE_WITHOUT_READING, qui ne se résout pas au retour. Elle se résout seulement par POST /usages/:id/regularize (chef), qui rattache un relevé accepté MANUAL ou COMPTEUR_CAN observé à ±30 min du départ (jamais une DISTANCE_GPS), ou par une clôture motivée « distance définitivement indéterminée ». L'approbation du relevé de retour fait passer NON_VALIDEE à VALIDEE. Distance = cumul au retour − cumul au départ ; si le cumul est incomplet mais que les deux relevés sont sur le même segment, on prend la différence physique. Fichiers : apps/api/src/modules/usages/usages.service.ts, apps/api/src/modules/usages/dto/return.dto.ts, apps/api/src/modules/usages/dto/regularize-usage.dto.ts, apps/api/src/modules/alerts/alerts.service.ts, apps/api/test/integration/usages.int.spec.ts.
- **Justification** : « Le retour physique doit toujours pouvoir être enregistré » (4.5), sans distance inventée et avec une régularisation traçable.

### D-146 — [4.3 / 4.4 / 5.2] Remises et restitutions saisies après coup, et « date non future »

- **Ambiguïté** : La date et l'heure réelles d'une remise ou d'un retour peuvent-elles être antérieures à maintenant (fiche papier saisie plus tard), et jusqu'à quand ? « Date non future » n'a pas de tolérance pour l'écart d'horloge, et l'ordre relatif avec la réservation et le relevé n'est pas défini.
- **Options** : Tolérance de 5 min dans le futur ; rétroactivité limitée à 7 jours, au-delà réservée à l'administrateur / Aucune rétroactivité / Rétroactivité illimitée
- **Décision** : checkedOutAt et returnedAt ≤ maintenant + 5 min (clockSkewMinutes). Rétroactivité jusqu'à 7 jours (usageBackdateMaxDays) pour le chef et l'opérateur ; au-delà, administrateur seul, avec motif. returnedAt > checkedOutAt et expectedReturnAt > checkedOutAt. Les contraintes d'exclusion empêchent tout chevauchement avec une utilisation existante. Le relevé de départ ou de retour prend observedAt = checkedOutAt ou returnedAt et passe les contrôles des relevés voisins. Les heures saisies sont converties dans le fuseau du groupe. Fichiers : apps/api/src/modules/usages/dto/checkout.dto.ts, apps/api/src/modules/usages/dto/return.dto.ts, apps/api/src/common/clock.ts, apps/api/src/modules/settings/settings.service.ts.
- **Justification** : Correspond aux pratiques terrain (fiches papier) sans permettre de réécrire l'historique sans limite. La chronologie reste contrôlée (5.2).

### D-147 — [4.3 / 4.4 / 5.2 / 5.6] Estimations DISTANCE_GPS face au contrôle de chronologie des relevés manuels — **contradiction-cdc**

- **Ambiguïté** : 5.2 refuse toute baisse par rapport au relevé accepté précédent, et 5.6 fait de l'estimation GPS calibrée un relevé accepté qui devient le compteur courant. T39 (estimation 81 000, puis restitution manuelle à 80 960) serait donc refusée, et une estimation pourrait bloquer une remise, ce que 5.6 interdit. Même risque avec une valeur CAN décimale (50 120,7) face à un tableau de bord qui affiche un entier (50 120).
- **Options** : Exclure les estimations du contrôle de chronologie ; tolérance entre sources mesurées / Contrôle strict de chronologie sur toutes les sources / Ne pas historiser les estimations comme relevés
- **Décision** : Les relevés DISTANCE_GPS sont stockés ACCEPTE, avec estimated = true, la distanceGps brute et referenceReadingId. Ils ne servent jamais de relevés voisins dans le contrôle de chronologie des relevés mesurés (MANUAL, IMPORT, COMPTEUR_CAN), qui ne se comparent qu'entre eux sur le même segment. Tout relevé mesuré accepté devient la nouvelle référence de calibrage ; les estimations postérieures sont recalculées, puisque ce sont des valeurs dérivées (13.3). Le compteur courant reste le relevé le plus récent par observedAt : il peut redescendre à la valeur manuelle, affichée « recalé sur relevé manuel ». Entre sources mesurées, tolérance readingSourceToleranceKm = 1 km : un relevé manuel inférieur d'au plus 1 km à un CAN accepté est accepté (arrondi du tableau de bord). Au-delà : EN_ATTENTE avec le motif CAN_CONFLICT si le voisin est un CAN, refus si le voisin est manuel (T09). Fichiers : apps/api/src/domain/odometer-rules.ts, apps/api/src/domain/gps-calibration.ts, apps/api/src/domain/odometer-rules.spec.ts, apps/api/src/domain/gps-calibration.spec.ts, apps/api/src/modules/odometer/odometer.service.ts, apps/api/test/integration/telemetry.int.spec.ts (T37 à T40).
- **Justification** : Seule lecture compatible à la fois avec T39 (nouvelle référence 80 960) et avec 5.6 (une estimation ne bloque ni remise ni saisie manuelle) ; elle déroge toutefois à la lettre de 5.2.

### D-148 — [4.3 / 5.1 / 5.2] Relevé de départ en anomalie ou en attente de validation

- **Ambiguïté** : « Le relevé doit être accepté pour valider le départ », mais une hausse au-delà du seuil de plausibilité met le relevé EN_ATTENTE, même pour un opérateur. Faut-il alors refuser la remise, l'enregistrer en attente, ou laisser le chef valider dans la foulée ? Le segment de compteur à utiliser et l'aide « dernière valeur automatique » ne sont pas cadrés.
- **Options** : Opération atomique : refus, ou validation immédiate par un détenteur de readings.approve / Remise enregistrée avec un relevé en attente / Relevé stocké en attente, remise refusée
- **Décision** : La remise appelle le service d'ingestion unique dans la même transaction. Relevé ACCEPTE : l'utilisation est créée. Diminution ou conflit : 422 et annulation complète de la transaction. Anomalie (EN_ATTENTE) : 422 READING_NEEDS_APPROVAL et annulation, sauf si l'appelant a readings.approve et renvoie confirmAnomaly=true avec un motif ; le relevé est alors accepté (approbation tracée ; valider sa propre saisie est permis mais doit être motivé) et la remise validée. Avec exceptions.override, on peut aussi passer en « départ sans relevé ». odometerSegmentId est facultatif ; s'il est fourni, il doit désigner le segment ouvert, sinon 409 SEGMENT_CHANGED. La dernière valeur automatique s'affiche comme indication à côté du champ, jamais comme valeur pré-remplie. Fichiers : apps/api/src/modules/usages/usages.service.ts, apps/api/src/modules/odometer/odometer.service.ts, apps/api/src/domain/odometer-rules.ts, apps/web/app/(app)/utilisations/[id]/page.tsx, apps/api/test/integration/usages.int.spec.ts.
- **Justification** : Aucune augmentation n'est inventée (4.3) et la valeur saisie reste celle du tableau de bord (5.6). Validations et dérogations restent au chef (2.2).

### D-149 — [4.3 / 5.2] Relevés identiques ou divergents « au même instant »

- **Ambiguïté** : « Même instant » et « même opération » ne sont pas définis : précision à la seconde ou à la minute ? Le CDC ne dit pas non plus ce que devient un second relevé de valeur différente (« conflit à traiter »).
- **Options** : Minute pour les saisies manuelles, seconde pour la télématique ; relevé divergent mis en attente / Égalité stricte à la milliseconde / Relevé divergent refusé
- **Décision** : « Même instant » : même observedAt tronqué à la minute pour MANUAL et IMPORT, à la seconde pour TELEMATICS. « Même opération » : même véhicule, segment, source, contexte, valeur et objet lié (utilisation, plein, intervention) ; le second appel renvoie le relevé existant (200, sans doublon). Valeur différente au même instant : le nouveau relevé est enregistré EN_ATTENTE avec le motif SAME_INSTANT_CONFLICT, le premier reste inchangé, et une alerte « relevé à valider » est émise. Dans une remise ou un retour, ce cas est traité comme une anomalie. Fichiers : apps/api/src/domain/odometer-rules.ts, apps/api/src/domain/odometer-rules.spec.ts, apps/api/src/modules/odometer/odometer.service.ts.
- **Justification** : Les saisies manuelles sont précises à la minute. Un conflit « à traiter » doit rester visible au chef plutôt qu'être perdu.

### D-150 — [4.3 / 5.2 / 5.6 / 17.1] Seuil de plausibilité : ni unité ni valeur

- **Ambiguïté** : Le seuil de plausibilité décide de l'acceptation des relevés de remise et de restitution, mais 17.1 ne lui donne ni unité ni valeur initiale. Pour F11, il est « rapporté à la durée écoulée ». Sans durée minimale de référence, T15 (89 500 → 90 000 → 90 200 saisis en quelques secondes) et T37 (CAN +120 km) passeraient EN_ATTENTE.
- **Options** : Km par jour pour les saisies manuelles, vitesse moyenne pour la télématique, avec une durée minimale / Seuil absolu en km par relevé / Pas de seuil en V1
- **Décision** : Deux paramètres d'organisation, réglables par société. plausibilityKmPerDay = 1 500 pour MANUAL et IMPORT : hausse autorisée = 1 500 × max(jours écoulés, 1). plausibilityMaxAvgSpeedKmh = 200 pour TELEMATICS : hausse autorisée = 200 × max(heures écoulées, 1). Au-delà, le relevé passe EN_ATTENTE avec le motif PLAUSIBILITY et une explication chiffrée. Un seul calcul, commun à toutes les sources, dans odometer-rules.ts. Avec ces valeurs, T15 (+500 et +200) et T37 (+120 km, puis +10) sont acceptés sans avoir à espacer les relevés. Fichiers : apps/api/src/domain/odometer-rules.ts, apps/api/src/domain/odometer-rules.spec.ts, apps/api/src/modules/settings/settings.service.ts, packages/db/src/seed-demo.ts.
- **Justification** : « Filtre administratif configurable, pas une limite physique » (5.2). La durée minimale évite les faux positifs sur des relevés rapprochés.

### D-151 — [4.3 / 13.2 / 15.3] Idempotence des remises, retours et créations

- **Ambiguïté** : « Les actions réalisées en double doivent produire un seul résultat », mais le contrat Return ne prévoit que expectedVersion : un double envoi recevrait 409 alors que l'action a réussi. La durée de conservation des clés, le cas de deux requêtes simultanées portant la même clé et la liste des routes concernées ne sont pas définis.
- **Options** : Idempotency-Key obligatoire sur les mutations critiques, conservation 24 h, état IN_PROGRESS / Uniquement expectedVersion / Déduplication par empreinte du corps, sans clé
- **Décision** : L'en-tête Idempotency-Key (UUID généré par formulaire côté web) est obligatoire sur : checkout, return, extend, transfer, création de réservation, validation de plein, clôture d'intervention, commit d'import. Il est facultatif ailleurs. Portée unique : (organizationId, userId, opération, clé), avec une empreinte SHA-256 du corps canonique. Fonctionnement : la clé est d'abord insérée à l'état IN_PROGRESS dans une transaction courte. Clé terminée et même empreinte : la réponse initiale (statut et corps) est rejouée. Empreinte différente : 409 IDEMPOTENCY_KEY_REUSED. Clé encore IN_PROGRESS : 409 IDEMPOTENCY_IN_PROGRESS, et le client réessaie. Les réponses 4xx sont mémorisées et rejouées ; les 5xx ne le sont pas. Conservation 24 h, purge par retention.job. Return garde aussi expectedVersion. Fichiers : apps/api/src/common/idempotency.ts, apps/api/src/common/optimistic-lock.ts, packages/db/prisma/schema.prisma (IdempotencyRecord), apps/worker/src/jobs/retention.job.ts, apps/api/test/integration/idempotency.int.spec.ts (T33).
- **Justification** : Applique 15.3 (même clé et même corps : réponse initiale ; corps différent : 409) et élimine les faux conflits en cas de nouvelle tentative réseau.

### D-152 — [4.5 / 9.1 / 17.1] Retard, réservations compromises et immobilisation pendant une utilisation

- **Ambiguïté** : « Signale les réservations suivantes affectées » : lesquelles (même véhicule seulement, même conducteur, sur quel horizon), sous quelle forme, et quand l'alerte se résout-elle ? La tolérance de retard est « configurable » sans valeur par défaut. Une immobilisation ou un document expiré qui rend une réservation impossible n'est pas rattaché à l'alerte « réservation compromise ».
- **Options** : Une alerte par réservation, même véhicule ou même conducteur, horizon de 24 h, résolution automatique / Une alerte globale par utilisation en retard / Toutes les réservations futures, sans horizon
- **Décision** : Retard : maintenant > expectedReturnAt + lateReturnToleranceMinutes (0 par défaut, réglable par société). Une alerte RETOUR_DEPASSE par utilisation (dédupliquée par usageId), dont la gravité monte au-delà de 24 h. Réservation compromise : une alerte par réservation (clé reservationId), pour toute réservation CONFIRMEE du même véhicule ou du même conducteur qui commence dans les 24 h (compromisedHorizonHours) et ne peut pas démarrer. Causes : utilisation en retard, immobilisation active ou planifiée qui chevauche, HORS_SERVICE, blocage documentaire à la date de début, conducteur inactif. Résolution automatique quand la cause disparaît ou que la réservation est modifiée, convertie, annulée ou passée NON_HONOREE. Évaluation après chaque mutation concernée et par alert-catch-up (toutes les 15 min). Immobilisation pendant une utilisation : autorisée ; le véhicule passe IMMOBILISE, le chef est alerté, le retour reste possible et le véhicule reste IMMOBILISE après le retour (T23). Fichiers : apps/api/src/modules/alerts/alerts.service.ts, apps/worker/src/jobs/alert-catch-up.job.ts, apps/api/src/modules/usages/usages.service.ts, apps/api/test/integration/usages.int.spec.ts (T07, T23).
- **Justification** : Déduplication par objet et occurrence (9.2). Un retard ne clôture rien (4.5), et le résultat attendu de T07 est obtenu.

### D-153 — [5.1 / 2.2 / 12.1] Périmètre des relevés du conducteur et statut des relevés importés

- **Ambiguïté** : Le CDC ne dit pas sur quel véhicule et pour quelle période un conducteur peut proposer un relevé. Le statut d'un relevé IMPORT cohérent n'est pas donné. On ignore si une anomalie d'import bloque tout le lot, et si l'approbation différée revalide la chronologie.
- **Options** : Conducteur limité à l'utilisation EN_COURS / Conducteur autorisé sur ses utilisations passées / Anomalie d'import traitée comme erreur ou comme avertissement
- **Décision** : Conducteur :
- uniquement le véhicule de son utilisation EN_COURS, avec observedAt entre checkedOutAt et maintenant ;
- relevé toujours EN_ATTENTE, motif de rejet obligatoire et visible sur /mon-vehicule ;
- une diminution donne 422 immédiat et propose « Signaler un problème ».

Import :
- erreurs dures (diminution, conflit, date future, hors segment) : le lot est bloqué ;
- PLAUSIBILITE_DEPASSEE : avertissement en prévisualisation, relevé créé EN_ATTENTE ;
- lignes cohérentes : ACCEPTE.

Approbation : chronologie revalidée à cet instant, expectedVersion requis.
- **Justification** : Applique 2.3 (le conducteur ne voit que son utilisation en cours) et 12.1 (aucune ligne validée si le lot contient des erreurs), sans faire échouer un import pour un simple avertissement.

### D-154 — [5.1 / 2.4 / 11.3] Relevé rétroactif antérieur à un transfert de société

- **Ambiguïté** : companyId vaut la « société au moment de l'observation ». Un chef de la société B qui saisit un relevé daté d'avant le transfert créerait donc une donnée de A qu'il ne peut pas voir. Le « relevé de transfert » de 11.3 n'est pas défini.
- **Options** : Autoriser la saisie et l'imputer à A / Refuser hors période de la société de l'utilisateur / Imputer à B
- **Décision** : companyId est calculé côté serveur à partir de VehicleCompanyHistory à observedAt. Hors administrateur, on ne crée ou ne corrige que des relevés dont la société à observedAt est dans son périmètre ; sinon 422 HORS_PERIODE_SOCIETE.

Le transfert propose un relevé de contexte TRANSFERT, facultatif. Sans lui, les distances qui couvrent le transfert sont « non ventilables ». La chronologie est contrôlée sur tout le segment, toutes sociétés confondues.
- **Justification** : Protège le cloisonnement (2.3) et l'attribution historique des kilomètres (11.3).

### D-155 — [5.1 / 4.3 / 4.4] Relevé mis en attente au moment d'une remise ou d'une restitution

- **Ambiguïté** : La remise exige un relevé accepté. Une anomalie saisie par un opérateur au départ met ce relevé EN_ATTENTE : le départ est-il bloqué ? À la restitution, « le retour physique doit toujours pouvoir être enregistré ».
- **Options** : Bloquer la remise et la restitution / Bloquer la remise, enregistrer la restitution avec distance non validée / Accepter les deux avec relevé en attente
- **Décision** : Remise : 422 RELEVE_A_VALIDER si le relevé passerait EN_ATTENTE. Deux issues :
- un titulaire de readings.approve confirme dans la même requête ;
- ou exception « départ sans relevé » (chef, administrateur).

Restitution : toujours enregistrée, utilisation TERMINEE avec distanceStatus NON_VALIDEE et relevé EN_ATTENTE rattaché. Ensuite :
- approbation : la distance passe VALIDEE ;
- rejet : elle reste NON_VALIDEE, avec alerte DISTANCE_NON_VALIDEE.
- **Justification** : Respecte à la fois « relevé accepté pour valider le départ » et « retour toujours enregistrable ».

### D-156 — [5.1 / 5.2] Liste fermée des « anomalies importantes », refus immédiats et confirmation par le chef

- **Ambiguïté** : 5.1 met en attente une « anomalie importante », y compris pour un opérateur, sans la définir. 5.2 ne cite que la hausse au-delà du seuil. L'administrateur n'est pas mentionné. On ignore si la saisie anormale d'un chef est elle aussi mise en attente, et qui l'approuve. La tolérance d'horloge pour « date non future » et les bornes du segment ne sont pas précisées.
- **Options** : Toute anomalie → EN_ATTENTE, pour tous les rôles / Anomalie → EN_ATTENTE sauf pour les titulaires de readings.approve, qui confirment explicitement / Anomalie → refus 422 pour tous
- **Décision** : Enum fermé anomalyCode dans packages/contracts : PLAUSIBILITE_DEPASSEE, CONFLIT_MEME_INSTANT, REGRESSION_TELEMATIQUE, DATE_FUTURE_SOURCE, VEHICULE_NON_ACTIF, CONTREDIT_PAR_MANUEL.

Refus immédiat (422, sans mise en attente) :
- valeur négative ;
- observedAt > maintenant + 2 min ;
- diminution par rapport à un relevé physique accepté voisin ;
- observedAt hors des bornes du segment.

Selon l'auteur :
- Opérateur ou conducteur avec anomalie : EN_ATTENTE.
- Titulaire de readings.approve (chef, et administrateur aligné sur le chef) : réponse 422 ANOMALIE_A_CONFIRMER avec l'explication. Le chef renvoie ensuite confirmAnomaly=true avec anomalyExplanation obligatoire, et le relevé passe ACCEPTE, audité.
- Télématique datée de plus de 5 min dans le futur : EN_ATTENTE DATE_FUTURE_SOURCE.

Pas de double contrôle obligatoire.
- **Justification** : « Proposée à validation avec explication » : le chef reste le valideur, mais sa validation doit être explicite et tracée. La liste fermée permet des motifs lisibles et des tests déterministes.

### D-157 — [5.1 / 14.4] Webhook fournisseur contre « aucun endpoint public n'accepte TELEMATICS »

- **Ambiguïté** : 14.4 prévoit d'utiliser un webhook s'il existe, alors que 5.1 interdit tout endpoint public acceptant la source TELEMATICS.
- **Options** : Ne jamais utiliser de webhook / Webhook qui crée les relevés directement / Webhook de réception brute traité par le worker
- **Décision** : Route /api/v1/telemetry/webhooks/:providerId, authentifiée par HMAC ou secret fournisseur. Elle stocke seulement la charge brute dans TelemetryInboundMessage, de façon idempotente par empreinte. Le worker (telemetry-sync.job.ts) la traite ensuite par le service d'ingestion unique. Route désactivée tant qu'aucun webhook n'est qualifié.
- **Justification** : Respecte la lettre de 5.1 : aucune route ne crée de relevé TELEMATICS. Profite aussi de la latence réduite promise par 14.4.

### D-158 — [5.2 / 5.6 / 4.3] Relevé manuel en conflit avec un relevé COMPTEUR_CAN accepté — **contradiction-cdc**

- **Ambiguïté** : COMPTEUR_CAN est « traité comme un compteur physique ». Une lecture du tableau de bord légèrement inférieure à un CAN antérieur (saisie entière contre valeur CAN décimale, écart de capteur) serait une diminution refusée, ce qui bloquerait la remise. Pourtant 5.6 dit qu'un relevé automatique ne bloque ni une remise ni une saisie manuelle. À l'inverse, un CAN un peu inférieur au dernier relevé manuel passerait EN_ATTENTE toutes les heures.
- **Options** : Refuser le relevé manuel (lettre de 5.2) / Mettre le relevé manuel EN_ATTENTE, ce qui bloque la remise / Priorité au manuel, avec tolérance ; les CAN contradictoires repassent EN_ATTENTE / Tolérance seule
- **Décision** : Tolérance `telemetry.canManualToleranceKm` (2 km par défaut).

Au-delà de la tolérance :
- Le relevé MANUAL/IMPORT cohérent avec les autres relevés non télématiques est ACCEPTE : le tableau de bord fait foi.
- Les relevés TELEMATICS COMPTEUR_CAN acceptés qui le contredisent passent, dans la même transaction, par une transition système ACCEPTE → EN_ATTENTE, avec anomalyCode CONTREDIT_PAR_MANUEL, un audit SYSTEME et une alerte RELEVE_A_VALIDER.
- Exception : si un CAN contradictoire est lié à une intervention, il n'est pas rétrogradé ; une alerte de conflit est levée et le chef régularise par correction.

CAN inférieur au dernier relevé manuel :
- Dans la tolérance : pas d'historisation, seulement l'échantillon et TelemetryUnitState.
- Au-delà : EN_ATTENTE REGRESSION_TELEMATIQUE (T40).

La transition ACCEPTE → EN_ATTENTE est interdite pour toute autre source.
- **Justification** : Le CDC donne la primauté à la valeur lue (« la valeur enregistrée reste celle lue sur le tableau de bord ») et interdit que l'automatique bloque le manuel. La valeur du CAN n'est pas modifiée, mais la transition ACCEPTE → EN_ATTENTE n'est pas prévue par 5.1/5.3 (« jamais écrasé »), d'où la classification en contradiction.

### D-159 — [5.2 / 5.6 / 17.1] Seuil de plausibilité : unité et valeur initiale absentes

- **Ambiguïté** : 5.2 parle d'un seuil configuré (absolu ?) et 5.6 d'un seuil « rapporté à la durée écoulée ». 17.1 ne donne aucune valeur. Un taux journalier proratisé à l'heure (1 500/24 ≈ 62 km/h) mettrait en attente un trajet autoroutier normal entre deux synchros de 15 min ; T42 fait d'ailleurs passer 89 500 à 90 000 entre deux synchros.
- **Options** : Seuil absolu en km par relevé / Taux km/jour proratisé à la seconde / Taux en km par jour entamé, avec un plancher d'un jour, et une même fonction pour toutes les sources
- **Décision** : Option 3. Paramètre odometer.plausibilityKmPerDay = 1 500 (niveau groupe, surchargeable par société). Hausse admise = taux × max(1, ceil(heures écoulées / 24)), comparée au relevé accepté non estimé qui précède dans le segment. Au-delà, le relevé passe EN_ATTENTE avec un motif lisible (valeur, délai, seuil). Une seule fonction pure checkPlausibility sert à MANUAL, IMPORT et TELEMATICS. Fichiers prévus : apps/api/src/domain/odometer-rules.ts, apps/api/src/domain/odometer-rules.spec.ts, apps/api/src/modules/settings/settings.service.ts.
- **Justification** : Le seuil est un filtre administratif et non une limite physique (5.2). Le plancher d'un jour évite les faux positifs d'une synchro à l'autre, et une seule règle respecte 14.2.

### D-160 — [5.2 / 5.6 / 17.1] Seuil de plausibilité : unité, valeur initiale et portée

- **Ambiguïté** : Le « seuil de plausibilité configuré » (5.2) n'a ni unité ni valeur initiale dans le tableau 17.1. En 5.6 il est « rapporté à la durée écoulée » pour F11, alors qu'en 5.2 il paraît absolu pour les saisies manuelles. Le CDC ne dit pas s'il s'applique aussi au relevé suivant lors d'une saisie rétroactive, ni s'il peut être surchargé par catégorie (poids lourd ou véhicule léger).
- **Options** : Seuil absolu en km entre deux relevés consécutifs / Seuil en km/jour rapporté à la durée, avec plancher / Deux paramètres distincts, manuel et télématique
- **Décision** : Un seul paramètre `odometer.plausibility.maxKmPerDay` (1 500 km/j par défaut), avec un plancher `odometer.plausibility.minAllowanceKm` (300 km par défaut). Hausse admise = max(plancher, maxKmPerDay × durée en jours depuis le relevé physique accepté précédent). La règle vaut pour MANUAL, IMPORT et TELEMATICS, et pour les deux intervalles (précédent → nouveau et nouveau → suivant) lors d'une saisie rétroactive. Surcharge facultative par VehicleCategory. Valeurs versionnées et auditées dans Settings, et ajoutées à la table 17.1 dans docs/DECISIONS.md. Une seule implémentation : checkPlausibility() dans apps/api/src/domain/odometer-rules.ts, testée dans odometer-rules.spec.ts.
- **Justification** : Une seule règle rapportée à la durée couvre à la fois 5.2 et 5.6 et reste un « filtre administratif, pas une limite physique ». Le plancher évite de bloquer des relevés rapprochés, par exemple une remise puis une restitution une heure plus tard, et empêche la division par des durées quasi nulles.

### D-161 — [5.2 / 5.6 / T39] Estimations DISTANCE_GPS et contrôle de chronologie des relevés physiques

- **Ambiguïté** : 5.2 impose de vérifier le relevé accepté précédent et suivant dans le segment. Une estimation GPS acceptée (81 000) suivie d'une restitution manuelle plus basse (80 960) serait donc une « diminution inexpliquée » refusée. Or T39 attend l'acceptation du relevé manuel et une nouvelle référence à 80 960.
- **Options** : Les estimations participent au contrôle de chronologie / Les estimations sont exclues du contrôle des relevés physiques / Les estimations ne sont jamais historisées comme OdometerReading
- **Décision** : checkChronology() dans apps/api/src/domain/odometer-rules.ts exclut les relevés isEstimate=true (DISTANCE_GPS) comme voisins d'un relevé physique (MANUAL, IMPORT, COMPTEUR_CAN).

Les estimations sont contrôlées uniquement entre elles, au sein du même calibrage, et doivent rester ≥ la référence manuelle. Le compteur courant est le relevé accepté le plus récent par observedAt. Les estimations antérieures restent ACCEPTE, libellées « estimé GPS », sans réécriture.

Tests T38 et T39 dans apps/api/test/integration/odometer.int.spec.ts.
- **Justification** : Une DISTANCE_GPS n'est « jamais présentée comme la valeur du compteur » : elle ne peut donc pas contredire une lecture physique. C'est la seule lecture compatible avec T39.

### D-162 — [5.2 / 15.3] Idempotence des saisies manuelles et notion de « même instant »

- **Ambiguïté** : Le contrat Reading n'a pas d'idempotencyKey. « Représentent la même opération » n'est pas défini. La précision de « même instant » (minute côté interface, milliseconde côté base) et le cas de deux sources au même instant ne sont pas traités. Le rejeu d'une approbation n'est pas couvert.
- **Options** : Clé d'idempotence obligatoire / Déduplication naturelle par attributs / Les deux
- **Décision** : POST /vehicles/:id/readings accepte l'en-tête Idempotency-Key (obligatoire pour /mon-vehicule), traité par apps/api/src/common/idempotency.

Sans clé :
- même véhicule, segment, observedAt (à la seconde), valeur, source, contexte et auteur : on renvoie l'existant (200) ;
- même instant, valeur différente contre un relevé MANUAL/IMPORT : 409 CONFLIT_MEME_INSTANT ;
- même instant, valeur différente contre un relevé TELEMATICS : le manuel l'emporte.

Précisions :
- La saisie manuelle se fait à la minute.
- Approbation ou rejet rejoué vers l'état déjà atteint par le même utilisateur : 200 sans effet ; sinon expectedVersion obsolète donne 409.
- **Justification** : Satisfait « les actions en double produisent un seul résultat » sur mobile et la règle d'idempotence de 5.2.

### D-163 — [5.3 / 15.3] Retrait d'un relevé accepté erroné sans valeur de remplacement — **contradiction-cdc**

- **Ambiguïté** : 15.3 exige replacementReading pour toute correction. Or un relevé accepté saisi sur le mauvais véhicule, ou un CAN aberrant accepté, n'a aucune valeur de remplacement légitime.
- **Options** : Imposer une valeur de remplacement (fausse donnée) / Opération distincte de retrait ACCEPTE → REJETE / Archiver le relevé hors statut
- **Décision** : POST /readings/:id/withdraw (readings.correct, motif obligatoire) : ACCEPTE → REJETE, avec audit avant/après. Mêmes contrôles de dépendances que la correction, et interdit si le relevé est lié à une utilisation ou une intervention (correction obligatoire dans ce cas).
- **Justification** : Évite d'inventer une valeur, mais ajoute une transition que 15.3 ne prévoit pas.

### D-164 — [5.3 / 15.3 / T13] Correction d'un relevé : liens métier et dépendances incohérentes — **irreversible**

- **Ambiguïté** : « Recalcule les données dépendantes » : le CDC ne dit pas vers quel relevé pointent ensuite les utilisations, interventions, pleins et calibrages. « Bloquer ou exiger leur régularisation » laisse le choix ouvert, et la notion d'incohérence n'est pas définie.
- **Options** : Liens conservés vers l'original, résolution par la chaîne de remplacement / Liens re-pointés vers le remplaçant / Blocage systématique de toute correction ayant des dépendants
- **Décision** : Transaction Serializable :
- l'original passe REMPLACE ;
- le remplaçant est ACCEPTE après les mêmes contrôles, voisins calculés hors original ;
- les liens métier sont re-pointés vers le remplaçant : VehicleUsage checkout/return, Intervention.performedReadingId, FuelEntry, référence TelemetryCalibration ;
- recalcul de la distance d'utilisation, des plans, de la consommation, du calibrage et des alertes.

Erreur 409 CORRECTION_DEPENDANCES, avec la liste des objets, si le remplaçant rend :
- un retour inférieur au départ ;
- une base de plan supérieure au relevé suivant ;
- une suite de pleins non croissante.

Le chef régularise ces objets depuis cette liste.
- **Justification** : Les calculs lisent un seul relevé actif, l'original reste traçable, et le blocage n'intervient que sur une incohérence réelle. Le sens des liens est structurant pour le schéma.

### D-165 — [5.3 / 18 (T13)] Correction qui rend des données dépendantes incohérentes

- **Ambiguïté** : Le CDC dit « bloquer ou régulariser », sans trancher entre les deux.
- **Options** : Cascade automatique / Refus explicite avec liste, puis parcours de correction ordonné
- **Décision** : Option 2. La correction est refusée (409 CORRECTION_INCOHERENTE) avec la liste des éléments en conflit. Sinon, une transaction marque l'original REMPLACE, accepte le remplacement, puis recalcule utilisations, plans, consommations, calibrage et alertes. Fichiers prévus : apps/api/src/modules/odometer/odometer.service.ts, apps/api/test/integration/odometer.int.spec.ts.
- **Justification** : Un relevé n'est jamais écrasé (5.3).

### D-166 — [5.4] Remplacement de compteur : autorisation, relevé de clôture, justificatif, rétroactivité

- **Ambiguïté** : Le CDC dit « remplacement autorisé » sans nommer la permission. Il n'est pas clair si le justificatif est une pièce jointe obligatoire. La « dernière distance cumulée validée » perd les km parcourus entre le dernier relevé et le remplacement. Le cas d'un relevé rétroactif inséré dans un segment clos n'est pas traité.
- **Options** : Permission readings.correct / Nouvelle permission dédiée / Relevé de clôture obligatoire ou facultatif
- **Décision** : POST /vehicles/:id/odometer-segments de type REMPLACEMENT, réservé à readings.correct (administrateur, chef).

Contenu :
- motif obligatoire ;
- pièce jointe facultative, signalée « sans justificatif » si absente ;
- valeur finale de l'ancien compteur si elle est lisible (relevé de clôture ACCEPTE). Sinon, base = dernier cumul validé et le segment est marqué « distance de transition inconnue ».

Relevé rétroactif dans un segment clos : admis s'il respecte ses voisins et si son cumul ≤ startCumulativeKm du segment suivant ; sinon 422. Jamais de remplacement implicite.
- **Justification** : Conforme à 5.4 et 14.5, sans fabriquer de distance, avec une trace explicite de ce qui manque.

### D-167 — [5.4 / 12.2] Initialisation du premier segment et « cumul incomplet »

- **Ambiguïté** : Le CDC ne dit pas quand le premier segment est créé (à la création du véhicule, au premier relevé ou par une action explicite), ni comment déclarer un historique inconnu. La colonne d'import meter_reference n'est pas définie.
- **Options** : Segment créé avec la fiche véhicule / Segment créé au premier relevé accepté / Initialisation explicite obligatoire
- **Décision** : La création de la fiche véhicule ne crée pas de segment : km NULL, fraîcheur INCONNU.

Le premier relevé accepté crée le segment 1 dans la même transaction, avec physique = cumulé.

Initialisation explicite (administrateur, chef) pour :
- déclarer une base cumulée différente du physique (base technique validée) ;
- ou marquer cumulativeKnown=false (« cumul incomplet ») ; les plans km restent alors INCOMPLET sans base.

Conducteur sur un véhicule sans segment : EN_ATTENTE, et le segment est créé à l'approbation. Import : meter_reference = numéro de séquence du segment (1 par défaut) ; une séquence inexistante est refusée.
- **Justification** : Respecte « kilométrage inconnu NULL, jamais zéro » et « ne pas fabriquer une distance ».

### D-168 — [5.4 / 13.2 / T14] Unicité par instant et changement de compteur — **irreversible**

- **Ambiguïté** : L'index unique partiel (vehicleId, observedAt) sur les relevés physiques acceptés empêche deux relevés au même instant T du remplacement : le relevé de clôture de l'ancien compteur (120 000) et le relevé initial du nouveau (0). Sans relevé dans le nouveau segment, le compteur courant afficherait encore 120 000 en physique.
- **Options** : Décaler artificiellement l'instant du second relevé / Index unique sur (segmentId, observedAt) / Pas de relevé initial ; compteur courant lu sur le segment
- **Décision** : Remplacer l'index par un index unique partiel sur (segmentId, observedAt) WHERE status='ACCEPTE' AND isEstimate=false.

Bornes des segments : ]début, T] pour l'ancien (clôture incluse à T), [T, …[ pour le nouveau. Non-chevauchement garanti par EXCLUDE gist sur tstzrange par véhicule, en migration SQL.

Compteur courant : tri par observedAt décroissant, puis par séquence de segment décroissante.
- **Justification** : Modélise T14 fidèlement sans instant forgé. La contrainte doit être posée avant les premières données.

### D-169 — [5.4 / 14.5 / 18 (T14, T40)] Remplacement du compteur de bord alors qu'un flux CAN est actif

- **Ambiguïté** : Après remplacement du compteur, le CAN remonte la nouvelle valeur (par ex. 500), qui passe en attente comme une régression tant que le segment n'a pas été créé. Le CDC ne dit pas ce que deviennent ensuite ces relevés en attente, ni le calibrage GPS rattaché à l'ancien segment.
- **Options** : Laisser le chef traiter les relevés en attente un par un / Réévaluer automatiquement les relevés en attente dès la création du segment / Laisser le connecteur créer le segment
- **Décision** : Option 2. À la création d'un segment (POST /vehicles/:id/odometer-segments), les relevés TELEMATICS EN_ATTENTE observés à partir du début du segment sont réévalués par l'ingestion unique. Ceux qui sont cohérents sont rattachés au nouveau segment et acceptés ; les autres restent en attente. Les calibrages DISTANCE_GPS passent NON_CALIBRABLE jusqu'au prochain relevé manuel dans le nouveau segment. Le connecteur ne crée jamais de segment. Fichiers prévus : apps/api/src/modules/odometer/odometer.service.ts, apps/api/src/modules/odometer/odometer-ingestion.service.ts, apps/api/src/domain/gps-calibration.ts, apps/api/test/integration/odometer.int.spec.ts.
- **Justification** : 14.5 interdit tout remplacement de compteur implicite. Le recalcul des données dépendantes (5.3) évite un traitement manuel fastidieux.

### D-170 — [5.5 / 1.1 / 3.1] Sens de « au-delà de sept jours » pour la fraîcheur

- **Ambiguïté** : S'agit-il d'une durée écoulée (7 × 24 h) ou de jours civils locaux ? Quels relevés comptent (les estimations GPS ?) La synthèse doit afficher le « dernier relevé validé », alors que le compteur courant peut être une estimation.
- **Options** : Durée écoulée, toutes sources acceptées ; synthèse sur deux lignes / Jours civils locaux / Relevés mesurés seulement
- **Décision** : freshness.ts : INCONNU si aucun relevé n'est accepté ; A_ACTUALISER si maintenant − observedAt du dernier relevé accepté, toutes sources confondues et estimations comprises (5.6), dépasse staleReadingDays × 24 h (7 jours) ; sinon A_JOUR. La synthèse du véhicule affiche deux lignes : « Compteur courant », éventuellement « estimé GPS » avec la date de sa référence, et « Dernier relevé mesuré » (MANUAL, IMPORT ou CAN). Le « dernier kilométrage validé » de 1.1 est le dernier relevé accepté toutes sources, avec sa source affichée. alert-catch-up évalue la fraîcheur, au plus 15 min après le seuil. Fichiers : apps/api/src/domain/freshness.ts, apps/api/src/domain/freshness.spec.ts, apps/api/src/modules/vehicles/vehicles.service.ts, apps/web/app/(app)/vehicules/[id]/page.tsx.
- **Justification** : Colle à 5.5 et 5.6 (toutes sources confondues) et ne présente jamais une estimation comme une mesure (11.3).

### D-171 — [5.5 / 6.2 / 7.1 / 9.1] Alertes et statuts des véhicules qui ne sont pas ACTIF

- **Ambiguïté** : Le CDC ne dit pas si un véhicule HORS_SERVICE, CEDE, ARCHIVE ou immobilisé doit générer des alertes d'entretien, de kilométrage, de document ou de GPS.
- **Options** : Alertes pour tous les véhicules / Alertes limitées aux véhicules ACTIF
- **Décision** : HORS_SERVICE : statuts calculés et affichés, mais aucune alerte ; les alertes existantes sont résolues avec le motif « véhicule hors service ».

CEDE ou ARCHIVE : plans désactivés, mappings clôturés, alertes résolues.

ACTIF immobilisé : alertes conservées, mais « kilométrage ancien » en INFO, sans e-mail.
- **Justification** : Évite le bruit sans masquer l'état réel, et reste cohérent avec 11.1 (les hors service ne gonflent pas le parc).

### D-172 — [5.5 / T12] Fraîcheur : mode de calcul du seuil, relevés pris en compte et nom des états

- **Ambiguïté** : « Au-delà de sept jours » : durée ou jours civils ? Le CDC ne dit pas si les estimations GPS rafraîchissent, ni comment s'appelle l'état frais, qui risque d'être confondu avec A_JOUR des plans (T12 met en garde contre un « faux à jour »).
- **Options** : 168 h glissantes / Jours civils locaux / Estimations GPS incluses ou exclues
- **Décision** : A_ACTUALISER si maintenant − observedAt du dernier relevé ACCEPTE > `odometer.freshness.maxAgeHours` (168 h), toutes sources confondues, estimations comprises (5.6).

États : INCONNU, RECENT (libellé « Relevé récent »), A_ACTUALISER.

Pour un véhicule en DISTANCE_GPS, l'âge de la dernière référence manuelle est affiché en plus. Destinataires de l'alerte : chefs de la société courante. Implémentation dans apps/api/src/domain/freshness.ts.
- **Justification** : Une durée ne dépend pas du fuseau et se teste avec l'horloge contrôlable. Le nom distinct évite toute confusion avec A_JOUR.

### D-173 — [5.6] Aide de saisie lors d'une remise ou d'une restitution

- **Ambiguïté** : « Propose la dernière valeur automatique comme aide » : préremplir le champ risquerait qu'on valide sans lire le compteur.
- **Options** : Préremplir le champ / Afficher la valeur à côté du champ, sans préremplissage
- **Décision** : Option 2. La valeur est lue en base, jamais par un appel synchrone au fournisseur, et masquée si la source est muette. Le relevé est enregistré en source MANUAL. Fichiers prévus : apps/web/app/(app)/utilisations/[id]/page.tsx, apps/api/src/modules/usages/usages.service.ts.
- **Justification** : « La valeur enregistrée reste celle lue sur le tableau de bord » (5.6).

### D-174 — [5.6] Référence de calibrage : distance GPS à l'instant du manuel, absence de référence, références tardives

- **Ambiguïté** : La distance GPS à l'instant exact d'un relevé manuel est rarement connue (échantillons toutes les 15 min, historisation horaire). Le CDC ne traite ni le véhicule nouvellement mappé sans relevé manuel, ni les relevés IMPORT ou les relevés conducteur approuvés plus tard, ni le sort des estimations déjà historisées.
- **Options** : Échantillon le plus proche / Interpolation linéaire entre les échantillons encadrants / Recalcul rétroactif des estimations
- **Décision** : distanceGpsReference :
- interpolation linéaire entre les deux TelemetryOdometerSample (rétention de 90 j) qui encadrent observedAt, si leur écart est ≤ 2 h ;
- sinon, échantillon le plus proche à ±15 min ;
- sinon, calibrage NON_CALIBRABLE et l'ancien reste en vigueur.

Sont des références : les relevés physiques MANUAL et IMPORT acceptés, y compris ceux d'un conducteur approuvés plus tard. Sans aucune référence, aucune estimation n'est produite.

Une référence tardive ne vaut que pour les échantillons ultérieurs : les estimations historisées ne sont jamais réécrites.

Le calcul se fait en km cumulés ; le physique affiché = cumulé − décalage du segment. Un nouveau segment ou un changement de mapping réinitialise la référence.
- **Justification** : Respecte la formule de 5.6 sans inventer de valeur, garde « jamais écrasé » pour les estimations acceptées et reste correct après un remplacement de compteur.

### D-175 — [5.6 / 3.2] Unités mappées sur un véhicule non ACTIF

- **Ambiguïté** : L'acceptation automatique suppose un véhicule actif à la date d'observation. Un véhicule HORS_SERVICE, CEDE ou ARCHIVE dont le mapping reste ouvert produirait un relevé EN_ATTENTE chaque heure. Le lien entre cession ou archivage et mapping n'est pas défini.
- **Options** : Mettre en attente chaque échantillon / Clore le mapping à la cession ou à l'archivage, et limiter les mises en attente pour HORS_SERVICE
- **Décision** : Option 2. La cession et l'archivage clôturent automatiquement le mapping ouvert (validTo = date de l'opération, audit). Pour un véhicule HORS_SERVICE, l'état de l'unité est mis à jour et au plus un relevé EN_ATTENTE par jour est créé, avec le motif VEHICULE_NON_ACTIF, sans recalcul d'entretien. Fichiers prévus : apps/api/src/modules/vehicles/vehicles.service.ts, apps/api/src/modules/telemetry/telemetry.service.ts, apps/api/test/integration/telemetry.int.spec.ts.
- **Justification** : On évite l'inondation de relevés en attente, et le cycle de vie reste distinct des événements (3.2).

### D-176 — [5.6 / 4.3] Aide de saisie : dernière valeur automatique proposée à la remise ou restitution

- **Ambiguïté** : Préremplir le champ avec la valeur GPS pousserait à l'accepter sans lire le tableau de bord. Le GPS se calibrerait alors sur lui-même, ce qui viderait de sens la « référence manuelle ».
- **Options** : Préremplir le champ / Afficher l'aide à côté d'un champ vide / Ne rien afficher
- **Décision** : Champ jamais prérempli. L'aide est affichée à côté, avec sa nature et son âge (« CAN, il y a 12 min » ou « estimé GPS, réf. du … »). Si la valeur saisie est égale à une estimation DISTANCE_GPS, une case « valeur lue sur le tableau de bord » est exigée. Les estimations sont libellées comme telles dans les écrans et les exports.
- **Justification** : Applique « la valeur enregistrée reste celle lue sur le tableau de bord » et protège la qualité du calibrage.

### D-177 — [5.6 / 5.2 / 18 (T37, T40)] Conflit entre COMPTEUR_CAN et relevé manuel

- **Ambiguïté** : Le COMPTEUR_CAN est « traité comme un compteur physique ». Il a une résolution décimale (50 120,4) alors que la saisie manuelle est entière (50 120) : la saisie apparaîtrait comme une diminution. Et si le CAN diverge réellement, un relevé CAN accepté pourrait bloquer une remise, alors qu'« une panne fournisseur ne bloque aucun parcours manuel ». On ignore aussi comment invalider un relevé TELEMATICS accepté à tort.
- **Options** : Tolérance silencieuse de N km / Aligner sur la résolution d'affichage, puis faire arbitrer le chef / Ignorer le CAN dans les contrôles des saisies manuelles
- **Décision** : Option 2. La comparaison entre manuel et CAN se fait sur floor(valeur CAN), c'est-à-dire la résolution entière d'affichage. Au-delà, le relevé manuel passe EN_ATTENTE avec le motif CONFLIT_CAN. Le chef, qui a readings.approve et readings.correct, arbitre directement dans le formulaire de remise ou de restitution : il invalide les relevés CAN contradictoires (statut REJETE, motif, audit), puis accepte le relevé manuel. L'opérateur peut demander l'exception « départ sans relevé » au chef. Symétriquement, un CAN inférieur au dernier relevé physique arrondi passe EN_ATTENTE (T40). Fichiers prévus : apps/api/src/domain/odometer-rules.ts, apps/api/src/modules/odometer/odometer.service.ts, apps/api/src/modules/odometer/dto/correct-reading.dto.ts, apps/api/test/integration/odometer.int.spec.ts.
- **Justification** : On n'invente pas de tolérance sur une diminution (5.2), mais on évite les faux conflits d'arrondi. L'arbitrage revient au chef (2.2).

### D-178 — [5.6 / 5.2 / 18 (T39)] Relevés estimés GPS dans le contrôle de chronologie des relevés physiques

- **Ambiguïté** : Une DISTANCE_GPS calibrée devient un relevé accepté qui compte pour le compteur courant. Si elle servait de voisin chronologique, la restitution manuelle à 80 960, postérieure à l'estimation à 81 000 (T39), serait une « diminution inexpliquée » et serait refusée. De plus, après un recalibrage, l'estimation suivante peut être inférieure à la précédente.
- **Options** : Traiter les estimations comme des voisins ordinaires / Exclure les estimations du contrôle de chronologie des relevés physiques et leur appliquer un contrôle propre / Ne pas stocker les estimations comme des relevés
- **Décision** : Option 2 :
1. Les voisins chronologiques d'un relevé MANUAL, IMPORT ou COMPTEUR_CAN sont uniquement les relevés ACCEPTE non estimés du segment.
2. Une estimation est acceptée si la distance GPS brute croît dans le mapping, si le km estimé est ≥ au dernier relevé physique accepté antérieur et si la plausibilité est respectée. Elle n'est jamais comparée aux estimations antérieures.
3. Le compteur courant reste le plus récent selon observedAt, toutes sources confondues, avec le libellé « estimé GPS (réf. manuelle du JJ/MM) ».
4. L'index unique « un relevé accepté par instant » exclut les estimations.
Fichiers prévus : apps/api/src/domain/odometer-rules.ts, apps/api/src/domain/gps-calibration.ts, apps/api/src/domain/odometer-rules.spec.ts, apps/api/src/modules/odometer/odometer-ingestion.service.ts, apps/api/test/integration/telemetry.int.spec.ts.
- **Justification** : T39 exige que le relevé soit accepté et devienne la nouvelle référence (80 960). Une estimation ne doit jamais bloquer une saisie manuelle (5.6).

### D-179 — [5.6 / 6.1] Plan limité aux relevés manuels ou COMPTEUR_CAN

- **Ambiguïté** : Le CDC ne dit pas quel kilométrage et quelle fraîcheur s'appliquent à un plan restreint, ni comment signaler un statut atteint via une estimation.
- **Options** : km = compteur courant global / km = dernier relevé admissible pour le plan
- **Décision** : Avec acceptedSources = MANUEL_OU_CAN : km du plan = dernier relevé ACCEPTE non estimé (MANUAL, IMPORT, COMPTEUR_CAN), et la fraîcheur affichée pour le plan porte sur ce relevé.

Avec TOUTES : un statut atteint via une estimation est libellé « selon estimation GPS ».

Changer ce paramètre relance le calcul, avec prévisualisation.
- **Justification** : Rend le paramètre de 5.6 opérationnel sans masquer l'origine de la donnée.

### D-180 — [5.6 / 6.1] Sources de relevés admises par défaut pour les plans d'entretien

- **Ambiguïté** : Le CDC autorise un plan limité aux relevés manuels ou CAN, sans dire quel est le réglage par défaut.
- **Options** : MANUEL_OU_CAN par défaut / TOUTES par défaut, avec badge « estimé GPS »
- **Décision** : Option 2. Défaut TOUTES pour les alertes, avec un badge qui signale l'estimation. La clôture exige toujours un relevé physique. Le réglage est modifiable par plan ou par modèle. Fichiers prévus : apps/api/src/domain/maintenance-schedule.ts, apps/api/src/modules/maintenance/maintenance.service.ts, apps/api/src/domain/maintenance-schedule.spec.ts.
- **Justification** : L'objectif de F11 est d'accélérer les alertes, en restant honnête sur la nature estimée.

### D-181 — [5.6 / 9.3 / 17.1 (T42)] Historisation horaire des relevés TELEMATICS face à l'alerte en une minute — **contradiction-cdc**

- **Ambiguïté** : Un relevé TELEMATICS n'est historisé qu'une fois par heure (plus une fois par jour), et seuls les relevés acceptés participent aux calculs. Or T42 attend A_FAIRE « au plus une minute après ingestion » de 90 000, alors que 89 500 a pu être historisé quelques minutes avant. Avec le seul plafond horaire, l'échéance serait détectée jusqu'à une heure trop tard. Le relevé « à minuit local » n'est pas défini : faut-il fabriquer une valeur à 00:00 ?
- **Options** : Plafond horaire, avec exceptions au franchissement d'un seuil d'échéance / Calculer les échéances depuis TelemetryUnitState, hors relevés acceptés / Historiser à chaque synchronisation
- **Décision** : Règle d'historisation (fonction pure). Un échantillon devient un OdometerReading si : (a) il progresse et 60 min au moins se sont écoulées depuis le dernier relevé TELEMATICS historisé du véhicule ; (b) c'est le premier échantillon du jour local (relevé quotidien, même sans progression, avec l'observedAt réel de l'échantillon et jamais un 00:00 fabriqué) ; (c) c'est le premier échantillon après la confirmation du mapping ou après une période de source muette ; (d) il franchit un seuil d'un plan actif qui accepte cette source (échéance − préavis, échéance, échéance + 1 km) ou le seuil de fraîcheur. Chaque relevé historisé recalcule plans et alertes dans la même transaction, donc en moins d'une minute. TelemetryUnitState est mis à jour à chaque synchronisation. Le volume supplémentaire reste borné par le nombre de seuils. Fichiers : apps/api/src/modules/telemetry/telemetry.service.ts, apps/api/src/domain/maintenance-schedule.ts, apps/api/src/modules/odometer/odometer.service.ts, apps/worker/src/jobs/telemetry-sync.job.ts, apps/api/test/integration/telemetry.int.spec.ts (T42).
- **Justification** : Garde « seuls les relevés acceptés participent » et l'objectif de volume tout en respectant T42. L'exception (d) déroge à « au plus une fois par heure ».

### D-182 — [5.6 / 9.3 / T38 / T42] Historisation au plus horaire contre alerte d'entretien en moins d'une minute — **contradiction-cdc**

- **Ambiguïté** : Un relevé TELEMATICS n'est historisé qu'une fois par heure au plus, et seuls les relevés acceptés participent aux calculs. Si le CAN passe de 89 500 à 90 000 en moins d'une heure, l'échéance ne bouge pas avant l'heure suivante. Or T42 exige A_FAIRE et une alerte au plus une minute après ingestion, et T38 attend une estimation juste après la référence. La notion de « progression » n'est pas quantifiée non plus (gigue GPS à l'arrêt).
- **Options** : Respecter strictement le plafond horaire (T42 échoue) / Évaluer les plans sur TelemetryUnitState non historisé / Historisation forcée hors fenêtre lors d'un franchissement de seuil
- **Décision** : Dans le service d'ingestion (apps/api/src/modules/odometer), l'historisation est forcée hors fenêtre dans trois cas :
- la valeur candidate changerait le statut d'au moins un plan actif (évalué par maintenance-schedule.ts) ;
- c'est le premier échantillon après une nouvelle référence de calibrage, un nouveau mapping ou un nouveau segment ;
- sans elle, la fraîcheur passerait A_ACTUALISER.

Sinon : fenêtre glissante de 60 min sur observedAt depuis le dernier relevé historisé, et progression ≥ `telemetry.historize.minProgressKm` (1 km par défaut).

Plans et alertes sont recalculés dans la même transaction que l'ingestion.
- **Justification** : Le plafond sert à maîtriser le volume (2 M relevés/an). Les franchissements de seuil sont rares, donc la dérogation reste bornée. Évaluer les plans sur un état non historisé violerait « seuls les relevés acceptés participent aux calculs ». La décision contredit la lettre « au plus une fois par heure ».

### D-183 — [5.6 / 13.3] Concurrence entre l'ingestion du worker et les parcours manuels

- **Ambiguïté** : L'ingestion télématique et une remise peuvent modifier le même véhicule en même temps. Un conflit de sérialisation ne doit pas faire échouer la remise (« ne bloque ni une remise »).
- **Options** : Serializable seul, avec reprise / Verrou consultatif par véhicule, priorité à l'utilisateur / File séparée sans verrou
- **Décision** : Le service d'ingestion unique prend pg_advisory_xact_lock(hash(vehicleId)), toujours dans le même ordre (véhicule puis utilisation), en Serializable avec 3 reprises sur P2034.

Le worker utilise lock_timeout = 2 s et reporte le véhicule au cycle suivant. Les requêtes utilisateur attendent le verrou, avec une reprise bornée.
- **Justification** : Donne la priorité aux parcours manuels, conformément à 13.3 et 5.6.

### D-184 — [5.6 / 14.3 / 18 (T36)] Idempotence télématique sans sourceReference et dédoublonnage des événements carburant — **irreversible**

- **Ambiguïté** : La clé de repli (unité, observedAt, valeur) n'est portée par aucun index. Le CDC ne dit rien d'une même sourceReference arrivant avec une valeur différente, ni d'un événement carburant rejoué avec des fenêtres légèrement décalées.
- **Options** : Ajouter un second index unique de repli / sourceReference synthétique et déterministe, avec un seul index
- **Décision** : Option 2 :
- Référence de repli = « fp: » + SHA-256 de (fournisseur, unité, nature, observedAt à la ms, valeur à 3 décimales).
- Même référence avec une valeur différente : échantillon ignoré et compté en conflit dans TelemetrySyncRun.
- Échantillons bruts : ON CONFLICT DO NOTHING.
- Clé de dédoublonnage FuelEvent = type, véhicule et observedAt du premier échantillon de l'épisode.
- Canal RAPPORT : SHA-256 du fichier, puis idempotence ligne par ligne.
Fichiers prévus : apps/api/src/modules/telemetry/telemetry-ingestion-keys.ts, apps/api/src/modules/odometer/odometer-ingestion.service.ts, apps/api/src/domain/fuel-events.ts, apps/api/test/integration/telemetry.int.spec.ts.
- **Justification** : Un seul index couvre les deux cas de 5.6 et T36. Changer ce format plus tard produirait des doublons.

### D-185 — [5.6 / 14.4] Flot de relevés automatiques EN_ATTENTE et reprise initiale

- **Ambiguïté** : Après une régression (boîtier changé) ou un saut, chaque relevé horaire suivant serait mis EN_ATTENTE : des centaines de relevés. La reprise d'historique (14.4) peut aussi entrer en conflit avec des relevés manuels existants.
- **Options** : Un relevé EN_ATTENTE par heure / Un relevé en attente par jour au plus tant que l'anomalie dure / Suspension automatique du mapping
- **Décision** : Tant qu'une anomalie est ouverte sur un mapping : au plus un relevé EN_ATTENTE par unité et par jour local, le reste en échantillons, et une seule alerte RELEVE_A_VALIDER avec compteur.

Le chef rejette, corrige, clôture le mapping ou déclare un remplacement de compteur. Aucun incident automatique.

Reprise initiale : relevés quotidiens uniquement. Une valeur en conflit avec un relevé manuel existant est ignorée, gardée en échantillon et comptée ; elle n'est jamais mise en attente.
- **Justification** : Garde la file de validation exploitable, conformément à la règle « ne bloque pas le manuel ».

### D-186 — [5.6 / 14.5] Conditions d'acceptation automatique : mapping, véhicule actif, société sans F11

- **Ambiguïté** : « Unité mappée à un véhicule actif à la date d'observation » : le CDC ne précise pas le point de départ du mapping (confirmation ou antidatage pour la reprise), le sort d'un véhicule HORS_SERVICE, CEDE ou ARCHIVE, ni celui d'une société sans telemetryEnabled.
- **Options** : validFrom = instant de confirmation / validFrom choisi par le chef, borné / Ingestion de tout l'historique disponible
- **Décision** : Un échantillon est ingéré seulement si :
- un mapping CONFIRME couvre observedAt (validFrom ≤ observedAt < validTo). validFrom vaut par défaut l'instant de confirmation ; il est antidatable dans la limite de la reprise initiale, jamais avant le dernier transfert ni le début du segment ouvert ;
- la société courante a telemetryEnabled=true et est couverte par le fournisseur.

Cas particuliers :
- Véhicule HORS_SERVICE : EN_ATTENTE VEHICULE_NON_ACTIF.
- Véhicule CEDE ou ARCHIVE : échantillon ignoré, compté dans TelemetrySyncRun, avec une alerte invitant à clôturer le mapping.
- Échantillon antérieur à validFrom : ignoré et compté.
- **Justification** : Applique « aucun relevé avant confirmation » tout en permettant la reprise initiale de 14.4, sans rattacher de kilomètres à la mauvaise société.

### D-187 — [5.6 / 17.1] Relevé quotidien de minuit local, seuil de progression, échantillons en désordre

- **Ambiguïté** : Pour le relevé « une fois par jour à minuit local », rien ne dit quelle valeur prendre, avec quel observedAt, ni s'il faut le créer sans progression. « A progressé » n'est pas chiffré, alors que le bruit GPS à l'arrêt produit quelques centaines de mètres. On ignore aussi s'il s'agit d'une fenêtre glissante ou d'une heure pleine, et ce qu'on fait des échantillons reçus en retard.
- **Options** : Heure pleine, avec un relevé de minuit horodaté 00:00 / Fenêtre glissante, progression minimale, relevé de minuit sur le dernier échantillon réel de la journée
- **Décision** : Option 2 :
- Fenêtre glissante de 60 min sur observedAt.
- Progression = valeur ≥ dernière valeur historisée + telemetry.minProgressKm (1 km).
- Au premier passage après 00:00 dans le fuseau du groupe, le job historise le dernier échantillon de la journée locale écoulée, avec son observedAt réel (jamais un 00:00 inventé), même sans progression, s'il n'est pas déjà historisé.
- Si aucune donnée n'est arrivée dans la journée, on ne crée rien : l'alerte de source muette prend le relais.
- Un échantillon plus ancien que lastHistorizedAt n'alimente que les échantillons bruts, sauf pendant une reprise initiale.
Fichiers prévus : apps/api/src/modules/telemetry/telemetry.service.ts, apps/worker/src/jobs/telemetry-sync.job.ts, apps/api/src/domain/civil-date.ts, apps/api/test/integration/telemetry.int.spec.ts.
- **Justification** : Le relevé quotidien maintient la fraîcheur d'un véhicule à l'arrêt (5.5) sans fabriquer d'observation. Le seuil de progression évite de stocker du bruit.

### D-188 — [5.6 / 17.1] Relevé quotidien « à minuit local »

- **Ambiguïté** : Le CDC ne dit pas si le relevé quotidien est créé à 00:00 avec un observedAt forgé, s'il exige une progression, ni quel échantillon utiliser.
- **Options** : Relevé daté 00:00 avec interpolation / Dernier échantillon réel de la journée locale, même sans progression / Relevé quotidien seulement s'il y a progression
- **Décision** : Pour chaque jour civil (fuseau de l'organisation), historiser le dernier échantillon observé avant 00:00 locale, avec son observedAt réel, même sans progression. Idempotence par (véhicule, jour local). Création par la première synchronisation après minuit (apps/worker/src/jobs/telemetry-sync.job.ts). Pas d'échantillon ce jour-là : rien n'est créé.
- **Justification** : Sans relevé quotidien sans progression, un véhicule garé dont le boîtier fonctionne passerait A_ACTUALISER à tort. Forger une observation à minuit inventerait une donnée.

### D-189 — [5.6 / 17.1 / 18 (T31, T41)] Source GPS muette : définition et fournisseur injoignable

- **Ambiguïté** : « Sans donnée » peut vouloir dire : pas de réponse, pas de nouvel observedAt, ou pas de progression. Certains fournisseurs renvoient la dernière valeur avec un observedAt ancien. Le cas d'un mapping jamais alimenté n'est pas traité, et le « régime manuel » n'est pas défini.
- **Options** : Se baser sur receivedAt / Se baser sur l'observedAt du dernier échantillon
- **Décision** : Option 2 :
- Source muette si maintenant − max(dernier observedAt, validFrom du mapping) dépasse 24 h.
- Évaluation par le rattrapage, même quand le fournisseur est injoignable.
- Clé d'alerte = mapping + dernier observedAt ; résolution à la réception d'un échantillon plus récent.
- Régime manuel = bandeau invitant à saisir un relevé, aide de remise masquée, fraîcheur calculée toutes sources confondues.
Fichiers prévus : apps/api/src/domain/freshness.ts, apps/api/src/modules/alerts/alerts.service.ts, apps/worker/src/jobs/alert-catch-up.job.ts, apps/api/test/integration/telemetry.int.spec.ts.
- **Justification** : Cela couvre T31 et T41 avec des unités déjà mappées, sans fausse fraîcheur.

### D-190 — [5.6 / 17.1 / 18 (T39)] Formule, arrondi et bornes de la dérive GPS

- **Ambiguïté** : Le pourcentage est pris « de la distance parcourue depuis la référence » : distance estimée (40/1 000 = 4,0 %) ou distance manuelle (40/960 ≈ 4,17 %) ? T39 attend 4,2 %. Plusieurs points restent ouverts : l'arrondi, le sens de la comparaison au seuil de 3 % (> ou ≥), le cas des petites distances (1 km d'écart sur 5 km = 20 %) et la résolution de l'alerte.
- **Options** : Dénominateur = distance estimée / Dénominateur = distance manuelle, avec une distance minimale d'évaluation
- **Décision** : Option 2 :
- dérive % = |km estimé à l'instant − km manuel| / (km manuel − km de référence) × 100, calculée en décimal non arrondi.
- Alerte GPS_DERIVE si la dérive dépasse strictement telemetry.driftPercent (3) et si la distance manuelle est ≥ telemetry.driftMinDistanceKm (50). En dessous, l'écart est seulement historisé.
- Affichage à une décimale (« 4,2 % »).
- Clé d'occurrence = mapping ; l'alerte est résolue au prochain calibrage sous le seuil.
- Le relevé devient toujours la nouvelle référence.
Fichiers prévus : apps/api/src/domain/gps-calibration.ts, apps/api/src/domain/gps-calibration.spec.ts, apps/api/test/integration/telemetry.int.spec.ts.
- **Justification** : Seul le dénominateur manuel redonne les 4,2 % de T39. La distance minimale évite des alertes absurdes sur de courts trajets.

### D-191 — [5.6 / 17.1 / T39] Calcul du pourcentage de dérive GPS

- **Ambiguïté** : Le dénominateur n'est pas défini : « distance parcourue depuis la référence », mesurée ou estimée ? Le CDC ne traite pas non plus les petites distances (pourcentages extrêmes), le signe, l'arrondi, ni la résolution de l'alerte.
- **Options** : Dénominateur = distance manuelle réelle / Dénominateur = distance estimée / Pas de seuil de distance minimale
- **Décision** : écart% = |kmEstimé à l'instant du manuel − kmManuel| / (kmManuel − kmRéférencePrécédente) × 100. Pour T39 : 40/960 = 4,17 %, affiché 4,2 %.

La comparaison au seuil de 3 % (`telemetry.drift.maxPercent`) se fait sur la valeur non arrondie. L'alerte GPS_DERIVE n'est levée que si la distance ≥ `telemetry.drift.minDistanceKm` (50 km) ; sinon l'écart est seulement historisé dans TelemetryCalibration.

Le relevé manuel devient la nouvelle référence dans tous les cas. Une alerte par mapping, résolue par un calibrage éligible sous le seuil. Implémentation dans apps/api/src/domain/gps-calibration.ts.
- **Justification** : C'est le seul dénominateur qui donne 4,2 % dans T39. Le plancher de distance évite les faux positifs sur les courses courtes (remise puis restitution après 10 km).

### D-192 — [5.6 / 17.1 (T39)] Formule de la dérive GPS et cas limites

- **Ambiguïté** : « Écart en pourcentage de la distance parcourue depuis la référence » : distance manuelle ou estimée ? À quel instant prendre l'estimation ? Que faire sur de très petites distances, où la division tend vers zéro ? T39 annonce 4,2 %.
- **Options** : Dénominateur = distance manuelle, distance minimale de 50 km / Dénominateur = distance estimée / Écart absolu en km
- **Décision** : ecartPct = |kmEstimé(t) − kmManuel| / (kmManuel − kmRéférence) × 100, où t est l'observedAt du relevé manuel. kmEstimé(t) utilise le dernier échantillon distanceGps antérieur ou égal à t, à condition qu'il date de 30 min au plus ; sinon, pas de mesure. T39 : |81 000 − 80 960| / 960 = 4,17 %, affiché 4,2 %, supérieur à 3 %, donc alerte. Aucun calcul si la distance manuelle est inférieure à 50 km (driftMinDistanceKm) ou nulle. L'écart est historisé (GpsCalibrationSample) même sous le seuil. Une alerte « dérive GPS » par mapping, dédupliquée, résolue quand un écart suivant repasse sous le seuil. Fichiers : apps/api/src/domain/gps-calibration.ts, apps/api/src/domain/gps-calibration.spec.ts, apps/api/src/modules/telemetry/telemetry.service.ts.
- **Justification** : C'est la seule interprétation qui donne le 4,2 % de T39 (avec la distance estimée, on obtiendrait 4,0 %). La distance minimale évite des pourcentages absurdes.

### D-193 — [5.6 / 18 (T38, T39)] Référence de calibrage : quel relevé et quelle distance GPS

- **Ambiguïté** : Le CDC dit « chaque relevé manuel accepté (remise, restitution, entretien, relevé libre) ». On ignore si les relevés carburant, les imports, les soumissions conducteur approuvées et les saisies rétroactives comptent. La distance GPS exacte à l'instant du relevé manuel n'existe pas (échantillons discrets). L'effet d'une correction de la référence ou d'un changement de segment n'est pas défini.
- **Options** : Interpoler la distance GPS entre deux échantillons / Prendre le dernier échantillon antérieur dans un écart maximal / N'accepter comme référence que les relevés de remise ou de restitution
- **Décision** : Option 2 :
- Référence = tout relevé de source MANUAL accepté et non estimé (y compris CARBURANT et soumissions conducteur approuvées), hors IMPORT, dont l'observedAt est postérieur à celui de la référence courante.
- distanceGpsReference = dernier échantillon DISTANCE_GPS brut observé dans les 30 min qui précèdent le relevé (telemetry.calibrationMaxGapMinutes). À défaut, calibrage NON_CALIBRABLE avec motif : estimations suspendues, retour au régime manuel.
- Le calcul se fait dans le domaine physique du segment de la référence, puis est converti en cumul.
- Une saisie rétroactive enregistre la dérive sans changer la référence.
- La correction d'une référence ouvre un nouveau calibrage ; les estimations passées restent rattachées à l'ancien.
Fichiers prévus : apps/api/src/domain/gps-calibration.ts, apps/api/src/domain/gps-calibration.spec.ts, apps/api/src/modules/telemetry/telemetry.service.ts.
- **Justification** : Cette règle respecte la formule de 5.6 (T38 : 80 000 + 450 = 80 450) sans fabriquer de distance (5.4).

### D-194 — [5.6 / T31 / T41] Source GPS muette : horodatage de référence et panne du fournisseur

- **Ambiguïté** : « Sans donnée » peut s'entendre de trois façons : aucune réception, aucune synchronisation réussie, ou aucun observedAt nouveau. Un fournisseur injoignable rendrait « muettes » les 500 unités à la fois. Le « régime manuel » n'est pas défini.
- **Options** : Référence receivedAt / Référence observedAt / Une alerte par unité, même en cas de panne globale
- **Décision** : La mutité se mesure sur le dernier observedAt de l'unité, pas sur receivedAt : un fournisseur qui renvoie une valeur périmée ne masque donc pas la panne.

- Fournisseur joignable : GPS_SOURCE_MUETTE par unité après `telemetry.silentSourceHours` (24 h).
- Coupe-circuit ouvert : GPS_SYNCHRO_EN_ECHEC immédiate, puis après 24 h une seule GPS_SOURCE_MUETTE agrégée par fournisseur et société (nombre d'unités), avec suppression des alertes par unité.

Résolution au premier échantillon frais. « Régime manuel » = simple badge d'affichage, sans changement de comportement.
- **Justification** : Satisfait T31 et T41 sans générer des centaines de doublons (9.2).

### D-195 — [5.6 / T36] Clé d'idempotence télématique et clé de repli — **irreversible**

- **Ambiguïté** : Le CDC définit deux clés : (fournisseur, unité, sourceReference) ou, à défaut, (unité, observedAt, valeur). Le schéma n'indexe que la première. La comparaison de valeur après conversion d'unités (m → km) et le cas même clé / valeur différente ne sont pas définis.
- **Options** : Deux index uniques partiels / sourceReference toujours renseignée, synthétique si besoin / Déduplication applicative seule
- **Décision** : L'adaptateur renseigne toujours sourceReference : l'identifiant fournisseur, sinon `syn:` + sha256(unité|observedAt ms|valeur km à 3 décimales|nature). La conversion m → km se fait avant l'empreinte (arrondi au mètre, half-up).

Index :
- un seul index unique partiel (providerId, providerUnitId, sourceReference) sur OdometerReading ;
- un index unique (unitId, kind, observedAt) sur TelemetryOdometerSample.

Même clé avec une valeur différente : on garde le premier et on compte l'erreur dans TelemetrySyncRun. Même principe pour FuelLevelSample et FuelEvent. Migration dans packages/db/prisma/migrations.
- **Justification** : Un seul index couvre les deux clés du CDC et rend T36 déterministe. Changer la clé une fois les données chargées imposerait une reprise d'historique.

### D-196 — [6.1 / 6.2 / 12.2] Plans partiellement initialisés et statut INCOMPLET

- **Ambiguïté** : Un plan km + date peut n'avoir qu'une base km, ou un km courant inconnu. Le CDC ne dit pas quand un tel plan est INCOMPLET plutôt qu'évalué sur le composant disponible.
- **Options** : INCOMPLET dès qu'un composant manque / Évaluer les composants disponibles et signaler le manque
- **Décision** : Chaque composant a sa propre base : dernière opération, base technique ou échéance initiale.

INCOMPLET seulement si aucun composant n'est évaluable (y compris un plan km seul avec km inconnu ou cumul incomplet), avec alerte ENTRETIEN_PLAN_INCOMPLET. Sinon, statut calculé sur les composants évaluables, avec l'indication « échéance date/km non initialisée ».

Base technique libellée « base technique (aucune opération) ».
- **Justification** : Applique « retenir le niveau le plus urgent et afficher séparément les données manquantes ».

### D-197 — [6.1 / 6.2 / 17.1] Seuils d'anticipation et intervalles en mois ou en jours

- **Ambiguïté** : « Intervalle en mois/jours » : exclusifs ou combinables ? Le CDC ne traite pas un préavis supérieur ou égal à l'intervalle, ni l'application des valeurs par défaut (500 km et/ou 30 jours) aux plans d'un seul composant.
- **Options** : Mois et jours cumulables / Mois ou jours, exclusifs / Préavis libre
- **Décision** : Mois ou jours, exclusifs (CHECK SQL). Les valeurs par défaut s'appliquent au seul composant présent.

Validations : noticeKm < intervalKm et noticeDays < durée minimale de l'intervalle (mois × 28), sinon 422.

Calcul : jours civils ajoutés tels quels ; mois via addMonths civil, ramené au dernier jour du mois (civil-date.ts).
- **Justification** : Évite les plans qui passent A_PREVOIR dès leur réalisation et fixe une arithmétique de dates sans ambiguïté.

### D-198 — [6.1 / 17.1] Copie d'un modèle de plan et modification d'un intervalle

- **Ambiguïté** : Le CDC ne traite pas la copie vers un véhicule qui a déjà un plan actif du même type, ni une modification ultérieure du modèle, ni le recalcul après changement d'intervalle.
- **Options** : Écraser le plan existant / Ignorer ou mettre à jour les seuls intervalles / Lien permanent avec le modèle
- **Décision** : La copie est un instantané ; templateId ne sert qu'à la traçabilité.

Si un plan actif du même type existe, choix par véhicule : l'ignorer, ou mettre à jour intervalles et seuils en gardant la base. Sinon, nouveau plan basé sur la dernière opération de ce type, ou INCOMPLET.

Changement d'intervalle : prévisualisation par plan (ancienne et nouvelle échéance, statut), application depuis la base courante, audit.
- **Justification** : Applique « la copie ne modifie pas rétroactivement les historiques » et la prévisualisation de 17.1.

### D-199 — [6.2 / 5.6 / 9.2] Recul du statut d'entretien quand un relevé physique corrige une estimation

- **Ambiguïté** : Une estimation GPS à 90 000 fait passer le plan A_FAIRE, puis un relevé manuel à 89 960 le ramène A_PREVOIR. Le CDC ne dit pas si l'alerte est résolue puis recréée à chaque oscillation.
- **Options** : Résoudre puis recréer l'alerte / Même occurrence avec gravité ajustée / Statut figé au plus urgent atteint
- **Décision** : Le statut suit le compteur courant et peut reculer. L'occurrence d'alerte (planId + échéance) est conservée : sa gravité baisse, et elle n'est résolue que sous A_PREVOIR ou après réalisation. Repasser le seuil réutilise la même occurrence.
- **Justification** : Respecte « résoudre seulement lorsque la condition cesse » et la déduplication de 9.2.

### D-200 — [6.2 / 7.1 / 9.3 / T16 / T21] Changement des statuts temporels au jour local et délais d'alerte

- **Ambiguïté** : Les statuts matérialisés (computedStatus) doivent changer à minuit local sans aucun événement déclencheur. Le moyen d'atteindre « 15 min après le seuil » et « 1 min après une validation » n'est pas précisé.
- **Options** : Recalcul global périodique / Date de prochaine transition matérialisée / Calcul à la lecture
- **Décision** : Matérialiser nextStatusChangeOn (date civile) pour chaque plan et chaque document. alert-catch-up.job.ts, toutes les 15 min, recalcule ceux dont la date est ≤ aujourd'hui local.

Les recalculs déclenchés par un relevé, une clôture, un document ou un retour se font dans la transaction métier : ils sont visibles dès le commit. L'horloge est injectée (clock.ts).
- **Justification** : Tient les deux objectifs de 9.3 à coût borné et reste testable avec l'horloge contrôlable.

### D-201 — [6.2 / 13.1 (T15, T42)] Bornes A_PREVOIR / A_FAIRE / EN_RETARD avec des kilomètres décimaux

- **Ambiguïté** : A_FAIRE correspond à « la valeur kilométrique exacte ». Avec un stockage en DECIMAL(15,3) et des valeurs CAN décimales (90 000,4), la fenêtre A_FAIRE se réduit à un point qu'on peut sauter. La borne du préavis (89 499 ou 89 500 ?) n'est pas précisée.
- **Options** : Comparaison sur le kilomètre entier (partie entière) / Comparaison décimale stricte / Tolérance de ±1 km
- **Décision** : maintenance-schedule.ts compare sur kmEntier = floor(kmCumulés), avec restant = échéance − kmEntier. restant > préavis : A_JOUR. 0 < restant ≤ préavis : A_PREVOIR (89 500 avec un préavis de 500 donne A_PREVOIR ; 89 499 donne A_JOUR). restant = 0 : A_FAIRE (de 90 000 à 90 000,999). restant < 0 : EN_RETARD (90 001, 90 200). Même logique sur la date civile locale : le jour J donne A_FAIRE, J+1 donne EN_RETARD. On retient le niveau le plus urgent entre km et date. Tests paramétrés reprenant T15, T16, T17 et T42. Fichiers : apps/api/src/domain/maintenance-schedule.ts, apps/api/src/domain/maintenance-schedule.spec.ts.
- **Justification** : Reproduit exactement les exemples de 6.2, fait correspondre le compteur manuel entier (13.1) et le CAN décimal, et garantit qu'un saut direct de 89 500 à 90 200 déclenche bien le retard.

### D-202 — [6.2 / T15 / T16 / T42] Bornes exactes de A_PREVOIR, A_FAIRE et EN_RETARD (km décimaux et jours locaux)

- **Ambiguïté** : A_FAIRE n'existe qu'« à la valeur kilométrique exacte ». Or les km sont en DECIMAL(15,3) et le CAN est décimal : 90 000,4 est-il EN_RETARD ? Les bornes de la fenêtre de préavis en jours ne sont pas précisées.
- **Options** : Comparaison décimale stricte / Comparaison sur le km entier / Tolérance autour de l'échéance
- **Décision** : restantKm = échéanceKm − floor(kmCumulé) :
- restant > préavis : A_JOUR ;
- 0 < restant ≤ préavis : A_PREVOIR ;
- restant = 0 : A_FAIRE ;
- restant < 0 : EN_RETARD.

j = échéanceDate − aujourd'hui local :
- 1 ≤ j ≤ préavis : A_PREVOIR ;
- j = 0 : A_FAIRE ;
- j < 0 : EN_RETARD.

Statut final = le plus urgent des composants évaluables.

T15 donne 89 500 → A_PREVOIR, 90 000 → A_FAIRE, 90 200 → EN_RETARD ; un saut direct 89 500 → 90 200 donne EN_RETARD. Aucune tolérance ajoutée. La saisie manuelle est en km entiers. Implémentation dans maintenance-schedule.ts.
- **Justification** : Colle à la lettre et aux exemples de recette. La comparaison entière est cohérente avec « affichage compteur entier ».

### D-203 — [6.3] Référence et total d'une intervention

- **Ambiguïté** : Le CDC ne précise ni le format de la référence, ni son unicité, ni le lien entre le total et les lignes.
- **Options** : Référence saisie librement / Référence générée par le serveur / Total saisi ou calculé
- **Décision** : Référence générée par le serveur, immuable, au format INT-AAAA-NNNNNN (séquence par organisation et par année, compteur verrouillé).

Total TTC = somme des lignes (calculée côté serveur via money.ts, DECIMAL(18,3)) s'il y a des lignes ; sinon saisi.
- **Justification** : Garantit une référence unique et évite un écart entre le total et les lignes.

### D-204 — [6.3 / 6.4 / 2.4 / T24] Machine d'états des interventions, réouverture et idempotence

- **Ambiguïté** : Les transitions ne sont pas listées : saisie a posteriori directe, annulation depuis EN_COURS, effets d'une réouverture sur la dépense et les plans. La notion d'« intervention ouverte » pour le transfert n'est pas définie.
- **Options** : Chaîne stricte BROUILLON → PLANIFIEE → EN_COURS → TERMINEE / Raccourcis autorisés pour la saisie a posteriori
- **Décision** : Transitions :
- BROUILLON → PLANIFIEE (dates prévues) → EN_COURS → TERMINEE ;
- BROUILLON ou PLANIFIEE → TERMINEE, pour une saisie a posteriori ;
- BROUILLON, PLANIFIEE ou EN_COURS → ANNULEE, avec motif.

Réouverture TERMINEE → EN_COURS (chef ou administrateur, motif, audit) : dans la même transaction, annulation traçable de la dépense, recalcul des bases sans l'intervention et réévaluation des alertes.

« Ouverte » = BROUILLON, PLANIFIEE ou EN_COURS (pour le transfert et l'archivage).

complete : même clé et même corps renvoient le résultat initial ; sur une intervention déjà TERMINEE avec une autre clé, 409.
- **Justification** : Couvre la saisie historique, 6.4 (réouverture motivée) et T24.

### D-205 — [6.3 / 7.4] Intervention et immobilisation : couplage explicite

- **Ambiguïté** : « L'immobilisation se gère explicitement », mais le CDC ne dit pas si démarrer ou terminer une intervention doit proposer d'agir sur l'immobilisation, ni ce qui se passe si une intervention planifiée chevauche des réservations.
- **Options** : Immobilisation automatique au démarrage / Cases explicites dans les formulaires / Aucun lien
- **Décision** : Démarrage : case « Immobiliser le véhicule », non cochée par défaut, cochée si l'intervention vient d'un incident.

Clôture ou annulation : case « Mettre fin à la cause d'immobilisation liée », cochée par défaut, exécutée dans la même transaction.

Intervention planifiée qui chevauche une réservation : avertissement dans /planning, sans blocage.
- **Justification** : Reste explicite comme l'exige 6.3, tout en évitant les immobilisations oubliées.

### D-206 — [6.4 / 8.4] Dépense liée quand le coût est inconnu ou nul à la clôture — **contradiction-cdc**

- **Ambiguïté** : 6.4 place la dépense liée dans la transaction de clôture et 8.4 exige « exactement une dépense ». Mais la facture arrive souvent après, l'utilisateur peut ne pas avoir costs.write, et la migration impose un montant de dépense > 0.
- **Options** : Bloquer la clôture sans montant / Clôture sans dépense, dépense créée à la saisie du coût / Dépense à 0
- **Décision** : Clôture sans montant autorisée : costStatus EN_ATTENTE et indicateur « coût à saisir ». Plus tard, la saisie du total (costs.write) crée l'unique dépense : sourceType INTERVENTION, unicité par source, société historique, date performedOn.

Total = somme des lignes TTC s'il y en a. Intervention sans coût : marquée « sans coût », sans dépense.
- **Justification** : Évite de bloquer la mise à jour des plans en attendant une facture, mais sort la dépense de la transaction de clôture prévue par 6.4.

### D-207 — [6.4 / 15.3] Relevé « correspondant » exigé à la clôture d'une intervention

- **Ambiguïté** : Le CDC ne dit pas à quelle date doit être le relevé, si une estimation GPS est admise, ni si le relevé peut être créé dans le parcours de clôture.
- **Options** : N'importe quel relevé accepté / Relevé physique proche de la date effective / Relevé du jour exact
- **Décision** : Pour un plan km, le relevé doit être :
- ACCEPTE, du même véhicule, physique (MANUAL, IMPORT ou COMPTEUR_CAN, jamais DISTANCE_GPS) ;
- observé le jour de performedOn ± `maintenance.completionReadingWindowDays` (1 j) ;
- admissible selon acceptedSources.

Il peut être créé dans la même transaction (contexte ENTRETIEN) ; s'il passerait EN_ATTENTE : 422, sans clôture partielle.

performedOn ≤ aujourd'hui local. Plan date seule : relevé facultatif.
- **Justification** : La base d'un plan est une référence durable : elle ne doit pas s'appuyer sur une estimation.

### D-208 — [6.4 / T18] Choix de la base : opération effective la plus récente, bases initiales et imports anciens

- **Ambiguïté** : Le CDC ne classe pas une base technique ou une échéance initiale par rapport à une opération réelle ajoutée plus tard. Le départage entre deux opérations le même jour n'est pas défini.
- **Options** : Priorité à la dernière saisie / Priorité à l'opération réelle la plus récente / Priorité à la base initiale
- **Décision** : computeBase() dans maintenance-schedule.ts : tâche réalisée d'une intervention TERMINEE avec le performedOn le plus récent, puis le km le plus élevé, puis la clôture la plus récente. Base km et base date viennent de la même opération.

La base initiale reste retenue tant qu'aucune opération n'est datée à partir de sa date (ou de la création du plan pour ECHEANCE_INITIALE).

Opérations plus anciennes : historique seulement (T18). Recalcul à chaque clôture, réouverture ou correction.
- **Justification** : « Recalculer depuis l'opération effective la plus récente, pas la dernière saisie », sans faire reculer la base.

### D-209 — [7.1 / 2.3] Correction d'une version de document et accès du conducteur

- **Ambiguïté** : Corriger une faute de frappe crée-t-il une nouvelle version ? Le CDC ne dit pas non plus quels documents du véhicule le conducteur peut consulter.
- **Options** : Toute modification crée une version / Correction en place, auditée
- **Décision** : Renouvellement = nouvelle version (previousVersionId). Faute de frappe = modification en place avec expectedVersion et audit avant/après (documents.manage). Version erronée = archivedAt, jamais de suppression physique.

Conducteur : seulement les types marqués visibleToDriver (par défaut assurance, carte grise, visite technique) du véhicule de son utilisation EN_COURS, plus son propre permis.
- **Justification** : Garde un historique propre et limite le conducteur aux « informations utiles à son utilisation en cours ».

### D-210 — [7.1 / 3.3] Documents requis (MANQUANT) : portée par type, catégorie et permis

- **Ambiguïté** : Le CDC ne dit pas quels types produisent MANQUANT (le caractère bloquant n'implique pas le caractère requis), ni pour quels véhicules. La vérification des catégories de permis et le cas d'une version sans fichier ne sont pas traités.
- **Options** : MANQUANT pour tous les types / MANQUANT pour les types requis dans leur périmètre
- **Décision** : DocumentType.required, avec une portée facultative par vehicleCategoryIds et companyIds. blocksCheckout implique required (CHECK SQL).

Permis : VehicleCategory.requiredPermitCategories est vérifié au départ si ce contrôle est paramétré comme bloquant.

Une version sans fichier est admise, signalée « justificatif absent » ; son statut dépend des seules dates.
- **Justification** : Ne produit pas de fausses alertes et laisse les règles juridiques à l'organisation (3.3, 7.1).

### D-211 — [7.1 / 18 (T21)] Fin de validité, renouvellement futur et trou entre versions

- **Ambiguïté** : T21 couvre le jour même et le lendemain, mais pas le cas d'un trou entre deux versions (l'ancienne finit le 10, la nouvelle commence le 12), ni celui d'un document qui n'a qu'une version future.
- **Options** : Considérer VALIDE si une version future existe / Statut calculé par date, sans anticipation
- **Décision** : Option 2 :
- VALIDE jusqu'à 23:59:59,999 heure locale de validTo.
- Ensuite EXPIRE, sauf si une version couvre la date. Un trou donne EXPIRE, avec la mention « renouvellement valable à partir du … », et reste bloquant si le type est bloquant.
- Une seule version future donne MANQUANT, avec mention.
- A_RENOUVELER à 30 jours ou moins, sauf si une version future prend le relais sans trou.
Fichiers prévus : apps/api/src/domain/document-status.ts, apps/api/src/domain/document-status.spec.ts, apps/api/test/integration/documents.int.spec.ts.
- **Justification** : « Un document futur ne remplace pas prématurément un document encore valide » (7.1). On évite ainsi toute fausse conformité.

### D-212 — [7.1 / T21] Fenêtre A_RENOUVELER, paliers 30/15/7 et jour d'échéance

- **Ambiguïté** : Le CDC ne dit pas si A_RENOUVELER commence au premier palier, si chaque palier crée une nouvelle alerte, ni quel est le statut le jour même de la date de fin.
- **Options** : Une alerte par palier / Une alerte dont la gravité monte / Statut le jour de fin : VALIDE ou A_RENOUVELER
- **Décision** : j = validTo − aujourd'hui local :
- VALIDE si j > max(préavis) ;
- A_RENOUVELER si 0 ≤ j ≤ max(préavis) ;
- EXPIRE si j < 0 ;
- MANQUANT : type requis sans version valable.

Une seule alerte DOCUMENT_ECHEANCE par version, dont la gravité monte : 30 j INFO, 15 j ATTENTION, 7 j URGENT, expiration CRITIQUE si bloquant (URGENT sinon).

hasExpiry = false : validTo interdit. Implémentation dans document-status.ts.
- **Justification** : Tient T21 (« valable jusqu'à la fin du jour ») et la déduplication de 9.2.

### D-213 — [7.1 / T21] Versions qui se chevauchent, renouvellement futur et trous de couverture

- **Ambiguïté** : Le CDC ne dit pas quelle version retenir si deux versions valent le même jour, si un renouvellement futur résout l'alerte, ni comment traiter un trou de couverture.
- **Options** : Dernière version créée / Version au validTo le plus tardif / Version future appliquée immédiatement
- **Décision** : Version applicable au jour D = version non archivée telle que début (validFrom, sinon issuedOn) ≤ D ≤ validTo. En cas d'égalité : validTo le plus tardif, puis création la plus récente.

Une version future n'est jamais applicable avant son début. L'alerte est résolue dès qu'une version future couvre le lendemain de validTo sans trou, et le statut porte « renouvelé à compter du … ». S'il reste un trou, l'alerte est maintenue en indiquant la période non couverte.
- **Justification** : Applique « un document futur ne remplace pas prématurément un document encore valide ».

### D-214 — [7.2 / 4.2 / T22] Contrôle documentaire au départ, à la réservation, et portée de la dérogation

- **Ambiguïté** : Le CDC ne dit pas si les documents du conducteur sont contrôlés, quelle portée a une dérogation, ni ce que vérifie une confirmation de réservation (« blocages connus »).
- **Options** : Documents du véhicule seulement / Documents du véhicule et du conducteur / Dérogation durable ou ponctuelle
- **Décision** : Départ : contrôle à checkedOutAt des documents bloquants du véhicule (propres et partagés) et du conducteur. Sinon 422 DOCUMENT_BLOQUANT, sauf dérogation exceptions.override (administrateur, chef) : valable pour ce seul départ, motif enregistré sur VehicleUsage, audit listant les documents.

Restitution : jamais contrôlée.

Réservation : refus si un document bloquant n'est pas valide au début du créneau et qu'aucune version future ne le couvre (dérogation possible) ; simple avertissement s'il expire pendant le créneau. Nouveau contrôle au départ.
- **Justification** : Applique 7.2 : la dérogation ne modifie ni l'expiration ni la règle, et le retour reste possible.

### D-215 — [7.3] Transitions d'incident et droits par rôle

- **Ambiguïté** : OUVERT → EN_TRAITEMENT → RESOLU → CLOTURE sont listés sans transitions. Le CDC ne traite pas la réouverture, le classement sans suite, les conditions de clôture, ni les droits de chaque rôle.
- **Options** : Chaîne stricte / Raccourcis et réouvertures motivés
- **Décision** : Transitions :
- OUVERT → EN_TRAITEMENT ;
- OUVERT ou EN_TRAITEMENT → RESOLU, avec note ;
- RESOLU → CLOTURE, si interventions terminées ou annulées et causes d'immobilisation terminées ;
- RESOLU → EN_TRAITEMENT, réouverture motivée ;
- OUVERT → CLOTURE, « sans suite » motivé ;
- CLOTURE est final, sauf réouverture par l'administrateur.

Rôles :
- conducteur : crée et commente ;
- opérateur : jusqu'à RESOLU ;
- chef et administrateur : tout.
- **Justification** : Distingue résolution technique et clôture administrative (7.3).

### D-216 — [7.3 / 2.3] Déclaration par le conducteur : fenêtre de temps et visibilité des commentaires

- **Ambiguïté** : « Sur son utilisation » : en cours seulement, ou aussi après le retour ? Le conducteur voit-il les commentaires internes de suivi ?
- **Options** : Utilisation EN_COURS seulement / Fenêtre après restitution / Commentaires tous visibles ou filtrés
- **Décision** : Déclaration possible sur l'utilisation EN_COURS ou sur une utilisation terminée depuis moins de `incidents.driverLateDeclarationHours` (24 h). Véhicule, utilisation et conducteur sont fixés par le serveur. Gravité proposée par le conducteur, requalifiable par le chef.

Commentaires : visibilité INTERNE (par défaut) ou PARTAGE_CONDUCTEUR. Le conducteur ne voit jamais les coûts.
- **Justification** : Couvre les dégâts constatés juste après le retour, sans exposer le suivi interne (2.3).

### D-217 — [7.3 / 8.4] Coût lié à un incident et contraventions — **irreversible**

- **Ambiguïté** : « Coût lié » au singulier (le schéma n'a qu'un expenseId), alors qu'un incident peut entraîner plusieurs frais. Rapprocher une contravention d'une utilisation risque de « déduire » une responsabilité.
- **Options** : Un seul coût par incident / 0..n dépenses liées / Rapprochement automatique du conducteur
- **Décision** : Relation Expense.relatedIncidentId en 0..n, à la place d'Incident.expenseId. Coût affiché = somme des dépenses liées et de celles des interventions issues de l'incident, visible avec costs.read seulement. Aucune dépense créée automatiquement.

Contravention : l'utilisation en cours à l'instant déclaré est affichée à titre d'information ; le lien avec le conducteur ne se pose que par une action explicite du chef, sans libellé « responsable ».
- **Justification** : Respecte « aucune responsabilité déduite automatiquement ». Cela change la cardinalité dans le schéma.

### D-218 — [7.3 / 9.1] Gravité et alerte « incident critique non traité »

- **Ambiguïté** : L'échelle de gravité, le sens de « non traité » et le délai avant alerte ne sont pas définis.
- **Options** : Alerte immédiate / Alerte après un délai
- **Décision** : Échelle FAIBLE, MOYENNE, ELEVEE, CRITIQUE. Un ACCIDENT est ELEVEE par défaut.

Alerte INCIDENT_CRITIQUE immédiate si CRITIQUE et OUVERT, avec e-mail critique. Résolue au passage EN_TRAITEMENT, ou si la gravité est abaissée.
- **Justification** : Donne une définition simple et testable de « non traité ».

### D-219 — [7.4 / 11.2] Durées d'immobilisation dans les rapports

- **Ambiguïté** : « Ne pas additionner deux fois » les causes superposées : le CDC ne dit pas comment présenter la ventilation par motif ni les immobilisations en cours.
- **Options** : Somme des causes / Union des intervalles avec ventilation séparée
- **Décision** : Total = intervalle de l'immobilisation (union des causes) croisé avec la période du rapport. Une immobilisation en cours compte jusqu'à maintenant, marquée « en cours ».

Ventilation par motif : durée propre de chaque cause, avec la mention « la somme peut dépasser le total ». Unités en heures et en jours (une décimale). Société historique.
- **Justification** : Donne des indicateurs honnêtes (11.1) sans double comptage.

### D-220 — [7.4 / T23] Modèle d'immobilisation : causes, doublons, fin, chevauchements et dérogation

- **Ambiguïté** : Le CDC ne définit pas les « doublons incohérents » ni les « causes bloquantes », et ne dit pas si la fin est automatique. La date de début (future ou rétroactive) et la possibilité de déroger au blocage de départ ne sont pas traitées.
- **Options** : Plusieurs immobilisations parallèles / Une immobilisation active qui regroupe les causes / Fin manuelle ou automatique
- **Décision** : Une seule immobilisation ACTIVE par véhicule, qui regroupe les causes. Une même source ne peut avoir deux causes ouvertes (index partiel). Toutes les causes sont bloquantes en V1.

La fin de la dernière cause termine l'immobilisation dans la même transaction.

Dates :
- début ≤ maintenant + 5 min ; début rétroactif admis sans chevauchement (EXCLUDE gist) ;
- fin réelle entre le début et maintenant ;
- pas d'immobilisation future : utiliser une intervention PLANIFIEE.

Aucune dérogation au départ. Création et fin : opérateur, chef, administrateur.
- **Justification** : Applique 7.4 (« disponibilité rétablie après clôture de toutes les causes ») et T23.

### D-221 — [8.1] Portée, unicité et archivage des fournisseurs — **irreversible**

- **Ambiguïté** : Le répertoire est « par société », mais rien ne dit si une même station ou un même garage utilisé par plusieurs sociétés, ou par la société destinataire d'un transfert, doit être dupliqué. La clé d'unicité n'est pas donnée : un nom seul est trop strict, car deux stations d'une même enseigne existent dans deux villes. Rien ne dit non plus si un fournisseur archivé reste sélectionnable, ni si un plein, une dépense ou une intervention peut référencer le fournisseur d'une autre société. Le schéma actuel impose @@unique([companyId, name]) et relie les fournisseurs par supplierId seul.
- **Options** : Fournisseur strictement rattaché à une société, avec duplication explicite / Fournisseur au niveau du groupe, partagé et rattaché à plusieurs sociétés / Hybride : fiche groupe et visibilité par société
- **Décision** : Supplier.companyId est NOT NULL. L'unicité est partielle sur (companyId, nom normalisé, libellé de localisation facultatif) WHERE status='ACTIF'. Une action « Copier vers une autre société » (admin, ou chef ayant les deux sociétés) crée un nouvel enregistrement. Toute référence supplierId depuis FuelEntry, Expense, Intervention et Immobilization passe par une FK composite (supplierId, companyId) → Supplier(id, companyId) : le fournisseur appartient donc forcément à la société historique de l'objet. Un fournisseur archivé est refusé dans les nouveaux formulaires (422 FOURNISSEUR_ARCHIVE) mais reste affiché dans l'historique. Création et modification : OPERATEUR, CHEF, ADMIN ; archivage : CHEF, ADMIN. Fichiers : packages/db/prisma/schema.prisma (Supplier.normalizedName, @@unique([id, companyId])), packages/db/prisma/migrations/<ts>_supplier_company_fk/migration.sql, apps/api/src/modules/suppliers/suppliers.service.ts, apps/api/src/modules/suppliers/dto/create-supplier.dto.ts, apps/api/test/integration/suppliers.int.spec.ts.
- **Justification** : Ce choix suit le texte (« répertoire par société ») et le cloisonnement 2.3 : un chef de B ne découvre pas l'historique de A à travers un fournisseur partagé. La FK composite rend impossible en base une relation entre sociétés incompatibles (13.1).

### D-222 — [8.2] Cycle de vie d'un plein et validation de son relevé — **irreversible**

- **Ambiguïté** : Seul « brouillon à valider » est défini. Plusieurs points restent ouverts : les statuts du plein, qui valide (l'opérateur ?), le sort du relevé du ticket si le validateur n'a pas readings.approve, la manière de « régulariser » un plein à compteur non validé, le retrait d'une soumission par le conducteur, le rejet et la correction.
- **Options** : Validation du coût et du relevé indissociables, réservée au chef / Validation du coût (costs.write) découplée de l'approbation du relevé (readings.approve) / Validation par l'opérateur de tout le plein
- **Décision** : États : SOUMIS (conducteur) → VALIDE | REJETE (motif obligatoire) | ANNULE (retrait par le conducteur tant que SOUMIS) ; VALIDE → ANNULE (motif) | REMPLACE (correction, nouvelle ligne replacesFuelEntryId, valeur d'énumération à ajouter). Une saisie directe par OPERATEUR, CHEF ou ADMIN (costs.write) est créée VALIDE avec sa dépense dans la même transaction. Valider une soumission demande costs.write. Le relevé passe toujours par OdometerIngestionService (source MANUAL, contexte CARBURANT). S'il est proposé par le conducteur, il reste EN_ATTENTE jusqu'à approbation par un titulaire de readings.approve, indépendamment de la validation du coût. Un plein VALIDE sans relevé ACCEPTE porte consumptionEligibility=COMPTEUR_NON_VALIDE : son coût est compté, mais il est exclu de la consommation. La régularisation consiste à approuver le relevé en attente ou à rattacher un nouveau relevé accepté avec observedAt=filledAt, puis l'éligibilité est recalculée. Fichiers : packages/db/prisma/schema.prisma (FuelEntryStatus.REMPLACE, replacesFuelEntryId, consumptionEligibility), apps/api/src/modules/fuel/fuel.controller.ts (POST /fuel-entries, /:id/validate, /:id/reject, /:id/cancel, /:id/correct), apps/api/src/modules/fuel/fuel.service.ts, apps/api/test/integration/fuel.int.spec.ts.
- **Justification** : Ce découpage respecte 8.2 (le chef peut enregistrer une dépense avec compteur non validé) et 5.1 (seules les soumissions approuvées par un habilité deviennent des relevés acceptés), sans donner à l'opérateur l'approbation des relevés.

### D-223 — [8.2] Horodatage d'un plein — **irreversible**

- **Ambiguïté** : Le champ « date » d'un plein peut être une date civile ou un horodatage. Or le rapprochement F11 repose sur une fenêtre de deux heures (8.5), la consommation exige un ordre entre pleins et le relevé associé exige un observedAt.
- **Options** : Date civile seule / Horodatage obligatoire / Horodatage facultatif, heure par défaut à midi
- **Décision** : FuelEntry.filledAt est un timestamptz obligatoire : saisie date + heure dans le fuseau du groupe, heure pré-remplie sur mobile, filledAt non futur à 5 minutes près. Expense.occurredOn = date civile locale de filledAt, figée à l'écriture. Le relevé du ticket (contexte CARBURANT) prend observedAt = filledAt. Les pleins sont ordonnés par filledAt puis createdAt. Aucune heure fictive n'est inventée. Fichiers : packages/db/prisma/schema.prisma, apps/api/src/modules/fuel/dto/create-fuel-entry.dto.ts, apps/api/src/domain/civil-date.ts.
- **Justification** : Le rapprochement ticket/remplissage et la chronologie des relevés sont impossibles avec une date seule. Cette colonne conditionne tout l'historique carburant.

### D-224 — [8.2] Tolérance entre litres x prix unitaire et total

- **Ambiguïté** : La tolérance est dite configurable, mais elle n'a ni unité (TND absolus ou pourcentage) ni valeur initiale dans 17.1. Le comportement n'est pas précisé (blocage, avertissement ou confirmation), ni la règle d'arrondi du produit litres x prix unitaire.
- **Options** : Tolérance absolue en TND / Tolérance relative en % / Maximum des deux, en avertissement non bloquant
- **Décision** : Paramètre fuel.amountTolerance = { absoluteTnd: '0.100', relativePercent: 1 }. Écart = |litres x prixUnitaire - total|, calculé en décimal exact sans arrondi intermédiaire (apps/api/src/domain/money.ts). Il est signalé quand il dépasse max(absolu, relatif x total). La saisie reste acceptée : amountMismatch=true, amountMismatchValue renseigné, badge « Écart montant » et filtre dans /carburant. La validation d'une soumission conducteur qui présente l'écart exige une case de confirmation explicite. Le total n'est jamais recalculé. Sans prix unitaire, aucun contrôle. Fichiers : apps/api/src/domain/money.ts et money.spec.ts, apps/api/src/modules/fuel/fuel.service.ts, apps/api/src/modules/settings/settings.catalog.ts.
- **Justification** : Le CDC demande de signaler sans corriger. Un seuil mixte évite les faux positifs sur les petits montants dus aux arrondis de pompe, tout en détectant les erreurs de saisie.

### D-225 — [8.2 / 8.3] Type de carburant, énergie du véhicule, AdBlue, capacité du réservoir

- **Ambiguïté** : Plusieurs cas ne sont pas traités : type de carburant incompatible avec l'énergie du véhicule, véhicule électrique (kWh hors V1), hybride ou GPL en bicarburation. Un achat d'AdBlue ou de lubrifiant saisi comme plein fausserait la consommation. Des litres supérieurs à la capacité du réservoir ne sont pas contrôlés.
- **Options** : Aucun contrôle / Refus strict de toute incohérence / Contrôles ciblés : refus des incompatibilités évidentes, avertissement pour la capacité
- **Décision** : FuelEntry.energy ∈ {DIESEL, ESSENCE, GPL}. Refus 422 pour un véhicule ELECTRIQUE (« module énergie kWh hors V1 : enregistrer une dépense »), et pour une énergie différente de celle du véhicule, sauf HYBRIDE (ESSENCE ou DIESEL) et bicarburation GPL déclarée sur la fiche. La consommation est calculée séparément par énergie. AdBlue et lubrifiants sont des dépenses (catégorie CARBURANT ou AUTRE) sans FuelEntry. Si la capacité est connue et que les litres dépassent capacité x 1,05, un avertissement non bloquant pose tankCapacityExceeded=true : la paire de consommation concernée est exclue tant que le chef n'a pas confirmé. Fichiers : apps/api/src/modules/fuel/fuel.service.ts, apps/api/src/domain/consumption.ts.
- **Justification** : Le calcul L/100 km reste honnête (8.3) et le périmètre énergie de la V1 est respecté, sans bloquer les cas légitimes.

### D-226 — [8.2 / 10.3] Périmètre des tickets carburant soumis par un conducteur

- **Ambiguïté** : Le CDC ne dit pas pour quel véhicule un conducteur peut soumettre un ticket : seulement l'utilisation en cours, ou aussi un ticket oublié après restitution ? Les champs obligatoires sur mobile ne sont pas listés. Ce que le conducteur voit après validation n'est pas défini, alors qu'il ne doit pas voir les factures (2.3).
- **Options** : Utilisation EN_COURS uniquement / Utilisation en cours ou récemment terminée, avec contrôle de la date / Tout véhicule de sa société
- **Décision** : La soumission est autorisée sur le véhicule de l'utilisation EN_COURS du conducteur, ou d'une utilisation TERMINEE depuis moins de drivers.lateSubmissionDays (7 j) si filledAt ∈ [checkedOutAt - 1 h, returnedAt + 1 h]. Sinon : 404 si le véhicule est hors droits, 422 HORS_UTILISATION sinon. Champs obligatoires sur mobile : date et heure, litres, montant total, indicateur plein complet ou partiel (sans valeur par défaut), photo du ticket. Le compteur est demandé mais facultatif ; s'il manque, le plein est exclu de la consommation. Le conducteur ne voit que ses propres FuelEntry (valeurs soumises, statut, motif de rejet), jamais l'Expense générée ni les pleins des autres. Fichiers : apps/api/src/modules/fuel/fuel.service.ts (canDriverSubmit), apps/api/src/modules/access-control/access-control.service.ts, apps/web/app/(app)/mon-vehicule/page.tsx, tests/e2e/mobile-conducteur.spec.ts.
- **Justification** : Un ticket est souvent saisi juste après le retour. Borner la fenêtre à la période d'utilisation garde le périmètre « ses propres utilisations » (2.2).

### D-227 — [8.3] Pleins admissibles et complétude des achats intermédiaires

- **Ambiguïté** : Plusieurs notions ne sont pas définies. « Pleins complets admissibles » et « tous les achats intermédiaires saisis » : l'absence d'un ticket ne peut pas être prouvée. Le traitement d'un plein intermédiaire à compteur non validé (exclu des calculs selon 8.2) ou d'une soumission en attente dans l'intervalle n'est pas précisé. Rien ne dit si A et B doivent être consécutifs, ni comment agréger sur une période, ni si les relevés estimés GPS sont admis.
- **Options** : Toute paire de pleins complets, sans contrôle de complétude / Pleins complets consécutifs, intervalle N/D au moindre doute, motif affiché / Utiliser la télématique pour combler les trous
- **Décision** : Dans apps/api/src/domain/consumption.ts, A et B sont des pleins complets consécutifs de même énergie, VALIDE, avec un relevé ACCEPTE non estimé (MANUAL, IMPORT ou COMPTEUR_CAN), un kmCumulé(B) > kmCumulé(A) et un cumul complet sur l'intervalle. L'intervalle vaut N/D avec un motif (énumération ConsumptionUnavailableReason) dans les cas suivants : pas de plein complet de référence ; plein intermédiaire SOUMIS ; plein intermédiaire ou B à compteur non validé ; capacité dépassée non confirmée ; distance nulle ; période déclarée « achats incomplets » par le chef ; avec F11, remplissage détecté sans ticket dans ]A, B]. Consommation d'une période = somme des litres / somme des km des intervalles dont B tombe dans la période, avec la liste des intervalles retenus et exclus. Calcul à la volée, affichage à 1 décimale, export à 2 décimales. Tests : apps/api/src/domain/consumption.spec.ts (T25 : 50 / 400 x 100 = 12,5 et chaque motif N/D).
- **Justification** : Le texte exige une base fiable, sinon N/D avec motif. Retirer les litres d'un plein exclu sous-estimerait la consommation : invalider l'intervalle est la seule lecture honnête.

### D-228 — [8.3 / 18 (T25)] Complétude des achats intermédiaires

- **Ambiguïté** : « Tous les achats intermédiaires saisis » ne peut pas être vérifié en l'état.
- **Options** : Toujours calculer / N/D motivé en présence de signaux d'incomplétude
- **Décision** : Option 2. Le résultat est N/D si un plein en attente, un ECART_TICKET non qualifié, une borne estimée ou kmB ≤ kmA se trouve dans l'intervalle. T25 donne 12,5 L/100 km. Fichiers prévus : apps/api/src/domain/consumption.ts, apps/api/test/integration/fuel.int.spec.ts.
- **Justification** : 8.3 demande un N/D motivé plutôt qu'un chiffre faux.

### D-229 — [8.4] Correction, annulation et avoir d'une dépense validée — **irreversible**

- **Ambiguïté** : Le CDC dit « version ou annulation traçable » sans trancher. L'effet sur les périodes déjà rapportées n'est pas défini, ni le lien de l'avoir avec une dépense, ni l'affichage d'un net négatif, ni le sort de la dépense liée quand un plein ou une intervention est corrigé. Les droits ne sont pas précisés.
- **Options** : Mise à jour en place avec audit / Dépenses immuables : nouvelle version ou annulation / Écriture de contre-passation négative datée du jour
- **Décision** : Une Expense est immuable. Correction : nouvelle Expense VALIDEE avec replacesExpenseId, l'ancienne passe REMPLACEE, même companyId et même source, motif obligatoire, audit avant/après. Annulation : status ANNULEE avec cancelReason. Les rapports ne comptent que les VALIDEE, à leur occurredOn : une annulation retire le coût de sa période d'origine. Avoir : kind=AVOIR, montant positif soustrait, relatedExpenseId facultatif ; un net négatif s'affiche tel quel. Corriger un plein ou rouvrir une intervention remplace la dépense liée dans la même transaction. Correction et annulation demandent costs.write et le rôle CHEF ou ADMIN. Fichiers : packages/db/prisma/schema.prisma (Expense.relatedExpenseId), apps/api/src/modules/expenses/expenses.controller.ts (POST /expenses/:id/correct, /:id/cancel), apps/api/src/modules/expenses/expenses.service.ts, apps/api/test/integration/expenses.int.spec.ts.
- **Justification** : Le registre reste traçable et sans double comptage, et l'opérateur ne fait pas de « correction historique validée » (2.2).

### D-230 — [8.4] Dépense sans véhicule (coûts de flotte) — **contradiction-cdc**

- **Ambiguïté** : En 8.4, le véhicule n'est pas marqué facultatif, alors que « source liée facultative » l'est explicitement. Pourtant, une assurance flotte, une taxe globale ou un contrat cadre concernent plusieurs véhicules. Le schéma actuel rend vehicleId facultatif sans règle d'usage.
- **Options** : Véhicule obligatoire : l'utilisateur ventile manuellement / Véhicule facultatif pour certaines catégories, ligne « non ventilé » / Répartition automatique au prorata
- **Décision** : vehicleId peut être NULL, uniquement pour les catégories ASSURANCE, TAXES, LOCATION et AUTRE (règle vérifiée par CHECK). La dépense porte le libellé « Dépense société non affectée ». Elle est incluse dans les totaux société et groupe, exclue des coûts et du coût/km par véhicule, et affichée dans une ligne « Non ventilé ». Aucune répartition automatique. Fichiers : packages/db/prisma/migrations/<ts>_expense_vehicle_optional_check/migration.sql, apps/api/src/modules/expenses/dto/create-expense.dto.ts, apps/api/src/modules/reports/reports.service.ts.
- **Justification** : Ce choix évite de fabriquer une ventilation (esprit 11.3) tout en couvrant un besoin réel de centralisation des coûts. Il s'écarte de la liste de champs de 8.4.

### D-231 — [8.4] Société imputée et date d'une dépense de synthèse — **irreversible**

- **Ambiguïté** : La « société au fait générateur » est ambiguë pour une soumission créée avant un transfert et validée après, et pour une intervention (société à la création ou à la clôture). La date retenue n'est pas précisée : date de facture ou date d'exécution.
- **Options** : Société du véhicule au moment de la validation / Société figée à la création de la source, date = date de l'événement / Société au choix de l'utilisateur
- **Décision** : Le companyId de FuelEntry et d'Intervention est figé à la création : c'est la société gestionnaire du véhicule à filledAt ou à la date prévue, résolue via VehicleCompanyHistory. L'Expense hérite du companyId de sa source et n'est jamais réimputée. occurredOn = date civile locale de filledAt (plein) ou de performedAt (intervention). Une soumission antérieure au transfert reste rattachée à l'ancienne société et n'est validable que par un utilisateur habilité sur celle-ci. Le transfert n'est pas bloqué par ces soumissions, mais son écran de prévisualisation liste les pleins et relevés en attente de l'ancienne société. Fichiers : apps/api/src/modules/expenses/expense-synthesis.service.ts, apps/api/src/modules/vehicles/vehicle-transfer.service.ts, apps/api/test/integration/transfer.int.spec.ts (T26).
- **Justification** : Le CDC impute les coûts à la société historique (8.4, 11.3) et ne liste pas les soumissions en attente parmi les causes de refus d'un transfert (2.4).

### D-232 — [8.4] Unicité des dépenses : « référence source » et relances — **irreversible**

- **Ambiguïté** : « Une référence source est unique » peut viser le lien vers l'objet source (plein ou intervention), le numéro de facture ou de ticket du fournisseur, ou l'empreinte du justificatif. Le cas de deux dépenses manuelles portant la même facture n'est pas traité, ni celui d'un plein validé une seconde fois (T24).
- **Options** : Unicité du seul couple (sourceType, sourceId) / Trois niveaux : lien source, référence fournisseur, empreinte du justificatif / Détection par montant et date
- **Décision** : Niveau 1 : index unique partiel (sourceType, sourceId) WHERE status='VALIDEE' ; la dépense est générée par upsert dans la transaction de validation. Niveau 2, dépense manuelle : index unique partiel (companyId, supplierId, lower(reference)) WHERE status='VALIDEE' AND reference IS NOT NULL, avec 409 DEPENSE_REFERENCE_EXISTANTE et lien vers l'existante. Niveau 3 : un sha256 de justificatif déjà rattaché à une dépense ou à un plein actif de la société déclenche un avertissement non bloquant avec confirmation. POST /expenses et POST /fuel-entries exigent une clé d'idempotence. Revalider un plein ou une intervention déjà validé renvoie la réponse rejouée si la clé est identique, sinon 409 DEJA_VALIDE, et ne crée jamais de seconde dépense. Fichiers : packages/db/prisma/migrations/<ts>_expense_reference_unique/migration.sql, apps/api/src/modules/expenses/expenses.service.ts, apps/api/test/integration/expenses.int.spec.ts (T24).
- **Justification** : Ce dispositif couvre à la fois la relance technique (idempotence) et la double saisie humaine d'un même justificatif, que le texte interdit.

### D-233 — [8.4 / 13.1] Arithmétique monétaire, TTC, montant nul, achat de véhicule — **irreversible**

- **Ambiguïté** : Plusieurs points manquent : l'arrondi des montants calculés (quantité x prix unitaire d'une ligne d'intervention), le statut HT ou TTC des lignes, le transport JSON des décimaux. Une intervention sous garantie à 0 doit générer « exactement une dépense » alors que la contrainte CHECK exige amount > 0. La devise est stockée par ligne. La catégorie des achats de véhicules n'est pas dans la liste 8.4.
- **Options** : Nombres JSON et flottants / Décimaux exacts transportés en chaînes, arrondi ROUND_HALF_UP à 3 décimales / Montants en millimes entiers
- **Décision** : Tous les montants sont saisis TTC, sans TVA. Montant de ligne = quantité x prix unitaire arrondi ROUND_HALF_UP à 3 décimales (decimal.js dans apps/api/src/domain/money.ts) ; total = somme exacte des lignes. Dans OpenAPI, les décimaux sont des chaînes ('12.345'), jamais des number. currency CHAR(3) doit égaler la devise de l'organisation ; la changer est interdit dès qu'une dépense existe. Une intervention à total 0 produit une dépense de synthèse à 0,000 (CHECK assoupli : amount > 0 OR sourceType IS NOT NULL). La catégorie ACHAT_VEHICULE a excludedFromOperatingCost=true par défaut, modifiable par un titulaire de costs.write avec audit. Fichiers : apps/api/src/domain/money.ts et money.spec.ts, packages/contracts (schémas Decimal), packages/db/prisma/migrations/<ts>_expense_zero_amount/migration.sql.
- **Justification** : Montants exacts en TND à 3 décimales (8.4), aucune perte de précision côté client, et respect de « exactement une dépense » par source.

### D-234 — [8.5] Calcul de la consommation télématique comparée

- **Ambiguïté** : Le CDC demande d'afficher « en parallèle » la consommation télématique et son écart, sans méthode de calcul, sans intervalle de comparaison et sans règle quand les échantillons sont incomplets.
- **Options** : Consommation mensuelle calendaire / Mêmes intervalles A→B que la consommation déclarée / Valeur fournie par la plateforme
- **Décision** : Calcul sur les mêmes intervalles A→B que la consommation déclarée, avec les mêmes km cumulés. CONSOMMATION_CAN : delta du compteur de litres entre filledAt(A) et filledAt(B). NIVEAU_SONDE : niveau après A - niveau avant B + somme des remplissages détectés dans ]A, B]. N/D si un trou d'échantillons dépasse 60 min ou si la couverture est inférieure à 90 % de l'intervalle. NIVEAU_CAN n'est jamais utilisé. Affichage : « Télématique (sonde) : x L/100 km, écart +y % par rapport à la consommation déclarée ». Pas de matérialisation. Fichiers : apps/api/src/domain/consumption.ts, apps/api/src/modules/fuel/fuel-analytics.service.ts.
- **Justification** : L'écart n'a de sens que sur des bornes identiques. La plateforme ne fournit pas de consommation théorique importable (8.5).

### D-235 — [8.5] Événements produits selon la nature de la mesure carburant

- **Ambiguïté** : Le CDC ne dit pas si NIVEAU_CAN (« contrôle grossier ») produit des remplissages détectés. CONSOMMATION_CAN ne permet pas de voir un remplissage. « Moteur coupé, vitesse nulle » suppose des données de contact et de vitesse que tous les fournisseurs ne remontent pas. La fusion des fenêtres qui se chevauchent n'est pas prévue.
- **Options** : Toutes natures pour tous les événements / Matrice restrictive par nature, avec détection désactivée faute de données / Estimer le contact à partir de la vitesse
- **Décision** : BAISSE_ANORMALE : NIVEAU_SONDE uniquement, avec engineOn=false et vitesse=0 sur tous les échantillons de la fenêtre ; sans donnée de contact, aucune détection et le mapping affiche « détection de baisse indisponible ». REMPLISSAGE_DETECTE : NIVEAU_SONDE et NIVEAU_CAN (seuil doublé pour le CAN : 20 L ou 20 %). CONSOMMATION_CAN : aucun événement, seulement la consommation télématique. Les épisodes contigus sont fusionnés, avec dedupeKey = vehicleId:type:début d'épisode aligné sur 5 min, ce qui rend le rejeu idempotent (T36). Fichiers : apps/api/src/domain/fuel-events.ts, apps/api/src/modules/telemetry/fuel-event-detector.service.ts.
- **Justification** : Le texte précise que la sonde est la seule nature exploitable pour détecter une baisse anormale. Refuser une détection sur données absentes évite des accusations infondées.

### D-236 — [8.5 / 8.3] Période de la consommation télématique affichée en parallèle

- **Ambiguïté** : Le CDC ne précise ni l'intervalle de calcul ni la formule selon la nature de mesure.
- **Options** : Moyenne glissante / Même intervalle [A, B] que la consommation calculée sur les pleins
- **Décision** : Option 2 :
- Compteur CAN de consommation : différence entre A et B.
- Sonde : niveau après A − niveau avant B + remplissages détectés.
- N/D en cas de trou de plus de 60 min ou de mesure NIVEAU_CAN.
Fichiers prévus : apps/api/src/domain/consumption.ts, apps/api/src/domain/consumption.spec.ts.
- **Justification** : La comparaison n'a de sens que sur le même intervalle.

### D-237 — [8.5 / 9.1] Rapprochement remplissage/ticket et « chaque événement devient une anomalie » — **contradiction-cdc**

- **Ambiguïté** : Lu littéralement, chaque remplissage détecté, même accompagné de son ticket, devient une anomalie à qualifier, ce qui noierait le chef. La fenêtre de deux heures est ambiguë : avant ou après, sur la date du plein ou la date de saisie, avec ou sans les tickets SOUMIS. Or les conducteurs saisissent souvent le ticket plus tard. Le schéma prévoit une alerte CARBURANT_REMPLISSAGE_DETECTE qui n'est pas listée en 9.1.
- **Options** : Tout remplissage est une anomalie / Seuls les écarts et absences de ticket deviennent des anomalies ; les remplissages rapprochés sont tracés sans alerte / Délai de grâce long avant de signaler l'absence de ticket
- **Décision** : Un remplissage rapproché est enregistré en FuelEvent REMPLISSAGE_DETECTE au nouvel état RAPPROCHE, sans alerte ni qualification. Rapproché signifie : FuelEntry SOUMIS ou VALIDE du même véhicule, |filledAt - detectedAt| ≤ 2 h, litres dans la tolérance. Sinon, à detectedAt + 2 h, le job alert-catch-up crée un FuelEvent ECART_TICKET A_QUALIFIER et l'alerte CARBURANT_ECART_TICKET (motif « absence de ticket » ou « écart de X L »). Si un ticket correspondant est saisi plus tard, il est rattaché automatiquement et l'alerte passe RESOLUE, mais l'événement reste à qualifier avec la suggestion « ticket saisi tardivement ». Une baisse anormale donne toujours une anomalie et une alerte. La qualification (JUSTIFIE, ANOMALIE_CONFIRMEE, ERREUR_CAPTEUR) est réservée à CHEF et ADMIN, motif obligatoire, sans jamais créer de dépense. Le type CARBURANT_REMPLISSAGE_DETECTE n'est plus émis. Fichiers : packages/db/prisma/schema.prisma (FuelEventStatus.RAPPROCHE), apps/api/src/modules/telemetry/fuel-event-detector.service.ts, apps/worker/src/jobs/alert-catch-up.job.ts, apps/api/test/integration/telemetry-fuel.int.spec.ts (T43 : deux anomalies).
- **Justification** : Ce choix garde l'intention (qualifier les anomalies, aucune déduction automatique) et la fenêtre littérale de deux heures, en lisant « chaque événement » comme « chaque événement anormal ».

### D-238 — [8.5 / 17.1] Seuils carburant manquants : remplissage, tolérance du ticket, % ou litres

- **Ambiguïté** : 17.1 ne fixe que la baisse anormale (10 L ou 5 % en 30 min). Il manque le seuil de remplissage, la tolérance en litres du rapprochement avec le ticket, l'interprétation du « ou » et la conversion % ↔ L quand la capacité du réservoir est inconnue.
- **Options** : Mêmes seuils que la baisse / Seuils dédiés paramétrables avec lissage / Seuils codés en dur
- **Décision** : Paramètres (groupe > société > véhicule) : fuel.refill.minRise = { liters: 10, percent: 10, windowMinutes: 30 }, niveau comparé sur la médiane de 3 échantillons avant et après ; fuel.drop = { liters: 10, percent: 5, windowMinutes: 30 } ; fuel.ticketMatch = { windowHours: 2, litersTolerance: max(5 L, 10 % des litres du ticket) }. « Ou » signifie que l'événement se déclenche dès qu'un des seuils disponibles est franchi. La conversion % → L n'a lieu que si tankCapacityLiters est connu ; sinon seul le seuil de la mesure disponible s'applique. Fichiers : apps/api/src/domain/fuel-events.ts et fuel-events.spec.ts, apps/api/src/modules/settings/settings.catalog.ts.
- **Justification** : Les trois événements de 8.5 deviennent calculables et testables (T43) sans inventer de précision que les capteurs n'ont pas.

### D-239 — [8.5 / 17.1 / 17.2] Pas des échantillons carburant et rétention — **irreversible**

- **Ambiguïté** : « Pas de cinq minutes maximum » peut signifier au plus un échantillon par tranche de 5 min, ou au moins un toutes les 5 min. La purge par partitions mensuelles ne donne pas exactement 90 jours.
- **Options** : Tout stocker / Au plus un échantillon par unité, nature et tranche de 5 min / Moyenne par tranche
- **Décision** : Au plus un échantillon stocké par (unité, nature, tranche de 5 min alignée sur UTC) : colonne bucketStart, unicité (unitId, kind, bucketStart), le dernier échantillon de la tranche est conservé. La détection d'événements tourne sur les échantillons bruts du lot avant sous-échantillonnage, avec les derniers échantillons stockés pour la continuité. Rétention de 90 j : le job apps/worker/src/jobs/retention.job.ts supprime les partitions entièrement antérieures et lance un DELETE quotidien dans la partition frontière. FuelEvent et OdometerReading ne sont jamais purgés. Fichiers : packages/db/prisma/schema.prisma (FuelLevelSample.bucketStart), packages/db/prisma/migrations/<ts>_fuel_sample_bucket/migration.sql.
- **Justification** : Le volume cible de 17.2 (13 millions d'échantillons pour 500 véhicules sur 90 j) correspond exactement à un échantillon par tranche de 5 min, ce qui fixe l'interprétation.

### D-240 — [8.5 / 17.1 / 18 (T43)] Seuils de remplissage et de baisse, et natures de mesure exploitables

- **Ambiguïté** : Le seuil de remplissage n'est pas donné. « 10 L ou 5 % » : on ignore si « ou » vaut « l'une ou l'autre », sur quelle base se calcule le pourcentage, et comment traiter un moteur à l'état inconnu.
- **Options** : Seuils stricts sur toute nature de mesure / Baisse évaluée uniquement sur sonde, arrêt prouvé, et l'une des deux conditions suffit
- **Décision** : Option 2 :
- Remplissage : hausse de plus de 10 L, ou de plus de 10 % de la capacité, en 30 min au plus.
- Baisse : sonde seulement, fenêtre de 30 min, moteur coupé et vitesse nulle prouvés ; déclenchée si la baisse dépasse 10 L ou 5 points.
- État du moteur inconnu : pas d'évaluation.
- Épisodes fusionnés ; surcharges possibles par véhicule.
Fichiers prévus : apps/api/src/domain/fuel-events.ts, apps/api/src/domain/fuel-events.spec.ts.
- **Justification** : 8.5 précise que seule la sonde permet de détecter une baisse anormale.

### D-241 — [8.5 / 17.2] Sens de « pas de cinq minutes maximum » pour les échantillons

- **Ambiguïté** : L'expression peut signifier qu'on stocke au moins un échantillon toutes les 5 min, ou au plus un échantillon par tranche de 5 min.
- **Options** : Tout stocker / Au plus un échantillon par tranche de 5 min, les événements étant calculés sur les données brutes
- **Décision** : Option 2. Les événements sont calculés sur les données brutes et sur les échantillons récents stockés. On stocke ensuite le dernier échantillon de chaque tranche. Fichiers prévus : apps/api/src/modules/telemetry/telemetry.service.ts, apps/api/src/domain/fuel-events.ts.
- **Justification** : 17.2 annonce 13 millions d'échantillons en 90 jours, ce qui correspond exactement à un pas de 5 min.

### D-242 — [8.5 / 18 (T43)] Remplissage détecté : anomalie systématique ou non — **contradiction-cdc**

- **Ambiguïté** : 8.5 dit « chaque événement devient une anomalie ». Mais T43 attend deux anomalies pour une baisse et un remplissage sans ticket, ce qui n'est possible que si le remplissage lui-même ne compte pas comme une anomalie séparée.
- **Options** : Chaque remplissage est une anomalie / Un remplissage rapproché d'un ticket est auto-justifié ; seul l'écart devient une anomalie
- **Décision** : Option 2. Le remplissage est rapproché des tickets saisis dans les 2 h qui l'entourent, avec une tolérance de 5 L ou 10 %. S'il correspond, il est qualifié JUSTIFIE automatiquement, avec audit. Sinon, il devient ECART_TICKET. Aucune dépense n'est jamais créée. Fichiers prévus : apps/api/src/modules/fuel/fuel-events.service.ts, apps/api/test/integration/fuel-telemetry.int.spec.ts.
- **Justification** : Cette lecture fait passer T43 et évite de noyer le chef sous les anomalies.

### D-243 — [9.1] Conditions de déclenchement non définies

- **Ambiguïté** : Plusieurs conditions ne sont pas définies : réservation compromise, incident critique « non traité », kilométrage absent (dès la création du véhicule ?), tolérance de retour. Le sort des alertes des véhicules HORS_SERVICE, CEDE ou ARCHIVE n'est pas précisé.
- **Options** : Conditions minimales / Conditions explicites et paramétrables / Laisser le chef créer les alertes
- **Décision** : RESERVATION_COMPROMISE : réservation CONFIRMEE avec startAt < now + reservations.compromiseHorizonHours (48 h) et au moins une des situations suivantes :
- utilisation EN_COURS du véhicule ou du conducteur, déjà en retard ou avec expectedReturnAt ≥ startAt ;
- immobilisation active sans fin prévue ou finissant après startAt ;
- document bloquant invalide à la date civile de startAt ;
- conducteur inactif ;
- véhicule non ACTIF.
Autres conditions : INCIDENT_CRITIQUE = incident de gravité CRITIQUE au statut OUVERT, levée dès la création et résolue au passage EN_TRAITEMENT. KILOMETRAGE_ABSENT = véhicule ACTIF sans relevé accepté, dès sa création. RETOUR_DEPASSE = now > expectedReturnAt + usages.lateToleranceMinutes (0 par défaut). Pour un véhicule HORS_SERVICE, CEDE ou ARCHIVE : aucune alerte entretien, document, kilométrage ou GPS, et les alertes existantes passent RESOLUE avec resolutionReason=CYCLE_DE_VIE. Fichiers : apps/api/src/modules/alerts/alert-evaluator.service.ts, apps/api/src/modules/alerts/alert-catalog.ts, apps/api/test/integration/alerts.int.spec.ts (T07).
- **Justification** : Des conditions explicites rendent les alertes justifiables (11.1 : aucun indicateur opaque) et évitent de gonfler les alertes pour des véhicules sortis du parc (11.1).

### D-244 — [9.1 / 2.2] Responsable, destinataires et visibilité des alertes par rôle

- **Ambiguïté** : Le « responsable » d'une alerte n'est défini que pour les plans et les incidents. Le CDC ne dit pas qui voit les alertes (opérateur, lecteur, conducteur) ni quelle donnée personnelle une alerte peut exposer (permis d'un conducteur).
- **Options** : Liste de destinataires matérialisée à la création / Visibilité calculée à la lecture selon le périmètre et le rôle / Tous les utilisateurs de la société
- **Décision** : responsibleUserId vaut, dans l'ordre : responsable du plan, responsable de suivi de l'incident, utilisateur ayant confirmé le mapping F11 ; sinon « Non attribué ». Visibilité calculée au point d'accès :
- ADMIN : tout ;
- CHEF : ses sociétés ;
- OPERATEUR : ses sociétés, sans GPS_* ni CARBURANT_* ;
- LECTEUR : lecture seule ;
- CONDUCTEUR : aucune alerte, seulement l'état de ses soumissions.
Les messages ne contiennent ni numéro de permis ni montant. Aucun bouton « résoudre » manuel : l'alerte renvoie vers l'action métier et se résout quand la condition cesse. E-mails réservés à CHEF et ADMIN. Fichiers : apps/api/src/modules/alerts/alerts.service.ts, apps/api/src/modules/access-control/policies.ts.
- **Justification** : Ce choix respecte le cloisonnement 2.3, l'exclusion du conducteur des données d'autrui, et la règle « résoudre seulement lorsque la condition cesse » (9.2).

### D-245 — [9.1 / 9.4] Niveaux de gravité et correspondance par type d'alerte

- **Ambiguïté** : Les gravités ne sont pas énumérées. Les « alertes critiques » envoyées par e-mail ne sont pas définies. L'escalade documentaire 30/15/7 j n'est pas rattachée à une gravité. Le schéma met NotificationPreference.minimumSeverity à URGENT par défaut.
- **Options** : Gravité unique / Quatre niveaux avec table de correspondance paramétrable / Gravité choisie par l'utilisateur
- **Décision** : Niveaux : INFO < ATTENTION < URGENT < CRITIQUE. Catalogue dans apps/api/src/modules/alerts/alert-catalog.ts :
- entretien : A_PREVOIR = ATTENTION, A_FAIRE = URGENT, EN_RETARD = CRITIQUE ; plan INCOMPLET = INFO ;
- document : 30 j = INFO, 15 j = ATTENTION, 7 j = URGENT, EXPIRE = CRITIQUE si bloquant sinon URGENT ; MANQUANT = CRITIQUE si bloquant sinon ATTENTION ;
- kilométrage absent ou ancien = ATTENTION ; relevé à valider = INFO, puis ATTENTION après 48 h ;
- retour dépassé = URGENT, CRITIQUE si une réservation suivante est compromise ; réservation compromise = URGENT ;
- incident critique = CRITIQUE ; départ sans relevé = URGENT ;
- F11 : source muette = ATTENTION, dérive = ATTENTION, unité non mappée = INFO, synchronisation en échec = URGENT ; baisse de carburant = CRITIQUE ; écart de ticket = URGENT.
Surcharges par organisation via alerts.severityOverrides. E-mail immédiat si la gravité ≥ préférence de l'utilisateur, CRITIQUE par défaut (passer le défaut du schéma de URGENT à CRITIQUE).
- **Justification** : Le texte ne prévoit l'e-mail immédiat que pour les alertes « critiques ». Une table explicite rend le comportement testable et configurable (9.4).

### D-246 — [9.1 / 9.4 / 17.1] Gravité par type et alertes « critiques » envoyées par e-mail

- **Ambiguïté** : Le CDC n'attribue de gravité à aucun type d'alerte et ne dit pas lesquelles sont « critiques », donc envoyées immédiatement. « Incident critique non traité » n'a pas de délai.
- **Options** : Tout envoyer immédiatement / Grille par défaut paramétrable, seules les CRITIQUE partant immédiatement
- **Décision** : Option 2. Grille par défaut :
- CRITIQUE : entretien EN_RETARD, document bloquant expiré ou manquant, immobilisation pendant une utilisation, baisse anormale de carburant, incident de gravité critique resté OUVERT plus de 4 h (incidents.criticalUntreatedHours).
- URGENT : A_FAIRE, document à 7 jours ou moins, retour dépassé, réservation compromise, source muette, synchro en échec.
- ATTENTION : A_PREVOIR, document à 15 ou 30 jours, relevé ancien ou à valider, dérive, écart de ticket, unité non mappée.
Seules les alertes CRITIQUE partent immédiatement ; les autres vont dans le récapitulatif. Fichiers prévus : apps/api/src/modules/alerts/alert-severity.ts, apps/api/src/modules/settings/settings.service.ts, apps/api/src/modules/notifications/notifications.service.ts.
- **Justification** : 9.4 prévoit des gravités configurables, et le chef ne doit pas être noyé sous les e-mails.

### D-247 — [9.1 / 13.1] Alertes sans société (niveau organisation) — **irreversible**

- **Ambiguïté** : Alert.companyId est NOT NULL, mais certaines alertes n'ont pas de société évidente : une unité fournisseur non mappée sans immatriculation reconnue, ou un fournisseur couvrant plusieurs sociétés.
- **Options** : Rattacher arbitrairement à une société / companyId facultatif pour les alertes d'organisation réservées à l'admin / Ne pas alerter
- **Décision** : Alert.companyId devient facultatif. Une alerte sans société (GPS_UNITE_NON_MAPPEE sans correspondance d'immatriculation) n'est visible que de l'ADMIN. Si l'immatriculation correspond à un véhicule, l'alerte prend la société de ce véhicule. Une panne fournisseur produit une alerte par société couverte, car le chef consulte l'état de synchronisation de ses sociétés (14.6). La contrainte unique passe en NULLS NOT DISTINCT (PostgreSQL 16). Fichiers : packages/db/prisma/schema.prisma, packages/db/prisma/migrations/<ts>_alert_company_optional/migration.sql, apps/api/src/modules/alerts/alerts.service.ts.
- **Justification** : company_id ne s'impose qu'aux objets appartenant à une société (13.1). Ce choix n'expose rien hors périmètre.

### D-248 — [9.1 / 14.5 / 2.3] Unités non mappées : alerte sans société et libellés sensibles — **irreversible**

- **Ambiguïté** : Alert.companyId est obligatoire, alors qu'une unité non mappée n'appartient à aucune société. De plus, les libellés d'unités peuvent contenir des noms de conducteurs, et un chef de la société A ne doit rien voir de B.
- **Options** : Une alerte par société couverte / companyId facultatif pour les alertes d'organisation, visibles des seuls administrateurs
- **Décision** : Option 2. Les alertes GPS_UNITE_NON_MAPPEE (agrégée par fournisseur) et d'échec de synchro fournisseur sont réservées aux administrateurs. Les chefs ne voient que les unités proposées ou mappées sur leurs véhicules. Cela demande une migration avec un index d'occurrence adapté (COALESCE ou index partiel). Fichiers prévus : packages/db/prisma/schema.prisma, packages/db/prisma/migrations/<ts>_org_level_alerts/migration.sql, apps/api/src/modules/alerts/alerts.service.ts, apps/api/src/modules/telemetry/telemetry.service.ts.
- **Justification** : Le cloisonnement (2.3) est préservé et l'administrateur reste seul à configurer (14.6).

### D-249 — [9.1 / 17.1 / 5.6] Alertes F11 : source muette, fournisseur injoignable, unité non mappée, dérive

- **Ambiguïté** : « Sans donnée » peut vouloir dire aucun échantillon ou aucune progression. Un fournisseur injoignable (T31) produirait 500 alertes muettes. Rien n'est prévu pour une unité volontairement non mappée (remorque). Le dénominateur de la dérive n'est pas précisé : T39 donne 40/960 = 4,17 %, affiché 4,2 %, alors que 40/1 000 donnerait 4,0 %. La dérive sur une faible distance ne dépend que du bruit. Le CDC ne dit pas s'il faut un échantillon GPS au moment exact du relevé manuel, ni si les relevés CARBURANT servent de référence.
- **Options** : Alerte par unité dans tous les cas / Alerte par unité si la synchronisation réussit, alerte unique par fournisseur sinon / Aucune alerte fournisseur
- **Décision** : Source muette par unité : aucune donnée, toutes natures confondues (TelemetryUnitState.lastObservedAt), depuis plus de 24 h alors que la synchronisation réussit. Sans synchronisation réussie depuis plus de 24 h : une seule alerte GPS_SOURCE_MUETTE par fournisseur et par société couverte (objectType=TelemetryProvider), sans alertes par unité. GPS_SYNCHRO_EN_ECHEC est levée à l'ouverture du coupe-circuit. Unité non mappée : alerte INFO, levée par un nouvel état de mapping IGNOREE. Dérive = |kmEstimé - kmManuel| / (kmManuel - kmRéférence) x 100, affichée à 1 décimale (T39 : 4,2 %). Elle n'est calculée que si la distance manuelle atteint au moins telemetry.drift.minDistanceKm (100 km) ; sinon la nouvelle référence est posée sans alerte. L'estimation au relevé manuel utilise l'échantillon le plus proche à ±30 min ; sinon NON_CALIBRABLE et la référence précédente est conservée. Les relevés CARBURANT et IMPORT ne servent pas de référence (seuls remise, restitution, entretien et relevé libre, selon 5.6). Fichiers : apps/api/src/domain/gps-calibration.ts et gps-calibration.spec.ts, apps/worker/src/jobs/telemetry-sync.job.ts, packages/db/prisma/schema.prisma (TelemetryMappingStatus.IGNOREE).
- **Justification** : Ce choix est cohérent avec T31, T39 et T41, évite l'avalanche d'alertes et suit la liste des références de calibrage de 5.6.

### D-250 — [9.1 / 17.1 / 18 (T07)] Définition de « réservation compromise » et tolérance de retour

- **Ambiguïté** : « Réservation compromise » n'est pas définie. « Alerte dès dépassement ; tolérance configurable » ne donne pas de valeur, et le rattrapage tourne toutes les 15 min.
- **Options** : Ne signaler que la réservation immédiatement suivante / Évaluer sur un horizon toutes les réservations confirmées ayant un bloqueur
- **Décision** : Option 2 :
- usages.returnToleranceMinutes = 0.
- RETOUR_DEPASSE quand maintenant dépasse expectedReturnAt + tolérance ; l'alerte apparaît au plus 15 min après.
- RESERVATION_COMPROMISE pour chaque réservation CONFIRMEE qui commence dans les 48 h (reservations.compromiseHorizonHours) et qui rencontre un bloqueur à son début : utilisation du véhicule ou du conducteur en retard ou dont le retour prévu dépasse le début, immobilisation active, document bloquant non valide à cette date, véhicule non ACTIF ou conducteur inactif.
- Occurrence = réservation + cause ; l'alerte est résolue quand la cause disparaît.
Fichiers prévus : apps/api/src/modules/alerts/alerts.service.ts, apps/worker/src/jobs/alert-catch-up.job.ts, apps/api/test/integration/alerts.int.spec.ts.
- **Justification** : Cela couvre T07 (alerte, utilisation ouverte, départ suivant bloqué) et les autres causes réalistes, sans clôture automatique (4.5).

### D-251 — [9.2] Clé d'occurrence, réactivation et alertes après transfert — **irreversible**

- **Ambiguïté** : « Occurrence » n'est pas définie par type. Le cas d'une condition qui cesse puis revient sur le même objet (retour prévu prolongé puis de nouveau dépassé) n'est pas traité. Après un transfert, une alerte d'état du véhicule porte l'ancienne société, qui fait partie de la clé de déduplication.
- **Options** : Une nouvelle ligne à chaque déclenchement / Clé d'occurrence par type, upsert, réactivation de la même ligne / Clé sans société
- **Décision** : occurrenceKey par type : ENTRETIEN_ECHEANCE = planId:baseOperationId ; ENTRETIEN_PLAN_INCOMPLET = planId ; DOCUMENT_ECHEANCE = documentVersionId ; DOCUMENT_MANQUANT = ownerId:documentTypeId ; KILOMETRAGE_ABSENT = vehicleId ; KILOMETRAGE_ANCIEN = lastAcceptedReadingId ; RELEVE_A_VALIDER = readingId ; RETOUR_DEPASSE = usageId ; RESERVATION_COMPROMISE = reservationId ; INCIDENT_CRITIQUE = incidentId ; GPS_SOURCE_MUETTE = mappingId:lastObservedAt ; GPS_DERIVE = calibrationId ; GPS_UNITE_NON_MAPPEE = unitId ; CARBURANT_* = fuelEventId. Écriture par INSERT … ON CONFLICT sur la clé unique. Une même occurrence redevenue vraie remet la ligne ACTIVE (reopenedCount++, trace en audit), et la gravité évolue sur la même ligne. Lors d'un transfert, les alertes d'état du véhicule (entretien, document véhicule, kilométrage, GPS) de l'ancienne société passent RESOLUE avec resolutionReason=TRANSFERT, puis sont réévaluées sous la nouvelle société. Les alertes liées à des événements historiques gardent leur société. Fichiers : apps/api/src/modules/alerts/alert-catalog.ts, apps/api/src/modules/alerts/alert-evaluator.service.ts, apps/api/test/integration/alerts.int.spec.ts (T19 : 10 recalculs donnent 1 ligne).
- **Justification** : Ce choix respecte « évolution de gravité sur la même alerte, pas de doublons » et « la récurrence suivante crée une nouvelle occurrence ». Les clés persistées ne pourront plus changer sans doublons.

### D-252 — [9.2] Report motivé : portée, durée et effets

- **Ambiguïté** : Le report peut être global ou propre à chaque utilisateur. L'unité de la date, la durée maximale, l'effet sur les e-mails et le récapitulatif, et le comportement en cas d'escalade de gravité pendant le report ne sont pas définis.
- **Options** : Report global de l'alerte / Report par destinataire, sans effet sur le statut / Report qui suspend l'alerte
- **Décision** : Le report est propre à chaque destinataire : AlertRecipientState.snoozedUntil (date civile, valable jusqu'à la fin du jour local), motif obligatoire, durée maximale alerts.maxSnoozeDays = 90. L'alerte reste ACTIVE et garde sa gravité et son retard. Elle apparaît dans le filtre « Reportées » avec motif et auteur, et les autres destinataires voient l'information. Elle est exclue, pour cet utilisateur seulement, des alertes prioritaires du tableau de bord, des e-mails immédiats et du récapitulatif. Toute hausse de gravité annule le report et remet readAt à zéro. Fichiers : apps/api/src/modules/alerts/alerts.controller.ts (POST /alerts/:id/snooze, /:id/read), apps/api/src/modules/alerts/dto/snooze-alert.dto.ts, apps/web/app/(app)/alertes/page.tsx.
- **Justification** : 13.2 place le report et la lecture par destinataire. 9.2 exige que le report ne retire pas le retard et affiche son motif.

### D-253 — [9.2 / 18 (T19)] Clé d'occurrence et déduplication des alertes — **irreversible**

- **Ambiguïté** : La déduplication se fait « par organisation, société, type, objet et occurrence », mais l'occurrence n'est définie pour aucun type, et encore moins pour les alertes F11.
- **Options** : Occurrence = objet seul / Clé d'occurrence explicite par type
- **Décision** : Option 2. Clé d'occurrence par type :
- Échéance d'entretien : plan + identifiant de la base (dernière opération). La gravité évolue de A_PREVOIR à A_FAIRE puis EN_RETARD sur la même alerte.
- Document : type + propriétaire + version courante.
- KILOMETRAGE_ANCIEN : véhicule + dernier relevé accepté.
- RELEVE_A_VALIDER : relevé.
- RETOUR_DEPASSE : utilisation.
- RESERVATION_COMPROMISE : réservation + cause.
- GPS_SOURCE_MUETTE : mapping + dernier observedAt.
- GPS_DERIVE : mapping.
- Unité non mappée : fournisseur.
- Carburant : événement.
L'écriture se fait par upsert sur l'index unique, les jobs sont dédupliqués par Job.dedupeKey, et un e-mail part une fois par niveau de gravité. Fichiers prévus : apps/api/src/modules/alerts/alert-occurrence.ts, apps/api/src/modules/alerts/alerts.service.ts, apps/api/test/integration/alerts.int.spec.ts.
- **Justification** : T19 exige une seule alerte active après dix recalculs. Changer ce format plus tard créerait des doublons dans les données déjà stockées.

### D-254 — [9.3] Chemin de recalcul des alertes après validation

- **Ambiguïté** : Le recalcul après validation peut être synchrone ou asynchrone. Le comportement n'est pas défini si le recalcul échoue après le commit de la mutation, alors que l'objectif est d'une minute.
- **Options** : Recalcul synchrone dans la transaction / Recalcul après commit, avec Job de secours inscrit dans la transaction / Uniquement par le rattrapage de 15 min
- **Décision** : La transaction de la mutation (relevé, clôture, document, restitution, plein, qualification) insère un Job alerts.recompute avec dedupeKey = alerts:vehicle:<id> (ou l'objet concerné). Après le commit, l'API exécute immédiatement AlertEvaluator.evaluateVehicle(id). En cas d'échec, le worker reprend le job en interrogeant la file toutes les 10 s. Le rattrapage toutes les 15 min (apps/worker/src/jobs/alert-catch-up.job.ts, verrou JobLease) balaie tout par organisation. L'évaluation est idempotente (upsert). Test avec horloge contrôlable : alerte présente moins de 60 s après le commit. Fichiers : apps/api/src/modules/alerts/alert-evaluator.service.ts, apps/api/test/integration/alerts.int.spec.ts.
- **Justification** : La réactivité vient du chemin synchrone. L'outbox de jobs garantit qu'aucun événement n'est perdu, conformément à « événements manqués » (9.3).

### D-255 — [9.3 / 5.6] Historisation horaire télématique contre alerte à une minute (T42) — **contradiction-cdc**

- **Ambiguïté** : 5.6 limite l'historisation d'un relevé TELEMATICS à un par heure et par véhicule, et seuls les relevés acceptés entrent dans les calculs (5.1). Or T42 exige A_PREVOIR puis A_FAIRE au plus une minute après l'ingestion : un franchissement de 90 000 entre deux historisations serait retardé jusqu'à une heure. Pour le relevé de « minuit local », le CDC ne dit pas s'il faut l'enregistrer même sans progression, ni à quelle heure l'horodater.
- **Options** : Limite horaire stricte, alerte retardée jusqu'à 1 h / Calculer les échéances sur TelemetryUnitState (hors relevés acceptés) / Limite horaire avec dérogation au franchissement d'un seuil d'entretien
- **Décision** : Fonction shouldHistorizeTelematics dans apps/api/src/domain/odometer-rules.ts. Un relevé est historisé dans trois cas : (a) au moins 60 min depuis le dernier relevé TELEMATICS historisé et valeur en progression ; (b) la valeur franchit un seuil d'un plan actif qui accepte cette source (entrée en A_PREVOIR, échéance atteinte, échéance dépassée), par dérogation à la limite horaire ; (c) premier échantillon observé après 00:00 locale, même sans progression, avec observedAt = heure réelle de l'échantillon et jamais un 00:00 inventé. Les alertes sont recalculées dans la même exécution du worker. Sinon, seul TelemetryUnitState est mis à jour. Fichiers : apps/api/src/domain/odometer-rules.ts et odometer-rules.spec.ts, apps/api/src/modules/telemetry/telemetry-ingestion.service.ts, apps/worker/src/jobs/telemetry-sync.job.ts, apps/api/test/integration/telemetry-odometer.int.spec.ts (T42).
- **Justification** : Ce choix garde l'objectif de volume de 5.6 et le principe « seuls les relevés acceptés comptent », tout en tenant l'objectif d'une minute de 9.3 et de T42. La dérogation s'écarte de la limite « au plus une fois par heure ».

### D-256 — [9.3 / 6.2 / 7.1 / 15.1 / 17.1] Fuseau, jour local et saisie des dates

- **Ambiguïté** : Plusieurs notions de temps local coexistent : minuit local, 08:00 local, fin de jour de validité, jour de l'échéance, mois calendaires. Rien ne dit quel fuseau utiliser si le navigateur est hors de Tunisie, si les instants sans décalage sont acceptés, comment obtenir la date de la dernière opération depuis un horodatage, ni ce qui se passe si le fuseau du groupe change.
- **Options** : Fuseau du navigateur / Fuseau du groupe partout, affiché, et décalage obligatoire côté API
- **Décision** : Option 2 :
- Saisie et affichage dans le fuseau du groupe, avec un libellé visible.
- L'API exige des instants ISO 8601 avec décalage (sinon 422) et des dates civiles au format AAAA-MM-JJ.
- civil-date.ts est l'unique source : localDate, endOfLocalDay, addCalendarMonths avec ramenée au dernier jour du mois.
- dateDerniereOperation = date locale de performedAt. Échéance A_FAIRE le jour J local, EN_RETARD à partir de J+1 00:00 local.
- L'horloge Clock est injectée partout ; jamais de now() SQL dans une règle.
- Changer le fuseau est réservé à l'administrateur, avec avertissement et sans réécriture des dates civiles stockées.
Fichiers prévus : apps/api/src/domain/civil-date.ts, apps/api/src/domain/civil-date.spec.ts, apps/api/src/common/clock.ts, apps/web/lib/dates.ts, apps/api/src/domain/maintenance-schedule.spec.ts.
- **Justification** : 9.3 impose Africa/Tunis configurable au niveau groupe. T16 et T21 portent sur le « jour local ».

### D-257 — [9.3 / 13.1] Fuseau de saisie et d'affichage, jour local, changement de fuseau — **irreversible**

- **Ambiguïté** : Le fuseau est configurable au niveau du groupe, mais le CDC ne dit pas dans quel fuseau l'utilisateur saisit et lit (celui du navigateur ou celui du groupe). L'effet d'un changement de fuseau sur les dates civiles déjà dérivées n'est pas défini, ni la granularité du rattrapage au passage de minuit local.
- **Options** : Fuseau du navigateur / Fuseau du groupe partout, affiché explicitement / Fuseau par société
- **Décision** : Toute saisie et tout affichage d'horodatage utilisent Organization.timezone (IANA, Africa/Tunis), libellé à l'écran, quel que soit le fuseau du navigateur. L'API exige des horodatages ISO 8601 avec décalage (422 pour une date naïve) et des dates civiles au format YYYY-MM-DD. Toutes les conversions passent par apps/api/src/domain/civil-date.ts (bibliothèque avec tzdata). Les dates civiles dérivées (occurredOn, snoozedUntil) sont figées à l'écriture. Changer de fuseau est réservé à l'admin, avec audit et avertissement. Le rattrapage s'exécute à :00, :15, :30 et :45 UTC, donc le passage de 00:00 locale est traité au plus 15 min après. Fichiers : apps/api/src/domain/civil-date.ts et civil-date.spec.ts, packages/contracts, apps/web/lib/format-date.ts.
- **Justification** : Un utilisateur en déplacement ne doit pas décaler les échéances. Stockage en UTC et dates civiles sans décalage (9.3).

### D-258 — [9.3 / 13.1 / 13.2 / 4.5] Fuseau de référence, conversions et calendrier du planning — **irreversible**

- **Ambiguïté** : Le fuseau est « configurable au niveau groupe » (9.3), mais 13.2 place des paramètres de fuseau et de devise sur Company. Le CDC ne dit pas comment l'API reçoit les horodatages (décalage horaire obligatoire ?), si l'interface affiche l'heure du navigateur ou celle du groupe, quel est le premier jour de la semaine du planning, ni ce qu'entraîne un changement de fuseau.
- **Options** : Un seul fuseau et une seule devise pour l'organisation, décalage obligatoire dans l'API, affichage dans le fuseau du groupe / Fuseau par société / Fuseau du navigateur
- **Décision** : En V1, un seul fuseau IANA et une seule devise, au niveau de l'organisation, sans surcharge par société. Les instants sont stockés en timestamptz UTC. L'API n'accepte que l'ISO 8601 avec décalage ou Z, sinon 422 ; les dates civiles (validité, échéances) sont des DATE au format YYYY-MM-DD. Le web saisit et affiche toujours dans le fuseau du groupe, jamais celui du navigateur, et le fuseau est indiqué sur les écrans et dans les exports. civil-date.ts centralise : jour local d'un instant, fin de journée locale, ajout de mois calendaires, bornes de jour, de semaine (lundi à dimanche) et de mois pour le planning et les rapports. Changement de fuseau : administrateur seul, audité, précédé d'un avertissement ; aucune donnée n'est réécrite et les statuts sont recalculés au rattrapage suivant. Fichiers : apps/api/src/domain/civil-date.ts, apps/api/src/domain/civil-date.spec.ts, apps/api/src/common/clock.ts, apps/api/src/modules/settings/settings.service.ts, apps/web/app/(app)/planning/page.tsx, packages/contracts.
- **Justification** : Applique 9.3 : fuseau du groupe, UTC en stockage, dates civiles sans décalage artificiel. Un utilisateur en déplacement voit les mêmes échéances que le chef.

### D-259 — [9.3 / 13.2 / 5.5 / 6.2 / 7.1] Fuseau horaire : niveau organisation ou société, et changement de fuseau

- **Ambiguïté** : 9.3 fixe un fuseau au niveau du groupe, alors que 13.2 prévoit des « paramètres de fuseau » par société. L'effet d'un changement de fuseau n'est pas décrit.
- **Options** : Fuseau par société / Fuseau unique pour l'organisation
- **Décision** : Fuseau unique pour l'organisation (`org.timezone`, Africa/Tunis). Pas de fuseau par société en V1.

Tous les calculs civils (fin de jour d'un document, jour d'échéance, relevé de minuit, rapports) passent par civil-date.ts avec une base IANA, sûre face aux changements d'heure.

Changement de fuseau : administrateur seulement, audité, avec recalcul de tous les statuts et alertes ; les dates civiles stockées ne changent pas.
- **Justification** : 9.3 est la règle explicite. Un seul fuseau évite des échéances différentes selon la société.

### D-260 — [9.3 / 18 (T42)] Mécanisme du recalcul d'alertes en moins d'une minute

- **Ambiguïté** : Le CDC fixe un objectif d'une minute après validation, sans dire si le recalcul est synchrone, s'il passe par le worker, ni comment rattraper un recalcul perdu en cas de crash entre le commit et le calcul.
- **Options** : Recalcul synchrone uniquement / Recalcul synchrone après commit, avec un job transactionnel comme filet de sécurité
- **Décision** : Option 2. Recalcul post-commit dans le processus, plus une ligne Job alerts.recompute insérée dans la même transaction (dedupeKey = objet) et consommée par le worker toutes les 10 s. L'ingestion télématique recalcule après chaque véhicule. Le rattrapage de 15 min traite les seuils temporels. Fichiers prévus : apps/api/src/modules/alerts/alerts.service.ts, apps/worker/src/jobs/alert-catch-up.job.ts, apps/api/test/integration/alerts.int.spec.ts.
- **Justification** : On tient l'objectif d'une minute même en cas de crash, sans dépendre de Redis (14.1).

### D-261 — [9.4] Outbox : rendu, reprises, abandon et absence de SMTP

- **Ambiguïté** : La politique de reprise n'est pas chiffrée. Si le corps est figé à l'enfilement, il peut montrer des données que le destinataire ne peut plus voir au moment de l'envoi. Le CDC ne dit pas s'il faut enfiler quand le SMTP est absent, ni comment réinitialiser un mot de passe sans SMTP. Le contenu autorisé dans un e-mail n'est pas défini.
- **Options** : Corps figé à l'enfilement / Références seulement, rendu à l'envoi après revérification des droits / Envoi direct sans outbox
- **Décision** : NotificationOutbox stocke le type, les références (alertId, userId) et les paramètres. Le rendu a lieu à l'envoi, après revérification : compte actif, habilitation sur la société, préférence ; sinon statut ANNULE (« droits révoqués »). Reprises à 1, 2, 4, 8, 16, 32, 60 puis 60 min (8 tentatives), puis ABANDONNE. Verrouillage par SELECT … FOR UPDATE SKIP LOCKED avec lockedUntil de 2 min ; une ligne EN_COURS dont le verrou a expiré repasse EN_ATTENTE, et le risque de double livraison est documenté dans docs/exploitation.md. Sans SMTP (SMTP_HOST vide ou email.enabled=false) : rien n'est enfilé et la bannière « Canal e-mail non configuré » s'affiche ; l'admin génère alors un lien de réinitialisation à usage unique, affiché une seule fois. Corps : texte brut et lien, sans pièce jointe, sans montant, sans donnée personnelle de conducteur. /administration montre l'état exact de l'outbox. Fichiers : apps/worker/src/jobs/outbox-dispatcher.job.ts, apps/api/src/modules/notifications/notifications.service.ts, apps/api/test/integration/notifications.int.spec.ts (T29).
- **Justification** : Ce choix applique « autorisations revérifiées avant envoi », « jamais de succès fictif » et « aucun PDF personnel » (9.4). Ne pas enfiler sans canal évite un déluge de messages obsolètes à l'activation du SMTP.

### D-262 — [9.4] Récapitulatif quotidien de 08:00

- **Ambiguïté** : Le contenu, les destinataires, le cas d'un récapitulatif vide, le rattrapage si le worker est arrêté à 08:00 et la déduplication ne sont pas définis.
- **Options** : Envoi à 08:00 exactement ou abandon / Envoi dès 08:00 avec rattrapage dans la journée / Envoi groupé hebdomadaire
- **Décision** : apps/worker/src/jobs/daily-digest.job.ts tourne chaque minute. Pour chaque CHEF ou ADMIN actif qui a un e-mail et la préférence emailDailyDigest : si l'heure locale est ≥ 08:00 et qu'aucune ligne d'outbox digest:<userId>:<dateLocale> n'existe, il génère le récapitulatif au moment de l'envoi. Contenu : alertes ACTIVE non reportées de son périmètre, groupées par gravité et société, soumissions en attente, retours attendus du jour. Pas d'envoi si le récapitulatif est vide. Rattrapage jusqu'à 23:59 locale, puis abandon du jour. Rien n'est envoyé si le canal n'est pas configuré. Fichiers : apps/worker/src/jobs/daily-digest.job.ts, apps/api/src/modules/notifications/digest.service.ts.
- **Justification** : Idempotent par jour et par destinataire, résistant aux redémarrages (9.4), sans e-mail fictif.

### D-263 — [9.4 / 16.1 / 18 (T29)] SMTP absent ou en panne, récapitulatif manqué, invitations

- **Ambiguïté** : Sans SMTP, on ignore s'il faut remplir l'outbox, ce qui provoquerait un envoi massif et périmé à l'activation. Le CDC ne fixe pas la politique de reprise, ne dit pas si un récapitulatif manqué à 08:00 est rattrapé, ni comment inviter un utilisateur ou réinitialiser un mot de passe sans SMTP.
- **Options** : Remplir l'outbox même sans SMTP / Pas d'outbox tant que le SMTP n'est pas configuré ; reprise bornée en cas de panne
- **Décision** : Option 2 :
- Sans SMTP : aucune ligne d'alerte dans l'outbox et le message « Canal e-mail non configuré ».
- SMTP en panne : reprise exponentielle 1, 2, 4… min plafonnée à 60 min, 8 tentatives puis ABANDONNE. Un bail lockedUntil permet la reprise après redémarrage.
- Récapitulatif : clé digest:utilisateur:date locale, rattrapé le jour même si besoin, jamais envoyé deux fois.
- Destinataire revérifié au moment de l'envoi.
- Sans SMTP, l'administrateur copie lui-même un lien d'invitation ou de réinitialisation à usage unique.
Fichiers prévus : apps/api/src/modules/notifications/notifications.service.ts, apps/worker/src/jobs/outbox-dispatcher.job.ts, apps/worker/src/jobs/daily-digest.job.ts, apps/api/test/integration/notifications.int.spec.ts.
- **Justification** : Cela répond à « ne jamais afficher un succès fictif » (9.4) et donne à T29 un statut exact avec reprise.

### D-264 — [10.1] Sélecteur de société, vue « Toutes mes sociétés », filtres persistants

- **Ambiguïté** : Le CDC ne définit pas qui est « habilité » à la vue consolidée. Il ne précise pas où persistent le choix de société et les filtres, ni comment créer un objet depuis la vue consolidée.
- **Options** : Vue consolidée réservée à l'admin / Vue offerte dès deux sociétés dans le périmètre / Toujours offerte
- **Décision** : La vue est offerte à tout utilisateur ayant au moins deux sociétés dans son périmètre ; l'admin les a toutes. Le choix de société n'est qu'un filtre companyId, recoupé côté serveur, mémorisé dans un cookie non sensible et dans l'URL. Les utilisateurs mono-société n'ont pas de sélecteur. En vue consolidée, les formulaires de création exigent un choix explicite de société. Filtres : les paramètres d'URL font foi, et la dernière combinaison est mémorisée en localStorage par liste (avec try/catch), jamais comme périmètre. Pagination de 25 par défaut, 100 au maximum. Fichiers : apps/web/components/company-switcher.tsx, apps/web/lib/list-state.ts, apps/api/src/common/request-context.ts, tests/e2e/consolidation.spec.ts (T02).
- **Justification** : Un chef multi-société a besoin de la consolidation (1.4). Les identifiants venant du navigateur ne font jamais autorité (2.3).

### D-265 — [10.2] Saisie rapide /kilometrage par parc : atomicité

- **Ambiguïté** : La saisie en masse peut être tout-ou-rien, comme un import, ou traitée ligne par ligne.
- **Options** : Tout-ou-rien / Ligne par ligne avec résultat individuel
- **Décision** : Chaque ligne est traitée indépendamment par OdometerIngestionService, avec la clé d'idempotence <cléLot>:<vehicleId>. Le résultat est donné par ligne : accepté, en attente avec motif, ou refusé avec motif. Les lignes vides sont ignorées ; 100 lignes au maximum. Fichiers : apps/api/src/modules/odometer/odometer.controller.ts (POST /readings/batch), apps/web/app/(app)/kilometrage/page.tsx.
- **Justification** : Chaque relevé est une observation autonome soumise aux contrôles de 5.2. Le tout-ou-rien est propre aux imports (12.1).

### D-266 — [10.2 / 2.2 / 11.2] Matrice des permissions coûts, exports et imports par écran

- **Ambiguïté** : Le rôle OPERATEUR a costs.write sans costs.read (packages/contracts) : il saisit une dépense qu'il ne peut pas relire. Le CDC ne dit pas ce que voient LECTEUR ou OPERATEUR sans costs.read sur /carburant, /fournisseurs, le tableau de bord, les tickets et les exports. Il ne précise pas qui valide, corrige, qualifie ou importe.
- **Options** : Rôles seuls / Permissions fines avec implication costs.write ⇒ costs.read et suppression des champs dans les DTO / Masquage côté client
- **Décision** : Matrice unique dans apps/api/src/modules/access-control/policies.ts ; effectivePermissions ajoute COSTS_READ si COSTS_WRITE. Sans costs.read :
- /depenses renvoie 403 et disparaît de la navigation ;
- /carburant affiche litres et dates sans montants ni ticket, champs retirés des DTO serveur ;
- pas de KPI de coût, pas de colonne de coût dans les exports, pas de montant dans l'historique fournisseur ;
- les fiches imprimables suivent les mêmes DTO.
Droits :
- création de plein, de dépense ou de fournisseur : costs.write ;
- validation d'une soumission : costs.write ;
- correction ou annulation d'une dépense validée : costs.write et rôle CHEF ou ADMIN ;
- qualification d'un FuelEvent : CHEF ou ADMIN ;
- export : reports.export, plus costs.read pour les colonnes de coûts ;
- import : CHEF ou ADMIN.
Tests : apps/api/test/integration/permissions-costs.int.spec.ts.
- **Justification** : « Consultation des coûts soumise à permissions explicites » (2.2), autorisation au point d'accès (2.3). L'opérateur doit pouvoir vérifier ce qu'il saisit.

### D-267 — [10.3] Hors connexion, doubles envois et photos mobiles

- **Ambiguïté** : Le CDC interdit de prétendre avoir enregistré hors connexion, mais ne dit pas comment éviter les doublons lors d'une nouvelle tentative après une coupure réseau, ni comment gérer les photos lourdes.
- **Options** : File hors ligne / Aucune file, brouillon local et clé d'idempotence réutilisée / Rechargement du formulaire
- **Décision** : Pas de file hors ligne. Le brouillon reste en mémoire et en sessionStorage. Une clé d'idempotence est générée à l'ouverture du formulaire et réutilisée à chaque nouvel essai ; le bouton est désactivé pendant l'envoi. En cas d'échec réseau, message « Non enregistré, réessayez ». La confirmation n'apparaît qu'après une réponse 2xx. Photos compressées côté client en JPEG de 2 Mo et 2 560 px au plus ; limite serveur de 10 Mo. Fichiers : apps/web/lib/submit-with-idempotency.ts, apps/web/components/photo-input.tsx, tests/e2e/mobile-conducteur.spec.ts.
- **Justification** : « Les actions réalisées en double doivent produire un seul résultat » (4.3), sans promettre de synchronisation hors ligne (1.3).

### D-268 — [10.3] Mobile conducteur : sans utilisation en cours, responsable habituel, QR

- **Ambiguïté** : Le CDC ne dit pas ce qu'affiche /mon-vehicule sans utilisation en cours. Il ne traite pas le conducteur responsable habituel qui roule sans remise formelle, ni le scan du QR d'un véhicule qui ne lui est pas attribué.
- **Options** : Actions limitées à l'utilisation EN_COURS / Étendre au véhicule dont il est responsable habituel / Étendre à tout véhicule scanné
- **Décision** : /mon-vehicule affiche l'utilisation EN_COURS. Sans utilisation, il affiche « Aucun véhicule remis » et l'historique des soumissions, avec les trois actions désactivées. Le paramètre drivers.allowHabitualVehicleSubmissions (false par défaut, activable par l'admin) ouvre ces actions sur le véhicule dont le conducteur est responsable habituel actif. QR : /q/<qrToken> exige une session et se résout côté serveur. Un véhicule inaccessible renvoie la même réponse 404 qu'un jeton inconnu. Aucune remise n'est créée. Fichiers : apps/web/app/(app)/mon-vehicule/page.tsx, apps/web/app/(app)/q/[token]/page.tsx, apps/api/src/modules/vehicles/vehicle-qr.controller.ts.
- **Justification** : Ce choix est fidèle à « ses propres utilisations » (2.2) et à « le QR ne remplace pas l'affectation » (10.3), et laisse une option à l'organisation.

### D-269 — [11.1] Définition des indicateurs, période et listes justificatives

- **Ambiguïté** : Des indicateurs d'état (disponibles…) sont filtrés « par période ». « Entretiens urgents », « relevés anciens », « documents expirés » et « retours attendus » ne sont pas définis. La place de la non-conformité documentaire dans la disponibilité n'est pas précisée, ni la contextualisation du cache.
- **Options** : États reconstitués à une date passée / États instantanés et flux filtrés par période / Tout filtré par période
- **Décision** : Les indicateurs d'état sont instantanés et horodatés. Les flux (coûts, entretiens réalisés, incidents, immobilisations) sont filtrés par période en dates civiles inclusives. Définitions :
- parc actif = cycle de vie ACTIF ;
- disponibles, en utilisation et immobilisés forment une partition exclusive (apps/api/src/domain/vehicle-status.ts), avec « dont non conformes » ;
- hors service = HORS_SERVICE ;
- entretiens urgents = A_FAIRE + EN_RETARD ;
- documents expirés = EXPIRE, MANQUANT compté à part ;
- relevés anciens = A_ACTUALISER, INCONNU compté à part ;
- retours attendus = utilisations EN_COURS avec retour prévu dans la journée locale ou dépassé ;
- coûts d'exploitation = dépenses VALIDEE moins les AVOIR, hors excludedFromOperatingCost.
Chaque tuile affiche numérateur, dénominateur et période, et renvoie vers la liste filtrée par la même requête. Calcul en direct, sans cache partagé. Fichiers : apps/api/src/modules/reports/dashboard.service.ts, apps/web/app/(app)/tableau-de-bord/page.tsx, apps/api/test/integration/dashboard.int.spec.ts (T01, T02).
- **Justification** : « Aucun indicateur opaque » et « chaque indicateur ouvre sa liste justificative » (11.1). Reconstituer un état passé dépasse la V1.

### D-270 — [11.2] Format des exports et neutralisation des formules

- **Ambiguïté** : Le séparateur, les décimales, l'encodage et l'emplacement des filtres, du fuseau et de la date de génération ne sont pas fixés. Le csv-safety actuel convertit les nombres en texte : -5 devient « '-5 ».
- **Options** : CSV à la virgule, point décimal, métadonnées absentes / CSV français avec bloc de métadonnées ; XLSX avec feuille de paramètres / Métadonnées dans le nom du fichier
- **Décision** : CSV : UTF-8 avec BOM, séparateur « ; », CRLF, virgule décimale, bloc de métadonnées en tête (rapport, généré le avec fuseau, auteur, périmètre, filtres, unités), puis une ligne vide et le tableau. Les en-têtes portent les unités. XLSX : feuille « Données » avec cellules numériques et dates typées, plus une feuille « Paramètres ». Seules les valeurs texte commençant par = + - @, tabulation ou retour chariot (y compris les variantes pleine chasse) sont neutralisées. Les nombres ne sont jamais préfixés. Aucune cellule formule. Fichiers : apps/api/src/common/csv-safety.ts et csv-safety.spec.ts, apps/api/src/modules/reports/export/csv-writer.ts, apps/api/src/modules/reports/export/xlsx-writer.ts, apps/api/test/integration/exports.int.spec.ts (T34).
- **Justification** : « Les exports reprennent filtres, unités, fuseau et date de génération » (11.2), protection contre les formules, et compatibilité avec Excel en français.

### D-271 — [11.2 / 7.4] Durées d'immobilisation dans les rapports

- **Ambiguïté** : Les durées de causes superposées ne doivent pas être comptées deux fois, mais la méthode de calcul, le traitement des immobilisations en cours et le découpage par période ne sont pas définis.
- **Options** : Somme des causes / Union des intervalles par véhicule, découpée à la période
- **Décision** : Durée par véhicule = union des intervalles d'immobilisation (fin réelle, ou now ou fin de période si en cours, avec le libellé « en cours »), découpée à la période. La ventilation par cause porte la mention « les causes se chevauchent ». Durées exprimées en jours avec 1 décimale. Fichier : apps/api/src/modules/reports/immobilization-report.service.ts.
- **Justification** : 7.4 et 11.2 exigent de ne pas compter deux fois les chevauchements.

### D-272 — [11.2 / 17.2] Exports volumineux et droits revérifiés

- **Ambiguïté** : Le seuil de passage en tâche de fond, le stockage, la durée de vie et le contrôle au téléchargement des exports ne sont pas définis.
- **Options** : Toujours synchrone / Synchrone jusqu'à un seuil, puis Job asynchrone avec fichier privé / Toujours asynchrone
- **Décision** : Export synchrone en flux jusqu'à 5 000 lignes. Au-delà, un Job report-export avec progression (apps/worker/src/jobs/report-export.job.ts) produit une pièce jointe privée ownerType=EXPORT, réservée au demandeur et supprimée après 7 jours. Au téléchargement, le serveur revérifie reports.export, costs.read si le fichier a des colonnes de coûts, et le périmètre ; sinon 403. Plafond de 100 000 lignes. Chaque export est audité. Fichier : apps/api/src/modules/reports/reports.controller.ts.
- **Justification** : « Droits revérifiés à l'exécution et au téléchargement » (11.2) et « rapports volumineux par job » (17.2).

### D-273 — [11.2 / 18 (T32, T34)] Exports synchrones ou asynchrones, droits et format CSV

- **Ambiguïté** : Le CDC ne dit ni à partir de quelle taille un export passe en job, ni quels séparateurs utiliser, ni comment neutraliser les formules.
- **Options** : Tout en synchrone / Synchrone jusqu'à un seuil, job au-delà, avec neutralisation par type de cellule
- **Décision** : Option 2 :
- Synchrone jusqu'à 5 000 lignes, en job au-delà.
- Fichier conservé 24 h, droits revérifiés au téléchargement.
- CSV avec BOM, séparateur « ; » et virgule décimale.
- Apostrophe ajoutée devant un texte commençant par =, +, -, @ ou un caractère de contrôle ; nombres typés.
Fichiers prévus : apps/api/src/common/csv-safety.ts, apps/worker/src/jobs/report-export.job.ts, apps/api/test/integration/exports.int.spec.ts.
- **Justification** : Couvre T32, T34 et 17.2.

### D-274 — [11.3] Distance d'une période, période observée et coût/km

- **Ambiguïté** : Des « relevés délimitant exactement une période » n'existent presque jamais. Le CDC ne définit ni la couverture minimale, ni le traitement des relevés estimés GPS, ni celui d'un cumul incomplet.
- **Options** : Interpolation linéaire / Période observée entre le premier et le dernier relevé de la période / N/D systématique
- **Décision** : R1 et R2 sont le premier et le dernier relevé accepté dans [du, au]. Distance = cumulé(R2) - cumulé(R1), affichée avec ses dates observées. N/D si moins de 2 relevés, si le cumul est incomplet, ou si les relevés appartiennent à des sociétés différentes sans relevé de transfert. Une borne DISTANCE_GPS est libellée « estimation GPS ». Coût/km = coûts dont occurredOn ∈ [date(R1), date(R2)] / distance, calculé seulement si la distance est positive et que la période observée couvre au moins reports.minObservedCoverage = 50 % de la période ; sinon N/D avec motif. Jamais 0 pour une donnée absente. Fichiers : apps/api/src/modules/reports/distance.service.ts, apps/api/src/domain/odometer-rules.ts.
- **Justification** : Pas d'interpolation silencieuse, et un intervalle explicitement défini (11.3). Les ratios GPS sont montrés comme estimations (5.6).

### D-275 — [11.3 / 2.4 / 13.1] Visibilité des données après transfert et ventilation

- **Ambiguïté** : 2.4 cite l'état technique courant et les documents partagés, sans dire quel historique la nouvelle société voit : relevés, interventions sans coûts, incidents, utilisations, échantillons carburant. Il ne dit pas ce que l'ancienne société voit du véhicule, ni comment traiter une distance à cheval sur le transfert.
- **Options** : Nouvelle société : aucun historique / Historique technique filtré et expurgé / Tout l'historique
- **Décision** : Règle d'accès : un objet historique est visible par les utilisateurs de sa société historique. La société courante du véhicule voit en plus :
- les relevés, avec l'auteur affiché « Utilisateur d'une autre société » ;
- les plans et leurs bases ;
- les interventions TERMINEE en vue technique, sans lignes, montants, fournisseur ni pièces jointes ;
- les documents listés dans sharedDocumentIds.
Elle ne voit jamais les utilisations, réservations, incidents, pleins, dépenses, FuelEvent ni échantillons antérieurs au transfert. L'ancienne société garde ses objets historiques, avec le code et l'immatriculation du véhicule, mais la fiche véhicule courante lui renvoie 404. Le transfert demande un relevé de contexte TRANSFERT (société source, observedAt = effectiveAt) ou un motif « sans relevé » ; sans relevé, la distance à cheval est « non ventilable ». Fichiers : apps/api/src/modules/access-control/policies.ts, apps/api/src/modules/vehicles/vehicle-transfer.service.ts, apps/api/test/integration/transfer.int.spec.ts (T01, T26).
- **Justification** : Les coûts et données personnelles restent protégés (2.4), l'état technique courant utile est partagé, et le cloisonnement est appliqué côté serveur.

### D-276 — [11.3 / 5.6] Distances et coût/km issus d'estimations

- **Ambiguïté** : Le CDC dit « affichés comme estimations » sans préciser si les estimations entrent dans les calculs des rapports.
- **Options** : Les mélanger aux relevés physiques / Bornes physiques par défaut et colonne estimée séparée
- **Décision** : Option 2. La distance d'utilisation se calcule uniquement sur relevés manuels. Les exports portent la nature de chaque borne, et un coût/km fondé sur une estimation est marqué « estimé ». Fichiers prévus : apps/api/src/modules/reports/reports.service.ts, apps/api/test/integration/reports.int.spec.ts.
- **Justification** : 11.3 exige des ratios honnêtes.

### D-277 — [12.1] Atomicité, revalidation à la confirmation et idempotence des lots

- **Ambiguïté** : La base peut changer entre la prévisualisation et la confirmation. Dans T27, « lot corrigé confirmé deux fois » peut désigner deux clics ou deux téléversements. Le CDC ne dit pas si une hausse au-delà du seuil de plausibilité est une erreur, qui peut importer, ni combien de temps garder les données.
- **Options** : Écriture sans revalidation / Transaction unique avec revalidation complète et clé de confirmation / Import ligne par ligne
- **Décision** : États : TELEVERSE → CONTROLE → CONFIRME | ABANDONNE (automatique après 7 j). La confirmation est une transaction unique qui revalide tout ; au moindre écart, rollback et retour à CONTROLE. commitKey = sha256(lot + fichier + mapping de colonnes) ; une seconde confirmation renvoie le même rapport sans écrire. Un fichier téléversé à nouveau déclenche l'avertissement « déjà importé le … » et les doublons en base sont des erreurs ; un relevé identique est idempotent. Pas de mode « ignorer les existants ». Une rupture de chronologie est une erreur ; une hausse au-delà du seuil importe la ligne EN_ATTENTE. Import réservé à CHEF et ADMIN, sur leur périmètre. ImportRow.data est purgé 90 jours après la fin du lot. Fichiers : apps/api/src/modules/imports/imports.service.ts, apps/api/test/integration/imports.int.spec.ts (T27).
- **Justification** : « Aucune ligne écrite avant confirmation ni validée si le lot a des erreurs » et « confirmation idempotente » (12.1).

### D-278 — [12.1] Formats de dates, nombres, encodage et fichiers acceptés

- **Ambiguïté** : Le CDC ne liste pas les formats de date et d'heure acceptés, ne tranche pas pour une date seule dans observed_at ni pour les séparateurs décimaux ou de milliers (45.230). Les encodages, séparateurs CSV, feuilles XLSX et formules ne sont pas définis.
- **Options** : Formats libres avec détection / Liste fermée et documentée, refus explicite des ambiguïtés / ISO seul
- **Décision** : Dates acceptées : YYYY-MM-DD, DD/MM/YYYY (jour en premier, année sur 4 chiffres) ou cellule date XLSX. Refusés : années à 2 chiffres, mois en lettres, numéros de série Excel dans un CSV. Horodatages : YYYY-MM-DD HH:mm[:ss], DD/MM/YYYY HH:mm, ou ISO avec décalage ; sans décalage, l'heure est locale au groupe. Une date seule dans observed_at vaut 00:00 locale, avec la note « heure non fournie ». Kilomètres en entiers ; tout séparateur « . » ou « , » est refusé. Booléens : oui/non, true/false, 1/0, actif/inactif. CSV en UTF-8, séparateur détecté entre « ; » et « , ». Feuille XLSX : la première ou « Données » ; formules sans valeur en cache et cellules fusionnées refusées. 2 000 lignes de données, 5 Mo. Fichiers : apps/api/src/modules/imports/parsers/*.ts, apps/api/src/modules/imports/templates/, docs/guide-imports.md.
- **Justification** : « Valeurs de date explicitement documentées ; dates ambiguës refusées » (12.1). « 45.230 » est ambigu entre milliers et décimales.

### D-279 — [12.2] Sémantique de meter_reference, base_km, base_mode et référentiels

- **Ambiguïté** : meter_reference n'est pas défini. Le CDC ne dit pas si base_km est physique ou cumulé, ne liste pas les valeurs de base_mode et n'a pas de colonne interval_days. Il ne précise pas le référencement des catégories et sites. L'état d'exploitation, obligatoire en 3.1, manque dans les colonnes. Il n'y a pas de modèle pour les sociétés et sites.
- **Options** : Colonnes libres interprétées / Vocabulaire fermé aligné sur les énumérations du schéma
- **Décision** : Relevés :
- meter_reference ∈ {INITIAL, COURANT} : INITIAL crée le premier segment, COURANT ajoute au segment ouvert ;
- colonne facultative initial_cumulative_km pour un compteur déjà remplacé ;
- jamais de remplacement implicite de compteur.
Bases d'entretien :
- base_km et next_due_km exprimés en km cumulés ;
- base_mode prend les valeurs de PlanBaseMode, avec les colonnes exigées selon le mode ;
- interval_days facultatif ;
- maintenance_type est un code du catalogue ;
- aucune intervention ni dépense créée.
Véhicules : catégorie par code, site par code ou nom unique, état ACTIF par défaut. driver_code unique dans l'organisation. Sociétés et sites se créent par l'administration. Fichiers : apps/api/src/modules/imports/templates/, apps/api/src/modules/imports/row-validators/*.ts.
- **Justification** : Pas de fausse distance ni de faux remplacement (5.4, 12.2). Pas de prestation simulée. Les entretiens reposent sur le cumul (5.4).

### D-280 — [12 / 18 (T27)] Relevés identiques déjà présents lors d'un import

- **Ambiguïté** : L'idempotence de 5.2 (même valeur au même instant) n'est pas déclinée pour les lignes d'import.
- **Options** : Traiter la ligne comme une erreur / Ligne marquée « déjà présente », non bloquante
- **Décision** : Option 2. La double confirmation renvoie 200 avec le rapport initial. Même instant avec une valeur différente : erreur. Cela suppose d'ajouter le statut IGNOREE à ImportRowStatus. Fichiers prévus : apps/api/src/modules/imports/imports.service.ts, packages/db/prisma/schema.prisma, apps/api/test/integration/imports.int.spec.ts.
- **Justification** : Applique 5.2 à l'import.

### D-281 — [13.1] Précision kilométrique et comparaison aux échéances

- **Ambiguïté** : Les km sont stockés en DECIMAL(15,3) mais affichés en entiers. Le CDC ne dit pas si la saisie manuelle accepte des décimales. Avec un CAN à 90 000,4, « la valeur exacte donne A_FAIRE » est ambigu. Le mode d'arrondi de l'affichage n'est pas fixé.
- **Options** : Comparaisons décimales strictes / Comparaison de la partie entière du cumul / Arrondi au km le plus proche
- **Décision** : Saisie manuelle en entiers ; décimales refusées pour MANUAL, sauf compteur au dixième. Les valeurs télématiques gardent 3 décimales. Les statuts comparent floor(kmCumulé) à l'échéance : égal donne A_FAIRE, supérieur donne EN_RETARD. Affichage tronqué. La chronologie et la plausibilité utilisent les valeurs exactes. Fichiers : apps/api/src/domain/maintenance-schedule.ts et maintenance-schedule.spec.ts (T15, T42), apps/api/src/modules/odometer/dto/create-reading.dto.ts.
- **Justification** : Le compteur physique affiche des entiers : on compare ce qu'un humain lirait sur le tableau de bord.

### D-282 — [13.1] Relations inter-organisations et inter-sociétés en base — **irreversible**

- **Ambiguïté** : Le CDC interdit « une relation entre objets de sociétés incompatibles », mais la société d'un véhicule change dans le temps. Le schéma a des FK simples : FuelEntry.driverId, Expense.vehicleId, Expense.supplierId.
- **Options** : Validation applicative seule / FK composites plus validation transactionnelle plus triggers / Triggers seuls
- **Décision** : Toutes les FK métier deviennent composites (id, organizationId). Les FK (id, companyId) sont utilisées quand l'appartenance est permanente : Supplier, Site, Department. Pour le couple véhicule/conducteur, une validation dans la transaction et un trigger SQL sur VehicleUsage, Reservation et FuelEntry contrôlent la cohérence ; un refus renvoie 422 RELATION_HORS_SOCIETE. Fichiers : packages/db/prisma/schema.prisma, packages/db/prisma/migrations/<ts>_composite_fks/migration.sql, apps/api/test/integration/relations.int.spec.ts.
- **Justification** : « Clés composites quand approprié » (13.3) et défense en profondeur contre les fuites entre sociétés.

### D-283 — [13.1 / 13.2] Conventions : objets modifiables, tables globales, suppression physique — **irreversible**

- **Ambiguïté** : Le CDC ne liste ni les objets « modifiables », ni les tables techniques globales, ni les cas de suppression physique autorisée.
- **Options** : version partout / version sur les tables mutables seulement, append-only documentées
- **Décision** : version, updatedAt et createdById sur toute table mutée par l'API. Tables append-only sans version : AuditEvent, VehicleCompanyHistory, SettingValue, TelemetrySyncRun, échantillons. Tables globales : JobLease, WorkerHeartbeat, LoginAttempt, _prisma_migrations. Suppression physique limitée aux interventions BROUILLON jamais planifiées, aux pièces jointes temporaires et aux lots d'import non confirmés ; tout le reste est archivé ou annulé. Documenté dans docs/ARCHITECTURE.md.
- **Justification** : « Politique explicite d'archivage » et « tables techniques globales documentées » (13.1).

### D-284 — [13.1 / 17.1] Arrondis et affichage

- **Ambiguïté** : Le CDC fixe la précision de stockage mais pas les règles d'affichage des compteurs, pourcentages et montants.
- **Options** : Arrondi commercial partout / Stockage exact et affichage tronqué pour les compteurs
- **Décision** : Option 2 :
- Compteurs affichés tronqués à l'entier.
- Montants en TND à 3 décimales, arrondi demi-supérieur.
- Pourcentages et L/100 km à une décimale.
- Comparaisons toujours faites sur les valeurs non arrondies.
Fichiers prévus : apps/api/src/domain/money.ts, packages/contracts/src/formats.ts.
- **Justification** : On n'affiche jamais un kilométrage supérieur à la réalité.

### D-285 — [13.2 / 5.2 / 5.6 / 11.3] Relevés GPS estimés et CAN contre contrôle de chronologie manuel — **contradiction-cdc**

- **Ambiguïté** : Une estimation GPS acceptée (80 450 à 10:00) suivie d'un relevé manuel juste mais inférieur (80 420 à 11:00) ferait refuser ce relevé comme une « diminution » (5.2). De même, un COMPTEUR_CAN accepté bloquerait une remise manuelle, contrairement à 5.6.
- **Options** : Chronologie toutes sources confondues / Chronologie sur les relevés non estimés ; le relevé manuel prime sur l'automatique contredit / Ignorer toute la télématique dans la chronologie
- **Décision** : Les voisins pris en compte pour la chronologie d'un relevé MANUAL ou IMPORT sont les relevés acceptés non estimés. Les estimations ne bloquent jamais. Si le seul conflit est avec un COMPTEUR_CAN, le relevé manuel est accepté et l'automatique contredit passe EN_ATTENTE (AUTO_CONTREDIT_PAR_MANUEL), avec audit et alerte. Un relevé TELEMATICS ne peut jamais faire refuser un relevé manuel. Les distances, consommations et échéances MANUEL_OU_CAN excluent les estimations. Fichiers : apps/api/src/domain/odometer-rules.ts et odometer-rules.spec.ts, apps/api/src/modules/odometer/odometer-ingestion.service.ts, apps/api/test/integration/telemetry-odometer.int.spec.ts (T37, T38, T40).
- **Justification** : 5.6 veut qu'un relevé automatique ne bloque ni une remise ni une saisie manuelle. Le relevé lu sur le tableau de bord fait foi. Ce choix s'écarte de la lettre de 5.2.

### D-286 — [13.2 / 15.3] Portée, durée et comportement des clés d'idempotence

- **Ambiguïté** : Le CDC ne précise pas quelles routes exigent une clé, ni comment on la fournit (en-tête ou corps), ni sa durée de vie. Il ne dit pas si une erreur doit être rejouée ni comment traiter une requête concurrente portant la même clé.
- **Options** : Clé facultative partout / Clé obligatoire sur les créations critiques, seules les réponses 2xx conservées / Tout conserver, erreurs comprises
- **Décision** : Clé passée dans l'en-tête Idempotency-Key, ou dans le corps en repli ; 422 si les deux diffèrent. Obligatoire sur checkout, return, relevés, pleins, dépenses, incidents, clôture d'intervention, transfert et commit d'import. Empreinte = JSON canonique du corps plus paramètres de route. Conservation 48 h. Même clé pendant une exécution en cours : 409 IDEMPOTENCE_EN_COURS. Seules les réponses 2xx sont conservées : après une erreur, la clé peut être réutilisée avec un corps corrigé. Fichiers : apps/api/src/common/idempotency.service.ts, apps/api/src/common/idempotency.decorator.ts, apps/api/test/integration/idempotency.int.spec.ts (T33).
- **Justification** : 15.3 : « même clé et même corps : réponse initiale ; corps différent : 409 ».

### D-287 — [13.2 / 17.1] Paramètres : seuils manquants, hiérarchie de surcharge, effet d'une modification

- **Ambiguïté** : Plusieurs seuils n'ont ni valeur ni unité, dont le seuil de plausibilité et les tolérances. La surcharge « par véhicule » prévue en 17.1 n'est pas modélisée. L'effet d'un changement de paramètre sur les alertes actives n'est pas défini.
- **Options** : Constantes codées en dur / Catalogue typé avec hiérarchie objet > société > groupe > défaut
- **Décision** : Catalogue typé dans apps/api/src/modules/settings/settings.catalog.ts : clé, unité, bornes, défaut, niveau de surcharge. Résolution dans l'ordre objet > société > groupe > défaut. Valeurs fixées, notamment odometer.plausibility.maxKmPerDay = 1 500 et les seuils carburant. Chaque modification crée une version, un audit et un job de réévaluation. Les intervalles d'entretien bénéficient d'une prévisualisation d'impact. Fichier : apps/api/src/modules/settings/settings.service.ts.
- **Justification** : « Paramètres modifiables, audités, surcharges explicites, prévisualisation » (17.1).

### D-288 — [13.3] Champs matérialisés dépendant du temps

- **Ambiguïté** : Des statuts comme la fraîcheur, A_FAIRE par date ou EXPIRE changent avec le temps. Les listes doivent pouvoir filtrer dessus sans dupliquer la formule en SQL.
- **Options** : Tout calculer à la lecture / Matérialiser avec nextStatusChangeAt et rafraîchissement par le rattrapage / Vue SQL dupliquant la formule
- **Décision** : Les valeurs issues d'événements sont matérialisées : compteur courant, échéances, version de document valide. Les statuts dépendant du temps sont matérialisés avec statusComputedAt et nextStatusChangeAt, et rafraîchis par le rattrapage de 15 min. Les fiches recalculent en direct avec la même fonction. Une commande recompute:materialized est fournie, avec un test d'intégration « matérialisé = recalculé ». Fichiers : apps/api/src/domain/maintenance-schedule.ts, apps/api/src/domain/freshness.ts, apps/api/src/domain/document-status.ts, apps/worker/src/jobs/alert-catch-up.job.ts.
- **Justification** : « Matérialisables mais recalculables » (13.3) et « une règle, un endroit » (14.2).

### D-289 — [13.3] Isolation, verrous et traduction des erreurs de concurrence

- **Ambiguïté** : Le nombre de reprises, l'ordre de verrouillage et la traduction des violations en réponses métier ne sont pas fixés.
- **Options** : Read Committed avec verrous / Serializable avec reprises bornées et verrous ordonnés / Verrous applicatifs
- **Décision** : Transactions Serializable avec 3 reprises au plus (backoff avec gigue) sur P2034 et 40001. Verrous FOR UPDATE posés dans l'ordre Vehicle → Driver → Usage → Reading. Traductions : P2002 donne 409 VEHICULE_DEJA_EN_UTILISATION ou 409 CONDUCTEUR_DEJA_EN_UTILISATION, 23P01 donne 409 CHEVAUCHEMENT, reprises épuisées donnent 409 CONCURRENCE. Fichiers : apps/api/src/common/transaction.ts, apps/api/src/common/errors.ts, apps/api/test/integration/concurrency.int.spec.ts (T04, T05).
- **Justification** : 13.3 : « une erreur de concurrence devient une réponse métier lisible, pas une double affectation ».

### D-290 — [13.3 / 2.4 / 4.2] Passage à NON_HONOREE et « réservation future non traitée »

- **Ambiguïté** : Le passage à NON_HONOREE n'est pas défini. « Non traitée », condition qui bloque un transfert, n'est pas défini non plus.
- **Options** : Passage manuel seulement / Passage automatique à endAt, marquage manuel possible plus tôt
- **Décision** : Une réservation CONFIRMEE non convertie à endAt passe automatiquement NON_HONOREE par le job de rattrapage (acteur SYSTEME, audit). Le chef peut la marquer ainsi dès startAt + 1 h. « Non traitée » pour le transfert = réservation CONFIRMEE avec endAt > now. Fichiers : apps/worker/src/jobs/alert-catch-up.job.ts, apps/api/src/modules/reservations/reservations.service.ts.
- **Justification** : Ce choix complète les statuts de 4.2 sans fabriquer d'utilisation.

### D-291 — [13.3 / 4.2 / 4.5] Réservations converties contre contrainte d'exclusion — **irreversible**

- **Ambiguïté** : La contrainte EXCLUDE actuelle ne porte que sur les réservations CONFIRMEE. Une fois la réservation CONVERTIE, le créneau se libère et une autre réservation peut chevaucher l'utilisation en cours. Une restitution anticipée ne libère pas le reste du créneau. La confirmation ne vérifie pas les utilisations en cours.
- **Options** : Contrainte limitée à CONFIRMEE / Contrainte sur CONFIRMEE et CONVERTIE avec releasedAt, plus contrôle des utilisations en service / Ajouter les utilisations dans une contrainte commune
- **Décision** : Ajout de Reservation.releasedAt, égal à returnedAt en cas de restitution anticipée. La contrainte EXCLUDE porte sur tstzrange(startAt, LEAST(endAt, COALESCE(releasedAt, endAt)), '[)') WHERE status IN (CONFIRMEE, CONVERTIE), par véhicule et par conducteur. La confirmation refuse aussi un chevauchement avec une utilisation EN_COURS ou une immobilisation. Conversion seulement pour le même véhicule et le même conducteur, sinon 409. L'erreur 23P01 est traduite en 409 RESERVATION_CHEVAUCHEMENT. Fichiers : packages/db/prisma/migrations/<ts>_reservation_exclusion_converted/migration.sql, apps/api/src/modules/reservations/reservations.service.ts, apps/api/test/integration/reservations.int.spec.ts (T06).
- **Justification** : Le créneau réellement occupé reste protégé en base (13.3) et une utilisation ne libère pas silencieusement le planning (4.5).

### D-292 — [14.1 / 19.1 / 21] Canal télématique à livrer alors que l'annexe A n'a pas été conduite

- **Ambiguïté** : Le lot F exige « le connecteur du canal retenu », mais ce canal dépend de la qualification du fournisseur (annexe A), qui n'a pas encore eu lieu. apps/telemetry-rpa n'existe que si le RPA est retenu. On ne sait donc ni quel adaptateur coder ni comment démontrer T35-T44 face à un fournisseur réel inconnu.
- **Options** : Bloquer tout le lot F jusqu'à la réponse écrite du fournisseur / Livrer le contrat TelemetryProvider, un simulateur, des adaptateurs API de référence (Traccar, Wialon) et un adaptateur RAPPORT générique paramétrable ; RPA seulement documenté / Coder les trois canaux, RPA compris
- **Décision** : Option 2. Un registre d'adaptateurs par type (TRACCAR, WIALON, RAPPORT_GENERIQUE, SIMULATEUR) implémente le même contrat. Le RPA reste une interface documentée, sans apps/telemetry-rpa en V1. T35-T44 s'exécutent sur le simulateur. Les adaptateurs réels sont testés sur des réponses enregistrées. Le rapport final classe le branchement au fournisseur réel en « dépendance externe à configurer ». Fichiers prévus : apps/api/src/modules/telemetry/adapters/traccar.adapter.ts, apps/api/src/modules/telemetry/adapters/wialon.adapter.ts, apps/api/src/modules/telemetry/adapters/report-generic.adapter.ts, apps/api/src/modules/telemetry/adapters/simulator.adapter.ts, apps/api/src/modules/telemetry/telemetry-provider.interface.ts, docs/connecteur-telematique.md, docs/DECISIONS.md.
- **Justification** : Le CDC interdit les faux succès (19.3) mais ne veut pas conditionner la V1 au GPS. Les plateformes en marque blanche citées (14.3) couvrent le cas le plus probable, et le RPA exige un accord écrit (21).

### D-293 — [14.2 / 14.1] Règle unique et aide dans les formulaires

- **Ambiguïté** : L'interface doit prévenir l'utilisateur d'une incohérence, mais ne peut pas recalculer les règles elle-même (14.2).
- **Options** : Dupliquer les règles côté client / Endpoint de prévisualisation côté serveur
- **Décision** : Option 2. POST /vehicles/:id/readings/preview exécute les contrôles sans écrire. Le worker importe les modules de l'API. L'écart d'arborescence avec le CDC est documenté. Fichiers prévus : apps/api/src/modules/odometer/odometer.controller.ts, docs/DECISIONS.md.
- **Justification** : « Une seule implémentation » (14.2).

### D-294 — [14.3] Contrat TelemetryProvider : historique, unités de mesure et horodatage

- **Ambiguïté** : getOdometers(unitIds) ne renvoie qu'un dernier état, sans période. Cela ne permet ni la reprise initiale de l'historique (14.4), ni le relevé quotidien de minuit, ni le calibrage à l'instant d'un relevé manuel. Le contrat ne fixe pas non plus les unités (Traccar renvoie des mètres, les niveaux arrivent en % ou en L), ni le fuseau d'observedAt, ni le format de sourceReference.
- **Options** : Garder le contrat strict (dernier état seulement) / Ajouter une méthode facultative getOdometerHistory(unitIds, from, to) et normaliser les unités dans chaque adaptateur / Laisser le service d'ingestion convertir selon le fournisseur
- **Décision** : Option 2. Formats normalisés :
- OdometerSample = {unitId, kind: COMPTEUR_CAN|DISTANCE_GPS, valueKm: chaîne décimale à 3 décimales, observedAt: instant UTC du fournisseur, sourceReference?}.
- FuelSample = {unitId, kind, liters?, percent?, engineOn?, speedKmh?, observedAt}.
L'adaptateur convertit les mètres en km et rejette tout échantillon sans horodatage fournisseur : receivedAt ne remplace jamais observedAt. getOdometerHistory est facultatif ; s'il manque, la reprise se limite à l'état courant et le fait est consigné dans TelemetrySyncRun. Fichiers prévus : apps/api/src/modules/telemetry/telemetry-provider.interface.ts, apps/api/src/modules/telemetry/adapters/*.adapter.ts, apps/api/src/modules/telemetry/adapters/traccar.adapter.spec.ts.
- **Justification** : Le service d'ingestion unique (14.3) doit recevoir des valeurs homogènes. Un observedAt inventé fausserait la fraîcheur, la chronologie et la détection de source muette.

### D-295 — [14.3 / 17.1] Activation et désactivation de telemetryEnabled

- **Ambiguïté** : Le CDC ne dit ni qui active le module, ni ce que deviennent les mappings, les alertes et la reprise lorsqu'on désactive puis réactive.
- **Options** : Supprimer les mappings à la désactivation / Geler les mappings et reprendre de façon bornée
- **Décision** : Option 2. Seul l'administrateur active ou désactive, avec audit. La désactivation arrête les jobs et les appels réseau, gèle les mappings et résout les alertes F11 avec le motif « module désactivé ». La réactivation reprend sur la plus courte durée entre backfillDays et la période d'inactivité. Fichiers prévus : apps/api/src/modules/telemetry/telemetry.service.ts, apps/api/src/modules/settings/settings.service.ts, apps/api/test/integration/telemetry.int.spec.ts.
- **Justification** : Aucune dépendance externe sans activation (17.1), et l'historique est conservé.

### D-296 — [14.4] Granularité des jobs de synchronisation

- **Ambiguïté** : « Un job par fournisseur et par société », alors que la liste des unités est commune au fournisseur et que l'intervalle se règle au niveau fournisseur. Le comportement d'une synchro manuelle lancée pendant un run n'est pas défini.
- **Options** : Un job par fournisseur / Un bail par couple fournisseur-société pour les données, et un par fournisseur pour la liste des unités
- **Décision** : Option 2 :
- Bail telemetry-sync:fournisseur:société pour le kilométrage et le carburant.
- listUnits une fois par heure par fournisseur.
- Intervalle ≥ 5 min, 15 par défaut.
- Bail de 5 min renouvelé ; plusieurs répliques de worker possibles.
- Synchro manuelle : job dédoublonné, réponse 202 avec l'identifiant du run en cours.
Fichiers prévus : apps/worker/src/jobs/telemetry-sync.job.ts, apps/api/src/modules/telemetry/telemetry.controller.ts, apps/api/src/common/job-lease.ts.
- **Justification** : C'est le texte de 14.4, sans multiplier les appels coûteux au fournisseur.

### D-297 — [14.4] Reprise exponentielle, quotas et coupe-circuit

- **Ambiguïté** : « Reprise exponentielle bornée », « respect des quotas » et « coupe-circuit après échecs répétés » ne sont pas chiffrés.
- **Options** : Valeurs laissées au code / Valeurs par défaut paramétrables et documentées
- **Décision** : Option 2 :
- 3 tentatives dans un même run (1, 4 puis 16 s) ; un 429 respecte Retry-After.
- Délai entre runs : intervalle × 2^n, plafonné à 60 min.
- Coupe-circuit après 5 échecs consécutifs, ouvert 60 min (runs IGNORE tracés), puis un essai unique.
- Alerte GPS_SYNCHRO_EN_ECHEC levée à l'ouverture et résolue au premier succès.
- Quota fournisseur réglé par maxRequestsPerMinute.
Fichiers prévus : apps/api/src/modules/telemetry/telemetry-resilience.ts, apps/worker/src/jobs/telemetry-sync.job.ts, apps/api/test/integration/telemetry.int.spec.ts.
- **Justification** : Une panne fournisseur ne bloque aucun parcours manuel (14.4) et reste visible.

### D-298 — [14.4 / 5.1] Webhook fournisseur vs « aucun endpoint public n'accepte TELEMATICS »

- **Ambiguïté** : 14.4 demande d'utiliser un webhook s'il existe, ce qui suppose un point d'entrée public. Or 5.1 réserve la source TELEMATICS au worker.
- **Options** : Laisser le webhook créer directement des relevés / Webhook authentifié qui ne fait que déclencher ou mettre en file ; le worker ingère
- **Décision** : Option 2. POST /api/v1/telemetry/webhooks/:providerId est authentifié par un HMAC dont le secret est chiffré, et désactivé par défaut. Il met en file un job (et, si nécessaire, le contenu brut expurgé) puis répond 202. Seul le worker crée les relevés, via l'ingestion unique. Fichiers prévus : apps/api/src/modules/telemetry/telemetry-webhook.controller.ts, apps/worker/src/jobs/telemetry-sync.job.ts, apps/api/test/integration/telemetry.int.spec.ts.
- **Justification** : On réduit la latence sans exposer la source TELEMATICS.

### D-299 — [14.4 / 5.6 / 9.3 / 18 (T42)] Historisation au plus horaire vs alerte à une minute — **contradiction-cdc**

- **Ambiguïté** : Un relevé TELEMATICS n'est historisé qu'une fois par heure, et seuls les relevés acceptés entrent dans les calculs. Prenons une valeur CAN qui atteint l'échéance 20 min après la dernière historisation : elle ne produit ni relevé ni alerte avant environ 40 min. Or T42 exige l'alerte « au plus une minute après ingestion ».
- **Options** : Lecture littérale : l'échéance n'est vue qu'à l'historisation suivante, et T42 se mesure depuis la création du relevé / Calculer les échéances sur TelemetryUnitState, qui n'est pas un relevé accepté / Forcer l'historisation hors quota quand la valeur candidate franchit un seuil d'un plan actif (entrée en A_PREVOIR, A_FAIRE, EN_RETARD)
- **Décision** : Option 3. On historise si (60 min se sont écoulées depuis lastHistorizedAt selon observedAt ET le compteur a progressé), OU si maintenance-schedule.ts détecte, sur la valeur candidate, un changement de statut d'un plan dont les sources admettent la nature du relevé. Les alertes sont recalculées dans le même job, juste après le commit du relevé. T42 vérifie une alerte au plus 60 s après la création du relevé. Fichiers prévus : apps/api/src/modules/odometer/odometer-ingestion.service.ts, apps/api/src/modules/telemetry/telemetry.service.ts, apps/api/src/domain/maintenance-schedule.ts, apps/worker/src/jobs/telemetry-sync.job.ts, apps/api/test/integration/telemetry.int.spec.ts.
- **Justification** : Le quota horaire limite le volume (17.2), et les franchissements de seuil sont rares. L'option 2 violerait « seuls les relevés acceptés participent aux calculs » (5.1).

### D-300 — [14.5] Changement de boîtier : continuité CAN et redémarrage du calibrage GPS

- **Ambiguïté** : Le changement de boîtier clôt le mapping précédent « sans modifier le kilométrage cumulé ». Mais un nouveau boîtier DISTANCE_GPS a son propre odomètre virtuel, et le CDC ne dit pas comment reprendre les estimations.
- **Options** : Reprendre la dernière estimation comme référence / Suspendre les estimations jusqu'au prochain relevé manuel
- **Décision** : Option 2. On clôt l'ancien mapping (validTo = instant du changement, motif, audit) et on ouvre un nouveau mapping confirmé. En COMPTEUR_CAN, la continuité est vérifiée contre le dernier relevé physique, et une valeur inférieure est une anomalie EN_ATTENTE. En DISTANCE_GPS, le calibrage est NON_CALIBRABLE jusqu'au prochain relevé manuel accepté ; entre-temps, TelemetryUnitState est mis à jour mais aucune estimation n'est créée. Fichiers prévus : apps/api/src/modules/telemetry/telemetry.service.ts, apps/api/src/domain/gps-calibration.ts, apps/api/test/integration/telemetry.int.spec.ts.
- **Justification** : Une estimation n'enchaîne jamais sur une autre (5.6). Seul un relevé manuel fait référence.

### D-301 — [14.5 / 14.4] Date d'effet d'un mapping et reprise initiale

- **Ambiguïté** : « Aucun relevé n'est ingéré avant confirmation » : s'agit-il de l'instant de traitement ou de la date d'observation ? La reprise initiale « récupère l'historique disponible sur une période configurable », mais sans valeur par défaut (17.1 est muet), et l'on ignore depuis quand la mener pour un mapping confirmé aujourd'hui.
- **Options** : validFrom = instant de confirmation, sans reprise / validFrom choisi par le chef, borné, avec reprise via l'ingestion unique
- **Décision** : Option 2. La confirmation porte sur l'instant de traitement. validFrom est saisi par le chef ; par défaut, il vaut la plus tardive des dates suivantes : now − telemetry.backfillDays (7), début du segment ouvert, entrée du véhicule dans sa société courante. La confirmation lance un job REPRISE_INITIALE sur [validFrom, now] qui passe par l'ingestion unique : contrôle des voisins et historisation horaire appliqués, relevés hors chronologie mis EN_ATTENTE et regroupés en une alerte par véhicule. Fichiers prévus : apps/api/src/modules/telemetry/telemetry.service.ts, apps/api/src/modules/telemetry/dto/confirm-mapping.dto.ts, apps/worker/src/jobs/telemetry-sync.job.ts, apps/api/test/integration/telemetry.int.spec.ts.
- **Justification** : Cela respecte « aucun relevé avant confirmation » tout en rendant la reprise initiale de 14.4 utile et bornée.

### D-302 — [14.5 / 18 (T35)] Rapprochement des unités par immatriculation normalisée

- **Ambiguïté** : La normalisation n'est pas précisée (casse, espaces, tirets, « TU », « TUN » ou « تونس »). Rien n'est dit sur deux unités portant la même immatriculation, ni sur un véhicule d'une société non couverte, non activée ou non ACTIF. On ignore aussi quelles données conserver pour une unité non mappée avant confirmation.
- **Options** : Rapprochement flou (distance d'édition) / Correspondance exacte unique sur la même fonction de normalisation que 3.1
- **Décision** : Option 2. La même fonction normalizeRegistration que pour les véhicules est partagée : majuscules, suppression des espaces, tirets et points, « TUN » et « تونس » ramenés à « TU ». Une proposition PROPOSE n'est créée que pour une correspondance unique avec un véhicule ACTIF d'une société couverte par le fournisseur et dont telemetryEnabled vaut vrai. Sinon, l'unité est non mappée avec un motif : inconnue, ambiguë ou société non couverte. Avant confirmation, seuls TelemetryUnit et son dernier état sont conservés, sans échantillon historique ni relevé. T35 : 10 PROPOSE, 2 non mappées, 0 OdometerReading. Fichiers prévus : apps/api/src/modules/vehicles/registration-normalizer.ts, apps/api/src/modules/telemetry/telemetry.service.ts, apps/api/test/integration/telemetry.int.spec.ts.
- **Justification** : 14.5 impose une confirmation humaine. Le flou créerait de fausses associations, et on évite de stocker les données de véhicules hors périmètre.

### D-303 — [14.6 / 18] Simulateur impossible à activer en production

- **Ambiguïté** : Le CDC ne dit pas comment garantir techniquement que le simulateur ne peut pas être activé en production.
- **Options** : Simple convention / Garde technique sur plusieurs niveaux
- **Décision** : Option 2. Le simulateur n'est enregistré que si APP_ENV vaut test, development ou demo. En production, la création renvoie 422 et le worker refuse de démarrer s'il trouve un simulateur actif. Le libellé « SIMULATEUR — données fictives » est visible partout. Les scénarios sont scriptables : panne, doublons, désordre. Fichiers prévus : apps/api/src/modules/telemetry/adapters/simulator.adapter.ts, apps/api/src/modules/telemetry/telemetry.module.ts, apps/api/test/integration/telemetry-simulator.int.spec.ts.
- **Justification** : 14.6 et 18 imposent un simulateur explicitement nommé et non activable en production.

### D-304 — [14.6 / 18 (T44)] Chiffrement, rotation et non-divulgation des secrets

- **Ambiguïté** : Le format de la clé « hors base », la procédure de rotation et ce que l'API peut renvoyer d'un secret ne sont pas précisés.
- **Options** : Clé maîtresse unique / Trousseau avec identifiant de clé et API en écriture seule
- **Décision** : Option 2 :
- AES-256-GCM, trousseau TELEMETRY_KEYS et TELEMETRY_ACTIVE_KID fournis par secret Docker.
- Script de rechiffrement pour la rotation.
- Secret fournisseur modifiable en écriture seule ; l'API ne renvoie que {kind, configured, rotatedAt}.
- Masquage dans le logger, assainissement des URL et des erreurs.
- T44 : un secret sentinelle est recherché dans l'API, les journaux, l'audit et les runs.
Fichiers prévus : apps/api/src/modules/telemetry/telemetry-secrets.service.ts, scripts/rotate-telemetry-key.ts, apps/api/test/integration/telemetry-secrets.int.spec.ts, docs/connecteur-telematique.md.
- **Justification** : Conforme à 14.6 et à T44.

### D-305 — [15.1 / 18 (T01, T28)] Codes 404/403, filtre de société, compteurs et bornes de pagination

- **Ambiguïté** : Plusieurs réponses ne sont pas fixées : un filtre companyId hors périmètre, la cohérence des compteurs et des badges, les fichiers de types interdits ou trop volumineux, et une taille de page supérieure à 100 (tronquée ou refusée ?).
- **Options** : Tronquer silencieusement les valeurs hors borne / Réponses explicites et identiques, qu'un objet existe ou non
- **Décision** : Option 2 :
- Objet hors périmètre ou inexistant : 404 identique.
- Action interdite sur un objet visible : 403.
- Filtre de société hors périmètre : 403 PERIMETRE_INTERDIT, que la société existe ou non.
- Totaux, badges, suggestions et exports calculés avec la même portée serveur.
- Fichier interdit ou supérieur à 10 Mo : 422. Le proxy limite les corps à 11 Mo et renvoie 413 au-delà.
- Pagination : page ≥ 1 et pageSize entre 1 et 100, sinon 422.
Fichiers prévus : apps/api/src/common/errors.ts, apps/api/src/common/pagination.ts, apps/api/src/modules/access-control/scope.service.ts, apps/api/test/integration/scope.int.spec.ts.
- **Justification** : Cela évite toute fuite par les compteurs (T01), conformément à 15.1.

### D-306 — [15.3] Verrouillage des contrats OpenAPI

- **Ambiguïté** : « Verrouiller dans OpenAPI » ne précise pas le mécanisme qui empêche un contrat de dériver.
- **Options** : Documentation générée seule / Document versionné, contrôle en CI et tests de contrat
- **Décision** : Option 2. openapi.json est versionné et la CI échoue en cas de différence. Validation avec whitelist et forbidNonWhitelisted : une source, une companyId ou un auteur fournis par le client donnent 422. Fichiers prévus : packages/contracts/openapi.json, apps/api/test/integration/contracts.int.spec.ts.
- **Justification** : Le serveur détermine seul l'auteur, la société et la source (15.3).

### D-307 — [15.3 / 6.4] CompleteIntervention : relevé d'exécution admissible

- **Ambiguïté** : « acceptedReadingId lorsque nécessaire » ne dit pas quelle nature de relevé est admise ni quel écart de date est toléré par rapport à la réalisation.
- **Options** : Accepter une estimation / Relevé physique uniquement, avec fenêtre temporelle
- **Décision** : Option 2. Le relevé est obligatoire dès qu'un intervalle en km s'applique. Il doit être accepté, non estimé, et observé dans les 24 h autour de performedAt. Sinon, le relevé peut être créé dans la même transaction via newReading ; un relevé en attente fait échouer la clôture (422). Fichiers prévus : apps/api/src/modules/interventions/interventions.service.ts, apps/api/src/modules/interventions/dto/complete-intervention.dto.ts, apps/api/test/integration/interventions.int.spec.ts.
- **Justification** : 6.4 exige un « relevé validé correspondant ».

### D-308 — [15.3 / 18 (T33, T24, T32)] Idempotence : portée, transport de la clé, durée, réponses rejouées

- **Ambiguïté** : La clé n'est citée que pour Checkout et CompleteIntervention. Le CDC ne dit pas si elle voyage dans le corps ou dans un en-tête, combien de temps elle vit, quelles réponses sont mémorisées, comment traiter une requête encore en cours, ni ce que renvoie une double validation sans clé.
- **Options** : Clé partout dans un en-tête / Clé dans le corps pour les deux contrats cités et en-tête facultatif ailleurs, avec des règles de rejeu précises
- **Décision** : Option 2 :
- Enregistrement par (organisation, utilisateur, opération, clé).
- Empreinte = SHA-256 du JSON canonique et des paramètres de route ; durée de vie de 24 h.
- Le rejeu n'intervient qu'après authentification et autorisation (T32).
- On mémorise les réponses 2xx et 422, pas les 409 de concurrence ni les 5xx.
- Clé déjà en cours : 409 IDEMPOTENCE_EN_COURS. Corps différent : 409 IDEMPOTENCE_CONFLIT.
- Double validation sans clé : 409 ETAT_INVALIDE, avec une dépense unique garantie par l'index sur la source.
Fichiers prévus : apps/api/src/common/idempotency.ts, apps/api/src/common/idempotency.interceptor.ts, apps/api/test/integration/idempotency.int.spec.ts.
- **Justification** : Cela correspond à 15.3 et à T33, et évite qu'une erreur transitoire reste figée.

### D-309 — [16.1 / 13.2] Audit des opérations automatiques

- **Ambiguïté** : Auditer chaque relevé automatique représenterait environ 2 millions d'événements par an.
- **Options** : Un audit par relevé / Trace portée par le run de synchronisation, audit des seules décisions humaines
- **Décision** : Option 2. Pas d'AuditEvent pour chaque relevé TELEMATICS : la trace est le TelemetrySyncRun, avec l'acteur SYSTEM. Sont audités les décisions humaines, la configuration, les connexions, les droits, les transferts, les exports et les téléchargements personnels. Fichiers prévus : apps/api/src/modules/audit/audit.service.ts.
- **Justification** : L'audit vise les actions sensibles (16.1).

### D-310 — [16.1 / 15.1] Limitation de débit (réponse 429)

- **Ambiguïté** : Le CDC demande une « limitation des tentatives » et prévoit le code 429, sans fixer de seuils ni de portée, et sans dire si l'état doit survivre à un redémarrage.
- **Options** : Compteur en mémoire / Compteur persistant en PostgreSQL avec seuils paramétrés
- **Décision** : Option 2. Seuils :
- Connexion : 5 échecs par compte en 15 min, avec délai progressif, et 20 par IP en 15 min.
- Mot de passe oublié : 3 par heure et par adresse, avec une réponse identique dans tous les cas.
- Synchro manuelle : 1 toutes les 5 min par couple fournisseur-société.
- API générale : 300 requêtes par minute et par session.
La réponse 429 porte Retry-After et un message non énumérant. Fichiers prévus : apps/api/src/common/rate-limit.guard.ts, apps/api/src/modules/auth/auth.service.ts, apps/api/test/integration/auth.int.spec.ts.
- **Justification** : Avec plusieurs instances et des redémarrages, un compteur en mémoire se contourne ; Redis n'est pas imposé (14.1).

### D-311 — [16.1 / 18 (T32)] Durée de session, politique de mot de passe et jeton de réinitialisation

- **Ambiguïté** : « Délai de session de douze heures » : absolu ou glissant ? La durée du jeton « court », les règles de mot de passe et l'effet immédiat d'un retrait de droits ne sont pas précisés.
- **Options** : Session glissante / Session absolue de 12 h avec droits relus à chaque requête
- **Décision** : Option 2 :
- Session absolue de 12 h (auth.sessionHours) ; jeton aléatoire de 256 bits stocké haché en SHA-256.
- Cookie __Host-, HttpOnly, Secure, SameSite=Lax.
- Droits relus à chaque requête : une désactivation ou un retrait s'applique immédiatement (T32).
- Mot de passe d'au moins 12 caractères, liste des mots de passe courants refusée, Argon2id.
- Réinitialisation : jeton de 30 min, à usage unique et haché ; elle révoque toutes les sessions.
- Invitation valable 72 h.
Fichiers prévus : apps/api/src/modules/auth/auth.service.ts, apps/api/src/modules/auth/session.guard.ts, apps/api/test/integration/auth.int.spec.ts, tests/e2e/connexion.spec.ts.
- **Justification** : Cette configuration est simple et vérifiable, et révoque les accès sans attendre (16.1).

### D-312 — [16.2] Cycle de vie des fichiers temporaires et conservation

- **Ambiguïté** : « Fichiers temporaires abandonnés » n'est pas défini, pas plus que le flux d'envoi (le fichier est-il envoyé avant ou avec son objet ?). La conservation est renvoyée aux « obligations validées avec le client », qui sont inconnues.
- **Options** : Envoi du fichier dans la même requête que l'objet / Envoi en deux temps avec purge des fichiers non rattachés
- **Décision** : Option 2. Le fichier est d'abord enregistré comme TEMPORAIRE, lié à son auteur et à la société cible. Il est rattaché au propriétaire métier dans la transaction de l'objet. Les fichiers temporaires non rattachés sont purgés après 24 h. Aucune purge des fichiers métier en V1 : leur conservation est une dépendance à valider avec le client. Une suppression autorisée est logique et auditée. Fichiers prévus : apps/api/src/modules/files/files.service.ts, apps/worker/src/jobs/temp-files-cleanup.job.ts, apps/api/test/integration/files.int.spec.ts.
- **Justification** : Le propriétaire métier est explicite (13.2), et l'on n'annonce pas de conformité juridique (16.2).

### D-313 — [16.2] Formats des photos mobiles et métadonnées EXIF

- **Ambiguïté** : Seuls PDF, JPEG et PNG sont autorisés, alors que les iPhone produisent du HEIC. Les photos portent des coordonnées GPS dans leurs métadonnées EXIF, ce qui contredit « aucune position ». Rien n'est dit non plus des PDF contenant du JavaScript.
- **Options** : Accepter le HEIC / Réencoder côté client en JPEG et supprimer les EXIF côté serveur
- **Décision** : Option 2 :
- Contrôle par signature binaire du fichier.
- HEIC et WebP refusés par l'API (422 FICHIER_TYPE_INTERDIT), mais le client réencode les captures en JPEG avant envoi.
- EXIF supprimées côté serveur.
- PDF contenant /JavaScript ou /OpenAction refusés.
- Téléchargement avec Content-Disposition attachment, nosniff et CSP sandbox.
Fichiers prévus : apps/api/src/modules/files/files.service.ts, apps/api/src/modules/files/file-inspection.ts, apps/web/lib/image-capture.ts, apps/api/test/integration/files.int.spec.ts.
- **Justification** : Les formats autorisés restent conformes à 16.2 et l'on évite de collecter une position par la bande (1.3).

### D-314 — [16.3] Application des migrations et retour arrière

- **Ambiguïté** : « Exécuter les migrations explicitement » et « retour arrière de l'application » ne disent pas comment sont lancées les migrations ni quelle stratégie adopter face à une migration destructrice.
- **Options** : Migration automatique au démarrage de l'API / Service de migration ponctuel, migrations uniquement en avant, schéma expand/contract
- **Décision** : Option 2. Un service migrate (prisma migrate deploy) s'exécute avant l'API et le worker. Une sauvegarde est obligatoire avant chaque mise à jour. Le retour arrière consiste à revenir à l'image précédente, compatible avec le schéma. Les images sont épinglées par digest. Fichiers prévus : docker-compose.prod.yml, scripts/update.sh, scripts/rollback.sh, docs/mise-a-jour.md.
- **Justification** : On ne promet pas de rollback d'une migration destructrice sans sauvegarde (16.3).

### D-315 — [16.3] Endpoints de santé et surveillance externe

- **Ambiguïté** : Le CDC demande de distinguer « vivant » et « prêt » et de contrôler le battement du worker. Mais un worker arrêté ne doit pas rendre l'API indisponible, et la surveillance doit être externe au VPS.
- **Options** : Faire échouer « prêt » si le worker est arrêté / Séparer la santé de l'API de celle du worker
- **Décision** : Option 2 :
- /api/v1/health/live : processus seul.
- /api/v1/health/ready : base de données et stockage en lecture et écriture ; l'état du worker y figure en information.
- /api/v1/health/worker : 503 si le dernier battement date de plus de 2 min.
Aucune version ni aucun secret n'est exposé. Le worker envoie un ping de type « dead man's switch » (HEALTHCHECK_PING_URL) à un service externe. Fichiers prévus : apps/api/src/modules/health/health.controller.ts, apps/api/src/modules/health/health.service.ts, docs/exploitation-surveillance.md, scripts/tests/health.sh.
- **Justification** : Une panne totale du VPS doit rester détectable de l'extérieur (16.3).

### D-316 — [16.3 / 16.1] Topologie de déploiement, CSRF et contrôle d'origine

- **Ambiguïté** : Le CDC ne précise pas si le web et l'API partagent la même origine, comment Next.js relaie la session côté serveur, ni comment appliquer le contrôle d'origine aux appels entre serveurs.
- **Options** : Deux origines avec CORS / Une origine unique derrière le reverse proxy
- **Décision** : Option 2. Caddy (TLS automatique) sert / vers le web et /api vers l'API. Le cookie posé par l'API est relayé tel quel par Next.js côté serveur. Toute mutation exige un jeton CSRF synchronisé (en-tête X-CSRF-Token) et une Origin ou un Referer égal à APP_URL. L'API, PostgreSQL et le stockage restent sur un réseau interne. Fichiers prévus : docker-compose.prod.yml, docker/Caddyfile, docker/api.Dockerfile, docker/web.Dockerfile, apps/api/src/common/csrf.guard.ts, docs/installation.md.
- **Justification** : Le cookie reste first-party et on évite CORS ; l'autorisation reste dans NestJS [R1].

### D-317 — [16.4 / 18 (T30)] Cohérence de la sauvegarde base/fichiers et sauvegarde des clés

- **Ambiguïté** : L'ordre entre la sauvegarde de la base et celle des fichiers n'est pas fixé, pas plus que le chiffrement hors VPS. Surtout, la clé des secrets télématiques est « hors base » : si elle n'est pas sauvegardée, une restauration rend ces secrets inutilisables.
- **Options** : Sauvegarder la base seule / pg_dump puis fichiers, archive chiffrée, clés sauvegardées séparément, restauration testée par script
- **Décision** : Option 2 :
- pg_dump au format custom, puis copie des fichiers : les fichiers forment un sur-ensemble, et les orphelins sont listés.
- Archive chiffrée avec age, envoyée hors du VPS par rclone vers une cible fournie par le client (dépendance externe).
- Rétention de 30 jours.
- Clés de chiffrement sauvegardées séparément.
- Le script de test restaure dans un compose isolé, compare les comptes de lignes et les empreintes, mesure RPO et RTO, et consigne le tout dans RECETTE.md.
Fichiers prévus : scripts/backup.sh, scripts/restore.sh, scripts/tests/backup-restore.sh, docs/sauvegarde-restauration.md, docs/RECETTE.md.
- **Justification** : 16.4 exige de documenter la cohérence et de tester une restauration complète.

### D-318 — [17.1] Portée, surcharges et droits sur les paramètres, et valeurs manquantes

- **Ambiguïté** : Plusieurs paramètres n'ont pas de valeur par défaut, et l'ordre de priorité entre les niveaux de surcharge n'est pas donné.
- **Options** : Valeurs codées en dur / Registre typé avec ordre de résolution
- **Décision** : Option 2 :
- Ordre de résolution : véhicule > plan > société > groupe.
- L'administrateur règle le groupe et les sociétés ; le chef, les plans et les véhicules.
- Chaque modification est versionnée et auditée, avec un aperçu d'impact.
- Valeurs par défaut manquantes : plausibilité 1 500 km/jour, tolérance de montant max(0,100 TND ; 0,5 %), tolérance de retour 0, remplissage 10 L, tolérance de ticket 5 L ou 10 %, reprise initiale 7 jours.
Fichiers prévus : apps/api/src/modules/settings/settings.service.ts, packages/contracts/src/settings-registry.ts.
- **Justification** : 17.1 prévoit des surcharges explicites.

### D-319 — [17.1 / 17.2] Rétention exacte avec partitions mensuelles — **irreversible**

- **Ambiguïté** : Supprimer des partitions mensuelles entières conserve en pratique entre 90 et 121 jours de données, et non 90.
- **Options** : Supprimer uniquement des partitions entières / Suppression des partitions expirées plus purge quotidienne de la partition la plus ancienne
- **Décision** : Option 2. Les partitions sont créées deux mois à l'avance. Une purge quotidienne supprime les lignes de plus de 90 jours dans la partition la plus ancienne, puis la partition est supprimée quand elle est vide. Les relevés et les événements carburant sont conservés sans limite. Fichiers prévus : apps/worker/src/jobs/retention.job.ts, packages/db/prisma/migrations/<ts>_partition_retention/migration.sql.
- **Justification** : La rétention est respectée exactement ; le choix du partitionnement est structurant.

### D-320 — [17.2] Jeu de données et scénario de charge

- **Ambiguïté** : Le CDC ne dit pas quels volumes injecter pour mesurer les p95.
- **Options** : Volume minimal / Volume cible complet hors CI et jeu réduit en CI
- **Décision** : Option 2. Jeu cible : 500 véhicules, 300 000 relevés manuels, 2 millions de relevés télématiques et 13 millions d'échantillons. Scénario k6 avec 50 utilisateurs virtuels. Résultats consignés dans RECETTE.md. Fichiers prévus : scripts/tests/load.sh, packages/db/src/seed-perf.ts.
- **Justification** : 17.2 demande de documenter le jeu de données et le scénario.

### D-321 — [18] Horloge contrôlable dans les tests

- **Ambiguïté** : Le CDC ne précise pas l'étendue de l'horloge contrôlable : API seule, ou aussi worker, base et tests navigateur.
- **Options** : Horloge de test pour l'API seulement / Clock injectée partout, avec un endpoint de test gardé
- **Décision** : Option 2. Clock est injectée dans l'API et le worker ; les horodatages métier sont fixés par l'application et non par now() SQL. POST /api/v1/__test/clock n'existe que si APP_ENV=test. Fichiers prévus : apps/api/src/common/clock.ts, apps/api/test/support/test-clock.ts.
- **Justification** : T12, T16, T21 et T41 dépendent du temps.

### D-322 — [18 (T40)] Volume des relevés automatiques en attente

- **Ambiguïté** : Un boîtier défaillant pourrait produire un relevé EN_ATTENTE à chaque synchro.
- **Options** : Un relevé en attente par échantillon / Au plus un relevé en attente par véhicule et par motif
- **Décision** : Option 2. Les échantillons incohérents suivants mettent seulement à jour l'état de l'unité, sans créer de nouveau relevé. Les relevés en attente sont exclus des calculs et du contrôle de chronologie. Fichiers prévus : apps/api/src/modules/odometer/odometer-ingestion.service.ts, apps/api/test/integration/telemetry.int.spec.ts.
- **Justification** : Le relevé en attente ne doit pas bloquer les remises (5.6 et T40).

### D-323 — [19.1] Fonctions sans lot et dépendances du lot F

- **Ambiguïté** : 19.1 ne rattache à aucun lot le transfert, la sauvegarde et le service d'audit. Le lot F dépend aussi, en pratique, des lots C et D.
- **Options** : Tout placer en lot E / Découpage explicite
- **Décision** : Option 2 :
- Transfert : lot D.
- Audit : écriture en lot A, consultation en lot E.
- Sauvegarde : lot E.
- Lot F découpé en F1 après B (T35-T38, T40, T44) et F2 après C et D (T39, T41-T43).
Fichiers prévus : docs/DECISIONS.md, docs/TRACEABILITY.md.
- **Justification** : Chaque lot livre des fonctions testables de bout en bout (19.1).

### D-324 — [19.2 / 19.3] Jeu de démonstration, premier administrateur, rapport de recette

- **Ambiguïté** : Le CDC ne dit pas comment interdire les données de démonstration en production, ni comment créer le premier administrateur et produire le rapport de recette.
- **Options** : Seed libre / Seed gardé par l'environnement et commande CLI de création d'administrateur
- **Décision** : Option 2. Le seed est refusé en production et ses dates sont relatives à la date d'exécution. Le premier administrateur se crée par une commande CLI à saisie masquée. RECETTE.md est généré depuis les sorties JUnit. Fichiers prévus : packages/db/src/seed-demo.ts, docs/RECETTE.md.
- **Justification** : 19.2 interdit tout mot de passe de démonstration automatique en production.

### D-325 — [21] Qualification : jeton en lecture seule, nature par véhicule, cumul de canaux

- **Ambiguïté** : L'annexe A ne dit pas comment la réponse du fournisseur se traduit dans la configuration : preuve du compte en lecture seule, nature du kilométrage par véhicule, fournisseur servi par plusieurs canaux.
- **Options** : Déclaration libre / Attestation obligatoire et nature fixée à la confirmation du mapping
- **Décision** : Option 2. Pas de fournisseur ACTIF sans attestation écrite de lecture seule. odometerKind est choisi par le chef, prérempli d'après la réponse du fournisseur. Un seul canal actif par fournisseur en V1, les unités étant portées par le fournisseur. Fichiers prévus : apps/api/src/modules/telemetry/dto/provider.dto.ts, docs/connecteur-telematique.md.
- **Justification** : Déduit des questions de l'annexe A.

<!-- AMBIGUITES:FIN -->
