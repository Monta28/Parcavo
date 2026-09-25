# Guide du chef de parc

Ce guide s’adresse au chef de parc. Il signale aussi ce que peuvent faire l’opérateur et le lecteur quand leurs droits diffèrent. Les sections réservées à l’administrateur groupe sont regroupées à la fin, dans « Administration ». Le conducteur a son propre guide : [guide du conducteur](guide-conducteur.md).

Conventions :

- Un texte entre guillemets (« Nouvelle remise ») reproduit exactement un libellé de l’écran : bouton, onglet, champ, statut ou message.
- Les dates et heures s’affichent dans le fuseau du groupe (Africa/Tunis par défaut). Les montants sont en dinars tunisiens (TND), avec trois décimales, toutes taxes comprises.
- Le serveur décide seul des droits. Un bouton masqué signifie que votre rôle ne permet pas l’action ; un bouton visible peut encore être refusé par le serveur, avec un message.

Guides thématiques à lire en complément :

- [guide utilisateur : carburant, dépenses, fournisseurs, alertes et transfert](guide-utilisateur.md) ;
- [guide : catalogue initial, conformité documentaire et dérogations](guide-conformite-entretien.md) ;
- [guide des imports](guide-imports.md).

## Ce que l’application ne fait pas

Lisez ces limites avant de commencer. Elles sont voulues.

- **Navigateur uniquement.** Il n’y a aucune application native à installer. Tout passe par le navigateur, sur ordinateur comme sur téléphone.
- **Pas de mode hors ligne.** Sans réseau, rien n’est enregistré et aucun envoi n’est rejoué plus tard.
- **Aucune position en temps réel.** La localisation est déclarative : l’écran affiche la « Dernière localisation déclarée », avec sa date et son auteur. Le module télématique lit le kilométrage et le carburant transmis par le fournisseur, jamais une position.
- **La dérogation n’est pas une autorisation de circuler.** L’écran le rappelle partout où elle est saisie : « La dérogation est un mécanisme administratif interne au parc : elle ne constitue pas une autorisation juridique de circuler et ne modifie ni l’expiration du document ni la règle paramétrée. »
- **Le registre des dépenses n’est pas une comptabilité.** L’écran le rappelle : « Le registre ne remplace pas la comptabilité et ne calcule aucune obligation fiscale ».
- **L’e-mail dépend du serveur d’envoi (SMTP).** Sans serveur d’envoi (SMTP) configuré par l’administrateur, aucun e-mail n’est envoyé : ni alerte, ni invitation, ni lien de mot de passe. Le centre d’alertes fonctionne dans tous les cas.
- **La confirmation nominative n’est pas une signature.** La fiche de remise l’indique : « Ceci n’est pas une signature certifiée. »
- **La consommation est une estimation.** Elle est calculée à partir des pleins saisis, pas mesurée.

## Rôles et droits

Chaque compte reçoit un rôle par société. Le rôle fixe des permissions par défaut ; l’administrateur peut en retirer ou en ajouter (voir « Utilisateurs » en fin de guide).

| Rôle | Ce qu’il fait | Permissions par défaut |
| --- | --- | --- |
| « Administrateur groupe » | Tout, sur toutes les sociétés, plus l’administration | Toutes |
| « Chef de parc » | Gestion complète de ses sociétés : décisions, validations, corrections, dérogations | « Consulter les coûts », « Saisir des coûts », « Exporter les rapports », « Valider les relevés », « Corriger les relevés acceptés », « Clôturer les interventions d'entretien », « Gérer les documents », « Accorder des dérogations » |
| « Opérateur » | Saisie au quotidien : remises, restitutions, relevés, réservations, interventions, incidents, pleins | « Saisir des coûts », « Gérer les documents » |
| « Lecteur » | Consultation seule | Aucune |
| « Conducteur » | Espace « Mon véhicule » et ses propres « Documents » uniquement | Aucune |

À retenir :

- Sans « Consulter les coûts », les montants sont masqués et l’entrée « Dépenses » disparaît du menu. C’est le cas par défaut de l’opérateur et du lecteur.
- Sans « Exporter les rapports », les rapports restent consultables à l’écran, sans export.
- La validation des relevés, la correction, le remplacement de compteur, la dérogation et la clôture d’une intervention dépendent chacun d’une permission. Un opérateur à qui l’administrateur accorde la permission peut donc aussi le faire, sauf mention contraire dans ce guide.

## 1. Connexion et choix de la société

### Se connecter

1. Ouvrez l’adresse de l’application dans le navigateur.
2. Saisissez « Adresse e-mail » et « Mot de passe ».
3. Cliquez sur « Se connecter ».
4. Vous arrivez sur le « Tableau de bord ». Un compte conducteur arrive sur « Mon véhicule ».

Il n’existe aucune inscription publique : l’administrateur crée les comptes.

Si la session a expiré (12 heures par défaut) ou a été révoquée, l’écran de connexion affiche « Votre session a expiré ou a été révoquée. Reconnectez-vous. ». Après connexion, vous revenez sur la page demandée.

### Mot de passe oublié

1. Cliquez sur « Mot de passe oublié ? ».
2. Saisissez votre adresse, puis « Envoyer le lien ».
3. Si le serveur d’envoi est configuré, vous recevez un lien. Utilisez-le vite : il expire au bout de 30 minutes.

Sans serveur d’envoi, aucun e-mail ne part. Demandez à l’administrateur un lien d’accès ou un nouveau mot de passe. Il n’existe pas d’écran pour changer soi-même son mot de passe une fois connecté.

### Choisir la société courante

En haut de l’écran, le sélecteur « Société courante » apparaît si vous gérez plusieurs sociétés.

1. Ouvrez le sélecteur.
2. Choisissez une société, ou « Toutes mes sociétés ».
3. L’écran se recharge avec ce périmètre.

Ce choix est un filtre d’affichage, mémorisé sur ce navigateur. Il ne donne aucun droit : le serveur limite toujours les données à vos sociétés. Certains droits affichés dépendent de la société choisie. Par exemple, le registre des dépenses demande de choisir une société où vous avez « Consulter les coûts ».

Pour quitter, cliquez sur « Déconnexion ».

## 2. Tableau de bord et alertes

### Tableau de bord

Le « Tableau de bord » regroupe trois blocs d’indicateurs : « État du parc », « Points de vigilance » et « Activité de la période ». Les états (parc actif, entretiens urgents, documents expirés…) sont instantanés. Les flux (interventions, coûts) portent sur la « Période des flux », par défaut le mois civil en cours.

