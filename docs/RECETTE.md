# Rapport de recette

Rapport exigé par le CDC (§ 18, § 19.2 « rapport de recette avec commandes et résultats réels », § 19.3). Chaque
chiffre ci-dessous vient d'une commande exécutée le **25/09/2026** (heures en UTC) sur la révision `19b3be6`
(branche `claude/funny-galileo-h43sub`), sans retouche des sorties. Les sorties brutes ont été conservées hors dépôt
dans le répertoire de travail de la session de recette.

Machine : 4 processeurs logiques `Intel(R) Xeon(R) Processor @ 2.10GHz`, 16 095 Mio de mémoire, Linux
6.18.44, Node.js v24.21.0, pnpm 10.34.5, PostgreSQL 16.15 en conteneur de test (`fsync=off`,
`synchronous_commit=off`, `full_page_writes=off`). Chaque suite a tourné sur une base neuve créée pour l'occasion.

## 1. Commandes exécutées et résultats globaux

| Réf. | Commande (depuis la racine du dépôt sauf mention) | Base | Début → fin | Résultat |
| --- | --- | --- | --- | --- |
| C1 | `pnpm lint && pnpm typecheck && TEST_DATABASE_URL=postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test_recette pnpm test && pnpm build` | `parc_auto_test_recette` (neuve) | 03:31 → 03:45:27 | code 0 en 889 s ; lint et types sans erreur ; tests : contrôles des secrets 3/3, contrôles d'exploitation 11/11, `contracts` 6/6, `db` 6/6, API unitaires 449/449 (74 fichiers), API intégration 491/491 (72 fichiers), web 109/109 (26 fichiers), worker 18/18 (6 fichiers), soit **1 093 tests réussis, 0 échec** ; build de tous les paquets puis contrôle des secrets du bundle réussis |
| C2 | `cd apps/api && npx vitest run --config vitest.config.ts --reporter=verbose` | — | 03:51:53 | 74 fichiers, 449 tests réussis |
| C3 | `cd apps/api && TEST_DATABASE_URL=postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test_recette_v npx vitest run --config vitest.config.integration.ts --reporter=verbose` | `parc_auto_test_recette_v` (neuve) | 03:52:02, 715 s | 72 fichiers, 491 tests réussis |
| C4 | `cd apps/web && npx vitest run --reporter=verbose` | — | 04:03:58 | 26 fichiers, 109 tests réussis |
| C5 | `cd apps/worker && TEST_DATABASE_URL=…/parc_auto_test_recette_v npx vitest run --reporter=verbose` | idem C3 | 04:04:02 | 6 fichiers, 18 tests réussis |
| C6 | `cd tests/e2e && TEST_DATABASE_URL=postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test_recette_e2e E2E_STORAGE_DIR=<répertoire temporaire> npx playwright test --reporter=list` (après C1, donc sur le build de C1) | `parc_auto_test_recette_e2e` (neuve) | 03:45:54 → 03:51:42 | **52 tests réussis** (5,8 min), 0 échec |
| C7 | `node scripts/tests/load-test.mjs --api http://127.0.0.1:3990 --origin http://localhost:3000 --sessions 50 --duration 300` | `parc_auto_test_perf2` (neuve, jeu de dimensionnement) | 03:17:13 → 03:22:14 | code 0 ; voir § 2.1 |
| C8 | `bash scripts/tests/check-exposed-ports.sh` | — | 03:26:26 | code 0 : « 6 service(s) ; seul le reverse proxy publie 80 et 443, en HTTPS automatique avec HSTS ; PostgreSQL et le stockage restent privés » |
| C9 | `docker build --network host … --target api -t parc-auto/api:test .` | — | 03:23 | **échec** (code 1) : voir § 2.2 |

C2 à C5 ont été lancés à la suite par un même script qui exporte `TEST_DATABASE_URL` (base `parc_auto_test_recette_v`) ; ils rejouent les mêmes suites que C1 avec le rapporteur détaillé, pour disposer du titre de chaque test réussi
(1 067 lignes « ✓ », aucune ligne en échec ni ignorée) : ce sont ces titres qui sont cités au § 3. Un premier essai
de C1 (03:28 → 03:30:13) avait échoué sur un test de cohérence de `docs/performance.md`
(`performance-doc.spec.ts › la synthèse reprend les p95 de la sortie brute de la mesure finale`), après la mise à
jour de ce document par la présente recette ; la formulation du statut a été corrigée, puis C1 a été relancé en
entier sur une base neuve (résultat ci-dessus).

## 2. Exploitation

### 2.1 Performance (CDC 17.2)

Jeu de dimensionnement rechargé sur une base neuve (`node apps/api/dist/cli/seed-load.js`, 150,2 s : 3 sociétés,
500 véhicules, 1 000 conducteurs, 50 comptes, 300 000 relevés, 49 526 utilisations, 37 240 pleins, 58 459 dépenses),
API compilée (`pnpm --filter @parc-auto/api build`) lancée avec `NODE_ENV=test`, port 3990,
`RATE_LIMIT_ENABLED=false`. Charge moyenne (1 min) : 0,85 avant la mesure, 3,05 en moyenne et 4,09 au maximum
pendant la mesure (60 échantillons).

