# Performance et dimensionnement (CDC 17.2)

Ce document décrit le jeu de dimensionnement, le scénario de charge, le matériel réellement utilisé, les
commandes pour reproduire la mesure, les résultats bruts obtenus et leurs limites. Les volumes sont ceux
que le CDC 17.2 propose comme **hypothèse de dimensionnement** : ce ne sont pas des volumes annoncés par le
client.

## 1. Synthèse

| Objectif (CDC 17.2) | Mesure finale (24/09/2026, 50 sessions, 300 s) | Statut |
| --- | --- | --- |
| p95 des lectures paginées courantes < 2 s | **1 275 ms** (11 804 requêtes, toutes lectures confondues) | Tenu sur la machine décrite au § 2 pour l'ensemble des lectures ; **Non tenu** pour le rapport carburant (p95 **3 852 ms**, § 8) |
| p95 d'une mutation simple < 3 s | **4 744 ms** (740 requêtes) | **Non tenu** : voir § 7 |
| Rapports volumineux en job avec progression, droits revérifiés | Export différé au-delà de 5 000 lignes (inchangé) ; pages des rapports calculées en base | Tenu (tests d'intégration) |
| Aucun historique complet chargé pour une page de 25 lignes | Pages des rapports calculées par PostgreSQL ; lignes renvoyées par la base mesurées pour chaque vue (`reports-pagination.int.spec.ts`) | Tenu pour les rapports (lignes lues proportionnelles à la page) ; référentiel encore découpé en mémoire et coût en requêtes au § 8 |

Le seuil des mutations n'est pas tenu ici, ni celui des lectures pour le rapport carburant : le p95 agrégé des
lectures (1 275 ms) est dominé par les listes simples et masque cette requête (p95 3 852 ms, 300 appels sur
11 804). La machine était partagée avec d'autres travaux (tests, builds) :
charge moyenne de **8,07** sur 4 processeurs pendant la mesure. Une mutation coûtait alors environ 90 requêtes SQL
exécutées l'une après l'autre (§ 7). Le constat et ses causes sont décrits au § 7 ; l'écart reste ouvert
(DECISIONS.md, D-016). Les optimisations du § 7.1, faites après cette mesure, ramènent un relevé à 39 requêtes, une
remise à 70, une restitution à 62 et une page du rapport carburant de 364 à 23 requêtes ; **la mesure de charge est à
refaire** : les chiffres des §§ 1 et 6 restent ceux du code mesuré le 24/09/2026.

## 2. Matériel de la mesure (relevé pendant la mesure)

| Élément | Valeur relevée |
| --- | --- |
| Processeurs | 4 processeurs logiques, `Intel(R) Xeon(R) Processor @ 2.10GHz` (`nproc` = 4) |
| Mémoire | 16 096 Mio au total, sans swap ; 9 861 Mio libres à la fin de la mesure (`free -m`, `os.freemem`) |
| Noyau | Linux 6.18.44 (conteneur de développement) |
| Node.js | v24.21.0 (API et générateur de charge) |
| PostgreSQL | 16.15 (image `postgres:16-alpine`, musl), conteneur Docker `parc-auto-postgres-test` **partagé** avec une trentaine d'autres bases de test ; aucune limite CPU ni mémoire (`NanoCpus=0`, `Memory=0`) |
| Réglages PostgreSQL | `shared_buffers` 128 Mo, `work_mem` 4 Mo, `max_connections` 100 ; **`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`** (conteneur de test) |
| API | build compilé (`tsc -p tsconfig.build.json`, même configuration que `nest build`), un processus Node, pool pg de 10 connexions (valeur du code), `NODE_ENV=test`, `LOG_LEVEL=info` (journaux redirigés dans un fichier), `RATE_LIMIT_ENABLED=false` |
| Générateur de charge | même machine que l'API et PostgreSQL (aucun réseau entre eux) |
| Charge machine | 1 minute : **8,07 en moyenne, 11,72 au maximum** pendant les 300 s de mesure (échantillon toutes les 5 s) ; au départ 3,37. D'autres processus tournaient : suites Vitest d'autres lots, builds, navigateur Playwright |

Le worker n'était pas démarré : aucun job planifié ne concurrençait les requêtes (recalculs quotidiens,
télématique).

## 3. Jeu de données