1. Pour changer la période, saisissez « Du » et « Au », puis « Appliquer ». « Mois en cours » revient à la période par défaut.
2. Pour un seul véhicule, utilisez « Filtrer sur un véhicule ».
3. Sur une tuile, « Voir la liste » ouvre la liste justificative et « Définition et source » explique le calcul.
4. « Actualiser » recharge les chiffres.

Plus bas :

- « Alertes prioritaires » : les alertes actives qui vous concernent, de la plus grave à la plus récente.
- « Retours attendus » : les utilisations dont le retour est prévu aujourd’hui ou déjà dépassé.
- « Actions rapides » : « Nouvelle remise », « Saisir des relevés », « Nouveau véhicule », « Nouveau conducteur » (opérateur, chef de parc, administrateur) et « Rechercher un véhicule » (tous).

Les coûts ne s’affichent qu’avec « Consulter les coûts ». Sinon, la tuile est remplacée par une ligne qui explique pourquoi.

### Centre d’alertes

Menu « Alertes ». Les compteurs en haut (« Actives », « Critiques », « Urgentes », « Attention », « Information », « Non lues », « Reportées par moi ») filtrent la liste d’un clic.

Pour chaque alerte :

1. « Voir l’objet concerné » ouvre l’écran où agir.
2. « Marquer comme lue » ne vaut que pour vous et ne résout rien.
3. « Reporter » ouvre « Reporter l’alerte » : choisissez « Reporter jusqu’au », saisissez le « Motif du report », puis « Confirmer le report ». Le report ne vaut que pour vous ; le motif est visible des autres.
4. « Annuler mon report » remet l’alerte dans votre liste.