| Seuil (CDC 17.2) | p95 mesuré (C7) | Statut |
| --- | --- | --- |
| Lectures paginées < 2 s | 618,2 ms (19 255 requêtes) | tenu |
| Rapport carburant < 2 s | 792,5 ms (508 requêtes) | tenu |
| Mutation simple < 3 s | 1 193,1 ms (755 requêtes) | tenu |

20 010 requêtes en 301 s ; 0 réponse non 2xx ; 0 refus `CONCURRENCE` ; verdict du script : « lectures p95 618.2 ms
(< 2000) OK ; mutations p95 1193.1 ms (< 3000) OK ». Sortie complète et limites (machine partagée de 4 processeurs,
PostgreSQL sans vidage disque, essai unique) : `docs/performance.md`, §§ 1, 6.1 et 8.

### 2.2 Images de production, pile HTTPS et T30 (CDC 16.3, 16.4)

Non exécuté. La construction des images a échoué avant la première étape du Dockerfile :

```text
ERROR: failed to build: failed to solve: failed to resolve source metadata for docker.io/docker/dockerfile:1.7:
failed to do request: Head "https://registry-1.docker.io/v2/docker/dockerfile/manifests/1.7": proxyconnect tcp:
dial tcp 127.0.0.1:45757: connect: connection refused
```

Le démon Docker de la machine de recette utilisait un proxy sortant (`127.0.0.1:45757`) qui n'écoutait plus (le
proxy de la session était passé sur un autre port). Le contournement envisagé (relais local vers le nouveau port) a
été refusé par la politique de permissions de la session et n'a pas été tenté autrement. Les images
`parc-auto/*:test` présentes sur la machine avaient été construites environ 12 h plus tôt, avant les commits des lots
C à F : elles ne correspondent pas à la révision recettée et n'ont pas été utilisées.

En conséquence, **n'ont pas été exécutés** : construction des 4 cibles (`api`, `worker`, `web`, `migrate`),
démarrage de `docker-compose.prod.yml`, création de l'administrateur par `create-admin.js` en conteneur,
`/api/v1/health/live`, `/ready`, `/worker` et `/login` en HTTPS derrière Caddy, redirection HTTP → HTTPS,
`scripts/tests/restart-persistence.sh`, création de données (société, véhicule, photo) sur la pile de production,
`scripts/ops/backup.sh` et `scripts/ops/restore-test.sh`. **Aucune mesure de RPO ni de RTO n'a donc été faite.**
Seul le contrôle statique de l'exposition des ports (C8) a été exécuté.

Les conteneurs et volumes d'un ancien exercice de restauration (projet compose `parcrestore` : `api`, `worker`,
`postgres`, volumes `parcrestore_postgres-data` et `parcrestore_storage`) ont été supprimés
(`docker compose -p parcrestore down -v --remove-orphans`, code 0).

## 3. Tests de recette T01 à T44

Statut « réussi » : au moins un test automatisé dont le titre énonce le scénario du CDC a réussi le 25/09/2026 dans
les sorties C2 à C6 (et dans C1, qui rejoue les mêmes suites). Le nombre indiqué compte les titres réussis (y compris
le nom de leur groupe) qui citent le numéro du test. Les correspondances test ↔ exigences sont dans
`docs/TRACEABILITY.md` (section « Tests de recette T01 à T44 »).

