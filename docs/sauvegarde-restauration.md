# Sauvegarde et restauration

## Ce qui est sauvegardé

1. La base PostgreSQL (`pg_dump` au format personnalisé, schéma et données, dont l'historique des migrations).
2. Les pièces jointes privées (volume `storage`).

L'ordre est **base puis fichiers**. Les fichiers ne sont jamais modifiés après leur écriture ; seules les pièces jointes temporaires non rattachées sont purgées. Un fichier présent dans l'archive mais absent de la base est ignoré ; un fichier référencé par la base est présent, sauf une pièce jointe temporaire purgée entre les deux étapes (aucune donnée métier).

## Sauvegarde quotidienne

```bash
BACKUP_ENCRYPTION_KEY='…clé conservée hors du serveur…' \
BACKUP_REMOTE='offsite:parc-auto' \
scripts/ops/backup.sh
```

- Archive `backups/parc-auto-AAAAMMJJTHHMMSSZ.tar.enc` chiffrée en AES-256 (clé dérivée par PBKDF2, 200 000 itérations), avec son empreinte `.sha256` et un manifeste interne (empreinte de chaque partie).
- Rétention locale : 30 jours (`BACKUP_RETENTION_DAYS`).
- Copie hors du VPS : `rclone copy` vers `BACKUP_REMOTE` (stockage objet, autre serveur). **Dépendance externe à configurer** : sans `BACKUP_REMOTE`, le script le signale et aucune copie hors site n'existe.

Planification (cron de l'hôte, 02:30 locale) :

```cron
30 2 * * * cd /opt/parc-auto && BACKUP_ENCRYPTION_KEY_FILE=/root/.parc-auto-backup-key sh -c 'BACKUP_ENCRYPTION_KEY=$(cat $BACKUP_ENCRYPTION_KEY_FILE) scripts/ops/backup.sh' >> /var/log/parc-auto-backup.log 2>&1
```

## Restauration

Toujours restaurer d'abord dans un **projet isolé** (volumes distincts), vérifier, puis seulement restaurer en production.

```bash
BACKUP_ENCRYPTION_KEY=… scripts/ops/restore.sh backups/parc-auto-….tar.enc parc-auto-restauration
```

Le script vérifie l'empreinte de l'archive et du manifeste, arrête l'application du projet ciblé, recrée la base, vide les tables techniques propres à l'instance sauvegardée (battements et baux des anciens workers), restaure les fichiers puis redémarre l'API et le worker.

### Exercice de restauration automatisé

```bash
BACKUP_ENCRYPTION_KEY=… scripts/ops/restore-test.sh backups/parc-auto-….tar.enc
```

Le script restaure l'archive dans un projet compose isolé et nommé à la volée (volumes distincts, aucun port exposé, pas de proxy), puis vérifie :

1. l'API restaurée répond « prêt » (`/api/v1/health/ready` : base et stockage), puis le worker restauré bat (`/api/v1/health/worker` : « actif ») ;
2. l'historique des migrations et les volumes principaux (organisations, véhicules, conducteurs, événements d'audit) ;
3. chaque pièce jointe rattachée et non supprimée a son fichier, avec la même empreinte SHA-256 qu'en base.

Il affiche « RÉUSSI » avec la durée, puis supprime le projet isolé (option `--garder` pour l'examiner). Tout écart arrête l'exercice en erreur.

## Objectifs à mesurer en recette

Perte maximale de données visée : 24 heures (sauvegarde quotidienne). Reprise visée : 4 heures. Ce sont des objectifs de conception à mesurer lors de l'exercice de restauration consigné dans `docs/RECETTE.md` (T30), pas des garanties.
