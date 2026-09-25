# Installation en production

Cible : un VPS Linux avec Docker Engine et le plugin Docker Compose, un nom de domaine pointant vers le serveur, les ports 80 et 443 ouverts. Tous les services tournent en conteneurs : reverse proxy HTTPS (Caddy), web (Next.js), API (NestJS), worker, PostgreSQL 16. PostgreSQL et le stockage des pièces jointes ne sont exposés sur aucun port de l'hôte.

## 1. Récupérer le code et préparer l'environnement

```bash
git clone <dépôt> parc-auto && cd parc-auto
cp .env.example .env
```

Renseigner dans `.env` (jamais versionné) :

| Variable | Rôle | Exemple / génération |
| --- | --- | --- |
| `DOMAIN` | Nom de domaine public servi en HTTPS | `parc.exemple.tn` |
| `ACME_EMAIL` | Adresse de contact du certificat Let's Encrypt | `admin@exemple.tn` |
| `POSTGRES_PASSWORD` | Mot de passe PostgreSQL (réseau interne uniquement) | `openssl rand -base64 24` |
| `SECRETS_ENCRYPTION_KEY` | Clé de chiffrement au repos des secrets télématiques (32 octets) | `openssl rand -base64 32` |
| `SMTP_*` | Canal e-mail (facultatif : sans SMTP, l'application fonctionne et affiche « Canal e-mail non configuré ») | selon le fournisseur |
| `APP_VERSION` | Étiquette de version des images | `2026.09.24` |

Conserver `SECRETS_ENCRYPTION_KEY` et la clé de sauvegarde hors du serveur (coffre de mots de passe) : sans elles, les secrets fournisseur et les sauvegardes chiffrées sont illisibles.

## 2. Construire les images

```bash
docker compose -f docker-compose.prod.yml build
```

Les images de base sont épinglées par empreinte (Node 24.21.0, Caddy 2.11.4, PostgreSQL 16). Derrière un proxy d'entreprise qui intercepte TLS, fournir son autorité de certification sans la copier dans l'image finale :

```bash
docker buildx build --secret id=extra_ca,src=/chemin/ca.pem --target api .
```

## 3. Appliquer les migrations (étape explicite)

```bash
docker compose -f docker-compose.prod.yml up -d postgres
docker compose -f docker-compose.prod.yml run --rm migrate
```

## 4. Démarrer

```bash
docker compose -f docker-compose.prod.yml up -d
```

Caddy obtient le certificat pour `DOMAIN`. Vérifier :

- `https://DOMAIN/api/v1/health/live` → `{"status":"vivant"}` (processus vivant, aucune dépendance contrôlée) ;
- `https://DOMAIN/api/v1/health/ready` → 200 `"status":"pret"` quand la base (joignable, pas en lecture seule) et le stockage des pièces jointes (répertoire lisible et inscriptible) sont accessibles, 503 `"degrade"` sinon ; le champ `checks.worker` y indique l'état du battement du worker, **à titre d'information** : un worker arrêté ne rend pas l'API indisponible (D-315) ;
- `https://DOMAIN/api/v1/health/worker` → 200 `"status":"actif"` si le worker a battu il y a deux minutes au plus (battement toutes les 30 s), 503 sinon (`"arrete"` : aucun battement récent ; `"inconnu"` : battement illisible, base injoignable).

Aucune de ces réponses ne contient de secret, de chemin, de nom d'hôte ni de version.

## 5. Créer le premier administrateur

Sur une base vierge uniquement (la commande refuse s'il existe déjà un administrateur dans l'organisation). Le mot de passe passe par une variable d'environnement ou la saisie au clavier, jamais par un argument :

```bash
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD
docker compose -f docker-compose.prod.yml run --rm -e ADMIN_PASSWORD migrate \
  node dist/cli/create-admin.js --org-code GROUPE --org-name "Mon groupe" \
  --email admin@exemple.tn --first-name Prénom --last-name Nom
unset ADMIN_PASSWORD
```

L'administrateur crée ensuite sociétés, sites, catégories, utilisateurs et paramètres depuis `/administration`. Le jeu de démonstration n'est jamais chargé en production (la commande le refuse si `NODE_ENV=production`).

Catalogue initial (facultatif, rejouable sans effet) : depuis `/entretiens` (onglet « Catalogue ») et `/documents` (onglet « Types »), le bouton « Installer le catalogue initial » ajoute les opérations d'entretien et les types de documents usuels absents (`POST /api/v1/maintenance-types/initial-catalog`, `POST /api/v1/document-types/initial-catalog`, administrateur, audité). Aucun élément existant n'est modifié ; aucun intervalle, exigence ou blocage n'est imposé (voir `docs/guide-conformite-entretien.md`).

## 6. Surveillance extérieure

Configurer un service de surveillance **extérieur au VPS** (supervision HTTP hébergée) avec deux sondes, chacune en alerte si la réponse n'est pas 200 pendant 5 minutes :

- `https://DOMAIN/api/v1/health/ready` : l'application répond (proxy, API, base, stockage) ;
- `https://DOMAIN/api/v1/health/worker` : les traitements planifiés tournent (rattrapage des alertes, e-mails, exports différés, synchronisation télématique).

Une panne totale du VPS fait échouer les deux sondes : elle ne peut pas être signalée par le VPS lui-même, d'où une supervision hébergée ailleurs. Aucun appel sortant du serveur n'est nécessaire.

Chaque contrôle de ces routes est borné à 3 secondes : une base qui ne répond plus (réseau bloqué, serveur figé) donne un 503 « sans réponse » au lieu d'une requête suspendue. Régler le délai d'attente des sondes à 10 secondes au moins.

## 7. Sauvegardes

Planifier `scripts/ops/backup.sh` chaque nuit (voir `docs/sauvegarde-restauration.md`) et tester une restauration isolée avant la mise en service.