| Test | Scénario (CDC 18) | Statut | Commande | Résultat réel (25/09/2026) |
| --- | --- | --- | --- | --- |
| T01 | Le chef de parc de A appelle la fiche, la recherche, un rapport et un fichier de B par leurs identifiants : aucun contenu de B, refus cohérent, aucune fuite dans les compteurs. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 32 tests réussis dont le titre ou le groupe cite T01 ; preuve : C3 « test/integration/scope.int.spec.ts > Cloisonnement des sociétés (CDC 2.3 — T01, T02, T03) > T01 — le chef de A ne voit ni la fiche, ni la recherche, ni le conducteur, ni les compteurs de B » ; C3 « test/integration/reports.int.spec.ts > Rapports V1 et exports (CDC 11.2, 11.3 — T01, T32, T34) > T01 — le chef A demandant un rapport filtré sur la société B reçoit 404, sans fuite dans le total ; conducteur seul : 403 » ; C3 « test/integration/attachments.int.spec.ts > Pièces jointes privées (CDC 16.2, T28) > T28 — le fichier privé de la société B est inaccessible au chef de A, sans session et par son seul identifiant » |
| T02 | L'administrateur ouvre toutes les sociétés puis filtre sur A : totaux consolidés puis limités à A, justifiables. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 14 tests réussis dont le titre ou le groupe cite T02 ; preuve : C3 « test/integration/scope.int.spec.ts > Cloisonnement des sociétés (CDC 2.3 — T01, T02, T03) > T02 — l’administrateur consolide toutes les sociétés puis filtre sur A avec des totaux justifiables » ; C3 « test/integration/dashboard.int.spec.ts > Tableau de bord (CDC 11.1, 10.2 — D-269 ; T01, T02) > T02 — administrateur : totaux consolidés A+B+C, puis filtre A ; chaque total égale sa liste justificative » |
| T03 | Un conducteur tente de voir un autre conducteur ou un ancien utilisateur du véhicule : refus, même avec l'identifiant. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 8 tests réussis dont le titre ou le groupe cite T03 ; preuve : C3 « test/integration/scope.int.spec.ts > Cloisonnement des sociétés (CDC 2.3 — T01, T02, T03) > T03 — un conducteur ne consulte ni les autres conducteurs ni un véhicule qu’il n’utilise pas » ; C3 « test/integration/usages.int.spec.ts > Remises, restitutions et réservations (CDC 4 — T04 à T08, T22, T23, T33) > T03 — un conducteur voit ses utilisations et pas celles des autres » |
| T04 | Deux requêtes simultanées remettent le même véhicule à deux conducteurs : une seule réussite, une seule utilisation ouverte. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 18 tests réussis dont le titre ou le groupe cite T04 ; preuve : C3 « test/integration/usages.int.spec.ts > Remises, restitutions et réservations (CDC 4 — T04 à T08, T22, T23, T33) > T04 — deux remises simultanées du même véhicule à deux conducteurs : une seule réussite » ; C3 « test/integration/usages.int.spec.ts > Remises, restitutions et réservations (CDC 4 — T04 à T08, T22, T23, T33) > T04 — dix remises concurrentes du même véhicule ne créent qu’une utilisation ouverte » |
| T05 | Le même conducteur reçoit deux véhicules au même instant : une seule utilisation en cours autorisée. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 3 tests réussis dont le titre ou le groupe cite T05 ; preuve : C3 « test/integration/usages.int.spec.ts > Remises, restitutions et réservations (CDC 4 — T04 à T08, T22, T23, T33) > T05 — même conducteur, deux véhicules au même instant : une seule utilisation en cours » |
| T06 | Réservations qui se chevauchent puis exactement consécutives : chevauchement refusé, succession [début, fin[ acceptée. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 2 tests réussis dont le titre ou le groupe cite T06 ; preuve : C3 « test/integration/usages.int.spec.ts > Remises, restitutions et réservations (CDC 4 — T04 à T08, T22, T23, T33) > T06 — réservations : chevauchement refusé, succession [début, fin[ acceptée » |
| T07 | Retour prévu dépassé avec une réservation suivante : alerte, utilisation toujours ouverte, départ suivant bloqué. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 1 tests réussis dont le titre ou le groupe cite T07 ; preuve : C3 « test/integration/usages.int.spec.ts > Remises, restitutions et réservations (CDC 4 — T04 à T08, T22, T23, T33) > T07 — retour dépassé avec réservation suivante : alerte, utilisation ouverte, départ suivant bloqué » |
| T08 | Responsable habituel A et utilisation ponctuelle par B : informations distinctes, historique conservé. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 18 tests réussis dont le titre ou le groupe cite T08 ; preuve : C3 « test/integration/usages.int.spec.ts > Remises, restitutions et réservations (CDC 4 — T04 à T08, T22, T23, T33) > T08 — responsable habituel A et utilisation ponctuelle B restent distincts, historique conservé » |
| T09 | Relevé de 89 000 après 89 500 dans le même segment : diminution refusée sans correction ni remplacement de compteur. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 19 tests réussis dont le titre ou le groupe cite T09 ; preuve : C3 « test/integration/odometer.int.spec.ts > Kilométrage manuel (CDC 5.1 à 5.5 — T09 à T14) > T09 — refuse 89 000 après 89 500 dans le même segment » |
| T10 | Insertion d'un ancien relevé entre deux relevés valides : contrôle des voisins, compteur courant inchangé. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 7 tests réussis dont le titre ou le groupe cite T10 ; preuve : C3 « test/integration/odometer.int.spec.ts > Kilométrage manuel (CDC 5.1 à 5.5 — T09 à T14) > T10 — un relevé rétroactif entre deux voisins est contrôlé et ne fait pas reculer le compteur courant » |
| T11 | Un conducteur soumet 90 200 non encore approuvé : soumission en attente, compteur officiel inchangé. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 2 tests réussis dont le titre ou le groupe cite T11 ; preuve : C3 « test/integration/odometer.int.spec.ts > Kilométrage manuel (CDC 5.1 à 5.5 — T09 à T14) > T11 — la soumission d’un conducteur reste en attente et ne modifie pas le compteur officiel » |
| T12 | Aucun relevé, ou dernier relevé antérieur au seuil : INCONNU ou A_ACTUALISER, jamais un faux « à jour ». | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 8 tests réussis dont le titre ou le groupe cite T12 ; preuve : C3 « test/integration/odometer.int.spec.ts > Kilométrage manuel (CDC 5.1 à 5.5 — T09 à T14) > T12 — fraîcheur INCONNU sans relevé puis A_ACTUALISER au-delà de sept jours » |
| T13 | Le chef corrige une lecture acceptée avec motif : original conservé, remplacement, audit, calculs recalculés. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 2 tests réussis dont le titre ou le groupe cite T13 ; preuve : C3 « test/integration/odometer.int.spec.ts > Kilométrage manuel (CDC 5.1 à 5.5 — T09 à T14) > T13 — correction motivée : original conservé, remplacement créé, audit et utilisations recalculées » |
| T14 | Remplacement du compteur à 120 000 par 0 puis lecture 500 : physique 500, cumul 120 500, entretien sur le cumul. | réussi | C3, C6 | intégration API : 72 fichiers, 491 tests réussis; e2e : 52 tests réussis ; 17 tests réussis dont le titre ou le groupe cite T14 ; preuve : C3 « test/integration/odometer.int.spec.ts > Kilométrage manuel (CDC 5.1 à 5.5 — T09 à T14) > T14 — remplacement à 120 000 par un compteur à 0 puis lecture 500 : physique 500, cumul 120 500 » ; C6 « specs/compteur.spec.ts:37:3 › Compteur kilométrique : remplacement et cumul (T14) › remplacement à 120 000 km par un compteur à 0 : lecture 500 = 120 500 km cumulés, compteur courant daté, sourcé et frais ; la base du nouveau compteur ne se corrige pas » |
| T15 | Vidange base 80 000, intervalle 10 000, relevés 89 500 / 90 000 / 90 200 : A_PREVOIR, A_FAIRE, EN_RETARD sans GPS. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 14 tests réussis dont le titre ou le groupe cite T15 ; preuve : C3 « test/integration/maintenance.int.spec.ts > Plans d’entretien (CDC 6.1, 6.2 — T15, T16) > T15 — base 80 000, intervalle 10 000 : 89 500 A_PREVOIR, 90 000 A_FAIRE, 90 200 EN_RETARD, sans GPS » |
| T16 | Date d'entretien atteinte avant le kilométrage : à faire puis en retard selon le jour local. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 12 tests réussis dont le titre ou le groupe cite T16 ; preuve : C3 « test/integration/maintenance.int.spec.ts > Plans d’entretien (CDC 6.1, 6.2 — T15, T16) > T16 — date atteinte avant le kilométrage : à faire le jour local de l’échéance, en retard le lendemain » |
| T17 | Batterie terminée puis vidange à 90 300 : batterie sans effet sur la vidange, vidange suivante à 100 300. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 15 tests réussis dont le titre ou le groupe cite T17 ; preuve : C3 « test/integration/interventions.int.spec.ts > Interventions et clôture ciblée (CDC 6.3, 6.4, 15.3 — T17, T18, T24) > T17 — une batterie terminée n’a aucun effet sur la vidange ; vidange à 90 300 → suivante à 100 300 » |
| T18 | Ajout après coup d'une vidange antérieure à la dernière opération : base courante non régressée. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 15 tests réussis dont le titre ou le groupe cite T18 ; preuve : C3 « test/integration/interventions.int.spec.ts > Interventions et clôture ciblée (CDC 6.3, 6.4, 15.3 — T17, T18, T24) > T18 — une vidange antérieure ajoutée après coup ne fait pas régresser la base courante » |
| T19 | Dix recalculs d'une même occurrence : une alerte active, aucun job logique dupliqué. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 9 tests réussis dont le titre ou le groupe cite T19 ; preuve : C3 « test/integration/alerts.int.spec.ts > Centre d’alertes et notifications e-mail (CDC 9.1, 9.2, 9.4 — T19, T20, T29) > canal e-mail configuré (SMTP) > T19 — dix recalculs de la même occurrence : une seule alerte active, aucune ligne d’outbox dupliquée » |
| T20 | « Lu » sur une vidange en retard : le retard et l'alerte métier persistent. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 9 tests réussis dont le titre ou le groupe cite T20 ; preuve : C3 « test/integration/alerts.int.spec.ts > Centre d’alertes et notifications e-mail (CDC 9.1, 9.2, 9.4 — T19, T20, T29) > canal e-mail configuré (SMTP) > T20 — « lu » sur une vidange en retard : l’alerte reste ACTIVE et le plan EN_RETARD ; report motivé visible, statut inchangé » |
| T21 | Fin de validité aujourd'hui puis lendemain local, renouvellement futur : valable jusqu'à la fin du jour, expiré ensuite sauf version valide. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 15 tests réussis dont le titre ou le groupe cite T21 ; preuve : C3 « test/integration/documents.int.spec.ts > Documents et conformité (CDC 7.1, 7.2 — T21, T22) > T21 — fin de validité aujourd’hui : valable jusqu’à la fin du jour local, expiré le lendemain, puis valide à l’entrée en vigueur du renouvellement futur » |
| T22 | Nouveau départ avec document bloquant expiré puis restitution : départ refusé sauf dérogation, retour autorisé. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 24 tests réussis dont le titre ou le groupe cite T22 ; preuve : C3 « test/integration/documents.int.spec.ts > Documents et conformité (CDC 7.1, 7.2 — T21, T22) > T22 — document bloquant expiré : départ refusé, dérogation motivée du chef, restitution toujours possible » |
| T23 | Immobilisation pendant une utilisation puis restitution : utilisation conservée, retour possible, véhicule toujours immobilisé. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 24 tests réussis dont le titre ou le groupe cite T23 ; preuve : C3 « test/integration/incidents.int.spec.ts > Incidents et immobilisations (CDC 7.3, 7.4, 4.5 — T23) > T23 — immobilisation pendant une utilisation : utilisation conservée, chef prévenu, retour possible, véhicule toujours immobilisé » |
| T24 | Validation en double de la même intervention et du même plein : une seule dépense par source. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 36 tests réussis dont le titre ou le groupe cite T24 ; preuve : C3 « test/integration/fuel.int.spec.ts > Pleins, soumissions conducteur et consommation (CDC 8.2, 8.3 — T24, T25) > T24 — plein validé deux fois : même clé → réponse rejouée, autre clé → 409 DEJA_VALIDE, une seule dépense » ; C3 « test/integration/interventions.int.spec.ts > Interventions et clôture ciblée (CDC 6.3, 6.4, 15.3 — T17, T18, T24) > T24 — clôture rejouée : même clé → même résultat ; autre clé → 409 ; une seule dépense » |
| T25 | Deux pleins complets, partiel intermédiaire de 20 L, dernier de 30 L, 400 km : 12,5 L/100 km ; N/D si historique insuffisant. | réussi | C2, C6 | unitaires API : 74 fichiers, 449 tests réussis; e2e : 52 tests réussis ; 17 tests réussis dont le titre ou le groupe cite T25 ; preuve : C2 « src/domain/consumption.spec.ts > T25 — consommation entre deux pleins complets (CDC 8.3, D-227) > 50 L / 400 km × 100 = 12,5 L/100 km ; le carburant acheté en A n’est pas compté » ; C6 « specs/carburant.spec.ts:29:3 › Carburant › le chef saisit un plein avec anomalies : avertissements de l’API, confirmation de la capacité, consommation N/D motivée puis 12,5 L/100 km (T25) » |
| T26 | Transfert avec opération ouverte puis après résolution : refus initial, transfert ensuite, coûts historiques inchangés. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 27 tests réussis dont le titre ou le groupe cite T26 ; preuve : C3 « test/integration/vehicle-transfer.int.spec.ts > Transfert de véhicule entre sociétés (CDC 2.4, 11.3 — T26 ; D-119 à D-125) > T26 — refus 409 TRANSFERT_BLOQUE avec une intervention ouverte, puis transfert après résolution ; coûts historiques inchangés » |
| T27 | Lot d'import avec doublon et mauvaise société, puis lot corrigé confirmé deux fois : aucune écriture puis une seule importation. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 9 tests réussis dont le titre ou le groupe cite T27 ; preuve : C3 « test/integration/imports.int.spec.ts > Import assisté (CDC 12.1, 12.2 — T27) > T27 — lot avec doublon et mauvaise société : aucune écriture ; lot corrigé confirmé deux fois : une seule importation » |
| T28 | Fichier privé de B, type interdit ou taille excessive : refus de lecture ou d'envoi, aucun fichier public. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 5 tests réussis dont le titre ou le groupe cite T28 ; preuve : C3 « test/integration/attachments.int.spec.ts > Pièces jointes privées (CDC 16.2, T28) > T28 — le fichier privé de la société B est inaccessible au chef de A, sans session et par son seul identifiant » ; C3 « test/integration/attachments.int.spec.ts > Pièces jointes privées (CDC 16.2, T28) > refuse un fichier HTML déguisé en image, un SVG et un fichier trop volumineux » |
| T29 | SMTP absent, puis panne SMTP et redémarrage du worker : alertes internes disponibles, statut exact, reprise des tentatives. | réussi | C3, C5 | intégration API : 72 fichiers, 491 tests réussis; worker : 6 fichiers, 18 tests réussis ; 12 tests réussis dont le titre ou le groupe cite T29 ; preuve : C3 « test/integration/alerts.int.spec.ts > Centre d’alertes et notifications e-mail (CDC 9.1, 9.2, 9.4 — T19, T20, T29) > sans SMTP (T29, D-263) > alertes internes disponibles, aucune ligne d’outbox, statut exact « Canal e-mail non configuré » » ; C5 « src/jobs/outbox-dispatcher.job.spec.ts > Outbox e-mail, panne SMTP et redémarrage du worker (CDC 9.4 — T29 ; D-261 à D-263) > (b) panne SMTP : ECHEC, prochaine tentative croissante, erreur expurgée, puis ABANDONNE après 8 tentatives » ; C5 « src/jobs/outbox-dispatcher.job.spec.ts > Outbox e-mail, panne SMTP et redémarrage du worker (CDC 9.4 — T29 ; D-261 à D-263) > (c) arrêt brutal pendant l’envoi puis redémarrage avec SMTP disponible : reprise après expiration du verrou, envoi réel (Mailpit), statut ENVOYE ; droits revérifiés » |
| T30 | Redémarrer les services puis restaurer une sauvegarde isolée : base et fichiers retrouvés, procédure de restauration vérifiée. | non testé | `scripts/tests/restart-persistence.sh`, `scripts/ops/backup.sh`, `scripts/ops/restore-test.sh` (non exécutés) | Non exécuté : les images de production n'ont pas pu être construites (§ 3.2) ; aucun test automatisé ne cite T30 dans les sorties du jour (0 titre). |
| T31 | F11 désactivé, puis actif avec fournisseur injoignable : parcours manuels intacts, alerte « source GPS muette », aucun faux suivi en direct. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 14 tests réussis dont le titre ou le groupe cite T31 ; preuve : C3 « test/integration/telemetry-sync.int.spec.ts > Connecteur télématique — synchronisation et ingestion (CDC 5.6, 8.5, 14.4 ; T31, T36 à T43) > T31 — F11 désactivé : aucun appel, parcours manuels complets ; fournisseur injoignable : reprises 1-4-16 s, délai exponentiel, coupe-circuit, alertes distinctes, parcours manuels intacts, reprise au premier succès » |
| T32 | Désactivation d'un compte connecté puis rejeu d'une mutation ou d'un export : session refusée, accès révoqué. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 26 tests réussis dont le titre ou le groupe cite T32 ; preuve : C3 « test/integration/auth.int.spec.ts > Authentification et sessions (CDC 16.1, T32) > T32 — un compte désactivé perd immédiatement sa session ; la mutation et la lecture sont refusées » ; C3 « test/integration/reports.int.spec.ts > Rapports V1 et exports (CDC 11.2, 11.3 — T01, T32, T34) > T32 — compte désactivé par l’administrateur : un nouvel export avec l’ancienne session est refusé (401) » |
| T33 | Même clé d'idempotence avec corps identique puis différent : réponse initiale rejouée, puis 409. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 17 tests réussis dont le titre ou le groupe cite T33 ; preuve : C3 « test/integration/usages.int.spec.ts > Remises, restitutions et réservations (CDC 4 — T04 à T08, T22, T23, T33) > T33 — même clé et même corps : réponse initiale rejouée ; même clé et corps différent : 409 » |
| T34 | Export filtré avec un texte commençant comme une formule : périmètre respecté, texte neutralisé. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 20 tests réussis dont le titre ou le groupe cite T34 ; preuve : C3 « test/integration/reports.int.spec.ts > Rapports V1 et exports (CDC 11.2, 11.3 — T01, T32, T34) > T34 — export CSV filtré : formules neutralisées, nombres non préfixés, bloc de métadonnées, lignes de B absentes ; XLSX sans formule » |
| T35 | Première synchronisation : 12 unités, 10 immatriculations reconnues, 2 inconnues : 10 propositions, 2 non mappées, aucun relevé avant confirmation. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 14 tests réussis dont le titre ou le groupe cite T35 ; preuve : C3 « test/integration/telemetry-core.int.spec.ts > Connecteur télématique — cœur (CDC 14.3 à 14.6 ; D-101, D-112, D-292, D-300 à D-304 ; T35, T44) > T35 — 12 unités, 10 immatriculations reconnues, 2 inconnues : 10 propositions, 2 non associées, aucun relevé avant confirmation » |
| T36 | Même lot fournisseur reçu deux fois : aucun doublon de relevé ni d'événement carburant. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 14 tests réussis dont le titre ou le groupe cite T36 ; preuve : C3 « test/integration/telemetry-sync.int.spec.ts > Connecteur télématique — synchronisation et ingestion (CDC 5.6, 8.5, 14.4 ; T31, T36 à T43) > T36 et T37 — CAN 50 000 puis 50 120, manuel 50 130 une heure après : acceptés, compteur courant 50 130 ; même lot reçu deux fois : aucun doublon de relevé ni d’événement carburant » |
| T37 | CAN 50 000 puis 50 120, relevé manuel 50 130 une heure après : relevés acceptés, compteur courant 50 130. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 1 tests réussis dont le titre ou le groupe cite T37 ; preuve : C3 « test/integration/telemetry-sync.int.spec.ts > Connecteur télématique — synchronisation et ingestion (CDC 5.6, 8.5, 14.4 ; T31, T36 à T43) > T36 et T37 — CAN 50 000 puis 50 120, manuel 50 130 une heure après : acceptés, compteur courant 50 130 ; même lot reçu deux fois : aucun doublon de relevé ni d’événement carburant » |
| T38 | Référence manuelle 80 000 à distanceGps 12 000, puis distanceGps 12 450 : 80 450 affiché « estimé GPS ». | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 6 tests réussis dont le titre ou le groupe cite T38 ; preuve : C3 « test/integration/telemetry-sync.int.spec.ts > Connecteur télématique — synchronisation et ingestion (CDC 5.6, 8.5, 14.4 ; T31, T36 à T43) > T38 et T39 — référence 80 000 à distanceGps 12 000, puis 12 450 → 80 450 « estimé GPS » ; estimation 81 000, restitution 80 960 → écart 4,2 %, alerte dérive, nouvelle référence 80 960 » |
| T39 | Estimation 81 000 depuis la référence 80 000, restitution manuelle 80 960 : écart 4,2 %, alerte dérive, nouvelle référence 80 960. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 6 tests réussis dont le titre ou le groupe cite T39 ; preuve : C3 « test/integration/telemetry-sync.int.spec.ts > Connecteur télématique — synchronisation et ingestion (CDC 5.6, 8.5, 14.4 ; T31, T36 à T43) > T38 et T39 — référence 80 000 à distanceGps 12 000, puis 12 450 → 80 450 « estimé GPS » ; estimation 81 000, restitution 80 960 → écart 4,2 %, alerte dérive, nouvelle référence 80 960 » |
| T40 | Valeur CAN inférieure à la précédente : relevé EN_ATTENTE motivé, compteur courant inchangé, remises non bloquées. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 2 tests réussis dont le titre ou le groupe cite T40 ; preuve : C3 « test/integration/telemetry-sync.int.spec.ts > Connecteur télématique — synchronisation et ingestion (CDC 5.6, 8.5, 14.4 ; T31, T36 à T43) > T40 — valeur CAN inférieure à la précédente : EN_ATTENTE motivé (un seul par motif), compteur courant inchangé, remise non bloquée » |
| T41 | Unité associée sans donnée pendant 25 h : alerte source muette, saisie manuelle possible, fraîcheur sur la dernière observation. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 1 tests réussis dont le titre ou le groupe cite T41 ; preuve : C3 « test/integration/telemetry-sync.int.spec.ts > Connecteur télématique — synchronisation et ingestion (CDC 5.6, 8.5, 14.4 ; T31, T36 à T43) > T41 — unité associée sans donnée pendant 25 h : alerte « source GPS muette », saisie manuelle possible, fraîcheur sur la dernière observation, résolution au premier échantillon frais » |
| T42 | Base vidange 80 000, intervalle 10 000, synchronisation CAN 89 500 puis 90 000 : A_PREVOIR puis A_FAIRE sans saisie, alerte en moins d'une minute. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 6 tests réussis dont le titre ou le groupe cite T42 ; preuve : C3 « test/integration/telemetry-sync.int.spec.ts > Connecteur télématique — synchronisation et ingestion (CDC 5.6, 8.5, 14.4 ; T31, T36 à T43) > T42 — base 80 000, intervalle 10 000 : synchro CAN 89 500 puis 90 000 → A_PREVOIR puis A_FAIRE sans saisie manuelle, alerte moins d’une minute après l’ingestion (délai mesuré) » |
| T43 | Sonde : baisse de 25 L moteur coupé en 20 min et remplissage de 40 L sans ticket : deux anomalies à qualifier, aucune dépense automatique. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 21 tests réussis dont le titre ou le groupe cite T43 ; preuve : C3 « test/integration/telemetry-sync.int.spec.ts > Connecteur télématique — synchronisation et ingestion (CDC 5.6, 8.5, 14.4 ; T31, T36 à T43) > T43 — sonde : baisse de 25 L moteur coupé en 20 min et remplissage de 40 L sans ticket → deux anomalies à qualifier, aucune dépense ; qualification par le chef ; ticket saisi ensuite → rapprochement » |
| T44 | Lecture de la configuration fournisseur par l'API et dans les journaux : aucun secret restitué ni journalisé. | réussi | C3 | intégration API : 72 fichiers, 491 tests réussis ; 22 tests réussis dont le titre ou le groupe cite T44 ; preuve : C3 « test/integration/telemetry-core.int.spec.ts > Connecteur télématique — cœur (CDC 14.3 à 14.6 ; D-101, D-112, D-292, D-300 à D-304 ; T35, T44) > T44 — secrets : jamais restitués par l’API, uniquement chiffrés en base, absents des journaux (création, test de connexion en échec d’authentification) » |

T31 : l'e2e `specs/telematique-complements.spec.ts › Télématique : aide à la saisie, panne du fournisseur, événements
carburant et seuils (5.6, 8.5, 14.4)` a aussi réussi (C6). T25 : la valeur 12,5 L/100 km est prouvée par le test
unitaire du domaine et par l'e2e cité.

## 4. Implémenté

Selon `docs/TRACEABILITY.md` à la révision `19b3be6` (790 exigences atomiques ; synthèse non recalculée par cette
recette) : 691 « fait », 49 « partiel », 24 « non testé », 8 « à faire », 18 « hors périmètre ». Les lots A à F du
CDC § 19.1 ont leur code dans le dépôt : API NestJS (`apps/api`), worker (`apps/worker`), interface Next.js
(`apps/web`), schéma et 10 migrations Prisma (`packages/db`), CLI (premier administrateur, jeu de démonstration, jeu
de dimensionnement), Dockerfile à 4 cibles, `docker-compose.prod.yml`, Caddyfile, scripts de sauvegarde, de
restauration et d'exercice de restauration, documentation d'exploitation et guides.

## 5. Testé avec succès (25/09/2026)

- Lint (dont contrôles des secrets et contrôles statiques d'exploitation), vérification des types et build de tous
  les paquets (C1).
- 1 093 tests automatisés, 0 échec (C1) ; 1 067 titres réussis en rapporteur détaillé (C2 à C5) ; 52 parcours
  Playwright réussis (C6).
- Scénarios T01 à T29 et T31 à T44 : statut « réussi » au § 3.
- Test de charge de 50 sessions pendant 300 s sur le jeu de dimensionnement : seuils p95 des lectures, du rapport
  carburant et des mutations tenus sur la machine décrite (C7, § 2.1).
- Contrôle statique de l'exposition réseau de `docker-compose.prod.yml` et du Caddyfile (C8).

## 6. Non testé

| Élément | Raison |
| --- | --- |
| T30 (persistance après redémarrage, sauvegarde chiffrée, restauration isolée) | Images de production non construites le 25/09/2026 (§ 2.2) ; `restart-persistence.sh`, `backup.sh` et `restore-test.sh` non exécutés |
| RPO 24 h et RTO 4 h (CDC 16.4) | Dépendent de l'exercice T30, non exécuté ; aucune durée mesurée |
| Images Docker des 4 cibles, pile `docker-compose.prod.yml`, HTTPS par Caddy, redirection HTTP → HTTPS, sondes de santé derrière le proxy, `create-admin.js` en conteneur | Même cause (§ 2.2) |
| Accessibilité (statuts non dépendants de la couleur, clavier et libellés) et interface responsive | Marqués « non testé » dans `docs/TRACEABILITY.md` ; aucun contrôle d'accessibilité automatisé exécuté par cette recette |
| Performance sur le matériel cible, avec une base aux réglages durables, au-delà de 50 sessions, volumétrie F11 (2 millions de relevés automatiques par an) | Mesure faite sur une machine de 4 processeurs partagée, PostgreSQL de test sans vidage disque, jeu sans données F11 (`docs/performance.md` § 8) |
| Autres exigences marquées « non testé », « partiel » ou « à faire » dans `docs/TRACEABILITY.md` | Liste et motif par exigence dans ce fichier ; non réexaminées une à une par cette recette |

## 7. Dépendances externes

| Dépendance | État à la date de la recette |
| --- | --- |
| Serveur SMTP réel | Non configuré. Les envois ont été vérifiés contre Mailpit (serveur SMTP local de test) ; sans SMTP, l'application affiche « Canal e-mail non configuré » (T29) |
| Nom de domaine et certificat TLS | Non disponibles. Caddy obtient le certificat Let's Encrypt pour `DOMAIN` ; nécessite un nom de domaine public pointant vers le serveur et les ports 80 et 443 ouverts (`docs/installation.md`) |
| Stockage hors site des sauvegardes | Non configuré. `backup.sh` copie l'archive par `rclone` vers `BACKUP_REMOTE` ; sans cette variable, aucune copie hors site n'existe |
| Accès au fournisseur GPS réel (annexe A du CDC) | Non disponible. T35 à T44 utilisent le simulateur de fournisseur (CDC § 18) ; aucun appel à une plateforme réelle n'a été fait |
| Supervision externe | Non configurée. Deux sondes hébergées hors du serveur sur `/api/v1/health/ready` et `/api/v1/health/worker` sont à mettre en place (`docs/installation.md` § 6) |

## 8. Conclusion

Le 25/09/2026, sur la révision `19b3be6` : lint, vérification des types, 1 093 tests automatisés et le build ont
réussi (C1) ; 52 parcours Playwright ont réussi (C6) ; 43 des 44 scénarios de recette (T01 à T29, T31 à T44) ont un
test automatisé réussi qui les énonce ; le test de charge de 50 sessions a donné des p95 de 618 ms pour les lectures,
793 ms pour le rapport carburant et 1 193 ms pour les mutations, sans réponse en erreur, sur une machine de
4 processeurs partagée. T30 n'a pas été exécuté : les images de production n'ont pas pu être construites sur la
machine de recette, si bien que la persistance après redémarrage, la sauvegarde, la restauration, le RPO et le RTO
n'ont pas été mesurés. La V1 n'est pas déclarée prête pour la production par ce rapport : T30 et les dépendances
externes du § 7 restent à traiter.
