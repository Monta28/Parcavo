# Connecteur télématique (module F11)

Ce document décrit le connecteur télématique : canaux disponibles, paramètres et secrets attendus par chaque adaptateur, ce qui a été testé et comment, et les limites connues (cahier des charges 5.6, 8.5, 14.3 à 14.6, annexe A ; décisions D-184, D-195, D-292, D-294, D-297, D-303, D-304). D’autres sections (activation, mapping des unités, synchronisation, rotation des clés) peuvent compléter ce document.

## Canaux et adaptateurs

Le canal réel du client dépend de la qualification du fournisseur (annexe A), qui n’a pas encore eu lieu (D-292). La V1 livre donc trois adaptateurs réels et un simulateur, tous conformes au même contrat. Le branchement au fournisseur réel reste une **dépendance externe à configurer**.

| Type (`TelemetryProvider.kind`) | Canal | Statut V1 | Test automatisé |
| --- | --- | --- | --- |
| `TRACCAR` | API (REST) | Opérationnel | Vrai serveur Traccar 6.15.3 en conteneur, positions réelles envoyées en protocole OsmAnd |
| `WIALON` | API (Remote API) | Opérationnel, **non vérifié contre un serveur Wialon réel** | Serveur HTTP local qui applique les formats de la documentation officielle |
| `RAPPORT_GENERIQUE` | RAPPORT (CSV/XLSX par IMAP ou SFTP) | Opérationnel | Vrais serveurs IMAP (GreenMail 2.1.3) et SFTP (atmoz/sftp) en conteneurs |
| `WEBHOOK_GENERIQUE` | WEBHOOK (lots JSON poussés et signés HMAC-SHA256 par le fournisseur) | Opérationnel ; le fournisseur doit envoyer le format documenté ci-dessous (ou passer par un intermédiaire qui le produit) | Requêtes HTTP réelles signées contre l’API complète, ingestion par la tâche du worker (intégration), écran d’administration dans un navigateur (e2e) |
| `SIMULATEUR` | API (fictive) | Tests et démonstration uniquement, jamais en production (D-303) | Tests T35 à T44 |
| `RPA` | RPA | **Non activable en V1** (voir plus bas) | Aucun : pas d’adaptateur |

Fichiers : `apps/api/src/modules/telemetry/adapters/traccar.adapter.ts`, `wialon.adapter.ts`, `report-generic.adapter.ts`, `webhook.adapter.ts`, outils communs `adapter-support.ts`. Le registre (`telemetry-adapter.registry.ts`) associe chaque type à sa fabrique et valide la configuration avec les analyseurs des adaptateurs (`parseTraccarSettings`, `parseWialonSettings`, `parseReportSettings`) : une configuration incohérente est refusée dès l’enregistrement (422), avec le même message qu’à l’exécution.

### Contrat commun

Chaque adaptateur implémente `TelemetryProvider` (`telemetry-provider.interface.ts`) :

- `listUnits()` : unités du fournisseur, avec identifiant stable, libellé, immatriculation déclarée et natures de mesure constatées dans les données ;
- `getOdometers(unités)` : dernier état des compteurs (canal RAPPORT : tous les relevés des fichiers nouveaux, triés par instant) ;
- `getOdometerHistory(unités, de, à)` : historique, **absent** quand le canal ne le permet pas (D-294) ;
- `getFuel(unités, de, à)` : échantillons carburant de la période ;
- `healthCheck()` : ne lève jamais, renvoie un message expurgé et la latence ;
- `close()` : ferme la session fournisseur ou la connexion IMAP/SFTP.

Normalisation imposée à tous les adaptateurs :

- **Kilomètres** en chaîne décimale à 3 décimales : les mètres sont arrondis au mètre (demi vers le haut) puis convertis ; les miles sont convertis (1 mi = 1,609344 km). Une valeur négative ou hors de la capacité `Decimal(15, 3)` est écartée.
- **Instant** : horodatage UTC du fournisseur. Un échantillon sans horodatage exploitable est écarté et compté ; l’heure de réception ne le remplace jamais.
- **Aucune valeur inventée** : une mesure absente est omise, jamais remplacée par 0.
- **sourceReference** : identifiant du fournisseur quand il existe. Pour un compteur, il est qualifié par la nature (`pos:123:COMPTEUR_CAN`), car une même position Traccar porte les deux natures. Sinon il vaut `null`, et le service d’ingestion applique la clé de repli (D-184, D-195).

Extensions facultatives du contrat, rétrocompatibles :

- `partialUnitList` : vrai pour le canal RAPPORT. La liste des unités n’y contient que les unités présentes dans les fichiers reçus ; une unité absente n’a pas disparu chez le fournisseur.
- `acknowledge()` (canal RAPPORT) : à appeler **après l’ingestion réussie** des échantillons renvoyés pendant le run. L’adaptateur inscrit alors chaque fichier au registre (`TelemetryReportFile`, SHA-256), puis marque les messages lus ou déplace les fichiers chez la source. Sans acquittement (run en échec), les fichiers restent à traiter et sont relus au run suivant ; l’idempotence ligne par ligne évite les doublons.
- `diagnostics()` : valeurs écartées par motif (et, pour le canal RAPPORT, fichiers lus, déjà traités, illisibles, lignes lues), pour renseigner `TelemetrySyncRun.errorCount` et `errorSummary`.
- `AdapterConfig.clock` : horloge du service, utilisée pour l’instant des contrôles de santé.

Sécurité (14.6, D-304, T44) :

- les adaptateurs ne journalisent rien ;
- les messages d’erreur ne contiennent ni secret, ni URL complète, ni corps de réponse du fournisseur ;
- les secrets passent dans un en-tête (Traccar) ou dans le corps POST (Wialon), jamais dans l’URL ;
- les redirections HTTP sont refusées, pour qu’un en-tête d’authentification ne parte jamais vers un autre hôte ;
- HTTPS est exigé, sauf pour un hôte local ou avec `allowPlainHttp: true`, réservé à un serveur interne ;
- les journaux internes des bibliothèques IMAP et SSH sont désactivés.

Les erreurs sont typées (`ProviderError`) pour la reprise et le coupe-circuit (D-297) :

| Situation | Type d’erreur |
| --- | --- |
| HTTP 401 ou 403, identifiants refusés, droits insuffisants | `AUTHENTIFICATION` |
| HTTP 429 (délai `Retry-After` en secondes ou en date HTTP, borné à 24 h) | `QUOTA` |
| Délai dépassé, connexion refusée, DNS, TLS, HTTP 5xx | `INJOIGNABLE` |
| Réponse non conforme, autre statut refusé | `REPONSE_INVALIDE` |
| Paramètre ou secret manquant ou incohérent | `CONFIGURATION` |

Deux paramètres sont communs à Traccar et à Wialon :

- `maxRequestsPerMinute` (facultatif) espace les appels ;
- `historyChunkHours` (24 par défaut, de 1 à 168) découpe les lectures d’historique.

### Traccar (API REST, `TRACCAR`)

**Prérequis côté fournisseur.** Créer un utilisateur Traccar dédié, en lecture seule (`readonly: true`), rattaché uniquement aux appareils du parc (permissions appareil ou groupe). Ne jamais utiliser un compte personnel ou administrateur.

**URL de base** : racine du serveur, par exemple `https://traccar.exemple.tn`. Le suffixe `/api` est accepté.

**Secrets** (écriture seule, jamais restitués) :

- `JETON_API` : jeton d’API de l’utilisateur de lecture, envoyé en `Authorization: Bearer`. Il est obtenu par `POST /api/session/token` (formulaire `expiration`) avec les identifiants de cet utilisateur.
- ou `IDENTIFIANTS_API` : `email:motdepasse`, envoyé en authentification Basic. Si les deux existent, le jeton est prioritaire.

**Paramètres (`settings`)** :

| Clé | Défaut | Rôle |
| --- | --- | --- |
| `registrationSource` | `name` | Immatriculation déclarée : `name`, `uniqueId` ou `attribute:<clé>` (attribut de l’appareil). |
| `timeSource` | `fixTime` | Instant de l’échantillon : `fixTime` ou `deviceTime`. |
| `staleFixToleranceSeconds` | 60 | En mode `fixTime`, écart maximal admis (0 à 86 400 s) entre `fixTime` et un `deviceTime` postérieur ; au-delà, l’échantillon est écarté (voir ci-dessous). |
| `canOdometerAttribute` | `odometer` | Attribut de position en mètres traité comme COMPTEUR_CAN (`null` : nature désactivée). |
| `gpsDistanceAttribute` | `totalDistance` | Attribut de position en mètres traité comme DISTANCE_GPS (`null` : nature désactivée). |
| `fuelAttribute` | aucun | Attribut carburant de la position ; sans lui, aucun carburant n’est collecté. |
| `fuelUnit` | obligatoire avec `fuelAttribute` | `L` ou `%`. |
| `fuelKind` | obligatoire avec `fuelAttribute` | `NIVEAU_CAN`, `NIVEAU_SONDE` ou `CONSOMMATION_CAN`. |
| `ignitionAttribute` | `ignition` | Attribut booléen de l’état moteur. |
| `historyChunkHours`, `maxRequestsPerMinute`, `allowPlainHttp` | 24, aucun, faux | Voir plus haut. |

Exemple :

```json
{
  "registrationSource": "attribute:immatriculation",
  "fuelAttribute": "fuel",
  "fuelUnit": "L",
  "fuelKind": "NIVEAU_SONDE"
}
```

Si le boîtier remonte dans `odometer` un compteur calculé par GPS (et non le compteur du tableau de bord), il faut le déclarer ainsi : `{"canOdometerAttribute": null, "gpsDistanceAttribute": "odometer"}`.

**Appels, tous en lecture seule** :

| Méthode | Appel Traccar |
| --- | --- |
| `listUnits` | `GET /api/devices`, puis `GET /api/positions` (dernières positions) pour constater les natures |
| `getOdometers` | `GET /api/positions` (dernière position de chaque appareil) |
| `getOdometerHistory` et `getFuel` | `GET /api/positions?deviceId&from&to` par appareil et par tranche |
| `healthCheck` | `GET /api/server` (version ; route publique), puis `GET /api/devices?limit=1` pour vérifier l’authentification |

**Position reçue sans fix GPS.** Quand un boîtier émet sans fix GPS (parking couvert, tunnel), Traccar recopie sur la position le dernier fix connu, `fixTime` compris, alors que ses attributs (`odometer`, carburant, contact) sont ceux de `deviceTime`. Ce comportement a été constaté sur le serveur 6.15.3 du test. En mode `fixTime`, dater ces mesures de `fixTime` les antidaterait. Une position dont `fixTime` précède `deviceTime` de plus de `staleFixToleranceSeconds` est donc écartée et comptée, avec le motif « position sans fix GPS récent ». Si les boîtiers du parc émettent souvent sans fix et que leur horloge est fiable, choisir `timeSource: "deviceTime"`.

La vitesse (nœuds) est convertie en km/h ; elle vaut `null` quand la position n’est pas valide (`valid: false`). Traccar renvoie un HTTP 400 accompagné d’une trace Java pour un appareil hors droits ou un jeton mal formé : ce cas est qualifié `AUTHENTIFICATION`, sans que le corps soit recopié. Aucune écriture n’est faite chez le fournisseur ; `PUT /devices/{id}/accumulators`, par exemple, n’est jamais appelé.

**Testé** (`apps/api/test/integration/telemetry-adapters.int.spec.ts`) contre l’image `mirror.gcr.io/traccar/traccar:6.15` (Traccar 6.15.3), démarrée par le test puis arrêtée. Le test crée par l’API REST :

- l’administrateur ;
- trois appareils fictifs ;
- un utilisateur de lecture rattaché à deux d’entre eux, et son jeton.

Il envoie ensuite des positions réelles par le protocole OsmAnd (HTTP, port 5055). Le décodeur OsmAnd de Traccar enregistre tout paramètre inconnu comme attribut numérique de la position (`OsmAndProtocolDecoder`, branche `default`) : `odometer` en mètres, `fuel`, `ignition`, et `speed` en nœuds. Le test vérifie :

- les unités et les immatriculations déclarées ;
- les échantillons normalisés : km au mètre près, instant `fixTime`, `sourceReference` égal à l’identifiant de position, natures ;
- `totalDistance`, comparé à la valeur brute de l’API ;
- l’historique ;
- le carburant en litres, l’état moteur et la vitesse en km/h ;
- une position envoyée sans latitude ni longitude : le serveur recopie le `fixTime` précédent, l’échantillon est écarté en mode `fixTime` et daté de `deviceTime` en mode `deviceTime` ;
- l’authentification Bearer, puis Basic ;
- le contrôle de santé ;
- les erreurs : mot de passe refusé, jeton falsifié, appareil hors droits, serveur injoignable. Aucun secret n’apparaît dans les messages.

Les tests unitaires (`traccar.adapter.spec.ts`) rejouent des réponses enregistrées de ce même serveur.