Chargé par `apps/api/src/cli/seed-load.ts` sur une base vierge (migrations appliquées), en 220 s pour la
mesure finale, puis `VACUUM ANALYZE`. Données fictives, relatives à l'instant du chargement : deux ans
d'historique, dernier relevé au plus tard 12 h avant (10 ou 20 jours pour les véhicules au kilométrage ancien).

| Objet | Volume chargé | Remarques |
| --- | --- | --- |
| Sociétés | 3 | 40 % / 35 % / 25 % du parc ; 2 sites chacune |
| Véhicules | 500 | VP, VU, PL ; 12 hors service ; 10 sans compteur initialisé ; 140 en utilisation ; 10 immobilisés |
| Conducteurs | 1 000 | 2 par véhicule, permis valides (catégorie C pour les poids lourds) |
| Comptes (sessions) | 50 | 5 administrateurs, 15 chefs de parc, 15 opérateurs, 15 lecteurs ; mot de passe `LOAD_PASSWORD` |
| Relevés kilométriques | 300 000 | segment unique par véhicule ; ACCEPTE, REJETE, EN_ATTENTE, REMPLACE + correction ; sources MANUAL et IMPORT |
| Utilisations | 49 526 | remise et restitution avec leurs relevés, distance validée, retards (tolérance de 30 min pour la société B) |
| Pleins | 37 240 | relevé CARBURANT lié, pleins complets et partiels, quelques rejetés et annulés |
| Dépenses | 58 459 | dépense CARBURANT par plein validé, entretien (avec avoirs), péages, stationnement, assurance, achats exclus, dépenses sans véhicule |
| Incidents | 1 960 | références `INC-AAAA-NNNNNN` suivies par la séquence |
| Immobilisations / causes | 510 / 760 | causes qui se chevauchent, causes restées ouvertes, 10 immobilisations actives |
| Plans d'entretien | 1 000 | vidange et pneumatiques ; statuts matérialisés calculés à la première lecture du jour |
| Versions de documents | 2 660 | assurance (bloquante), visite technique, carte grise, visite médicale ; expirés, à renouveler, renouvelés, manquants |

