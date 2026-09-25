# Mise à jour et retour arrière

## Principe

Chaque version est construite en images étiquetées (`APP_VERSION`). La mise à jour applique les migrations **explicitement**, après une sauvegarde. Le retour arrière de l'**application** consiste à redémarrer les images de la version précédente ; il n'existe **pas** de retour arrière automatique d'une migration de base : une migration destructrice ne s'annule qu'en restaurant la sauvegarde prise juste avant.

## Procédure

```bash
# 1. Sauvegarde préalable (obligatoire)
BACKUP_ENCRYPTION_KEY=… scripts/ops/backup.sh

# 2. Récupérer la nouvelle version et construire ses images
git fetch && git checkout <étiquette>
APP_VERSION=<nouvelle> docker compose -f docker-compose.prod.yml build

# 3. Migrations explicites
APP_VERSION=<nouvelle> docker compose -f docker-compose.prod.yml run --rm migrate

# 4. Redémarrage
APP_VERSION=<nouvelle> docker compose -f docker-compose.prod.yml up -d

# 5. Contrôle : API prête (base, stockage) puis worker actif (battement de moins de 2 min)
curl -fsS https://$DOMAIN/api/v1/health/ready
curl -fsS https://$DOMAIN/api/v1/health/worker
```

## Retour arrière de l'application

Si la nouvelle version pose problème et que ses migrations sont **additives** (ajout de colonnes, de tables, de contraintes compatibles) :

```bash
git checkout <étiquette précédente>
APP_VERSION=<précédente> docker compose -f docker-compose.prod.yml up -d api worker web
```

Si une migration a transformé ou supprimé des données, restaurer la sauvegarde de l'étape 1 (`docs/sauvegarde-restauration.md`), puis redémarrer la version précédente. Les notes de version signalent toute migration non additive.