**Limites** :

- `GET /api/positions` sans paramètre renvoie les dernières positions de tous les appareils du compte : le volume est proportionnel au parc.
- L’historique renvoie toutes les positions de la période : le volume dépend de la fréquence d’émission du boîtier.
- La signification de `odometer` dépend du protocole et du boîtier : elle est à qualifier par véhicule (annexe A).
- Aucun webhook : Traccar est interrogé.
- Traccar ne renvoie pas nativement de 429 ; ce cas est couvert par le client HTTP commun et testé avec le serveur Wialon local.

### Wialon Remote API (`WIALON`)

**Prérequis côté fournisseur.** Créer un utilisateur Wialon dédié, avec des droits de consultation sur les unités (propriétés, messages, capteurs), sans droit de modification. Générer pour lui un jeton d’accès.

**URL de base** : hôte de l’API, par exemple `https://hst-api.wialon.com` (Wialon Hosting) ou l’hôte d’une installation locale. L’adaptateur appelle `<URL>/wialon/ajax.html`.

**Secret** : `JETON_API`, le jeton Wialon. Il est envoyé dans le corps de `token/login`, jamais dans l’URL.

**Paramètres (`settings`)** :

| Clé | Défaut | Rôle |
| --- | --- | --- |
| `odometerKind` | **obligatoire** | `COMPTEUR_CAN` ou `DISTANCE_GPS`. Wialon calcule le compteur par GPS ou le lit sur un capteur selon son paramétrage : la nature doit venir de l’annexe A. |
| `registrationSource` | `name` | `name`, `uid` (identifiant du boîtier), `profile:<champ>` (par exemple `profile:registration_plate`) ou `custom:<nom du champ personnalisé>`. |
| `fuelSensors` | `[]` (pas de carburant) | Liste de `{ "type": "fuel level", "name": "…", "kind": "NIVEAU_SONDE" }` : type (`t`) et/ou nom (`n`) du capteur, et nature. |
| `engineSensor` | `{ "type": "engine operation" }` | Capteur de l’état moteur ; `null` pour ne pas le lire. |
| `mileageSensor` | aucun | Capteur de kilométrage, par exemple `{ "type": "mileage" }`. Il active `getOdometerHistory`. Ne le renseigner que si le compteur de l’unité est lui-même basé sur ce capteur. |
| `historyChunkHours`, `maxRequestsPerMinute`, `allowPlainHttp` | 24, aucun, faux | Voir plus haut. |

Exemple :

```json
{
  "odometerKind": "COMPTEUR_CAN",
  "registrationSource": "profile:registration_plate",
  "fuelSensors": [{ "type": "fuel level", "kind": "NIVEAU_SONDE" }],
  "mileageSensor": { "type": "mileage" }
}
```

**Appels.** Toutes les requêtes sont des `POST /wialon/ajax.html` avec un corps `application/x-www-form-urlencoded` (`svc`, `params` JSON, `sid`).

| Étape | Appel Wialon |
| --- | --- |
| Session | `token/login` (le champ `eid` de la réponse devient le `sid`). En cas d’erreur 1 (session invalide), une seule reconnexion puis nouvel essai. `core/logout` à la fermeture. |
| `listUnits` | `core/search_items` sur `avl_unit`, drapeaux 1 (base), 8 (champs personnalisés), 256 (uid), 1024 (dernier message et position), 4096 (capteurs), 8192 (compteurs) et 8388608 (profil) |
| `getOdometers` | `unit/calc_last` (`mileage.value`, en km ou en miles selon le format ou le système de mesure `mu`) |
| `getFuel` et `getOdometerHistory` | `messages/load_interval` (messages de données : `flags` 0, `flagsMask` 65280), puis `unit/calc_sensors` sur le chargeur (valeurs calculées message par message), puis `messages/unload` |

Deux précisions sur `getOdometers` :

- La réponse de `unit/calc_last` ne porte pas d’instant. L’instant retenu est celui du dernier message (`lmsg.t`), lu par `core/search_items` avant et après l’appel. Si un message est arrivé entre les deux lectures, l’échantillon est écarté et repris au run suivant : il n’est jamais daté faussement.
- `sourceReference` vaut `msg:<t>:<nature>` pour un compteur et `msg:<t>` pour le carburant : Wialon identifie un message par l’unité et son instant, et l’idempotence porte sur (fournisseur, unité, référence).

La valeur « inconnue » de Wialon (`-348201.3876`) est traitée comme une mesure absente.

Correspondance des codes d’erreur :

| Code Wialon | Type d’erreur |
| --- | --- |
| 1, 7, 8 | `AUTHENTIFICATION` |
| 4 et autres codes | `REPONSE_INVALIDE` |
| 5, 6 | `INJOIGNABLE` |
| 1003 | `QUOTA` |

**Testé, sans serveur Wialon réel.** `telemetry-adapters.int.spec.ts` démarre un serveur HTTP local (`node:http`) qui applique strictement les formats des pages suivantes de la documentation officielle (help.wialon.com/en/api) :

- `user-guide/api-reference/reqformat` : POST, `x-www-form-urlencoded`, `svc`, `params`, `sid` ;
- `user-guide/code-examples/login-and-logout` : réponse `{host, eid, tm}` de `token/login`, `{"error":0}` de `core/logout` ;
- `user-guide/error-codes` ;
- `user-guide/api-reference/core/search_items` ;
- `user-guide/data-format/units` : blocs par drapeau ;
- `user-guide/api-reference/unit/calc_last` ;
- `user-guide/api-reference/messages/load_interval` : `{count, messages}`, et erreur 1003 sans `Accept-Encoding: gzip` ;
- `user-guide/data-format/messages` et `messages/get_messages` : structure d’un message ;
- `user-guide/api-reference/unit/calc_sensors`.

L’adaptateur réel l’interroge en HTTP. Le test vérifie :

- la session par jeton ;
- les unités et l’immatriculation lue dans un champ de profil ;
- le kilométrage daté du dernier message ;
- la conversion des miles ;
- le carburant, l’état moteur et la vitesse, message par message ;
- l’historique du capteur de kilométrage ;
- la reconnexion unique sur l’erreur 1 ;
- l’échantillon écarté quand un message arrive pendant la lecture ;
- les erreurs : code 7 → `AUTHENTIFICATION`, HTTP 429 avec `Retry-After` → `QUOTA`, délai dépassé → `INJOIGNABLE` ;
- l’appel de `core/logout`.

**Ce test ne prouve pas la compatibilité avec un serveur Wialon réel**, dont l’accès dépend du fournisseur : c’est une dépendance externe à valider lors de la qualification.

**Limites** :

- `odometerKind` vaut pour toutes les unités du fournisseur. Un compte Wialon dont une partie des unités lit le compteur CAN et l’autre le calcule par GPS ne peut pas être décrit par un seul fournisseur : l’annexe A doit le signaler, et les associations ne portent alors que sur la nature déclarée.
- Les noms de types de capteurs (`fuel level`, `engine operation`, `mileage`) sont ceux de la documentation. Ils sont paramétrables et à confirmer sur le compte du fournisseur.
- Un seul capteur carburant par nature et par unité : s’il y en a plusieurs, la nature est ignorée et comptée. Il faut alors préciser `name`.
- La vitesse des messages n’est reprise que pour les unités en système métrique (`mu` 0 ou 3).
- `messages/load_interval` ne s’exécute pas en parallèle d’autres requêtes de rapport : l’adaptateur traite les unités une par une.

### Rapport générique CSV/XLSX (`RAPPORT_GENERIQUE`, canal RAPPORT)

**Prérequis côté fournisseur.** Des rapports planifiés (horaires ou quotidiens) envoyés en pièce jointe vers une boîte e-mail dédiée, ou déposés dans un répertoire SFTP dédié. Le compte ne sert qu’à ce flux. Le déplacement des fichiers traités exige le droit d’écriture sur le répertoire (ou le dossier IMAP) ; à défaut, voir `afterProcessing`.

**URL de base** : sans objet. La source se décrit dans les paramètres.

**Secrets** :

- `IMAP` : `identifiant:motdepasse` ;
- ou `SFTP` : `identifiant:motdepasse`, ou `identifiant:` suivi d’une clé privée PEM (`-----BEGIN OPENSSH PRIVATE KEY-----…`).

**Paramètres de la source** :

| Clé | Défaut | Rôle |
| --- | --- | --- |
| `source` | obligatoire | `IMAP` ou `SFTP`. |
| `imap.host`, `imap.port` | port 993 (TLS implicite) ou 143 | Serveur IMAP. |
| `imap.tls` | `implicite` | `implicite`, `starttls` (STARTTLS exigé) ou `aucun`. `aucun` n’est admis que pour un hôte local ou avec `imap.allowUnencrypted: true`. |
| `imap.mailbox` | `INBOX` | Dossier lu : messages **non lus** uniquement, ouverts en lecture seule (EXAMINE), donc jamais marqués lus avant l’acquittement. |
| `imap.afterProcessing` | `marquer_lu` | `marquer_lu`, ou `deplacer` vers `imap.processedMailbox` (créé s’il manque). |
| `imap.maxMessages`, `imap.maxMessageMegabytes` | 50, 25 | Bornes par run. |
| `sftp.host`, `sftp.port` | port 22 | Serveur SFTP. |
| `sftp.hostKeySha256` | **obligatoire** | Empreinte de la clé d’hôte au format OpenSSH (`SHA256:…`, donnée par `ssh-keyscan -p <port> <hôte> \| ssh-keygen -lf -`). Une clé différente est refusée (`CONFIGURATION`). |
| `sftp.directory` | obligatoire | Répertoire lu (fichiers `.csv` et `.xlsx`, du plus ancien au plus récent). |
| `sftp.afterProcessing` | `deplacer` | `deplacer` vers `sftp.processedDirectory` (par défaut `<répertoire>/traites`, créé s’il manque ; suffixe `-1`, `-2`… si le nom existe déjà), ou `laisser` : les fichiers restent en place et sont écartés par leur empreinte, au prix d’un téléchargement à chaque run. |
| `sftp.maxFiles` | 100 | Borne par run. |

**Paramètres du fichier** :

| Clé | Défaut | Rôle |
| --- | --- | --- |
| `columns.unit`, `columns.timestamp` | obligatoires | En-têtes de l’identifiant d’unité et de l’horodatage (comparaison sans casse ni espaces de bord). |
| `columns.odometer`, `columns.fuelLiters`, `columns.fuelPercent` | au moins une | Colonnes de mesure. |
| `columns.label`, `columns.registration`, `columns.engine`, `columns.speed`, `columns.reference` | facultatives | Libellé, immatriculation déclarée, état moteur, vitesse (km/h), identifiant de ligne du fournisseur (devient `sourceReference`). **`columns.reference` doit être un identifiant stable et unique par unité d’un fichier à l’autre** (numéro d’enregistrement du fournisseur). Un numéro de ligne qui repart de 1 dans chaque fichier ferait écarter comme doublons les lignes des fichiers suivants ; dans ce cas, laisser la colonne vide : la clé de repli (unité, nature, instant, valeur) s’applique. |
| `timestampFormat` | obligatoire | `ISO`, `EPOCH_S`, `EPOCH_MS` ou un format Luxon comportant l’heure (par exemple `dd/MM/yyyy HH:mm:ss`). Une cellule date-heure XLSX est lue directement. |
| `timezone` | fuseau de l’organisation | Fuseau d’un horodatage sans décalage, et des cellules XLSX. |
| `decimalSeparator` | `.` | `.` ou `,`. Une cellule numérique XLSX est toujours lue avec le point. Les séparateurs de milliers sont refusés. |
| `odometerUnit`, `odometerKind` | obligatoires avec `columns.odometer` | `km` ou `m` ; `COMPTEUR_CAN` ou `DISTANCE_GPS`. |
| `fuelKind` | obligatoire avec une colonne carburant | `NIVEAU_CAN`, `NIVEAU_SONDE` ou `CONSOMMATION_CAN`. |
| `engineOnValues`, `engineOffValues` | `1, oui, on, true, vrai, marche, allumé` et `0, non, off, false, faux, arrêt, arret, éteint` | Valeurs reconnues pour l’état moteur, sans casse. |
| `maxRowsPerFile`, `maxFileMegabytes` | 200 000, 20 | Bornes. |

Exemple (SFTP, CSV en heure locale) :

```json
{
  "source": "SFTP",
  "sftp": { "host": "sftp.fournisseur.tn", "directory": "/rapports", "hostKeySha256": "SHA256:…" },
  "columns": { "unit": "Unité", "registration": "Immatriculation", "timestamp": "Date", "odometer": "Compteur (km)", "fuelLiters": "Carburant (L)", "engine": "Moteur", "reference": "N°" },
  "timestampFormat": "dd/MM/yyyy HH:mm:ss",
  "decimalSeparator": ",",
  "odometerUnit": "km",
  "odometerKind": "COMPTEUR_CAN",
  "fuelKind": "NIVEAU_SONDE"
}
```