Taille de la base : 247 Mo après le premier chargement, 299 Mo à la fin des mesures (index de listes et données des tests compris). Hors jeu : transferts de société, télématique (F11), réservations,
interventions ; la volumétrie F11 (2 millions de relevés automatiques par an, 13 millions d'échantillons) n'est
pas exercée.

## 4. Scénario de charge

`scripts/tests/load-test.mjs` (Node, `fetch` natif, aucune dépendance) :

1. **Connexion** des 50 comptes par `POST /api/v1/auth/login` (vraies sessions, cookies et jeton CSRF) ; durée
   relevée à part (Argon2id) : p50 495 ms, p95 889 ms.
2. **Préparation non mesurée** : droits de coût de chaque session (`GET /reports`) ; pour chacune des 35
   sessions habilitées aux opérations, jusqu'à 4 véhicules disponibles sans document bloquant, chacun avec un
   conducteur libre de sa société dont la remise est possible (`GET /usages/checkout-preview`) : 131 couples,
   aucune collision voulue entre sessions ; préchauffage d'un appel par liste.
3. **Mesure pendant 300 s** : chaque session enchaîne des requêtes, avec un temps de réflexion aléatoire de 250
   à 750 ms.
   - Lectures paginées (25 lignes) : liste des véhicules, des relevés, des utilisations, historique d'un
     véhicule, tableau de bord et rapports sur les 30 derniers jours, pages 1 à 3 : relevés, qualité des relevés,
     utilisations, retards, carburant, inventaire, expirations documentaires, immobilisations, dépenses par
     véhicule (sessions ayant `costs.read`).
   - Mutations simples, une itération sur cinq pour les sessions habilitées : relevé kilométrique, remise puis
     restitution (avec `expectedVersion`), à tour de rôle sur les véhicules de la session. Relevés croissants,
     horodatés maintenant, au plus un par véhicule et par minute : deux relevés manuels d'une même minute
     désignent le même instant (CDC 5.3, `CONFLIT_MEME_INSTANT`).
4. **Résultats** : p50, p95, p99, maximum par catégorie et par requête, requêtes en échec comprises ; réponses
   non 2xx par code ; refus pour concurrence (409 `CONCURRENCE`) publiés à part avec leur taux. Échec (code 1)
   si le p95 des lectures atteint 2 s, celui des mutations 3 s, ou si une autre réponse non 2xx est reçue.
5. **Fin** : les utilisations ouvertes par le test sont restituées (trois tentatives au plus, hors mesure).

## 5. Commandes

```sh
# Variables exportées au préalable, hors dépôt : DATABASE_URL (base dédiée, ex. parc_auto_test_perf),
# LOAD_PASSWORD (mot de passe des 50 comptes), SECRETS_ENCRYPTION_KEY et STORAGE_DIR de l'API (voir .env.example).
pnpm db:migrate
pnpm --filter @parc-auto/api build
# Jeu de dimensionnement (refusé en production et sur une base non vide)
pnpm seed:load
psql "$DATABASE_URL" -c 'VACUUM ANALYZE'
# API compilée sur un port libre, limitation de débit désactivée (refusé en production)
NODE_ENV=test APP_ORIGIN=http://localhost:3000 COOKIE_SECURE=false PORT=3990 RATE_LIMIT_ENABLED=false \
  LOG_LEVEL=info node apps/api/dist/main.js
# Test de charge
pnpm test:load --api http://127.0.0.1:3990 --origin http://localhost:3000 --sessions 50 --duration 300 \
  --out resultats.json
```

Le mot de passe des comptes et la clé de chiffrement ne sont jamais écrits dans le dépôt. Pour la mesure,
l'API a été compilée dans un répertoire privé (`tsc -p tsconfig.build.json --outDir …`) afin de ne pas dépendre
des reconstructions de `apps/api/dist` lancées en parallèle par d'autres travaux.

## 6. Résultats bruts

### 6.1 Mesure finale (24/09/2026 21:08:28 → 21:13:30 UTC)

Sortie du script, sans retouche :

```text
API http://127.0.0.1:3990 — 50 sessions, 300 s de mesure, réflexion 250–750 ms.
Connexions : 50 sessions ouvertes ({"n":50,"p50":495.1,"p95":889.3,"p99":898.8,"max":898.8,"mean":501} ms).
Préparation : 35 sessions habilitées aux opérations, 131 couples véhicule/conducteur réservés (jusqu’à 4 par session).
Mesure : 300 s à partir de 2026-09-24T21:08:28.394Z.
Attention : 5 utilisation(s) du test restée(s) ouverte(s) après trois tentatives de restitution.

12544 requêtes mesurées en 302 s (41.5 req/s).
Catégorie / requête                                       n      p50      p95      p99      max (ms)
[lecture]                                             11804    480.7   1275.3   2334.8   4735.3
[mutation]                                              740   2644.6   4743.7   6190.8   6955.2
  lecture · liste relevés                              2469    378.5    860.5   1226.1   1666.8
  lecture · liste utilisations                         2505    533.3     1170   1622.6   2086.6
  lecture · liste véhicules                            2585    380.2    877.1   1252.9   1694.3
  lecture · rapport carburant                           300   2134.6     3852   4429.2   4735.3
  lecture · rapport documents                           298    550.5   1188.3   1557.3   1796.4
  lecture · rapport dépenses par véhicule                81    439.5    836.1   1096.9   1096.9
  lecture · rapport immobilisations                     330    459.3    912.5   1276.6   1786.1
  lecture · rapport inventaire                          315    667.6   1303.4   1708.4   2022.4
  lecture · rapport qualité des relevés                 321    487.6   1008.5   1431.2   1501.4
  lecture · rapport relevés                             319    423.9    883.8   1188.9     1551
  lecture · rapport retards                             287    589.5   1355.1   1894.5   2092.4
  lecture · rapport utilisations                        302    442.2     1005   1149.8   1674.7
  lecture · relevés d’un véhicule                       853      532   1157.6   1666.9   1963.1
  lecture · tableau de bord                             839    832.5     1857   2242.3   2364.6
  mutation · relevé kilométrique                        229   2333.9   4550.2   4956.7   5091.5
  mutation · remise                                     277   2979.2   5309.4   6277.2   6465.1
  mutation · restitution                                234   2644.6   4697.5   6190.8   6955.2
Machine : 4 processeurs logiques, charge moyenne (1 min) 8.07 pendant la mesure (max 11.72).
Réponses non 2xx : 26 {"409":26} ; dont refus pour concurrence (409 CONCURRENCE) : 26 {"remise":"17/277","restitution":"9/234"} ; autres : 0
Verdict : lectures p95 1275.3 ms (< 2000) OK ; mutations p95 4743.7 ms (< 3000) ÉCHEC.
```

### 6.2 Mesures successives (même scénario, 50 sessions)

| Mesure | Code mesuré | Durée | Requêtes | Lectures p50 / p95 / max (ms) | Mutations p50 / p95 / max (ms) | Charge 1 min |
| --- | --- | --- | --- | --- | --- | --- |
| Initiale, 20:06 | première réécriture SQL des rapports, sans index de listes ; script v1 | 90 s | 2 724 | 749 / 2 065 / 18 658 | 2 098 / 5 164 / 7 509 | non relevée (≈ 5 à 7) |
| Après optimisations, 20:44 | index de listes, SQL des documents v2, consommations en parallèle | 180 s | 7 455 | 498 / 1 223 / 3 967 | 2 472 / 4 064 / 4 733 | 7,65 (max 10,23) |
| Essai pool de 25 connexions, 20:50 | idem, pool pg porté à 25 (essai non conservé) | 180 s | 6 166 | 585 / 1 705 / 5 947 | 4 091 / 7 273 / 12 355 | 16,22 (max 20) |
| **Finale, 21:08** | idem, pool de 10 (code livré) | 300 s | 12 544 | **481 / 1 275 / 4 735** | **2 645 / 4 744 / 6 955** | 8,07 (max 11,72) |

Une mesure intermédiaire (20:28) n'est pas retenue : le script n'envoyait pas `expectedVersion` à la
restitution (422 systématique), ce qui faussait le mélange des mutations.

### 6.3 Lectures isolées (une session, serveur au repos, deuxième appel)

| Requête | Avant (ms) | Après (ms) | Changement |
| --- | --- | --- | --- |
| `GET /readings?page=5` | 478 | 27 | index `(organizationId, observedAt DESC, enteredAt DESC)` |
| `GET /usages?page=5` | 76 | 22 | index `(organizationId, companyId, status, checkedOutAt DESC)` |
| Rapport des expirations documentaires, page 2 | 1 689 | 57 | agrégats des versions par jointure de hachage |
| Rapport carburant, pleins, page 2 | 1 259 | 175 | consommations des véhicules de la page par groupes de 5 |
| Rapport carburant par véhicule, page 1 | 749 | 186 | idem |
| Rapport des retards, page 1 | 251 | 42 | — |
| `GET /dashboard` (administrateur, 3 sociétés) | 531 | 530 | inchangé (§ 8) |

## 7. Analyse des mutations et optimisations

- **Nombre de requêtes** : une instrumentation ponctuelle des requêtes Prisma (build privé, hors dépôt) compte
  environ **90 requêtes SQL séquentielles pour un relevé kilométrique** : session et habilitations, clé
  d'idempotence, transaction sérialisable de l'ingestion (verrou véhicule, voisins, segment, insertion, audit),
  puis, après validation, recalcul des plans d'entretien du véhicule (une transaction par plan), résolution
  d'alertes, contrôles télématiques et relecture de la vue renvoyée. Au repos, une mutation prend 150 à 500 ms ;
  sous charge, chaque aller-retour attend le processeur et une connexion du pool, et la latence est multipliée
  par le nombre d'allers-retours.
- **Conflits de sérialisation** : les remises et restitutions s'exécutent en isolation `SERIALIZABLE`.
  PostgreSQL pose ses verrous de prédicat par page d'index ; les index partiels `usage_one_open_per_vehicle` et
  `usage_one_open_per_driver` tiennent sur une ou deux pages, si bien que deux remises simultanées de véhicules
  différents entrent en conflit. Le serveur reprend la transaction jusqu'à trois fois, puis répond 409
  `CONCURRENCE` : 17 remises sur 277 (6 %) et 9 restitutions sur 234 (4 %) dans la mesure finale. Ces refus sont
  honnêtes (rien n'est écrit, l'utilisateur est invité à réessayer) mais les reprises allongent les mutations
  réussies.
- **Taille du pool** : l'essai à 25 connexions n'améliore rien. Plus de transactions simultanées donnent plus de
  conflits (70 refus). La mesure a eu lieu avec une charge machine deux fois plus forte ; le pool de 10 est
  conservé.
- **Pistes relevées le 24/09/2026** : regrouper le recalcul des plans et les écritures d'alertes, alléger la
  relecture de la vue ; pour les remises, se fonder sur les verrous `FOR UPDATE` déjà pris et sur les index
  uniques partiels (isolation `READ COMMITTED`) plutôt que sur l'isolation sérialisable. Elles sont traitées au
  § 7.1 (le recalcul reste fait par l'API, après validation, dans la requête : aucun report vers le worker).

### 7.1 Optimisations faites après la mesure (25/09/2026)

**Nombre de requêtes SQL par requête HTTP**, avant et après, compté par une instrumentation temporaire du pilote
pg (même technique que `reports-pagination.int.spec.ts` : chaque instruction envoyée à PostgreSQL, `BEGIN`,
`SET TRANSACTION` et `COMMIT` compris), hors dépôt et supprimée ensuite. Jeu réduit de `seed-load.ts`
(60 véhicules, 2 400 relevés, 120 plans d'entretien), API de test au repos, compte chef de parc (administrateur
pour les rapports et les plans), véhicule disponible avec deux plans d'entretien actifs, relevés et remise avec
relevé accepté. Ce sont des nombres d'allers-retours, pas des durées.

| Requête HTTP | Avant | Après | Transactions avant → après | Instructions de la transaction critique (BEGIN et COMMIT compris) avant → après |
| --- | --- | --- | --- | --- |
| `POST /vehicles/:id/readings` (relevé kilométrique) | 84 | 39 | 3 → 2 | 22 → 14 (sérialisable) |
| `POST /usages/checkout` (remise avec relevé) | 117 | 70 | 3 → 2 | 43 → 32 (`READ COMMITTED` sous verrous) |
| `POST /usages/:id/return` (restitution avec relevé) | 111 | 62 | 3 → 2 | 34 → 24 (`READ COMMITTED` sous verrous) |
| Rapport carburant, pleins, page de 25 (administrateur) | 364 | 23 | — | — |
| Rapport carburant, pleins, page de 25 (chef de parc) | 334 | 21 | — | — |
| Rapport carburant par véhicule, page de 25 | 360 | 19 | — | — |
| `GET /maintenance-plans`, première lecture du jour (120 plans à matérialiser) | 862 | 31 | 1 → 1 | 131 → 12 |

Optimisations, sans changement de règle métier (les règles restent dans `apps/api/src/domain/`) :

- **Recalculs dépendants d'un relevé accepté (hors correction)** : fraîcheur, échéances d'entretien et leurs
  alertes s'exécutent après validation dans **une seule transaction** (`OdometerEventsService.recomputeDependents`),
  au lieu d'une transaction par plan et d'écritures unitaires : plans du véhicule verrouillés, évalués en lot,
  écrits en une instruction (`UPDATE … FROM unnest`), alertes synchronisées en lot (`AlertsService.sync` : une
  lecture des alertes concernées, écritures limitées aux alertes à créer, modifier ou résoudre, mêmes règles que
  `raise` et `resolve`). Une correction garde ce recalcul dans sa propre transaction (R-13.3-07), avec les mêmes
  fonctions groupées.
- **Allers-retours supprimés** : verrou du véhicule et lecture de sa société en une instruction ; voisins du relevé
  (précédent, suivant, même instant) en une lecture ; segment et caractère « ordinaire » du compteur réutilisés
  dans la transaction ; opérations d'entretien réalisées lues par jointure ; lien d'un relevé avec une autre
  utilisation vérifié seulement pour un relevé rejoué ; aucune recherche d'alerte « relevé à valider » pour un
  relevé accepté dès sa saisie ; contrôles de visibilité du véhicule, du conducteur et de l'utilisation en une
  lecture ; empreinte CSRF lue avec la session ; association GPS vérifiée avant le calibrage ; alertes de la
  restitution synchronisées en lot.
- **Vue renvoyée** : la réponse d'un relevé est construite depuis la ligne insérée (seul l'auteur est lu) ; celle
  de la remise et de la restitution reste relue (vue complète de l'utilisation).
- **Mémoïsation par requête HTTP** (`common/request-memo.ts`) : paramètres versionnés et fuseau du groupe lus une
  fois par requête (lecture groupée anticipée pour le relevé, la remise et la restitution), invalidés par leur
  modification dans la requête ; aucune mémoire hors requête (worker, exports), aucune mémoire partagée entre
  requêtes.
- **Remise et restitution en `READ COMMITTED`** sous les verrous `FOR UPDATE` véhicule → conducteur → utilisation
  (lignes du véhicule et du conducteur versionnées sans changement de valeur, pour que les transactions encore
  sérialisables qui attendent ces verrous soient reprises), index uniques partiels et contraintes en garde finale
  (DECISIONS.md, D-016, qui détaille pourquoi chaque invariant tient). Les verrous de prédicat de l'isolation sérialisable, cause des 26 refus `CONCURRENCE` du § 6.1,
  disparaissent ; des remises et restitutions simultanées de couples distincts aboutissent toutes
  (`usages.int.spec.ts`).
- **Rapport carburant** : consommations des véhicules de la page par `FuelService.consumptionMany` (même règle
  `computeConsumption`, même périmètre que `GET /vehicles/:id/consumption`) : pleins, périodes d'achats
  incomplets, événements F11, relevés de régularisation, associations, échantillons et remplissages lus une fois
  pour la page, quel que soit le nombre de véhicules. Égalité avec le calcul unitaire vérifiée pour chaque véhicule
  du jeu et chaque ligne du rapport (`reports-pagination.int.spec.ts`).
- **Matérialisation des statuts des plans** (première lecture du jour, rattrapage `recomputeAll`) : par lots de
  500 plans, une écriture par lot, alertes synchronisées par lot ; un lot en échec est repris plan par plan.
- **Pool de connexions** : délai d'obtention d'une connexion borné (`DATABASE_CONNECTION_TIMEOUT_MS`, 10 s par
  défaut, `.env.example`) au lieu d'une attente sans limite.

**Mesure de charge à refaire** : le test de 50 sessions (§§ 4 et 5) n'a pas été relancé après ces optimisations ; il
doit l'être sur une machine au calme avant de conclure sur les objectifs. Restent, par requête : la session et les
habilitations (5 requêtes), la clé d'idempotence (2), et une requête par relation incluse par Prisma dans les vues
(12 pour la vue d'une utilisation).

## 8. Limites et écarts restants

- **Machine partagée** : 4 processeurs pour l'API, PostgreSQL, le générateur de charge et d'autres travaux
  (charge moyenne de 8). Les chiffres ne représentent pas un serveur dédié. Les réglages de test de PostgreSQL
  (`fsync=off`, `synchronous_commit=off`) ne coûtent aucun vidage disque à la validation : une base durable
  ajouterait ce coût à chaque mutation.
- **Hors mesure** : réseau lent et transfert de fichiers (exclus par le CDC), navigateur (temps de rendu), worker
  et F11, exports différés (couverts par les tests d'intégration), montée en charge au-delà de 50 sessions.
- **Rapport carburant : objectif de lecture non tenu à la mesure du 24/09/2026** (p95 3 852 ms, 2,5 % des
  lectures). Chaque page calculait alors la consommation de chacun de ses véhicules séparément : environ
  14 requêtes SQL par véhicule, soit environ 360 requêtes pour une page de 25 lignes. Le calcul est désormais
  groupé pour les véhicules de la page (23 requêtes, § 7.1) ; la mesure de charge est à refaire pour conclure.
- **Référentiel découpé en mémoire dans le rapport coûts et distances** : les véhicules candidats du périmètre et
  leurs transferts (environ 500 lignes) sont lus, découpés en parts de propriété (`ownershipSegments`), puis la
  page est prise sur ces parts ; relevés et dépenses ne sont lus que pour les parts de la page. Ce rapport ne
  figure pas dans le scénario de charge.
- **Entretien à venir** : la première lecture du jour matérialise les statuts de tous les plans du périmètre
  (862 requêtes pour 120 plans sur le jeu réduit avant le traitement par lots, 31 depuis, § 7.1) ; le scénario le
  fait en préchauffage, hors mesure (§ 4), et le rattrapage périodique du worker (`recomputeAll`,
  `alert-catch-up.job.ts`) le fait en exploitation.
- **Pagination en mémoire hors rapports** : le tableau de conformité documentaire (`GET /documents/compliance`,
  utilisé deux fois par le tableau de bord) évalue tous les couples objet × type du périmètre avant de découper
  la page. Le tri des plans d'entretien sur un reste calculé projette tous les plans filtrés. Ces deux cas
  portent sur le référentiel courant (1 500 objets, 1 000 plans), pas sur l'historique. Ils expliquent l'essentiel
  des 530 ms du tableau de bord administrateur.
- **Objectif des mutations non tenu** dans cet environnement (p95 4,7 s pour 3 s visés) : écart ouvert
  (R-17.2-04), à remesurer sur le matériel cible après les optimisations du § 7.1 (mesure de charge à refaire).