Une alerte se résout seule quand sa condition disparaît : entretien réalisé, document renouvelé, relevé saisi, retour enregistré. Exemples de types : « Entretien à prévoir / à faire / en retard », « Document manquant », « Kilométrage ancien », « Relevé à valider », « Retour dépassé », « Réservation compromise », « Incident critique non traité », « Départ sans relevé », « Distance non validée ». Détails : [guide utilisateur, section Alertes](guide-utilisateur.md#alertes-alertes).

## 3. Véhicules

### Trouver un véhicule

Menu « Véhicules ».

1. Tapez dans « Rechercher » : code, immatriculation, marque ou VIN.
2. Filtrez par « Statut opérationnel » (« Disponible », « En utilisation », « Immobilisé »), par « Cycle de vie » et par « Catégorie ». Par défaut, la liste montre « Actifs et hors service ».
3. Cliquez sur une ligne pour ouvrir la fiche.

### Créer un véhicule

Opérateur, chef de parc ou administrateur de la société.

1. Cliquez sur « Nouveau véhicule ».
2. Renseignez au minimum la société, « Code interne », « Immatriculation ou identifiant provisoire » (cochez « Identifiant provisoire » si besoin), la catégorie, la marque et le modèle.
3. Cliquez sur « Créer le véhicule ».
4. Saisissez ensuite le premier kilométrage depuis l’onglet « Kilométrage » de la fiche.

Pour un parc entier, préférez l’import (section 18).

### La fiche du véhicule

L’en-tête affiche le cycle de vie, l’état opérationnel, la fraîcheur du kilométrage et les documents bloquants. Les boutons d’en-tête :

- « Fiche imprimable » (tous les membres du personnel) ;
- « Modifier » (opérateur, chef de parc, administrateur) ;
- « Changer le cycle de vie » (chef de parc, administrateur) ;
- « Transférer » (administrateur seulement).

| Onglet | Contenu |
| --- | --- |
| « Synthèse » | « Responsable habituel », « Utilisateur actuel », « Dernière localisation déclarée », « Dernier relevé validé », « Prochaines échéances », « Conformité et suivi », caractéristiques |
| « Localisation » | Déclarations de lieu et bouton « Déclarer une localisation » |
| « Kilométrage » | « Compteur courant », « Compteurs successifs », « Historique des relevés » (section 8) |
| « Photos et QR » | Photos du véhicule et « QR code interne » |
| « Affectations » | Responsable habituel et historique (section 6) |
| « Réservations » | Créneaux à venir ou historique complet, lien « Ouvrir le planning du véhicule » |
| « Entretien » | « Plans d’entretien » et « Interventions » du véhicule |
| « Documents » | « Conformité documentaire » et « Versions enregistrées » |
| « Carburant » | « Consommation estimée » et « Pleins du véhicule » (section 15) |
| « Historique » | « Chronologie du véhicule », filtrable par catégorie |

Dans l’« Historique », un événement marqué « Vue technique · autre société » vient d’une autre société qui a géré le véhicule : il s’affiche sans auteur, texte libre, montant ni fournisseur.

### Déclarer une localisation

Opérateur, chef de parc ou administrateur.

1. Onglet « Localisation », cliquez sur « Déclarer une localisation ».
2. Choisissez « Site » ou « Lieu libre ».
3. Indiquez la « Date d’observation » et, si utile, un « Commentaire ».
4. Cliquez sur « Déclarer ».

Une remise ou une restitution crée aussi une déclaration. L’écran le rappelle : « Aucune position temps réel n’est suivie. »

### Fiche imprimable

1. Cliquez sur « Fiche imprimable ».
2. Choisissez la période avec « Période du » et « au ».
3. Cliquez sur « Imprimer ». « Retour au dossier » revient à la fiche.

La fiche reprend l’identité, l’état, le compteur, le responsable habituel, les plans d’entretien, les documents et la distance de la période. Les coûts n’y figurent qu’avec « Consulter les coûts ».

### QR code du véhicule

Onglet « Photos et QR », carte « QR code interne ».

1. Cliquez sur « Imprimer » et collez le QR code dans le véhicule.
2. En cas de perte ou de fuite, cliquez sur « Régénérer » (chef de parc, administrateur). L’ancien code n’ouvre plus la fiche.

Le QR code ne contient qu’un identifiant opaque. Scanné, il demande une connexion puis ouvre la fiche selon les droits du compte. Il n’affecte aucun conducteur et ne crée aucune remise.

### Cycle de vie

Chef de parc ou administrateur.

1. Cliquez sur « Changer le cycle de vie ».
2. Choisissez le « Nouveau statut » : « Actif », « Hors service », « Cédé » ou « Archivé ».
3. Saisissez le « Motif (obligatoire) », puis « Confirmer ».

La cession et l’archivage sont refusés tant qu’il reste une utilisation en cours, une immobilisation active, une intervention ouverte ou une réservation future. L’archivage est aussi refusé tant qu’un incident est ouvert ou en traitement. Un dossier n’est jamais supprimé.

### Transfert vers une autre société

Seul l’administrateur transfère un véhicule, avec le bouton « Transférer ». L’aperçu liste les « Opérations bloquantes », les avertissements et les décisions à prendre. Le détail est dans le [guide utilisateur, section Transfert](guide-utilisateur.md#transfert-dun-véhicule-administrateur). En tant que chef de parc, préparez le transfert : clôturez l’utilisation en cours, les immobilisations et les interventions ouvertes, et traitez les réservations futures.

## 4. Conducteurs

Menu « Conducteurs ». La liste affiche le permis et l’utilisation en cours.

### Créer un conducteur

Opérateur, chef de parc ou administrateur.

1. Cliquez sur « Nouveau conducteur ».
2. Renseignez la société, « Identifiant interne », « Nom » et « Prénom ». L’identifiant n’est plus modifiable ensuite.
3. Cliquez sur « Créer le conducteur ».

### Fiche du conducteur

Onglets « Fiche et permis », « Utilisations », « Incidents et soumissions » et « Documents ».

- **Permis** : « Renseigner le permis » ou « Modifier le permis », puis « Enregistrer le permis ». Le permis se gère ici, pas comme un document. La catégorie de permis exigée par la catégorie du véhicule est contrôlée à la remise et à la réservation.
- **Désactiver** (chef de parc, administrateur) : bouton « Désactiver », motif obligatoire. Refusé tant qu’une utilisation est en cours. Les réservations confirmées à venir ne sont annulées que si vous cochez « Annuler ces réservations avec la désactivation ». L’affectation habituelle est clôturée. « Réactiver » rend la fiche de nouveau utilisable.
- **Compte utilisateur** : seul l’administrateur lie un compte à un conducteur, depuis la fiche de l’utilisateur. Sans compte, le conducteur n’a pas accès à « Mon véhicule ».

## 5. Planning et réservations

Menu « Planning ». Deux vues : « Planning » et « Réservations ». Le conducteur ne voit que ses propres réservations.

### Lire le planning

1. Choisissez la « Vue » : « Jour », « Semaine » ou « Mois ».
2. Choisissez l’« Affichage » : « Chronologie » ou « Liste ».
3. Naviguez avec « Aujourd’hui » et les flèches, ou « Aller à la date ».
4. Cochez « Masquer les véhicules sans élément » pour alléger.

Le planning montre les réservations, utilisations, immobilisations et interventions. Un chevauchement entre une intervention et une réservation confirmée est signalé (« Chevauchement signalé »), sans blocage.

### Créer une réservation

Opérateur, chef de parc ou administrateur.

1. Cliquez sur « Nouvelle réservation ».
2. Choisissez le véhicule, puis le conducteur (conducteurs actifs de la société du véhicule).
3. Saisissez « Début prévu (inclus) », « Fin prévue (exclue) » et le « Motif ». La destination et le commentaire sont facultatifs.
4. Cliquez sur « Confirmer la réservation ».

La création vaut confirmation après contrôles : chevauchements, conducteur actif, permis, documents bloquants. Deux créneaux qui se suivent sont admis ; deux créneaux qui se chevauchent sont refusés.

Si un document bloquant ou le permis bloque la réservation, une personne qui a « Accorder des dérogations » peut saisir le « Motif de la dérogation » puis cliquer sur « Confirmer avec dérogation ». Cette dérogation ne vaut pas pour le départ : la remise refait tous les contrôles.

### Gérer une réservation

Depuis la liste « Réservations » ou le détail d’une réservation :

- « Modifier » : motif obligatoire. Après le début prévu, seule la fin se modifie.
- « Convertir en remise » : ouvre la remise avec le véhicule et le conducteur de la réservation (section 7).
- « Déclarer non honorée » (ou « Non honorée » dans le détail) : possible à partir du début prévu plus un délai de grâce (60 minutes par défaut). Sans remise, le constat est fait automatiquement à la fin prévue.
- « Annuler la réservation » : motif obligatoire, définitif.

## 6. Affectations : le responsable habituel

Le responsable habituel est la personne responsable du véhicule sur une période. Ce n’est pas une preuve qu’elle le conduit. La personne qui conduit est celle de l’utilisation en cours. Une utilisation ponctuelle ne remplace jamais le responsable habituel.

Opérateur, chef de parc ou administrateur, depuis l’onglet « Affectations » du véhicule :

1. Cliquez sur « Nommer un responsable habituel ».
2. Choisissez le conducteur, le « Début de la responsabilité » et, si besoin, la « Fin (facultative) ».
3. S’il existe déjà un responsable en cours, cochez la case qui commence par « Remplacer ». Sans elle, la nomination est refusée.
4. Cliquez sur « Nommer le responsable ».

Pour arrêter une affectation, cliquez sur « Terminer l’affectation » et saisissez un motif. « Modifier » change la fin prévue et les notes d’une affectation en cours.

La fiche du conducteur liste les « Véhicules dont il est responsable habituel ». Si l’administrateur active le paramètre qui le permet, le conducteur fait, sans utilisation en cours, les trois actions de « Mon véhicule » sur ce véhicule : son relevé arrive « En attente » dans la file de validation, son ticket « Soumis (à valider) », et son signalement ouvre un incident rattaché à lui mais à aucune utilisation. Pendant une utilisation en cours, seul le véhicule remis est ouvert (voir le [guide du conducteur](guide-conducteur.md)).

## 7. Remise et restitution

Menu « Utilisations ». Une utilisation est la possession réelle d’un véhicule : une remise l’ouvre, une restitution la termine. Opérateur, chef de parc ou administrateur de la société.

### Remettre un véhicule

1. Cliquez sur « Nouvelle remise » (ou « Convertir en remise » depuis une réservation).
2. Choisissez le « Véhicule disponible » et le « Conducteur actif ».
3. Si une réservation confirmée existe pour eux, choisissez-la dans « Réservation à convertir ». Elle passera à « Convertie ».
4. Lisez les « Contrôles avant remise ». Le serveur les calcule et les refait à l’enregistrement. Chaque blocage est marqué « Bloquant » ou « Dérogation possible ».
5. Remplissez la remise : « Date et heure réelles de la remise », « Retour prévu », « Motif ». Si le conducteur est responsable habituel du véhicule avec une fin prévue, « Utiliser la fin de l’affectation habituelle » reprend cette date.
6. Saisissez le « Compteur affiché (km) », lu sur le tableau de bord, jamais estimé. Une photo du compteur est facultative.
7. Indiquez le « Lieu de remise » : « Site de la société » ou « Lieu libre ».
8. Si besoin : « Niveau de carburant approximatif », « Clés, documents et accessoires remis » (liste paramétrée par société), « Observations (réserves à la remise) », « Photos de la remise », « Confirmation nominative (facultative) ».
9. Cliquez sur « Vérifier et enregistrer la remise », relisez, puis « Confirmer la remise ».

Le relevé du compteur doit être accepté par le serveur pour valider le départ. Un conducteur ou un véhicule ne peut avoir qu’une utilisation en cours.

### Départ bloqué et dérogation

Les blocages marqués « Dérogation possible » (document bloquant manquant ou expiré, permis qui ne couvre pas la catégorie) se lèvent par une dérogation motivée. Il faut la permission « Accorder des dérogations » (chef de parc et administrateur par défaut).

1. Dans « Contrôles avant remise », saisissez le « Motif de la dérogation » (5 caractères au moins).
2. Enregistrez la remise comme d’habitude.

La dérogation est enregistrée avec votre nom et son motif dans le journal d’audit. Elle ne modifie ni l’expiration du document ni la règle. Elle ne vaut ni assurance, ni visite technique, ni permis. L’utilisation porte ensuite la mention « Départ avec dérogation ». Un blocage marqué « Bloquant » (véhicule immobilisé, utilisation déjà en cours…) ne se lève pas par dérogation. Voir aussi le [guide de conformité](guide-conformite-entretien.md#blocage-dun-départ-et-dérogation).

**Départ sans relevé.** Si le compteur est illisible, une personne qui a « Accorder des dérogations » peut choisir « Départ sans relevé (exception motivée) » et saisir le motif. Une alerte persistante est créée et la distance restera indéterminée.

### Prolonger le retour prévu

Sur la fiche de l’utilisation, « Prolonger le retour prévu », saisissez le « Nouveau retour prévu » et un motif, puis « Prolonger ». Un retard ne clôture jamais rien : l’utilisation reste en cours, marquée « Retour dépassé », et les réservations suivantes touchées sont signalées.

### Enregistrer la restitution

Le retour reste toujours possible, même si le véhicule est immobilisé ou hors service, et même si un document a expiré.

1. Ouvrez l’utilisation, puis cliquez sur « Enregistrer le retour ».
2. Saisissez « Date et heure réelles du retour » et le compteur.
3. Indiquez le « Lieu de restitution », le carburant, la « Checklist de retour », les « Observations (réserves au retour) » et les « Photos du retour ».
4. En cas de dommage, cochez « Déclarer un dommage (ouvre un incident) » et décrivez-le. L’incident est ouvert au retour ; le retour ne le clôture pas.
5. Cliquez sur « Enregistrer le retour », puis « Confirmer le retour ».

L’utilisation passe « Terminée ». La distance est validée seulement avec deux relevés acceptés, au départ et au retour.

**Retour sans relevé.** Si le relevé manque ou est contesté, une personne qui a « Accorder des dérogations » peut choisir « Retour constaté sans relevé (exception motivée) ». Le trajet reste « Distance non validée » jusqu’à régularisation.

### Régulariser la distance

Chef de parc ou administrateur (permission « Accorder des dérogations »), quand le retour a été constaté sans relevé ou que le relevé de retour a été rejeté.

1. Sur la fiche de l’utilisation, cliquez sur « Régulariser la distance ».
2. Choisissez « Saisir le relevé du retour (photo retrouvée, compteur relu) » ou « Rattacher un relevé accepté déjà enregistré ».
3. Saisissez la valeur et l’instant de lecture (entre le retour et la remise suivante), ou choisissez le relevé.
4. Saisissez le motif (5 caractères au moins), puis « Régulariser ».

Un relevé qui demanderait une validation est refusé ici : la valeur doit être lue, jamais estimée.

### Fiche de remise et de restitution

Sur la fiche de l’utilisation, cliquez sur « Fiche imprimable », puis « Imprimer ». La fiche reprend les noms, dates, relevés, accessoires, réserves et incidents. Elle comporte des « Signatures manuscrites » à compléter à la main. La confirmation nominative saisie dans l’application n’a pas valeur de signature électronique.

## 8. Kilométrage

Menu « Kilométrage ». Trois onglets : « Saisie rapide », « À valider » et « Historique ». Seuls les relevés acceptés comptent dans les calculs.

### Saisie rapide

Opérateur, chef de parc ou administrateur.

1. Onglet « Saisie rapide ». Réglez la « Date et heure d’observation par défaut ».
2. Recherchez les véhicules, puis saisissez la valeur affichée dans « Nouveau relevé (km) ». Les lignes vides sont ignorées.
3. Joignez une photo du compteur si vous l’avez.
4. Cliquez sur « Enregistrer les relevés » (100 lignes au plus par envoi).
5. Lisez le « Résultat du dernier envoi » : chaque ligne est acceptée, mise en attente avec un motif, ou refusée avec un motif.

Une diminution ou une rupture de chronologie est refusée. Une hausse jugée improbable est mise en attente. Le seuil de plausibilité est un filtre administratif paramétré, pas une limite physique.

Un relevé isolé se saisit aussi depuis la fiche du véhicule : onglet « Kilométrage », « Ajouter un relevé ».

### Valider ou rejeter

Permission « Valider les relevés » (chef de parc et administrateur par défaut). Sans elle, la file s’affiche en consultation seule.

1. Onglet « À valider ». Le nombre de relevés en attente s’affiche sur l’onglet.
2. Sur la ligne, lisez le motif d’attente et la photo.
3. Cliquez sur « Valider » : saisissez un « Commentaire de validation (facultatif) », puis « Valider le relevé ».
4. Ou cliquez sur « Rejeter » : saisissez le « Motif du rejet », puis « Rejeter le relevé ».

Le conducteur voit le résultat et le motif dans « Mon véhicule ». Un relevé rejeté reste dans l’historique et ne compte dans aucun calcul.

### Corriger un relevé accepté

Permission « Corriger les relevés acceptés » (chef de parc et administrateur par défaut).

1. Onglet « Historique », ligne du relevé, cliquez sur « Corriger ».
2. Saisissez la « Valeur physique corrigée (km) », la date si besoin, et le « Motif de la correction ».
3. Cliquez sur « Enregistrer la correction ».

L’original n’est jamais écrasé : il passe au statut « Remplacé » et un nouveau relevé est créé. Les distances, échéances et consommations qui en dépendent sont recalculées. Une correction qui rompt la chronologie est refusée.

### Initialiser ou remplacer le compteur

Depuis l’onglet « Kilométrage » de la fiche du véhicule :

- **« Initialiser le compteur »** (chef de parc, administrateur ; seulement tant qu’aucun relevé n’est accepté). Choisissez « Compteur d’origine : cumul égal à la valeur affichée », « Compteur non d’origine : base cumulée validée connue » ou « Historique antérieur inconnu : cumul incomplet ».
- **« Remplacement de compteur »** (permission « Corriger les relevés acceptés ») :
  1. Saisissez la « Date du remplacement » et la « Valeur affichée par le nouveau compteur (km) ».
  2. Si elle est lisible, saisissez la « Dernière valeur lue sur l’ancien compteur (km) ».
  3. Saisissez le « Motif du remplacement » et joignez le « Justificatif du remplacement » (photo, facture ou attestation), obligatoire.
  4. Cliquez sur « Enregistrer le remplacement ».

L’ancien compteur est clôturé et un nouveau s’ouvre à partir du dernier cumul validé : aucune distance n’est inventée. Le tableau « Compteurs successifs » montre chaque compteur. Sans base connue, le cumul est marqué « Cumul incomplet » et les échéances en kilomètres le signalent.

## 9. Entretiens

Menu « Entretiens ». Onglets « Échéances », « Calendrier », « Catalogue » et « Modèles ». Les statuts de plan sont « À jour », « À prévoir », « À faire », « En retard » et « Incomplet ». Ils sont calculés par le serveur.

### Catalogue et catalogue initial

Le catalogue des opérations est commun au groupe. Seul l’administrateur le modifie : « Nouvelle opération », « Modifier », « Archiver », « Réactiver ».

Sur un catalogue vide, l’administrateur peut cliquer sur « Installer le catalogue initial ». Seules les opérations absentes sont ajoutées. Aucun intervalle n’est imposé. Détails dans le [guide de conformité](guide-conformite-entretien.md#catalogue-initial).

### Plans d’entretien

Chef de parc ou administrateur de la société du véhicule. L’opérateur et le lecteur consultent.

1. Onglet « Échéances », cliquez sur « Nouveau plan ».
2. Choisissez le véhicule et l’opération. Un seul plan par véhicule et par opération.
3. Saisissez au moins un intervalle en km ou en temps (mois ou jours). Le préavis est facultatif.
4. Choisissez la « Base de calcul » : « Dernière opération connue », « Base technique (aucune opération) », « Échéance initiale » ou « Aucune base (plan incomplet) ».
5. Choisissez les « Relevés admis pour le calcul » et, si besoin, un responsable.
6. Cliquez sur « Créer le plan ».

Sans base, le plan est « Incomplet » avec une alerte. Aucune fausse opération n’est créée.

Filtres utiles : « Urgents uniquement (à faire, en retard) » et « Inclure les plans désactivés ». Un clic sur « Détail » ouvre le plan, avec « Modifier », « Désactiver », « Réactiver » et « Nouvelle intervention ».

### Modifier un plan avec aperçu

1. Dans le détail du plan, cliquez sur « Modifier ».
2. Changez les intervalles, préavis ou sources, et saisissez le « Motif de la modification ».
3. Cliquez sur « Prévisualiser l’impact ». Le serveur calcule l’avant et l’après sans rien enregistrer.
4. Vérifiez le tableau, puis « Confirmer la modification ».

L’historique ne change pas ; seules les échéances futures sont recalculées. « Désactiver le plan » arrête ses échéances et alertes ; « Réactiver le plan » les recalcule.

### Modèles de plans et aperçu d’impact

Un modèle regroupe des opérations et leurs intervalles, à copier sur plusieurs véhicules. L’administrateur crée les modèles (« Nouveau modèle »). Le chef de parc et l’administrateur les appliquent.

1. Onglet « Modèles », sur un modèle actif, cliquez sur « Appliquer à des véhicules ».
2. Choisissez la société et cochez les véhicules (« Sélectionner les véhicules affichés » coche la page).
3. Choisissez quoi faire si le véhicule a déjà un plan actif : « Ignorer le plan existant » ou « Mettre à jour ses intervalles et préavis (base conservée) ». Un « Choix par véhicule (facultatif) » peut remplacer ce choix.
4. Si un plan existant sera mis à jour, cliquez sur « Prévisualiser l’impact ». Le tableau montre l’avant et l’après sous le titre « Prévisualisation de l’impact — rien n’est encore enregistré ».
5. Cliquez sur « Confirmer l’application ». Sans mise à jour, le bouton applique directement le modèle.
6. Lisez le « Résultat par véhicule », puis « Terminer ».

Si un plan a changé entre l’aperçu et la confirmation, rien n’est enregistré : refaites l’aperçu. La copie ne modifie aucun historique.

### Calendrier

L’onglet « Calendrier » montre, mois par mois, les échéances en date des plans actifs et les interventions planifiées. Naviguez avec « Mois précédent », « Mois suivant » et « Mois en cours ». Les échéances uniquement en kilomètres sont dans l’onglet « Échéances ». Une intervention planifiée n’est pas une intervention réalisée.

## 10. Interventions

Menu « Interventions ». Statuts : « Brouillon », « Planifiée », « En cours », « Terminée », « Annulée ». L’écran le rappelle : « Planifier ne signifie pas exécuter ».

### Créer et planifier

Opérateur, chef de parc ou administrateur.

1. Cliquez sur « Nouvelle intervention ».
2. Choisissez le véhicule et le type (« Préventif » ou « Correctif »), le garage, les dates prévues, le diagnostic et les « Travaux prévus ». Une ligne de travail peut être rattachée à un plan du véhicule.
3. Pour un entretien déjà réalisé, cochez « Opération historique saisie a posteriori ». Vous la terminerez ensuite avec sa date effective.
4. Cliquez sur « Créer l’intervention ». Avec un début prévu, elle est « Planifiée » ; sans date, c’est un « Brouillon ».

Sur la fiche : « Planifier » ou « Replanifier », « Démarrer » (la case d’immobilisation déclare explicitement le véhicule immobilisé), « Modifier », « Annuler l’intervention » (motif).

### Terminer une intervention

Permission « Clôturer les interventions d'entretien » (chef de parc et administrateur par défaut).

1. Cliquez sur « Terminer ».
2. Saisissez la « Date effective de réalisation » et cochez les « Lignes de travail réalisées ». Seules les lignes cochées mettent à jour leur plan.
3. Choisissez le « Relevé d’exécution » : « Saisir le relevé lu au compteur », « Choisir un relevé accepté existant » ou « Sans relevé ». Un relevé est exigé dès qu’un plan réalisé a un intervalle en kilomètres.
4. Choisissez le coût : « coût à saisir plus tard », « lignes pièces / main-d’œuvre (total calculé par le serveur) », « total TTC saisi » ou « sans coût (aucune dépense) ». Saisir un coût demande « Saisir des coûts ».
5. Joignez les « Pièces jointes (factures, bons, photos) ».
6. Laissez cochée « Mettre fin à la cause d’immobilisation liée » si le véhicule redevient disponible.
7. Cliquez sur « Terminer l’intervention », puis « Confirmer la clôture ».

La clôture met à jour, en une seule fois, les plans réalisés, la dépense liée et les alertes. Si le coût reste à saisir, cliquez plus tard sur « Saisir le coût », puis « Enregistrer le coût ».

Une erreur se corrige par « Rouvrir » (chef de parc ou administrateur, motif obligatoire). La réouverture annule la dépense liée et recalcule les échéances.

## 11. Fournisseurs

Menu « Fournisseurs ». Le répertoire est tenu par société : garages, stations, assureurs, loueurs.

- « Nouveau fournisseur », « Modifier » : opérateur, chef de parc, administrateur.
- « Archiver », « Réactiver », « Copier vers une autre société » : chef de parc ou administrateur.
- « Voir la fiche » affiche l’« Historique des dépenses » du fournisseur, avec « Consulter les coûts ».

Le module se limite au répertoire. Détails : [guide utilisateur, section Fournisseurs](guide-utilisateur.md#fournisseurs-fournisseurs).

## 12. Documents et conformité

Menu « Documents ». Onglets « Conformité », « Versions » et « Types ».

### Suivre la conformité

L’onglet « Conformité » affiche une ligne par véhicule ou conducteur et par type de document applicable. Statuts : « Valide », « À renouveler », « Expiré », « Manquant ». Filtrez par « Objet », « Statut », « Type de document », ou cochez « Bloquant un départ uniquement ». Une date de fin reste valable jusqu’à la fin de ce jour.

### Enregistrer, renouveler, corriger

Permission « Gérer les documents » (chef de parc, opérateur et administrateur par défaut).

1. Cliquez sur « Enregistrer un document », ou « Enregistrer » sur une ligne « Manquant ».
2. Choisissez le type, l’objet, les dates et le justificatif, puis « Enregistrer le document ».
3. Pour un nouveau document qui remplace l’ancien, cliquez sur « Renouveler », puis « Enregistrer la nouvelle version ». L’historique est conservé.
4. Pour une faute de frappe, ouvrez « Autres actions », puis « Corriger une faute de saisie ». Le motif est tracé.
5. Pour une version saisie par erreur, choisissez « Archiver (version erronée) ». Elle n’est jamais supprimée.

Une version future ne remplace pas une version encore valide avant sa date de début.

### Types de documents

L’onglet « Types » est paramétré par l’administrateur : « Nouveau type », « Requis », « Bloque un départ », « Visible par le conducteur », « Préavis en jours ». Un type bloquant manquant ou expiré empêche un nouveau départ, jamais une restitution. L’administrateur peut aussi « Installer le catalogue initial » des types usuels, facultatifs et non bloquants. Voir le [guide de conformité](guide-conformite-entretien.md).

## 13. Incidents

Menu « Incidents ». Statuts : « Ouvert », « En traitement », « Résolu », « Clôturé ». Types : « Panne », « Dommage », « Accident », « Crevaison », « Anomalie compteur », « Contravention », « Autre ».

### Déclarer un incident

Opérateur, chef de parc ou administrateur. Le conducteur signale depuis « Mon véhicule », sur son utilisation (en cours ou terminée depuis moins de 24 heures par défaut) ou, si le paramètre des soumissions du responsable habituel est actif, sur le véhicule dont il est responsable habituel.

1. Cliquez sur « Déclarer un incident ».
2. Choisissez le véhicule et le « Type ». Pour la « Gravité », laissez « Gravité par défaut (proposée par le serveur) » si vous hésitez : le serveur applique la gravité par défaut du type.
3. Saisissez « Date et heure du fait », le lieu, la « Description », et si besoin l’« Utilisation concernée » et le « Conducteur concerné ».
4. Ajoutez des photos, puis « Déclarer l’incident ».

Un incident « Critique » non pris en charge déclenche une alerte.

### Traiter un incident

Sur la fiche de l’incident :

1. « Prendre en charge » : il passe « En traitement » (opérateur, chef de parc, administrateur).
2. « Ouvrir une intervention » ou « Immobiliser le véhicule » si nécessaire.
3. « Résoudre » avec une « Note de résolution » : c’est la résolution technique.
4. « Clôturer » : clôture administrative, chef de parc ou administrateur. Elle est refusée tant qu’une intervention issue de l’incident ou une cause d’immobilisation liée reste ouverte.
5. « Clôturer sans suite » (chef de parc, administrateur) : pour un incident ouvert, motif obligatoire.
6. « Rouvrir » : un incident résolu revient « En traitement » (chef de parc, administrateur). Seul l’administrateur rouvre un incident clôturé.

La requalification de la gravité est réservée au chef de parc et à l’administrateur (« Modifier »).

**Commentaires.** Choisissez la « Visibilité » : « Interne (personnel) » ou « Partagé avec le conducteur », puis « Publier le commentaire ». Le conducteur ne voit que les commentaires partagés. Un commentaire ne se modifie plus.

**Contravention.** C’est une information de suivi. L’utilisation en cours à l’instant du fait est affichée à titre d’information. Le lien avec un conducteur ne se pose que par « Lier le conducteur » (chef de parc, administrateur). Aucune responsabilité ni retenue n’est déduite.

## 14. Immobilisations

Menu « Immobilisations ». Opérateur, chef de parc ou administrateur.

1. Cliquez sur « Immobiliser un véhicule ».
2. Choisissez le véhicule, le « Motif », le « Début », la « Fin prévue » facultative et le lieu.
3. Choisissez la « Source de la cause » : « Incident du véhicule », « Intervention du véhicule » ou « Autre motif ».
4. Cliquez sur « Immobiliser ».

Si le véhicule est déjà immobilisé, la cause s’ajoute à l’immobilisation active. Sur la fiche : « Ajouter une cause », « Modifier fin prévue / lieu », « Terminer la cause » pour une cause, « Fin d’immobilisation » pour toutes. Le véhicule redevient disponible seulement quand toutes les causes sont terminées.

Une immobilisation pendant une utilisation est possible : les deux sont conservées et une alerte « Immobilisation pendant une utilisation » prévient le chef. Le retour du véhicule reste toujours possible.

## 15. Carburant

Menu « Carburant ». Il liste les pleins saisis par le personnel et les tickets soumis par les conducteurs. Statuts : « Soumis (à valider) », « Validé », « Rejeté », « Annulé », « Remplacé (corrigé) ».

### Saisir un plein

Rôle opérationnel et permission « Saisir des coûts ».

1. Cliquez sur « Saisir un plein ».
2. Choisissez le véhicule, la « Date et heure du plein », les litres, le montant total TTC et le « Type de plein » (« Plein complet » ou « Plein partiel »).
3. Saisissez le « Kilométrage au compteur » : sans compteur validé, le plein ne sert pas au calcul de consommation.
4. Joignez le « Ticket (photo ou PDF) », puis « Enregistrer le plein ».

Un plein saisi par le personnel est validé directement. Il crée une dépense de synthèse au registre.

### Valider les tickets des conducteurs

Rôle opérationnel et permission « Saisir des coûts ».

1. Cliquez sur « Afficher les pleins à valider ».
2. Ouvrez le plein et vérifiez la photo du ticket.
3. Cliquez sur « Valider », puis « Valider le plein ». Une dépense de synthèse est créée ; le relevé du compteur reste soumis à sa propre validation (« Valider le relevé »).
4. Ou cliquez sur « Rejeter », saisissez le « Motif du rejet », puis « Rejeter ». Aucune dépense n’est créée et le conducteur voit le motif.

Une seconde validation est refusée : un plein validé produit une seule dépense.

### Anomalies

Le serveur signale sans jamais corriger :

- « Écart montant » : litres × prix unitaire diffère du total au-delà de la tolérance. Le total saisi est conservé.
- « Capacité dépassée » : les litres dépassent la capacité du réservoir. Si le ticket est exact, « Confirmer la capacité » (chef de parc, administrateur).
- « Compteur à valider », « Compteur rejeté », « Sans compteur » : état du relevé lié.

### Corriger ou annuler un plein validé

Chef de parc ou administrateur, avec « Saisir des coûts ».

- « Corriger » crée une nouvelle version qui remplace le plein et sa dépense. Pour changer de véhicule ou de date, annulez puis ressaisissez.
- « Annuler le plein » annule le plein et sa dépense, avec un motif.

### Consommation

Onglet « Carburant » de la fiche du véhicule, bloc « Consommation estimée ». Elle est calculée entre deux pleins complets admissibles, avec tous les achats intermédiaires. Sinon, elle affiche « N/D » avec un motif. Si des achats n’ont pas été saisis (carte perdue, tickets non remis), le chef de parc peut « Déclarer une période » d’achats incomplets : les intervalles concernés passent « N/D ».

## 16. Dépenses

Menu « Dépenses », visible avec « Consulter les coûts ». Chaque coût reste imputé à la société qui gérait le véhicule à sa date, même après un transfert.

### Registre

- Filtres : « Société », « Véhicule », « Dépenses sans véhicule », « Catégorie », « Nature », « État », « Source », « Du », « Au », « Recherche ».
- Par défaut, l’état affiché est « Validées (en vigueur) ». Les autres : « Annulées », « Remplacées par une correction », « Tous les états ».
- Un clic sur la date ouvre le détail et la « Chaîne des corrections ».

### Saisir une dépense ou un avoir

Permission « Saisir des coûts ». L’opérateur, sans « Consulter les coûts » par défaut, ne voit pas l’entrée « Dépenses » du menu ; à l’adresse `/depenses`, il peut saisir une dépense sans consulter le registre.

1. Cliquez sur « Saisir une dépense ».
2. Choisissez la « Nature » : « Dépense » ou « Avoir ». Un avoir réduit le coût ; ce n’est pas un paiement.
3. Choisissez le « Rattachement » : « Un véhicule » ou « Sans véhicule » (assurance, taxes, location ou autre).
4. Saisissez la date, la catégorie, le fournisseur, la « Référence (facture, ticket) », le montant TTC et le justificatif.
5. Cliquez sur « Enregistrer la dépense ».

Une même référence d’un même fournisseur n’est acceptée qu’une fois dans la société.

### Synthèse

La « Synthèse » applique les filtres de la liste et ne compte que les dépenses validées. Elle présente le coût d’exploitation, la part sans véhicule (ligne « Non ventilé », jamais répartie) et les dépenses hors coût d’exploitation (achats de véhicules par défaut), puis le « Coût d’exploitation par catégorie ».

### Corrections

Une dépense validée n’est jamais modifiée.

- « Corriger » (chef de parc, administrateur ; saisies manuelles seulement) : crée une nouvelle version, l’ancienne reste consultable comme remplacée.
- « Annuler la dépense » (mêmes conditions) : définitif, motif obligatoire ; la dépense sort des totaux de sa période.
- « Exclure du coût d’exploitation » ou « Inclure dans le coût d’exploitation » (permissions « Consulter les coûts » et « Saisir des coûts »).
- Les dépenses de synthèse se corrigent depuis leur plein ou leur intervention.

« Le registre ne remplace pas la comptabilité et ne calcule aucune obligation fiscale ». Il n’y a ni écriture comptable, ni TVA, ni déclaration. Détails : [guide utilisateur, section Dépenses](guide-utilisateur.md#dépenses-depenses).

## 17. Rapports et exports

Menu « Rapports ». Les rapports disponibles sont : inventaire du parc, affectations et utilisations, relevés et qualité des données, entretiens réalisés et à venir, expirations documentaires, incidents et immobilisations, carburant, dépenses, distances et coût par kilomètre.

1. Dans « Choix du rapport et filtres », choisissez le « Rapport » et sa « Vue ».
2. Réglez les filtres. La période est en dates locales, bornes incluses.
3. Lisez le tableau. Le bloc « Filtres, fuseau et date de génération » indique ce qui a été appliqué.
4. Pour exporter, cliquez sur « Exporter » suivi du format, CSV ou XLSX. Un gros export passe dans « Exports différés » : attendez, puis « Télécharger ».

Droits :

- L’export demande « Exporter les rapports ». Il ne contient que les sociétés où vous l’avez.
- Les colonnes de coût et le rapport des dépenses demandent « Consulter les coûts ». Un montant non autorisé s’affiche « Masqué ».
- Une valeur absente s’affiche « N/D » ou « Inconnu » avec son motif, jamais comme zéro. Les estimations GPS sont signalées.

## 18. Imports

Menu « Imports », réservé au chef de parc et à l’administrateur. Il sert à initialiser le parc à partir de fichiers CSV ou XLSX : véhicules, conducteurs, relevés kilométriques et bases d’entretien. Rien n’est écrit avant votre confirmation, et le lot est importé en entier ou pas du tout.

Suivez le [guide des imports](guide-imports.md) : modèles, formats, ordre des imports et garanties.

## 20. Notifications et préférences

Lien « Mes notifications » en haut de l’écran.

1. Activez ou non « Recevoir immédiatement les alertes par e-mail ».
2. Choisissez la « Gravité minimale d’un e-mail immédiat ».
3. Activez ou non « Recevoir le récapitulatif quotidien ». Il part chaque jour à l’heure paramétrée (08:00 par défaut), s’il n’est pas vide.
4. Cliquez sur « Enregistrer mes préférences ».

Seuls les chefs de parc et l’administrateur groupe reçoivent ces e-mails. L’opérateur et le lecteur voient « Votre rôle ne reçoit pas d’e-mails d’alerte ». Si l’écran affiche « Canal e-mail non configuré », aucun e-mail n’est envoyé ni mis en file ; vos préférences sont conservées. Un e-mail peut exceptionnellement arriver deux fois (voir [exploitation](exploitation.md)).

## Administration

Cette partie est réservée à l’administrateur groupe (menu « Administration »). Seule exception : le chef de parc ouvre l’onglet « Audit » pour les sociétés qu’il gère.

Les sections : « Sociétés », « Sites et services », « Catégories de véhicules », « Utilisateurs », « Organisation », « Paramètres », « Notifications », « Audit ». Chaque modification est journalisée.

### Paramètres

1. Onglet « Paramètres ». Choisissez le « Niveau affiché » : « Groupe (valeur par défaut des sociétés) » ou une société.
2. Sur une ligne, cliquez sur « Modifier » (valeur groupe) ou « Surcharger » (valeur propre à une société).
3. Saisissez la valeur et un « Motif » (3 à 500 caractères), puis « Enregistrer la nouvelle version ».
4. « Retirer la surcharge » rend la valeur groupe à la société. « Historique » montre toutes les versions.

Exemples de paramètres :

- « Kilométrage ancien après » ;
- « Seuil de plausibilité par 24 h (filtre administratif, pas une limite physique) » ;
- « Tolérance de retard au retour » ;
- « Checklist de remise et de restitution » ;
- « Préavis documents » et « Préavis entretien par défaut (distance) » ;
- « Heure du récapitulatif e-mail » ;
- « Durée de session (appliquée aux nouvelles connexions) » ;
- « Soumissions du conducteur sur le véhicule dont il est responsable habituel (sans utilisation en cours) ».

Certains paramètres sont marqués « Non modifiable » (pagination) : c’est une borne du produit.

### Utilisateurs

Les comptes ne sont jamais supprimés : ils sont désactivés.

1. Cliquez sur « Nouvel utilisateur ».
2. Saisissez « Prénom », « Nom », « E-mail ».
3. Laissez « Mot de passe initial » vide pour envoyer une invitation (si le serveur d’envoi est configuré) ou pour générer ensuite un lien d’accès.
4. Dans « Habilitations », cliquez sur « Ajouter une habilitation » : choisissez le « Rôle » et la « Société ». Une seule habilitation par société. Le rôle « Administrateur groupe » s’applique à toutes les sociétés.
5. Ajustez les « Permissions fines » : décochez pour retirer, cochez pour accorder.
6. Pour un conducteur, liez sa fiche dans « Conducteur lié » avec « Lier ». Sans ce lien, il n’a pas accès à « Mon véhicule ».
7. Cliquez sur « Créer l’utilisateur ».

Sur la fiche du compte : « Renvoyer l’invitation par e-mail », « Générer un lien d’accès » (lien à usage unique, affiché une seule fois, à transmettre par un canal sûr), « Définir un mot de passe », « Révoquer toutes les sessions », « Désactiver le compte », « Réactiver le compte ». Les « Permissions effectives » sont calculées par le serveur.

### Sociétés

« Nouvelle société » : « Code » (non modifiable ensuite), « Raison sociale », coordonnées et « Identifiant fiscal ». « Archiver » est refusé tant que des véhicules actifs ou hors service, ou des utilisations en cours, sont rattachés.

### Sites et services

Choisissez la société, puis « Nouveau site » (nom, adresse en texte libre, responsable) ou « Nouveau service ». « Archiver » retire l’élément des formulaires sans effacer l’historique ; « Réactiver » le rétablit.

### Catégories de véhicules

« Nouvelle catégorie » : code, libellé et « Catégories de permis exigées ». Ces catégories de permis relèvent de votre paramétrage : aucune règle juridique n’est appliquée automatiquement. Elles servent au contrôle du permis à la remise et à la réservation.

### Organisation

« Nom de l’organisation » et « Fuseau horaire » (identifiant IANA, par exemple Africa/Tunis). Le code, la devise et les décimales monétaires sont fixés à l’installation.

### Notifications

Onglet « Notifications » : « État du canal e-mail » et « File d’envoi » (statut, destinataire, tentatives, dernière erreur). Sans serveur d’envoi (SMTP), aucun e-mail n’est mis en file ni envoyé ; utilisez « Générer un lien d’accès » pour donner un accès. Procédure d’exploitation : [exploitation](exploitation.md).

### Audit

Onglet « Audit », titre « Journal d’audit ». Il trace les actions sensibles : acteur, date, objet, motif, valeurs avant et après (mots de passe et secrets expurgés). Filtrez par « Du », « Au », « Action », « Type d’objet », « Acteur ». L’administrateur voit toute l’organisation. Le chef de parc voit seulement ses sociétés ; il y accède par l’adresse `/administration/audit` ou par le lien « Journal d’audit de ce plein » d’une fiche de plein.