```text
N°;Unité;Immatriculation;Date;Compteur (km);Carburant (L);Moteur
5001;U-17;123 TU 4567;24/09/2026 08:15:00;80450,125;62,5;off
```

**Déroulement d’un run** :

1. La source est lue une seule fois par run.
2. Chaque fichier est identifié par son SHA-256. Un fichier déjà inscrit au registre, ou reçu deux fois dans le même lot, n’est pas relu.
3. Les fichiers nouveaux sont analysés par le lecteur unique CSV/XLSX des imports (`imports/parsers/tabular.ts` : UTF-8, séparateur détecté, feuille « Données » ou première feuille). Une ligne sans unité ou sans horodatage valide est écartée ; une valeur de mesure invalide est écartée seule. Chaque rejet est compté dans `diagnostics()`, et aucune valeur n’est inventée.
4. Un rapport sans ligne de données est valide.
5. Un fichier illisible (encodage, colonne absente, format, taille) n’est ni inscrit ni acquitté : il réapparaît dans les diagnostics à chaque run jusqu’à correction.
6. Après l’ingestion réussie, `acknowledge()` inscrit les fichiers au registre puis marque les messages lus ou déplace les fichiers. Un message IMAP n’est acquitté que si toutes ses pièces jointes CSV ou XLSX ont été lues, ou étaient déjà connues. Un message sans pièce jointe exploitable est acquitté et compté.

**Testé** (`telemetry-adapters.int.spec.ts`) :

- **IMAP.** Le conteneur `mirror.gcr.io/greenmail/standalone:2.1.3` (SMTP et IMAP en clair) est démarré avec un utilisateur fictif. Le test dépose par SMTP (nodemailer) un rapport CSV, son doublon et un message sans pièce jointe. Il vérifie :
  - les unités, les relevés et le carburant ;
  - les rejets comptés ;
  - que les messages restent non lus avant l’acquittement ;
  - l’inscription au registre (SHA-256 et nombre de lignes) et le déplacement vers `Traites` ;
  - qu’un renvoi du même fichier est ignoré par son empreinte ;
  - qu’un run sans acquittement laisse le fichier à relire ;
  - qu’un mot de passe refusé donne `AUTHENTIFICATION`, sans secret dans le message.
- **SFTP.** Le conteneur `mirror.gcr.io/atmoz/sftp:alpine` est démarré avec un utilisateur fictif. Le test y dépose un classeur XLSX (cellules date-heure, distance en mètres, carburant en %). Il vérifie :
  - l’heure murale convertie en UTC, la conversion en km et le rejet d’une valeur illisible ;
  - le déplacement dans `traites` et l’inscription au registre réel en base (`createReportLedger`, table `TelemetryReportFile` de la base de test : empreinte, nom, lignes, instant) ;
  - qu’un run suivant ne trouve plus rien à lire ;
  - qu’une clé d’hôte différente donne `CONFIGURATION` et qu’un mot de passe refusé donne `AUTHENTIFICATION` ;
  - le contrôle de santé.

Les deux conteneurs sont arrêtés à la fin.

**Limites** :

- Pas d’historique rejouable : `getOdometerHistory` est absent. Les lignes d’unités non encore mappées sont abandonnées à l’acquittement : il n’y a aucun relevé avant confirmation (14.5, D-302).
- `getFuel` applique la fenêtre demandée. Les lignes hors fenêtre ne sont pas renvoyées et le fichier est acquitté.
- Une heure locale ambiguë (retour à l’heure d’hiver) est lue avec le premier décalage ; une heure inexistante (passage à l’heure d’été) est refusée.
- Une cellule XLSX de date sans heure est refusée : une date seule ne date pas une mesure.
- Le schéma ne compte pas les lignes écartées par fichier : `TelemetryReportFile.rowCount` contient les lignes lues, et les rejets passent par `diagnostics()` vers `TelemetrySyncRun`.
- Les messages ou fichiers illisibles restent dans la source et sont lus en premier (du plus ancien au plus récent). Si leur nombre atteint `imap.maxMessages` ou `sftp.maxFiles`, les rapports plus récents ne sont plus lus : il faut les déplacer ou les corriger (les diagnostics du run les comptent à chaque exécution).
- La découverte des unités (`listUnits`, au plus une fois par heure) ne voit que les fichiers encore présents dans la source : un fichier acquitté entre deux découvertes par la synchronisation n’y figure plus. Une unité qui n’apparaît que dans de tels fichiers n’est découverte qu’à son prochain passage dans un fichier présent lors d’une découverte.

### Webhook générique (`WEBHOOK_GENERIQUE`, canal WEBHOOK)

Le fournisseur **pousse** ses mesures (CDC 14.4 « webhook utilisé s’il existe » ; D-298 ; R-14.4-02, R-14.4-X01). Aucun appel sortant n’est fait vers lui. Chaîne complète :

1. **Réception** (`POST /api/v1/telemetry/webhooks/:providerId`, `apps/api/src/modules/telemetry/webhook/`) : route publique, distincte des routes utilisateur, **sans session ni cookie** (le cookie de session éventuel est ignoré ; le garde CSRF ne s’applique pas à cette seule route, marquée `@SignedWebhook()`, puisqu’aucune authentification par cookie n’y existe). L’émetteur est authentifié par la signature ; la réception contrôle, dépose le lot dans la file `TelemetryWebhookDelivery` et répond **202**. Aucun relevé n’est créé à la réception.
2. **Ingestion** par le worker, tâche `telematique-webhooks` (toutes les 10 s, bail unique) → `TelemetrySyncService.runWebhooks` : lots réservés par `FOR UPDATE SKIP LOCKED` et verrou temporel (10 min, repris après l’arrêt d’un worker), puis **la même exécution que la synchronisation** : un run `WEBHOOK` par société couverte et activée, sous le bail du couple fournisseur-société, mêmes contrôles (association confirmée couvrant l’instant, véhicule actif, société activée, normalisation, idempotence par échantillon, historisation, carburant, alertes, source muette). Un lot rejoué ne crée donc aucun doublon. Les unités nouvelles d’un lot sont enregistrées et proposées à l’association (liste partielle, comme le canal RAPPORT) ; aucun relevé avant confirmation.

**URL et signature** (fiche du fournisseur, section « Réception webhook ») :

- URL : `<APP_ORIGIN>/api/v1/telemetry/webhooks/<identifiant du fournisseur>`, méthode `POST`, `Content-Type: application/json`, corps non compressé ; le relais web `/api/v1` transmet les octets tels quels.
- `X-Webhook-Timestamp` : secondes Unix (UTC) de l’envoi ; hors de ± `toleranceSeconds` (300 s par défaut) de l’horloge du serveur, le lot est refusé (401 `SIGNATURE_EXPIREE`).
- `X-Webhook-Signature: sha256=<hex>` avec `hex = HMAC-SHA256(secret, "<X-Webhook-Timestamp>.<corps brut>")`. Plusieurs valeurs séparées par des virgules sont admises (rotation côté fournisseur). Comparaison en temps constant.
- Exemple (shell) :

  ```bash
  corps='{"version":1,"odometers":[{"unitExternalId":"U-1","kind":"COMPTEUR_CAN","valueKm":"50120.5","observedAt":"2026-09-24T09:00:00Z"}]}'
  ts=$(date +%s)
  sig=$(printf '%s.%s' "$ts" "$corps" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
  curl -sS -X POST "$URL" -H 'Content-Type: application/json' -H "X-Webhook-Timestamp: $ts" -H "X-Webhook-Signature: sha256=$sig" --data-binary "$corps"
  ```

**Format du lot** (version 1, même forme normalisée que le contrat des adaptateurs ; `telemetry-webhook-format.ts`) :

```json
{
  "version": 1,
  "units": [{ "externalId": "U-1", "label": "Camion 12", "registration": "123 TU 4567", "odometerKinds": ["COMPTEUR_CAN"], "fuelKinds": ["NIVEAU_SONDE"] }],
  "odometers": [{ "unitExternalId": "U-1", "kind": "COMPTEUR_CAN", "valueKm": "50120.500", "observedAt": "2026-09-24T09:00:00Z", "sourceReference": "pos-9" }],
  "fuel": [{ "unitExternalId": "U-1", "kind": "NIVEAU_SONDE", "liters": "42.25", "percent": null, "engineOn": false, "speedKmh": "0", "observedAt": "2026-09-24T08:05:00+01:00", "sourceReference": null }]
}
```

- `units`, `odometers`, `fuel` sont facultatifs (un lot vide sert de signal de vie) ; 1 000 unités et 5 000 échantillons par liste au plus.
- Kilomètres, litres, pourcentages (≤ 100) et vitesses : décimaux positifs à 3 décimales au plus, en chaîne (recommandé) ou en nombre ; natures `COMPTEUR_CAN`, `DISTANCE_GPS` ; `NIVEAU_CAN`, `NIVEAU_SONDE`, `CONSOMMATION_CAN` ; litres ou pourcentage obligatoire pour le carburant.
- `observedAt` : instant ISO 8601 **avec décalage explicite** (`Z` ou `±hh:mm`), horodatage du fournisseur, stocké en UTC ; jamais remplacé par l’heure de réception.
- `sourceReference` : identifiant stable de l’échantillon chez le fournisseur ; à défaut, clé de repli `fp:` (D-184).
- Tout champ non prévu (positions, conducteur…) est ignoré et **n’est pas conservé** : la file ne stocke que le lot normalisé.

**Réponses** (corps `{ code, message, fieldErrors?, details?, requestId }`, jamais de secret ni de signature attendue) :

| Statut | Code | Cas |
| --- | --- | --- |
| 202 | — | Lot déposé : `{ deliveryId, status: "EN_ATTENTE", receivedAt, units, odometers, fuel }` |
| 400 | `CORPS_ABSENT`, `JSON_INVALIDE` | Corps vide ou JSON illisible |
| 401 | `SIGNATURE_ABSENTE`, `HORODATAGE_INVALIDE`, `SIGNATURE_EXPIREE`, `SIGNATURE_INVALIDE` | En-têtes absents, horodatage illisible ou hors tolérance, signature fausse ; fournisseur inconnu ou d’un autre canal : même réponse qu’une signature fausse (existence non révélée) |
| 409 | `WEBHOOK_REJOUE` | Même requête signée reçue deux fois (même horodatage, même corps : index unique `telemetry_webhook_no_replay`) ; le lot initial est conservé |
| 413 | `CONTENU_TROP_VOLUMINEUX` | Corps de plus de 1 Mio (`Content-Length` annoncé ou octets reçus, lecture interrompue) |
| 415 | `TYPE_NON_SUPPORTE`, `ENCODAGE_NON_SUPPORTE` | Autre type que JSON, corps compressé |
| 422 | `FOURNISSEUR_INACTIF`, `TELEMETRIE_DESACTIVEE`, `LOT_INVALIDE` | Émetteur authentifié mais fournisseur non actif, module activé pour aucune société couverte, ou lot non conforme (erreurs par champ) : rien n’est déposé |
| 429 | `LIMITE_DEBIT`, `FILE_WEBHOOK_PLEINE` | Plus de `maxRequestsPerMinute` lots acceptés sur 60 s glissantes pour ce fournisseur (compté en base sous verrou de la ligne du fournisseur, donc valable avec plusieurs instances de l’API), ou 500 lots déjà en attente ; en-tête `Retry-After` |

Un même lot renvoyé avec un **nouvel** horodatage (nouvelle signature) est accepté et ingéré sans doublon : c’est ainsi qu’un fournisseur réessaie. La limite par adresse IP (`RATE_LIMIT_ENABLED`) est portée sur cette route à 600 requêtes par minute, plafond de `maxRequestsPerMinute` (au lieu de 300 pour le reste de l’API) : un débit autorisé par l’administrateur n’est jamais coupé plus tôt, et les requêtes non authentifiées restent bornées (429 `LIMITE_DEBIT`, `Retry-After`).

**Paramètres non secrets** (`settings`, tous facultatifs ; aucune URL de base) : `maxRequestsPerMinute` (1 à 600, 60 par défaut), `toleranceSeconds` (60 à 900, 300), `rotationOverlapHours` (0 à 168, 24).

**Secret de signature** (`SIGNATURE_WEBHOOK`) : propre au fournisseur, 32 à 256 caractères imprimables sans espace, chiffré au repos par le mécanisme commun (AES-256-GCM, clé hors base, rechiffré par `telemetry:rotate-secrets`), jamais renvoyé ni journalisé, jamais transmis à un adaptateur. L’écran le **génère dans le navigateur** (Web Crypto, 32 octets, `whsec_` + base64url), l’affiche une seule fois pour qu’il soit transmis au fournisseur, puis le dépose en écriture seule (`PUT …/credentials/SIGNATURE_WEBHOOK`) ; un secret fourni par le fournisseur se dépose de la même façon (« Remplacer »). Un nouveau dépôt est une **rotation** : l’ancien secret reste accepté pendant `rotationOverlapHours` (colonne `TelemetryCredential.expiresAt`, contrainte : jamais sur un secret actif), puis il est refusé et supprimé par le worker ; « Révoquer » supprime immédiatement tous les secrets de signature. L’activation exige ce secret.

