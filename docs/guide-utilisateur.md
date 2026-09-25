# Guide utilisateur — chef de parc et conducteur

Ce guide décrit l'usage courant des écrans de coûts, de fournisseurs et d'alertes (CDC 8, 9 et 10.2), ainsi que le transfert d'un véhicule entre sociétés (CDC 2.4). L'application est en français ; les dates et heures s'affichent dans le fuseau du groupe (Africa/Tunis par défaut, modifiable par l'administrateur dans Administration › Organisation) et les montants en dinars tunisiens avec trois décimales (TTC).

Chaque écran n'affiche que les sociétés de votre périmètre ; le serveur refuse toute donnée hors périmètre, même demandée directement par une adresse.

## Carburant (`/carburant`)

- **Saisir un plein** (personnel) : véhicule, date et heure, station, litres, prix unitaire facultatif, montant total, plein complet ou partiel, compteur et ticket. Un écart entre litres × prix unitaire et montant total est signalé selon la tolérance paramétrée ; il n'est jamais corrigé automatiquement.
- **Conducteur** : depuis « Mon véhicule », « Déclarer un plein » envoie un brouillon (ticket en photo). Il ne produit ni dépense ni relevé accepté tant qu'un chef ne l'a pas validé.
- **Valider ou rejeter** une déclaration depuis la fiche du plein. Une seconde validation est refusée : un plein validé produit exactement une dépense de synthèse, accessible par le lien « Dépense de synthèse » de sa fiche.
- **Consommation** (fiche du véhicule) : calculée entre deux pleins complets admissibles avec tous les achats intermédiaires ; sinon « N/D » avec le motif. C'est une estimation fondée sur les saisies, pas une mesure.

## Dépenses (`/depenses`)

Le registre réunit toutes les dépenses et tous les avoirs du parc. Chaque coût reste imputé à la société qui gérait le véhicule à sa date, même après un transfert.

- **Saisir une dépense** ou un avoir (permission « Saisir des coûts ») : véhicule ou société (dépense sans véhicule : assurance flotte, taxes, location, autre), date, catégorie, fournisseur, référence, montant TTC et justificatif. Une même référence d'un même fournisseur n'est acceptée qu'une fois dans la société ; renvoyer le même formulaire ne crée pas de seconde écriture. Une dépense saisie par le personnel est validée dès la saisie (voir DECISIONS.md, D-016).
- **Consulter** (permission « Consulter les coûts ») : filtres par société, véhicule ou « sans véhicule », catégorie, nature, état, source, période et recherche. La synthèse applique les mêmes filtres et ne compte que les dépenses validées : coût d'exploitation par catégorie, ligne « Non ventilé » (dépenses sans véhicule, jamais réparties) et dépenses hors coût d'exploitation (achats de véhicules par défaut).
- **Détail d'une dépense** : un clic sur la date ouvre sa fiche (source, justificatif, incident, avoir d'origine) et la chaîne des versions (« Corrige la version précédente », « Remplacée par la version corrigée »).
- **Corriger** ou **annuler** (chef de parc ou administrateur, avec motif) : une dépense validée n'est jamais modifiée ; la correction crée une nouvelle version et l'annulation retire le coût de sa période d'origine. Les dépenses de synthèse se corrigent depuis leur plein ou leur intervention.
- **Avoir** : réduit le coût (net négatif possible) ; ce n'est pas un paiement.

Le registre ne remplace pas la comptabilité et ne calcule aucune obligation fiscale : il n'y a ni écriture comptable, ni TVA déductible, ni déclaration.

## Fournisseurs (`/fournisseurs`)

- **Répertoire par société** : nom, catégorie (garage, station, assurance, loueur, autre — liste fermée), contact, téléphone, e-mail, adresse et notes. Un nom n'est porté que par un seul fournisseur actif de la société (majuscules, accents et espaces ignorés).
- **Rechercher** par nom ou contact, filtrer par catégorie et par statut (actifs par défaut, archivés à la demande).
- **Fiche** : coordonnées et **historique des dépenses** du fournisseur (visible avec la permission « Consulter les coûts » ; chaque ligne ouvre le détail de la dépense).
- **Archiver** (chef de parc ou administrateur) : le fournisseur n'est plus proposé dans les nouvelles saisies, son historique reste visible ; il peut être réactivé.
- **Copier vers une autre société** (chef de parc des deux sociétés ou administrateur) : nouvelle fiche active, sans historique ni montants.

Aucune gestion des commandes, du stock ni des comptes fournisseurs n'est livrée en V1 : le module se limite au répertoire.

## Alertes (`/alertes`)

- Chaque alerte indique son type, sa gravité, l'objet et la société concernés, la condition, la date de déclenchement, son **responsable** (ou « Non attribué ») et un lien vers l'action utile.
- **Lue** est propre à chaque utilisateur et ne résout rien : une vidange en retard reste en retard.
- **Reporter** jusqu'à une date (motif obligatoire) masque l'alerte pour vous seul ; le motif est visible des autres et le statut de retard est conservé.
- Une alerte se **résout** seule quand sa condition cesse (entretien réalisé, document renouvelé, relevé récent, retour constaté, incident pris en charge). La récurrence suivante (échéance suivante, nouvelle version d'un document) crée une nouvelle alerte ; l'ancienne reste dans l'historique des alertes résolues.
- **E-mails** : lorsque le serveur SMTP est configuré, les alertes critiques et un récapitulatif quotidien à 08:00 (heure locale) sont envoyés aux destinataires autorisés, selon leurs préférences (Profil › Notifications). Sans SMTP, l'application affiche « Canal e-mail non configuré » (Administration › Notifications) et aucun envoi n'est annoncé. Un e-mail peut exceptionnellement être reçu deux fois (voir docs/exploitation.md).

## Transfert d'un véhicule (administrateur)

Depuis la fiche du véhicule, le bouton « Transférer » ouvre un aperçu calculé par le serveur :

- **Objets bloquants** : utilisation en cours, immobilisation active, intervention ouverte ou réservation future non traitée. Chacun a un lien vers son écran de traitement ; le transfert est refusé tant qu'il en reste un.
- **Avertissements** à acquitter : relevés en attente, pleins soumis, incidents ouverts.
- **Décisions explicites** : affectation habituelle, plans d'entretien (conserver avec un responsable éligible dans la société destinataire — administrateurs groupe compris — ou désactiver), site, service, documents partagés, relevé de transfert ou motif d'absence.

Les dépenses et événements passés restent à la société d'origine ; la société destinataire ne voit pas les anciens coûts.