**File et suivi** : états `EN_ATTENTE` → `EN_COURS` → `TRAITE`, `IGNORE` (fournisseur devenu non actif, ou module désactivé pour toutes les sociétés couvertes entre la réception et le traitement : jamais ingéré) ou `ECHEC` (5 tentatives, délai 30 s × 2^n plafonné à 30 min ; ré-ingestion idempotente ; un lot dont le traitement est interrompu — worker arrêté, erreur imprévue — est repris à l’échéance de son verrou de 10 min, puis passe en `ECHEC` s’il a déjà consommé ses 5 tentatives). Contraintes en base : empreinte SHA-256 hexadécimale, compteurs positifs, cohérence état / verrou / date de fin. Les lots terminés sont supprimés 7 jours après leur traitement. `GET /api/v1/telemetry/providers/:id/webhook` (administrateur) renvoie l’URL, les règles, l’état du secret (jamais sa valeur), les compteurs sur 24 h et les 20 derniers lots ; les runs `WEBHOOK` figurent dans les exécutions. Pas de synchronisation manuelle pour ce canal (422 `SYNCHRO_PAR_WEBHOOK`) ; le passage planifié `runDue` ne l’interroge pas. Le test de connexion vérifie la présence du secret et résume la file ; « Découvrir les unités » relit les unités des lots des 7 derniers jours.

**Journaux** : un lot refusé est journalisé avec le seul motif et l’identifiant du fournisseur, jamais les en-têtes, le corps ni un secret ; les secrets déchiffrés pour la vérification sont suivis par le masquage du journal le temps de l’appel.

### RPA (portail web du fournisseur) — non activable en V1

**Contrat prévu.** Un automate (Playwright) implémenterait le même `TelemetryProvider`, dans une application distincte `apps/telemetry-rpa` exécutée dans un conteneur isolé. Cet automate :

- ouvre une session sur le portail avec un compte dédié en lecture seule ;
- appelle ensuite les requêtes JSON internes du portail, identifiées lors d’une phase de découverte, pour tout le parc en un appel, sans parcourir les écrans véhicule par véhicule ;
- normalise les réponses comme les autres adaptateurs (km, instant du fournisseur, natures) ;
- échoue proprement, avec une erreur `REPONSE_INVALIDE` et une alerte, dès que le portail change.

**Conditions cumulatives d’activation** (14.3, 14.6, annexe A) :

1. un accord écrit du fournisseur autorisant la lecture automatisée du portail ;
2. un compte dédié en lecture seule, distinct des comptes personnels ;
3. aucun contournement de captcha ni de double authentification : si le portail en impose, le canal est impossible ;
4. un conteneur isolé, sans accès aux autres secrets ni à la base métier, qui ne remet que des échantillons normalisés ;
5. le recours au RPA seulement si ni API ni rapport planifié n’existent, ou en complément d’un rapport quand la fraîcheur horaire est indispensable et autorisée.

**Pourquoi il n’est pas activable en V1** (D-292) :

- la qualification du fournisseur (annexe A) n’a pas eu lieu : aucun portail n’est identifié, aucun accord écrit n’existe, et les requêtes internes à appeler sont inconnues ;
- livrer un automate générique reviendrait à livrer un connecteur incomplet présenté comme opérationnel.

Le type `RPA` existe dans le modèle de données, mais le registre le refuse (422 `CANAL_RPA_INDISPONIBLE`) et aucun secret RPA n’est accepté.

### Exécuter les tests

Depuis `apps/api` :

```bash
npx vitest run src/modules/telemetry/adapters/traccar.adapter.spec.ts src/modules/telemetry/adapters/wialon.adapter.spec.ts src/modules/telemetry/adapters/report-generic.adapter.spec.ts
TEST_DATABASE_URL=postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test_f2 \
  npx vitest run -c vitest.config.integration.ts test/integration/telemetry-adapters.int.spec.ts
```

Le test d’intégration exige Docker et les images `mirror.gcr.io/traccar/traccar:6.15`, `mirror.gcr.io/greenmail/standalone:2.1.3` et `mirror.gcr.io/atmoz/sftp:alpine`. Les conteneurs portent un suffixe propre à l’exécution et publient leurs ports sur `127.0.0.1` avec un port hôte choisi par Docker : deux exécutions simultanées ne se gênent pas. Le test SFTP écrit dans la base de test (`TEST_DATABASE_URL`) une organisation et un fournisseur fictifs pour le registre des fichiers. Si Docker ou une image manque, le test échoue ; il n’est jamais sauté.

## Configuration, secrets et associations (cœur du connecteur)

Module `apps/api/src/modules/telemetry` : registre des adaptateurs, configuration des fournisseurs, secrets, activation par société, unités et associations (14.3 à 14.6 ; D-101, D-112, D-249, D-292, D-295, D-300 à D-304). L’application fonctionne entièrement sans lui : aucun appel externe tant qu’aucune société n’a activé le module.

### Droits (D-112)

| Action | Administrateur | Chef de parc | Opérateur, lecteur | Conducteur |
| --- | --- | --- | --- | --- |
| Créer, modifier, activer, suspendre, désactiver un fournisseur ; déposer un secret ; test de connexion | oui | non (403) | non (403) | non (403) |
| Activer / désactiver le module pour une société | oui | non (403) | non (403) | non (403) |
| Lire l’état des fournisseurs (sans paramètres, URL ni état des secrets) | tout | fournisseurs couvrant ses sociétés | idem | non (403) |
| Découvrir les unités d’un fournisseur actif | oui (aussi en brouillon) | sociétés couvertes qu’il gère | non | non |
| Confirmer, rejeter, créer, clôturer une association | oui | véhicules de ses sociétés | non (403) | non |
| Ignorer une unité, ne plus l’ignorer (D-249) | oui | unités d’un fournisseur couvrant une société qu’il gère (404 hors périmètre) | non (403) | non (403) |
| Lire unités, associations, exécutions | tout | ses sociétés (404 hors périmètre) | ses sociétés | non |

### Routes (`/api/v1/telemetry`)

- `GET provider-kinds` : types et disponibilité de l’adaptateur (`RPA` : indisponible, `SIMULATEUR` : selon l’instance).
- `GET|POST providers`, `GET|PATCH|DELETE providers/:id` (suppression : brouillon jamais synchronisé seulement), `POST providers/:id/activate|suspend|deactivate` (`expectedVersion`, motif obligatoire pour suspendre ou désactiver). Le canal est déduit du type ; `syncIntervalMinutes` ≥ 5 ; `backfillDays` de 0 à 90. Un brouillon peut être enregistré sans paramètres ; l’activation exige des paramètres valides (analyseurs des adaptateurs), l’URL de base pour une API, une société couverte et le secret requis.
- `PUT providers/:id/credentials/:kind` `{ secret }` et `DELETE providers/:id/credentials/:kind` : la réponse, comme toute lecture, ne contient que `{ kind, configured, rotatedAt }` (plus `previousValidUntil` pour `SIGNATURE_WEBHOOK`). Formats : `JETON_API` brut ; `IDENTIFIANTS_API`, `IMAP`, `SFTP` en « identifiant:motdepasse » (SFTP : aussi « identifiant:clé privée PEM ») ; `SIGNATURE_WEBHOOK` : 32 à 256 caractères imprimables sans espace, dépôt = rotation avec recouvrement.
- `POST webhooks/:providerId` (public, signé HMAC, sans session ni CSRF) et `GET providers/:id/webhook` (administrateur) : voir « Webhook générique ».
- `POST providers/:id/health` : appel réel de `healthCheck`, message expurgé. `POST providers/:id/discover` : `listUnits` réel, propositions ; 502 `FOURNISSEUR_EN_ECHEC` si le fournisseur échoue (motif expurgé, exécution tracée).
- `GET companies`, `POST companies/:companyId/enable|disable` `{ reason, expectedVersion? }`.
- `GET units?category=NON_ASSOCIEES|PROPOSEES|ASSOCIEES|VEHICULES_SANS_UNITE|IGNOREES` (avec les cinq compteurs, dont `ignorees`), `GET mappings`, `GET mappings/:id`, `POST mappings` (association manuelle confirmée), `POST mappings/:id/confirm|reject|close`, `GET sync-runs`.
- `POST units/:id/ignore` `{ reason }` (motif obligatoire, 3 caractères au moins) et `POST units/:id/unignore` `{ reason? }` : réponse = la vue de l’unité (`ignoredAt`, `ignoredById`, `ignoredReason`). 409 `UNITE_ASSOCIEE` si l’unité a une association confirmée en cours ; 422 `TRANSITION_INVALIDE` si elle est déjà ignorée (ou ne l’est pas pour la reprise).

### Secrets : chiffrement, masquage et rotation (D-304, T44)

- Chiffrement AES-256-GCM au dépôt, clé hors base (`SECRETS_ENCRYPTION_KEY`, identifiant `SECRETS_ENCRYPTION_KEY_ID`). Un seul secret actif par nature ; un nouveau dépôt le remplace.
- Déchiffrement uniquement par le registre des adaptateurs, en mémoire, le temps d’un appel. Pendant l’appel, les valeurs sont suivies et remplacées par `[expurgé]` dans tout texte assaini. Toute erreur qui sort de l’adaptateur est assainie : paramètres `token`, `sid`, `password`…, identifiants dans les URL, en-têtes `Bearer`/`Basic`, champs JSON sensibles, y compris encodés dans une URL. Le journal de l’API (`RedactingConsoleLogger`, exporté pour le worker) applique le même masquage à chaque ligne.
- Les paramètres non secrets refusent toute clé évoquant un secret (`token`, `password`, `apiKey`…) : `SECRET_DANS_PARAMETRES`.
- **Rotation** :
  1. générer une clé : `openssl rand -base64 32` ;
  2. déclarer la nouvelle clé active (`SECRETS_ENCRYPTION_KEY`, `SECRETS_ENCRYPTION_KEY_ID=k2`) et déplacer l’ancienne dans `SECRETS_ENCRYPTION_PREVIOUS_KEYS=k1:<base64>` (plusieurs : séparées par des virgules), puis redémarrer l’API et le worker : les secrets restent lisibles ;
  3. simuler (par défaut, aucune écriture) : `pnpm --filter @parc-auto/api telemetry:rotate-secrets` (après `pnpm --filter @parc-auto/api build`), ou en production `docker compose -f docker-compose.prod.yml run --rm api node apps/api/dist/cli/rotate-telemetry-secrets.js` ;
  4. rechiffrer : même commande suivie de `--apply` (audit `telemetrie.secrets.rechiffrement`) ;
  5. relancer la simulation (`toReencrypt: 0`), puis retirer l’ancienne clé du trousseau. Un secret sous une clé absente du trousseau est signalé (`undecryptable`, code de sortie 1), jamais perdu silencieusement.

### Simulateur (D-303)

Nommé « SIMULATEUR — données fictives » partout : type, avertissement de la fiche, libellé des unités, messages de santé et d’alerte. Il n’est enregistré que si `TELEMETRY_SIMULATOR_ENABLED=true` hors production. `loadEnv` refuse ce drapeau en production, le registre refuse le type en production (422 `SIMULATEUR_INTERDIT_EN_PRODUCTION`) et `assertNoActiveSimulatorInProduction(prisma, env)` doit être appelé au démarrage du worker : il refuse de démarrer si un simulateur actif ou suspendu existe en base.

Scénario (`settings.scenario`), déterministe (aucune valeur aléatoire ; l’horloge de l’application décide des échantillons disponibles) :

```json
{
  "units": [{ "externalId": "U-1", "label": "Camion", "declaredRegistration": "123 TU 4567", "odometerKinds": ["COMPTEUR_CAN"], "fuelKinds": ["NIVEAU_SONDE"], "removedAt": null }],
  "odometerSamples": [{ "unitExternalId": "U-1", "kind": "COMPTEUR_CAN", "valueKm": "50000.000", "observedAt": "2026-09-24T08:00:00Z", "sourceReference": "p1" }],
  "fuelSamples": [{ "unitExternalId": "U-1", "kind": "NIVEAU_SONDE", "liters": "80", "percent": null, "engineOn": false, "speedKmh": "0", "observedAt": "2026-09-24T08:00:00Z" }],
  "failures": [{ "mode": "INJOIGNABLE | QUOTA | AUTHENTIFICATION", "from": null, "until": null, "retryAfterSeconds": 60, "operations": ["getOdometers"] }],
  "duplicates": false,
  "order": "CHRONOLOGIQUE | INVERSE | ENTRELACE",
  "authRequired": false,
  "supportsHistory": true,
  "echoRequestUrlInErrors": false
}
```

`echoRequestUrlInErrors` reproduit un client HTTP qui cite l’URL appelée, jeton compris, dans ses erreurs : le test T44 vérifie ainsi que le service assainit toute erreur fournisseur.

### Activation par société (D-101, D-295)

`telemetryEnabled` vaut faux par défaut. L’administrateur active ou désactive avec un motif, et l’opération est auditée ; c’est le seul chemin : `PATCH /companies/:id` refuse toute modification de `telemetryEnabled` (422 `ACTIVATION_TELEMETRIE_DEDIEE`). À la désactivation, les alertes F11 actives de la société sont résolues (« module désactivé ») ; les associations restent confirmées mais l’ingestion exige `telemetryEnabled` (D-186) ; les relevés déjà acceptés sont conservés. La réactivation relance le calcul des alertes « unité non associée ». La reprise bornée (plus courte durée entre `backfillDays` et la période d’inactivité) relève du worker.

### Unités et associations (14.5 ; D-175, D-186, D-249, D-300 à D-302)

- **Découverte** : upsert des unités et de leur présence chez le fournisseur. Pour le canal RAPPORT (`partialUnitList`), une unité absente n’est pas marquée disparue. Une proposition n’est faite que sur une correspondance exacte et unique de l’immatriculation normalisée (`normalizeRegistration`) avec un véhicule ACTIF d’une société couverte, activée et dans le périmètre de l’appelant. Motifs de non-association : `INCONNUE`, `IMMATRICULATION_ABSENTE`, `AMBIGUE`, `VEHICULE_DEJA_EQUIPE`, `PROPOSITION_REJETEE`, `VEHICULE_NON_ELIGIBLE` (administrateur seulement), `A_REEXAMINER`. Aucun échantillon, état d’unité ni relevé n’est écrit ; chaque découverte est tracée dans `TelemetrySyncRun` (déclencheur MANUEL, société nulle).
- **Confirmation** par le chef de la société courante du véhicule : `odometerKind` (`COMPTEUR_CAN`, `DISTANCE_GPS` ou `AUCUN`, selon l’annexe A), `fuelKinds`, `validFrom`. Par défaut, `validFrom` vaut la plus tardive des dates suivantes : maintenant − `backfillDays`, début du compteur ouvert, entrée dans la société courante, fin de la précédente association du véhicule ou de l’unité. Une date saisie hors de ces bornes, ou future, est refusée (422). Les propositions concurrentes sont rejetées. Un véhicule ou une unité n’a qu’une association confirmée ouverte : 409 sinon.
- **Périodes sans chevauchement** (R-14.5-X01) : contraintes d’exclusion SQL `telemetry_mapping_no_overlap_unit` et `telemetry_mapping_no_overlap_vehicle` sur [validFrom, validTo[ des associations `CONFIRME` et `CLOTURE` (CHECK `telemetry_mapping_period_valid` : date d’effet obligatoire, fin jamais avant le début). Une date d’effet antérieure à la fin de l’association précédente de l’unité ou du véhicule est refusée en 409 `PERIODE_UNITE_CHEVAUCHEMENT` / `PERIODE_VEHICULE_CHEVAUCHEMENT`, de même qu’une violation de la contrainte par des décisions concurrentes.
- **Aide télématique** (5.6, R-5.6-17) : `GET /vehicles/:id/odometer` (`lastTelematicsHint`) et l’aperçu de remise (`telematicsHint`) proposent le dernier échantillon de la nature retenue par l’association en cours, observé depuis sa date d’effet (`currentTelematicsHint`) : jamais la valeur d’un boîtier réutilisé observée sur son véhicule précédent ; la valeur enregistrée reste celle saisie.
- **Changement de boîtier** (`close` avec `replacement`) : l’association passe `CLOTURE` avec `validTo` égal à l’instant du changement (jamais avant le dernier relevé reçu de l’unité), et la nouvelle association est confirmée à partir du même instant. Le kilométrage cumulé et les compteurs ne sont jamais modifiés. Une valeur CAN inférieure reçue ensuite est une anomalie traitée par l’ingestion unique, jamais un remplacement implicite. Une association couvre un instant t si `status ∈ {CONFIRME, CLOTURE}` et `validFrom ≤ t < validTo` (validTo nul : ouverte).
- **Alerte `GPS_UNITE_NON_MAPPEE`** (INFO) : unité présente chez un fournisseur ACTIF, non ignorée, sans association confirmée ni proposition en attente, une alerte par société couverte et activée. Elle est résolue dès qu’une association est proposée ou confirmée, que l’unité est ignorée, qu’elle disparaît, ou que la société ou le fournisseur sort du périmètre.
- **Unité ignorée** (D-249 : remorque, boîtier de rechange, unité volontairement sans véhicule) : l’état est porté par l’unité (`TelemetryUnit.ignoredAt`, `ignoredById`, `ignoredReason`, contrôle CHECK en base : les trois champs sont nuls, ou la date et un motif non vide sont renseignés), car une association exige un véhicule. Même règle d’accès que la découverte : administrateur, ou chef de parc d’une société couverte par le fournisseur ; 404 hors périmètre. Ignorer est refusé (409) tant qu’une association confirmée est en cours : il faut d’abord la clôturer. Les propositions en attente de l’unité sont rejetées avec le motif « Unité ignorée : … » ; un chef ne peut pas ignorer une unité proposée pour un véhicule d’une société qu’il ne gère pas (403, seul l’administrateur le peut). L’alerte « unité non associée » est résolue avec le même motif. Ensuite, la découverte ne propose plus rien pour cette unité : elle la signale `NON_ASSOCIEE` avec le motif `IGNOREE` et la compte dans `ignored`, hors `unmapped` ; l’unité n’entre plus dans le rapprochement (elle ne rend donc plus ambiguë une autre unité). Elle quitte la catégorie `NON_ASSOCIEES` pour `IGNOREES`, qui liste les unités ignorées, présentes ou non chez le fournisseur. Une unité ignorée ne peut pas être associée (422 `UNITE_IGNOREE`, contrôlé aussi dans la transaction de l’association sous verrou de l’unité). La reprise (`unignore`) remet l’unité « à associer » et relève de nouveau son alerte (même occurrence réactivée). Les propositions rejetées lors de l’ignorance ne sont pas recréées : l’association manuelle reste possible. Audit : `telemetrie.unite.ignoree` et `telemetrie.unite.reprise` (objet `TelemetryUnit`, motif, propositions rejetées, alertes résolues).
- **Désactivation d’un fournisseur** (état terminal) : associations en cours clôturées (`validTo` = instant de la désactivation, motif, audit par association), propositions rejetées, alertes F11 résolues ; ses unités ne figurent plus parmi les unités à associer. Les découvertes d’un même fournisseur (API et worker) sont sérialisées : ni unité ni proposition en double. Pour un chef, la réponse de découverte n’indique ni véhicule ni association d’une autre société.
- `closeOpenMappingsForVehicle(tx, …)` clôt l’association ouverte (audit `telemetrie.association.cloture` par association), rejette les propositions et résout les alertes F11 de l’association, dans la transaction de l’opération. Il est appelé à la cession et à l’archivage du véhicule (D-175) ainsi qu’à son transfert de société.

### Limites connues du modèle de données

- L’état « ignorée » (D-249) est porté par l’unité et non par un statut d’association `IGNOREE` : `TelemetryVehicleMapping` exige un véhicule (voir D-016 dans `docs/DECISIONS.md`).
- `TelemetryUnit` ne conserve pas les natures remontées (`odometerKinds`, `fuelKinds`). Elles sont renvoyées par la découverte, mais la confirmation ne peut pas les recontrôler.
- `Company` ne date pas la dernière désactivation : la reprise bornée à la réactivation (D-295) doit la lire dans l’audit (`telemetrie.societe.desactivation`).

### Tests du cœur

```bash
npx vitest run src/common/secret-redaction.spec.ts src/infra/secrets-crypto.service.spec.ts src/modules/telemetry/adapters/simulator.adapter.spec.ts src/modules/telemetry/telemetry-adapter.registry.spec.ts
TEST_DATABASE_URL=postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test_f1 \
  npx vitest run -c vitest.config.integration.ts test/integration/telemetry-core.int.spec.ts
```

## Synchronisation et ingestion (moteur de synchronisation)

Module `apps/api/src/modules/telemetry/sync` (CDC 5.6, 8.5, 14.3, 14.4 ; D-100, D-101, D-173 à D-195, D-234 à D-242, D-249, D-255, D-260, D-285, D-294 à D-299, D-322). Aucune société sans `telemetryEnabled` n’est synchronisée : aucun appel externe, et l’application fonctionne entièrement sans ce module.

### Branchement du worker

Branché dans `apps/worker` (planificateur `apps/worker/src/scheduler/worker-scheduler.service.ts`, une tâche à bail unique par entrée) :

- tâche `telematique-synchro` (`apps/worker/src/jobs/telemetry-sync.job.ts`, chaque minute) → `TelemetrySyncService.runDue(now, { holder })` : clôture des runs interrompus, runs échus de chaque couple fournisseur `ACTIF` × société couverte et activée, liste des unités au plus une fois par heure et par fournisseur, puis évaluation « source muette ». `holder` est l’identifiant du worker (titulaire des baux).
- tâche `retention-quotidienne` (`apps/worker/src/jobs/daily-retention.job.ts`, un créneau par jour UTC) → création des partitions mensuelles des trois mois suivants (`ensure_month_partitions`), puis `TelemetryPurgeService.purgeSamples(now)` : purge des échantillons (voir « Rétention »).
- tâche `telematique-webhooks` (`apps/worker/src/jobs/telemetry-webhook.job.ts`, toutes les 10 s) → `TelemetrySyncService.runWebhooks(now, { holder })` : ingestion des lots webhook en file, lots de fournisseurs devenus non actifs ignorés, purge des lots terminés depuis 7 jours et des anciens secrets de signature expirés.
- `assertNoActiveSimulatorInProduction(prisma, env)` au démarrage du worker (`onApplicationBootstrap` du planificateur) : un simulateur actif en production arrête le processus.

### Planification et résilience (D-296, D-297)

- Un run tracé (`TelemetrySyncRun`) par couple fournisseur-société, sous le bail `telemetry-sync:<fournisseur>:<société>` (table `JobLease`, 5 min, renouvelé après chaque appel et chaque étape) : plusieurs répliques de worker, ou l’API pour une synchronisation manuelle, n’exécutent jamais deux runs du même couple en même temps. Déclencheurs : `PLANIFIE`, `MANUEL`, `REPRISE_INITIALE`, `WEBHOOK` (lot poussé, canal WEBHOOK) ; `IGNORE` pour un créneau échu pendant l’ouverture du coupe-circuit ou un report de quota.
- Reprises dans un run : 1, 4 puis 16 s pour un fournisseur injoignable ou un quota ; un 429 respecte `Retry-After` (au-delà de 60 s, pas d’attente dans le run : l’appel suivant est différé d’autant). Pas de reprise dans le run pour le canal RAPPORT (lot lu une fois par exécution).
- Délai entre runs : intervalle × 2^n (n = échecs consécutifs), plafonné à 60 min.
- Coupe-circuit : ouvert 60 min après 5 échecs consécutifs (runs `IGNORE` tracés, aucun appel), puis un essai unique sans reprise ; alerte `GPS_SYNCHRO_EN_ECHEC` (société par société) à l’ouverture, résolue au premier succès.
- Canal RAPPORT : les sociétés couvertes sont traitées dans la même session et les fichiers ne sont acquittés qu’après leur ingestion.
- `POST /api/v1/telemetry/providers/:id/sync` `{ companyId?, reprise? }` (administrateur ; chef de parc pour ses sociétés couvertes et activées ; `reprise` réservée à l’administrateur) : réponse 202 immédiate avec l’identifiant du run lancé en arrière-plan, ou du run déjà en cours (`alreadyRunning`), ou un run `IGNORE` si le coupe-circuit est ouvert. Opérateur et lecteur : 403 ; conducteur : 403 ; fournisseur hors périmètre : 404.

### Reprise initiale (14.4, D-294, D-295, D-301)

Une association confirmée déclenche au passage suivant un run `REPRISE_INITIALE` sur `[max(validFrom, maintenant − backfillDays), maintenant]`, via `getOdometerHistory` si le canal le permet (sinon état courant seulement, consigné dans le run). La reprise faite est marquée dans l’audit (`telemetrie.association.reprise_initiale`, par association). Pendant une reprise, seuls les relevés quotidiens sont historisés et une valeur en conflit avec un relevé existant reste un simple échantillon (D-185). La reprise explicite de l’administrateur (`reprise: true`) est bornée en plus à la dernière désactivation du module (audit `telemetrie.societe.desactivation`).

### Ingestion du kilométrage (5.6)

- Seulement sous une association `CONFIRME` ou `CLOTURE` couvrant l’instant d’observation, véhicule actif à cette date, société activée ; échantillon brut stocké (`TelemetryOdometerSample`, unicité unité/nature/instant) et état de l’unité mis à jour (`TelemetryUnitState`).
- Idempotence : `sourceReference` du fournisseur, sinon clé de repli `fp:` + SHA-256(fournisseur, unité, nature, instant, valeur) ; même instant avec une autre valeur : premier conservé, conflit compté (T36).
- Relevé `TELEMATICS` créé par l’ingestion unique (`OdometerIngestionService`) selon `historizationReason` : premier échantillon après association ou silence, premier du jour local (jamais un 00:00 fabriqué), franchissement d’un seuil de plan (échéance − préavis, échéance, échéance + 1 km : alerte d’entretien dans la même exécution, T42), ou progression après `telemetry.historizeEveryMinutes`.
- `COMPTEUR_CAN` = compteur physique (T37). Une régression est présentée à l’ingestion : relevé `EN_ATTENTE` motivé, compteur courant inchangé, remises non bloquées ; tant qu’elle est ouverte, au plus un relevé en attente par véhicule et par motif (T40, D-322). Le connecteur ne crée jamais de compteur : un véhicule non initialisé garde ses échantillons.
- `DISTANCE_GPS` = estimation calibrée (`ingestGpsEstimate`) : relevé `ACCEPTE`, `isEstimate`, distance GPS brute, lien de calibrage, libellé « Estimé GPS (réf. manuelle du JJ/MM/AAAA, N km) » ; mêmes contrôles de valeur, de chronologie et de plausibilité face aux seuls relevés physiques ; une estimation incohérente est écartée (comptée), jamais mise en attente ; elle ne sert jamais de voisin à un relevé physique.
- Calibrage (T38, T39) : tout relevé physique `MANUAL` ou `IMPORT` accepté d’un véhicule associé en `DISTANCE_GPS` devient une référence (écouteur des relevés acceptés, y compris une soumission conducteur approuvée ou une correction), avec la distance GPS du dernier échantillon dans `telemetry.calibrationMaxGapMinutes` ; sans échantillon : `NON_CALIBRABLE`, estimations suspendues. L’écart est historisé ; au-delà de `telemetry.driftThresholdPercent` (distance ≥ `telemetry.driftMinDistanceKm`), alerte `GPS_DERIVE`, résolue au calibrage suivant sous le seuil. Les estimations postérieures calculées sur une référence plus ancienne sont recalculées (remplacement, jamais d’écrasement).

### Source muette (T31, T41 ; D-100, D-189, D-194, D-249)

Évaluée à chaque passage, même fournisseur injoignable : unité associée sans observation (toutes natures) depuis `telemetry.silentAfterHours` → `GPS_SOURCE_MUETTE` sur l’association (occurrence = dernière observation), résolue au premier échantillon plus récent ; aucune synchronisation réussie du couple fournisseur-société depuis ce seuil → une seule `GPS_SOURCE_MUETTE` agrégée sur le fournisseur, sans alertes par unité. La fraîcheur du kilométrage reste calculée sur la dernière observation acceptée toutes sources ; aucune saisie n’est bloquée et aucun « suivi en direct » n’est affiché.

### Carburant (8.5, T43 ; D-234 à D-242)

- Échantillons stockés au plus un par unité, nature et tranche de `telemetry.fuelSampleStepMinutes` (le dernier de la tranche), pour les natures retenues dans l’association.
- Détection (`detectFuelEpisodes`) sur les échantillons du lot complétés des échantillons stockés : baisse anormale (sonde, moteur coupé, vitesse nulle), remplissage (`telemetry.fuelFillMinLiters` ou `telemetry.fuelFillPercent` en `telemetry.fuelFillWindowMinutes`). Un épisode = au plus un `FuelEvent` (clé `episodeDedupeKey`).
- Remplissage rapproché des pleins saisis (`matchTicket`, fenêtre `telemetry.fuelTicketWindowHours`, tolérance max(`telemetry.fuelTicketToleranceLiters`, `telemetry.fuelTicketTolerancePercent` % du ticket)) : rapproché → qualifié `JUSTIFIE` automatiquement (audit) ; sans ticket → `REMPLISSAGE_DETECTE` à qualifier ; hors tolérance → `ECART_TICKET` à qualifier. Un ticket saisi après coup justifie automatiquement le remplissage aux passages suivants. Alertes `CARBURANT_*` ; aucune dépense, responsabilité ni retenue n’est jamais créée.
- `GET /api/v1/telemetry/fuel-events` (lecture, périmètre), `GET /api/v1/telemetry/fuel-events/:id`, `POST /api/v1/telemetry/fuel-events/:id/qualify` `{ qualification: JUSTIFIE | ANOMALIE_CONFIRMEE | ERREUR_CAPTEUR, note, expectedVersion }` (chef de parc ou administrateur ; 409 sur version obsolète ; 422 si déjà qualifié).
- Seuils propres à un véhicule (D-238, D-240 ; R-8.5-07, R-17.1-14) : `GET /api/v1/telemetry/vehicles/:id/fuel-thresholds` (valeur de la société avec son origine, surcharge du véhicule, valeur appliquée) et `PUT` `{ dropLiters?, dropPercent?, dropWindowMinutes?, fillLiters?, fillPercent?, fillWindowMinutes?, reason, expectedVersion }` (chef de parc de la société ou administrateur ; bornes des paramètres `telemetry.fuel*` ; 409 sur version obsolète ; audit `telemetrie.seuils_carburant.modification` / `.suppression` ; tous les champs nuls rétablissent les seuils de la société). La détection applique `applyVehicleFuelThresholds` (véhicule > société > groupe > produit) et trace les seuils appliqués dans `details.seuils` de l’événement. Écran : carte « Seuils carburant du véhicule » de l’onglet Télématique de la fiche véhicule.
- Consommation télématique en parallèle (D-234, D-236 ; R-8.5-10) : `GET /api/v1/vehicles/:id/consumption` ajoute `telematics` à chaque intervalle et à chaque total quand le véhicule a une mesure `CONSOMMATION_CAN` ou `NIVEAU_SONDE` (absent sinon : réponse inchangée sans F11). Mêmes intervalles A → B et mêmes kilomètres que la consommation déclarée ; compteur CAN : dernier − premier échantillon de [A, B] ; sonde : pic du remplissage rapproché du plein A − creux du remplissage rapproché du plein B + remplissages intermédiaires mesurés ; N/D motivé (trou > 60 min, couverture < 90 %, remplissage A ou B non détecté, volume inconnu, bilan négatif) ; écart en % avec la consommation déclarée des mêmes intervalles. Règle unique : `apps/api/src/domain/telemetry/telematic-consumption.ts`. Écran : onglet « Carburant » de la fiche véhicule, bloc « Consommation estimée » (« Télématique (Niveau sonde) : x L/100 km, écart +y % par rapport à la consommation déclarée »).
- Les pages `/carburant` (liste et détail d’un plein) renvoient aux événements carburant télématiques du véhicule ou du périmètre (`/telematique?onglet=carburant&vehicule=…`), avec le nombre restant à qualifier ; rien n’est affiché sans événement.

### Rétention

Échantillons carburant : `telemetry.fuelSampleRetentionDays` (90 j). Échantillons bruts d’odomètre : `telemetry.odometerSampleRetentionDays` (90 j, D-174). La purge supprime les lignes expirées par organisation, puis les partitions mensuelles entièrement antérieures à la rétention la plus longue. La création des partitions à venir (`ensure_month_partitions`) reste au job de rétention du worker. Les relevés et les événements carburant ne sont jamais purgés.

### Limites connues

- `FuelLevelSample` n’a pas de colonne de tranche (D-239) : l’unicité par tranche est assurée par le service, l’index unique porte sur l’instant exact.
- Aucun champ ne porte la prochaine échéance d’un couple fournisseur-société : un `Retry-After` trop long est tenu par `circuitOpenUntil` (message « quota » distinct du coupe-circuit).
- Seuls les seuils de baisse et de remplissage se surchargent par véhicule (`VehicleFuelThresholds`, D-240) ; le rapprochement avec le ticket et le pas des échantillons restent des paramètres de la société ou du groupe (voir D-016).
- Un véhicule hors service n’a pas d’historique de statut : ses échantillons sont conservés sans relevé (D-175, D-186).

### Tests de la synchronisation

```bash
npx vitest run src/modules/telemetry/sync
TEST_DATABASE_URL=postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test_f3 \
  npx vitest run -c vitest.config.integration.ts test/integration/telemetry-sync.int.spec.ts
```

## Guide d’exploitation : écrans, procédures et qualification

Cette partie s’adresse à l’administrateur et au chef de parc. Elle décrit les écrans F11, les procédures d’activation, d’association, de suivi de la synchronisation, de calibrage et de qualification du carburant, la sécurité des secrets, les restrictions du simulateur, la liste de contrôle de l’annexe A, les limites et les dépendances externes (CDC 5.6, 8.5, 9.1, 14.3 à 14.6, annexe A, T31, T35 à T44 ; D-100, D-101, D-112, D-147, D-161, D-169, D-173 à D-195, D-234, D-236, D-240, D-242, D-249, D-255, D-260, D-285, D-292, D-294 à D-304, D-322).

Principe constant : **l’application fonctionne entièrement avec F11 désactivé**. Aucun parcours manuel (remise, restitution, relevé, entretien, plein) ne dépend du connecteur, et aucun écran n’affiche de « suivi en direct » : seules les données reçues du fournisseur et leur traitement sont montrés (T31).

### Écrans

| Écran | Qui | Contenu |
| --- | --- | --- |
| `/administration/telematique` (onglet « Télématique » de l’administration) | Administrateur seulement (les autres rôles reçoivent l’accès refusé de l’administration) | Activation du module par société, avec motif audité ; fournisseurs : liste filtrable (nom, statut), création en brouillon par type avec les paramètres documentés (formulaire ou JSON complet, exemple documenté), fiche du fournisseur (état de synchronisation, configuration non secrète, secrets en écriture seule affichés « Configuré le … », test de connexion, découverte des unités, synchronisation manuelle avec ou sans reprise d’historique, activation, suspension, désactivation avec motif, suppression d’un brouillon) ; exécutions de synchronisation filtrables. Le simulateur porte partout la mention « SIMULATEUR — données fictives ». |
| `/telematique` | Chef de parc et administrateur (décisions) ; opérateur et lecteur en lecture seule ; conducteur : écran réservé au personnel | Onglet **Associations** : propositions à confirmer (nature du kilométrage et du carburant, date d’effet), rejet motivé, unités non associées avec leur motif (« Ignorer cette unité » pour une remorque ou un boîtier de rechange), associations en cours (clôture, changement de boîtier), véhicules sans unité, unités ignorées (« Ne plus ignorer », administrateur et chef de parc), association manuelle. Onglet **Synchronisation** : module par société, état de chaque fournisseur (dernière synchronisation, dernière réussite, échecs consécutifs, coupe-circuit, dernière erreur expurgée), synchronisation manuelle et découverte pour les sociétés gérées, exécutions. Onglet **Événements carburant** : anomalies à qualifier avec une note. |
| Fiche véhicule, onglet « Télématique » (`apps/web/app/(app)/vehicules/[id]/telemetry-panel.tsx`, composant `VehicleTelemetryPanel({ vehicleId, companyId })`, affiché par `vehicle-detail.tsx` ; lien direct `?onglet=telematique`) | Personnel de gestion du périmètre (onglet absent pour un compte conducteur) | Unité associée et natures retenues, dernière observation reçue (valeur brute : la distance GPS est l’odomètre virtuel du fournisseur, jamais le compteur), dernière estimation « estimé GPS » avec la date et la valeur de sa référence manuelle, dernier calibrage et dernière dérive, lien vers `/telematique`. |

Les liens d’action des alertes F11 fournis par l’API sont tous servis : `/telematique` (source muette par fournisseur, synchronisation en échec), `/telematique/unites` (unité non mappée : redirige vers les unités non associées), `/telematique/carburant?evenement=…` (événement carburant : redirige vers l’onglet « Événements carburant », qui affiche en tête l’événement signalé avec son bouton « Qualifier »). Les alertes de dérive et de source muette par unité ouvrent la fiche du véhicule (`/vehicules/:id?onglet=kilometrage`).

L’entrée « Télématique » du menu principal (`apps/web/components/layout/nav.tsx`) ouvre `/telematique` pour le personnel ; elle ne figure pas dans le menu d’un compte conducteur. Les alertes du tableau de bord qui pointent vers `/telematique` sont cliquables (section `telematique` de `EXISTING_SECTIONS`, `alert-list-item.tsx`). Le formulaire de la société (`/administration`, « Modifier ») n’active plus le module : il affiche son état et renvoie vers l’onglet Télématique, seul chemin qui exige le motif et résout les alertes F11 (D-101).

Route de lecture ajoutée pour le panneau : `GET /api/v1/telemetry/vehicles/:vehicleId` (administrateur, chef, opérateur, lecteur dans leur périmètre ; conducteur 403 ; hors périmètre ou inconnu 404). Réponse : `{ vehicleId, vehicleCode, companyId, telemetryEnabled, mapping, pendingProposals, provider, lastObservation, lastEstimate, lastCalibration, lastDrift }`. Le fournisseur n’y figure que par son nom, son type, son statut et son état de synchronisation : ni URL, ni paramètres, ni secret. Aucune valeur n’y est calculée : elle lit l’état d’unité, le dernier échantillon carburant, la dernière estimation historisée et les calibrages enregistrés ; la dérive est affichée à une décimale par `formatPercent` (D-190). L’état d’unité étant tenu par boîtier, la dernière observation n’est restituée que si elle date de l’association en cours (à partir de sa date d’effet) : un boîtier réutilisé n’affiche jamais sur son nouveau véhicule le kilométrage de l’ancien.

### Activation : procédure

1. **Qualifier le fournisseur** avec la liste de contrôle de l’annexe A (plus bas). Sans réponse écrite, le module reste inactif et le régime manuel s’applique sans dégradation.
2. **Créer le fournisseur** (administrateur, `/administration/telematique`, « Nouveau fournisseur ») : type selon le canal retenu, URL de base pour une API, paramètres non secrets du type, intervalle (5 min au minimum, 15 par défaut), profondeur de reprise (0 à 90 jours, 7 par défaut), sociétés couvertes. Il est créé en **brouillon** : aucune donnée n’est lue.
3. **Déposer le secret** (fiche du fournisseur, « Déposer ») : compte dédié en lecture seule. La valeur n’est plus jamais affichée.
4. **Tester la connexion** : appel réel de `healthCheck`, message expurgé, latence. Corriger URL, paramètres ou secret tant que le test échoue.
5. **Activer le fournisseur** : l’API refuse l’activation tant que la configuration est incomplète et liste les manques (paramètres, URL, société couverte, secret).
6. **Activer le module pour chaque société** (tableau « Activation par société », motif obligatoire et audité). Tant qu’une société n’est pas activée, aucun appel externe n’est fait pour elle.
7. **Découvrir les unités** (administrateur depuis la fiche, ou chef depuis l’onglet Synchronisation) puis faire **confirmer les associations** par le chef de parc. Aucun relevé n’est ingéré avant la confirmation (T35).
8. Le worker synchronise ensuite à l’intervalle prévu (tâche `telematique-synchro`, voir « Branchement du worker ») : le service `worker` doit tourner.

**Désactiver** le module d’une société (même tableau, motif) arrête la synchronisation, conserve les associations (suspendues), conserve les relevés déjà acceptés et résout les alertes F11 actives avec le motif « module désactivé ». La réactivation reprend l’historique au plus sur la durée d’inactivité, bornée par la profondeur de reprise (D-295). **Suspendre** un fournisseur arrête ses synchronisations et résout ses alertes, et il peut être réactivé. **Désactiver** un fournisseur est définitif : ses associations en cours sont clôturées à cet instant (historique, unités et relevés conservés) et ses propositions rejetées, si bien que les véhicules redeviennent « sans unité » et peuvent être associés au fournisseur suivant. Seul un brouillon jamais synchronisé peut être supprimé.

### Associations : procédure du chef de parc

- **Propositions à confirmer** : nées de la découverte, sur une correspondance exacte et unique de l’immatriculation normalisée (D-302). Avant de confirmer, choisir :
  - la **nature du kilométrage**, d’après la réponse écrite du fournisseur pour ce véhicule (annexe A) :

    | Nature | À choisir quand | Effet |
    | --- | --- | --- |
    | `COMPTEUR_CAN` | le boîtier lit le compteur du tableau de bord sur le bus CAN/FMS | valeur traitée comme un compteur physique (T37) ; une valeur inférieure passe en attente avec motif (T40) |
    | `DISTANCE_GPS` | le fournisseur calcule un odomètre virtuel à partir des positions | kilométrage « estimé GPS » calibré sur les relevés manuels, jamais présenté comme le compteur (T38) |
    | `AUCUN` | aucun kilométrage fiable (carburant seul, par exemple) | aucun kilométrage ingéré |

  - les **natures de carburant** réellement exposées (`NIVEAU_CAN`, `NIVEAU_SONDE`, `CONSOMMATION_CAN`) ; une consommation théorique n’est jamais importée ;
  - la **date d’effet**, facultative. Par défaut, c’est la plus tardive de ces dates : maintenant moins la reprise, début du compteur ouvert, entrée du véhicule dans sa société, fin de la précédente association. Elle n’est jamais dans le futur (D-301). La confirmation déclenche la reprise initiale au passage suivant du worker.

  Aucune nature n’est présélectionnée : le choix est explicite.
- **Rejeter** une proposition exige un motif ; la paire n’est plus reproposée.
- **Unités non associées** : le motif est affiché (immatriculation inconnue, absente, ambiguë, véhicule déjà équipé, proposition rejetée, véhicule non éligible, correspondance à réexaminer). « Associer à un véhicule » crée une association confirmée immédiatement. Pour une unité volontairement sans véhicule (remorque, boîtier de rechange), « Ignorer cette unité » demande un motif : l’unité ne reçoit plus de proposition ni d’alerte d’information, et ses propositions en attente sont rejetées. Une unité associée doit d’abord être clôturée.
- **Ignorées** (administrateur et chef de parc seulement) : unités ignorées avec la date et le motif ; « Ne plus ignorer » (motif facultatif) la remet parmi les unités non associées et relève de nouveau l’alerte d’information.
- **Véhicules sans unité** : véhicules actifs des sociétés activées sans association confirmée ; « Associer une unité » choisit parmi les unités non associées.
- **Changement de boîtier** (« Clôturer / changer de boîtier ») : motif, instant du changement (ni futur, ni antérieur au dernier relevé reçu de l’unité), nouvelle unité et ses natures. L’ancienne association est clôturée et la nouvelle confirmée au même instant. Le kilométrage cumulé n’est **jamais** modifié : une valeur CAN inférieure reçue ensuite est une anomalie en attente, jamais un remplacement de compteur implicite (D-300, D-169). En `DISTANCE_GPS`, les estimations reprennent au prochain relevé manuel accepté.
- La cession, l’archivage et le transfert d’un véhicule clôturent automatiquement son association ouverte (D-175).

### Synchronisation et résilience : lire l’état

| Indicateur | Lecture |
| --- | --- |
| Dernière synchronisation / dernière réussite | Instant de la dernière exécution et de la dernière exécution réussie du fournisseur. |
| Échecs consécutifs | Remis à zéro au premier succès ; le délai entre exécutions double à chaque échec (plafond 60 min). |
| Coupe-circuit ou report de quota | Ouvert 60 min après 5 échecs consécutifs : les créneaux échus sont tracés « Ignorée », sans appel au fournisseur, puis un essai unique a lieu ; l’alerte « Synchronisation GPS en échec » est levée à l’ouverture et résolue au premier succès (D-297). Un quota dont le `Retry-After` dépasse l’attente admise dans une exécution reporte aussi les appels, sans ouvrir le coupe-circuit. L’écran affiche alors « Appels suspendus jusqu’au … » avec l’échéance fournie par l’API ; le seuil de 5 échecs n’est connu que de l’API. |
| Dernière erreur | Résumé expurgé (aucun secret, aucune URL complète). |

Résultats des exécutions : **Réussie**, **Partielle** (des échantillons ont été écartés ou refusés : voir le nombre d’erreurs et le résumé), **En échec**, **Ignorée** (coupe-circuit ouvert ou report de quota), **En cours**. Déclencheurs : planifiée, manuelle, reprise initiale. Une exécution sans société est une découverte des unités. Pendant qu’une exécution est en cours, la table est relue toutes les 5 s. C’est l’état des exécutions qui est suivi, jamais la position des véhicules.

Que faire :

- **Authentification refusée** : le compte ou le jeton a été révoqué ou modifié chez le fournisseur. Déposer un nouveau secret, puis tester la connexion.
- **Quota atteint** : augmenter l’intervalle de synchronisation ou `maxRequestsPerMinute`. Un `Retry-After` est respecté.
- **Fournisseur injoignable** : rien à faire côté application, les reprises sont automatiques. Au-delà de 24 h sans donnée, l’alerte « source GPS muette » invite à la saisie manuelle (T31, T41).
- **Réponse invalide ou configuration** : vérifier les paramètres du type (noms d’attributs, de colonnes ou de capteurs).

La synchronisation manuelle (administrateur, ou chef de parc pour ses sociétés couvertes et activées) répond immédiatement. Elle signale l’exécution lancée, l’exécution déjà en cours, ou une exécution ignorée si le coupe-circuit est ouvert (D-296). La reprise d’historique est réservée à l’administrateur.

### Calibrage GPS et dérive

- Pour un véhicule associé en `DISTANCE_GPS`, chaque relevé physique accepté devient la référence de calibrage : remise, restitution, entretien, relevé libre, soumission conducteur approuvée ou correction.
- Formule : kilométrage estimé = kilométrage de la référence + (distance GPS − distance GPS de la référence). La distance GPS de la référence est le dernier échantillon brut reçu dans `telemetry.calibrationMaxGapMinutes`. Sans échantillon, le calibrage est « Non calibrable » : les estimations sont suspendues jusqu’au relevé manuel suivant (D-174, D-193).
- Une estimation est un relevé accepté marqué « estimé GPS », avec la date et la valeur de sa référence manuelle. Elle ne sert jamais de voisin au contrôle de chronologie d’un relevé physique, et un relevé manuel plus bas qu’une estimation est accepté (D-147, D-161, D-178, D-285). Une référence plus récente fait recalculer les estimations postérieures par remplacement, jamais par écrasement.
- Dérive = |estimation à l’instant du relevé − relevé manuel| ÷ (relevé manuel − référence précédente) × 100, en décimal exact, affichée à une décimale. T39 : 40 ÷ 960 donne 4,2 %. Au-delà de `telemetry.driftThresholdPercent` (3 %), et si la distance vaut au moins `telemetry.driftMinDistanceKm` (50 km), l’alerte « dérive GPS » est levée sur l’association. Elle est résolue au calibrage suivant sous le seuil ; le relevé manuel devient toujours la nouvelle référence (D-190 à D-192).
- Le panneau télématique de la fiche véhicule affiche la dernière estimation avec sa référence, le dernier calibrage (et son motif s’il n’est pas calibrable) et la dernière dérive mesurée.

### Carburant

- Trois natures, affichées telles quelles : `NIVEAU_CAN` (tendance, contrôle grossier), `NIVEAU_SONDE` (seule nature exploitable pour une baisse anormale), `CONSOMMATION_CAN` (litres consommés).
- Événements dérivés :
  - **remplissage détecté** : rapproché automatiquement d’un plein saisi dans la fenêtre, et alors justifié automatiquement ;
  - **baisse anormale à l’arrêt** : sonde seulement, moteur coupé et vitesse nulle prouvés ;
  - **écart remplissage / ticket** : litres hors tolérance, ou aucun ticket dans la fenêtre (D-240, D-242).
- Qualification (onglet « Événements carburant », chef de parc ou administrateur) :

  | Qualification | Sens |
  | --- | --- |
  | Justifié | L’événement a une explication. |
  | Anomalie confirmée | L’anomalie est avérée ; son traitement se fait hors de l’application. |
  | Erreur de capteur | La mesure est fausse. |

  La note est obligatoire et auditée. Une version obsolète est refusée (409), un événement déjà qualifié aussi (422).
- **Aucune dépense, responsabilité ni retenue n’est jamais créée** à partir d’un événement (T43). La consommation officielle reste calculée sur les pleins validés ; la consommation télématique n’est qu’affichée en parallèle (D-234, D-236).

### Sécurité des secrets et procédure de rotation

- Les secrets (jeton, identifiants API, accès IMAP ou SFTP) se déposent uniquement depuis la fiche du fournisseur, en écriture seule. L’API ne renvoie que `{ kind, configured, rotatedAt }` et l’écran n’affiche que « Configuré le … ». Ils ne sont jamais journalisés, et toute erreur fournisseur est expurgée (T44). Les paramètres non secrets refusent toute clé évoquant un secret.
- **Rotation d’un secret fournisseur** (compte compromis, départ d’un intervenant, échéance du jeton) :
  1. créer le nouveau jeton ou mot de passe chez le fournisseur, sur le compte dédié en lecture seule ;
  2. fiche du fournisseur, « Remplacer » : le nouveau secret remplace l’ancien ;
  3. « Tester la connexion » ;
  4. révoquer l’ancien jeton chez le fournisseur ;
  5. vérifier dans les exécutions que la synchronisation suivante réussit.
- **Rotation du secret de signature d’un webhook** (fiche du fournisseur, section « Réception webhook ») :
  1. « Générer un nouveau secret (rotation) » : copier la valeur affichée (une seule fois), cocher la confirmation, enregistrer ;
  2. transmettre le secret au fournisseur par un canal sûr ; l’ancien reste accepté pendant `rotationOverlapHours` (24 h par défaut, date affichée) ;
  3. vérifier dans « Derniers lots » que les lots suivants sont acceptés ; à l’échéance, l’ancien secret est refusé puis supprimé ;
  4. en cas de fuite : « Révoquer » (plus aucun lot authentifié) puis générer un nouveau secret.
- **Rotation de la clé de chiffrement** (clé hors base) : procédure et script décrits dans « Secrets : chiffrement, masquage et rotation ». En résumé :
  1. générer la nouvelle clé (`openssl rand -base64 32`) ;
  2. la déclarer active et placer l’ancienne dans `SECRETS_ENCRYPTION_PREVIOUS_KEYS` ;
  3. redémarrer l’API et le worker ;
  4. `pnpm --filter @parc-auto/api telemetry:rotate-secrets` (simulation), puis la même commande suivie de `--apply` ;
  5. relancer la simulation (0 secret à rechiffrer), puis retirer l’ancienne clé.

  Le script n’affiche jamais un secret et sort en erreur si l’un d’eux est indéchiffrable.

### Simulateur : restrictions

- Mention « SIMULATEUR — données fictives » sur le type, la fiche, la liste des fournisseurs, les unités, les associations, les événements carburant (`isSimulator` de la vue d’un événement), le panneau du véhicule, les messages de santé et les alertes de niveau fournisseur ou unité (source muette du fournisseur, synchronisation en échec, unité non mappée). Les alertes par véhicule (dérive, source muette d’une unité associée, événements carburant) ne la portent pas dans leur texte : l’écran lié l’affiche.
- Disponible seulement si `TELEMETRY_SIMULATOR_ENABLED=true` hors production. En production :
  - `loadEnv` refuse ce drapeau ;
  - le type est indisponible dans l’écran de création et refusé par l’API (422) ;
  - le worker doit refuser de démarrer si un simulateur actif ou suspendu existe (`assertNoActiveSimulatorInProduction`).
- Il sert aux tests T35 à T44 et à la démonstration. Ses scénarios sont déterministes et ne contiennent que des données fictives. Il ne remplace jamais la qualification d’un fournisseur réel.

### Qualification du fournisseur (annexe A) : liste de contrôle

À remplir avec les **réponses écrites** du fournisseur avant toute création de fournisseur réel.

| # | Question | Réponse attendue | Où elle se reporte dans l’application | Fait |
| --- | --- | --- | --- | --- |
| 1 | Plateforme : développement propre ou marque blanche (Wialon, Traccar, Navixy, autre), et version ? | Nom et version | Type du fournisseur : `TRACCAR`, `WIALON`, sinon `RAPPORT_GENERIQUE` ; une autre plateforme exige un nouvel adaptateur | ☐ |
| 2 | API ouverte au client : documentation, authentification, quotas, coût ? | Oui ou non, et documentation | Canal API ; URL de base ; `maxRequestsPerMinute` ; intervalle de synchronisation | ☐ |
| 3 | Compte ou jeton dédié en lecture seule ? | Oui ou non | Secret `JETON_API` ou `IDENTIFIANTS_API` (obligatoire pour API et RPA) | ☐ |
| 4 | Origine du kilométrage par véhicule : compteur CAN ou calcul GPS ? | Liste par véhicule | Nature du kilométrage choisie à chaque confirmation d’association ; Traccar : `canOdometerAttribute` et `gpsDistanceAttribute` ; Wialon : `odometerKind` ; rapport : `odometerKind` | ☐ |
| 5 | Carburant par véhicule : jauge CAN, sonde, compteur de consommation ou estimation théorique ? | Liste par véhicule | Natures carburant de l’association ; paramètres carburant du type. L’estimation théorique n’est pas importée | ☐ |
| 6 | Fréquence de remontée et profondeur d’historique ? | Minutes, mois | Intervalle de synchronisation (5 min au minimum) ; profondeur de reprise (0 à 90 jours) ; `historyChunkHours` | ☐ |
| 7 | Webhook ou envoi push ? | Oui ou non, et format | Oui, au format documenté (ou via un intermédiaire qui le produit) : type `WEBHOOK_GENERIQUE`, URL et secret de signature communiqués depuis la fiche. Sinon : interrogation périodique (API ou rapports) | ☐ |
| 8 | Rapports planifiés CSV/XLSX par e-mail ou SFTP ? | Oui ou non, et format | Canal RAPPORT : source IMAP ou SFTP, colonnes, format d’horodatage, fuseau, unités | ☐ |
| 9 | Lecture automatisée du portail web autorisée par écrit ? | Accord écrit | Condition du canal RPA, non activable en V1 (D-292) | ☐ |
| 10 | Identifiant stable d’unité et immatriculation associée ? | Nom du champ | Traccar : `registrationSource` ; Wialon : `registrationSource` (`profile:` ou `custom:`) ; rapport : `columns.unit` et `columns.registration` | ☐ |

Décision : API disponible → canal API. Sinon, rapports planifiés → canal RAPPORT. Le RPA ne vient qu’en complément, si la fraîcheur horaire est indispensable et autorisée par écrit, et il n’est pas disponible en V1. Sinon, **F11 reste inactif** et le régime manuel s’applique sans dégradation.

### Limites et dépendances externes

**Dépendances externes à configurer** (hors de l’application) :

- compte fournisseur dédié en lecture seule et ses secrets ;
- accès réseau sortant du serveur vers l’API, la boîte IMAP ou le SFTP du fournisseur ;
- réponses écrites de l’annexe A ;
- pour Wialon, validation contre un serveur réel (l’adaptateur n’a été testé que contre un serveur local conforme à la documentation) ;
- pour les tests d’intégration des adaptateurs, Docker et les images citées plus haut.

**Déjà branché dans l’application** (rien à ajouter par l’intégrateur) :

- dans le worker : tâches `telematique-synchro` (`runDue` chaque minute), `telematique-webhooks` (`runWebhooks` toutes les 10 s) et `retention-quotidienne` (partitions à venir et `purgeSamples` chaque jour), contrôle `assertNoActiveSimulatorInProduction` au démarrage ;
- le lien de menu « Télématique » vers `/telematique`, et la section `telematique` parmi les sections liables des alertes du tableau de bord (`EXISTING_SECTIONS` de `alert-list-item.tsx`) : leurs liens d’action sont cliquables ;
- le panneau `VehicleTelemetryPanel` dans l’onglet « Télématique » de la fiche véhicule, et le paramètre `onglet=` de la fiche (`onglet=kilometrage` pour les alertes de dérive et de source muette, `onglet=telematique`), lu par `vehicle-detail.tsx` ;
- pour un webhook, le reverse proxy fourni (`deploy/Caddyfile`) transmet déjà `/api/*`, donc `<APP_ORIGIN>/api/v1/telemetry/webhooks/*`, à l’API sans authentification de proxy.

**Reste à la charge de l’exploitation** : pour un webhook derrière un autre reverse proxy, exposer publiquement `<APP_ORIGIN>/api/v1/telemetry/webhooks/*` sans authentification de proxy ; dans tous les cas, garder l’horloge du serveur synchronisée (NTP) pour la tolérance de l’horodatage signé.

**Limites connues** :

- Aucun suivi en direct ni carte : ce n’est pas une fonction de la V1.
- Les natures remontées par la découverte ne sont pas conservées sur l’unité : le chef les choisit à la confirmation, sans contrôle croisé.
- L’état d’unité ne précise pas l’unité de la dernière valeur carburant (litres ou pourcentage). Le panneau affiche donc le dernier échantillon carburant stocké, qui les distingue.
- Parcours navigateur réels (Playwright) : `tests/e2e/specs/telematique-webhook.spec.ts` (section « Réception webhook » de l’administration, secret généré puis tourné, lots signés) et `tests/e2e/specs/telematique-complements.spec.ts` (aide télématique à la remise et à la restitution, événements carburant qualifiés dans `/telematique`, seuils carburant de l’onglet « Télématique » de la fiche). Les onglets « Associations » et « Synchronisation » de `/telematique` (confirmation, rejet, changement de boîtier, synchronisation manuelle, découverte) ne sont vérifiés que par le rendu côté serveur d’un test web et par les tests d’intégration de l’API : leurs clics et boîtes de dialogue restent à vérifier en recette.

### Tests des écrans et du panneau

Depuis `apps/api` :

```bash
TEST_DATABASE_URL=postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test_f4 \
  npx vitest run -c vitest.config.integration.ts test/integration/telemetry-vehicle.int.spec.ts test/integration/telemetry-screens.int.spec.ts
```

- `telemetry-vehicle.int.spec.ts` : périmètre (404 et 403), proposition en attente sans donnée, puis scénario T38/T39 lu par le panneau. Il vérifie l’estimation 80 450 « estimé GPS » avec sa référence du 24/09, la dérive 4,2 % avec alerte, et l’absence de secret dans la réponse.
- `telemetry-screens.int.spec.ts` : chaque appel des écrans, avec la forme exacte des requêtes de l’interface (paramètres de liste, corps des formulaires), et les droits correspondant aux boutons affichés.

- `telemetry-vehicle.int.spec.ts` couvre aussi le boîtier réutilisé : après clôture sur un premier véhicule et association à un second, le second n’hérite pas de la dernière observation du premier.

Web : `pnpm --filter @parc-auto/web typecheck && pnpm --filter @parc-auto/web lint && pnpm --filter @parc-auto/web build`, puis, depuis `apps/web`, `npx vitest run components/telemetry/telemetry-render.spec.ts`. Ce test rend réellement (côté serveur, à partir de réponses de l’API placées dans le cache de requêtes) :

- le panneau du véhicule : estimation « ≈ … km (estimé GPS) » avec sa référence, distance GPS brute présentée comme non calibrée, dérive 4,2 %, mention du simulateur, lien vers `/telematique`, aucune position ;
- la fiche fournisseur : secret affiché « Configuré le … » sans champ relisant sa valeur, actions selon le statut ;
- l’onglet Synchronisation : synchronisation et découverte pour le chef d’une société activée, consultation seule pour l’opérateur ;
- les liens d’action des alertes : `/telematique/carburant?evenement=…` et `/telematique/unites` redirigent vers l’onglet attendu (un identifiant non conforme est ignoré).

`telemetry-vehicle.int.spec.ts` vérifie de son côté que l’alerte « remplissage détecté » porte bien le lien `/telematique/carburant?evenement=<id>`, et que l’événement se lit par son identifiant dans le périmètre (404 pour le chef d’une autre société, 403 pour le conducteur).

### Tests de la réception webhook

```bash
# apps/api
npx vitest run src/modules/telemetry/webhook
TEST_DATABASE_URL=postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test_f2 \
  npx vitest run -c vitest.config.integration.ts test/integration/telemetry-webhook.int.spec.ts
# apps/worker (après pnpm --filter @parc-auto/api build)
TEST_DATABASE_URL=… npx vitest run src/jobs/telemetry-webhook.job.spec.ts
# apps/web
npx vitest run lib/webhook-secret.spec.ts components/telemetry/webhook-render.spec.ts
# tests/e2e (API et web compilés)
npx playwright test specs/telematique-webhook.spec.ts
```

- `telemetry-webhook.int.spec.ts` (requêtes HTTP réelles contre l’API complète, horloge contrôlée) : 202 sans ingestion synchrone puis ingestion par `runWebhooks` (unité proposée, association confirmée, relevés CAN `WEBHOOK` et échantillons carburant, événement de remplissage) ; même lot renvoyé sans doublon ; rejeu exact 409 ; lot verrouillé par un worker arrêté repris ; purge à 7 jours ; 401 signature absente, fausse, expirée (passé et futur), corps altéré, fournisseur inconnu ou d’un autre canal ; cookie de session sans effet, origine étrangère ignorée sur cette route mais toujours refusée ailleurs (403), relevé `TELEMATICS` forgé par une route utilisateur refusé (422) ; fournisseur suspendu ou module désactivé : 422 à la réception, lot ignoré s’il l’est devenu entre-temps, aucune donnée ingérée, saisie manuelle possible ; 413 (annoncé et par morceaux), 415, 400, 422 par champ, 429 avec `Retry-After` par fournisseur ; secret chiffré, absent des réponses, journaux, audit et file ; rotation avec recouvrement puis expiration et purge ; révocation ; vue d’administration réservée à l’administrateur.
- `telemetry-webhook.job.spec.ts` : la tâche planifiée du worker ingère les lots déposés, sans doublon au renvoi, ignore ceux d’un fournisseur suspendu, et ne fait rien sans fournisseur.
- `webhook-render.spec.ts` et `telematique-webhook.spec.ts` : section « Réception webhook » (URL, règles, état du secret sans sa valeur, génération une seule fois, rotation, derniers lots) ; la seconde dans un vrai navigateur, avec des lots signés envoyés au travers du relais web.
