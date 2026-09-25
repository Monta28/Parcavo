# Guide du conducteur

Ce guide s’adresse au conducteur. Il décrit l’espace « Mon véhicule », pensé pour le téléphone. Le chef de parc a son propre guide : [guide du chef de parc](guide-chef-de-parc.md).

Un texte entre guillemets (« Ajouter un kilométrage ») reproduit exactement un libellé de l’écran.

## Avant de commencer

- **Pas d’application à installer.** Il n’existe aucune application native. Vous utilisez le navigateur du téléphone (ou d’un ordinateur), à l’adresse donnée par votre parc.
- **Il faut du réseau.** Rien n’est enregistré sans connexion (voir la section 9).
- **Aucune position en temps réel.** L’application ne suit pas le véhicule. Elle enregistre ce que vous déclarez : kilométrage, tickets, problèmes.
- **Un compte lié à votre fiche.** L’administrateur crée votre compte et le lie à votre fiche conducteur. Sans ce lien, l’écran affiche « Aucune fiche conducteur liée ».

## 1. Se connecter

1. Ouvrez l’adresse de l’application dans le navigateur du téléphone.
2. Saisissez « Adresse e-mail » et « Mot de passe ».
3. Touchez « Se connecter ».
4. Vous arrivez sur « Mon véhicule ». Votre menu a deux entrées : « Mon véhicule » et « Documents » (section 7).

Pour ouvrir le menu sur téléphone, touchez l’icône en haut à gauche. Pour partir, touchez « Déconnexion ».

Si l’écran affiche « Votre session a expiré ou a été révoquée. Reconnectez-vous. », reconnectez-vous : vous revenez sur la page demandée.

Mot de passe oublié : touchez « Mot de passe oublié ? ». Un lien n’arrive par e-mail que si votre parc a configuré l’envoi d’e-mails. Sinon, seul l’administrateur peut vous redonner un accès : prévenez le gestionnaire du parc.

## 2. L’écran « Mon véhicule »

### Avec une utilisation en cours

Une utilisation commence quand le gestionnaire du parc vous remet le véhicule (remise) et se termine à la restitution. Pendant ce temps, l’écran affiche une carte avec :

- le code et l’immatriculation du véhicule ;
- « Marque et modèle », « Motif », « Remis le », « Retour prévu le », « Lieu de remise » ;
- le « Dernier kilométrage validé ».

Si l’heure de retour est dépassée, la carte affiche « Retour dépassé » et vous demande : « Rapportez le véhicule ou contactez le gestionnaire du parc. »

Le lien « Voir le détail de l’utilisation » ouvre la fiche complète de votre utilisation.

### Sans utilisation en cours

L’écran affiche « Aucun véhicule remis ». Le bouton « Ajouter un kilométrage » est alors grisé, avec la mention « Disponible pendant une utilisation en cours, ou sur le véhicule dont vous êtes responsable habituel si votre organisation l’autorise. ». « Ajouter un ticket carburant » et « Signaler un problème » restent possibles juste après une restitution (voir la section 3). Vos déclarations passées restent consultables plus bas.

### Le véhicule dont vous êtes responsable habituel

Le parc peut vous nommer responsable habituel d’un véhicule. Ce n’est pas une remise : l’écran n’affiche pas ce véhicule comme utilisation en cours.

L’administrateur peut activer un paramètre (`drivers.allowHabitualVehicleSubmissions`, libellé « Soumissions du conducteur sur le véhicule dont il est responsable habituel (sans utilisation en cours) »). Il est désactivé par défaut : les trois actions restent alors grisées sans utilisation. Une fois activé, et tant qu’aucune utilisation n’est en cours à votre nom :

- sous « Aucun véhicule remis », une carte présente ce véhicule, marqué « Véhicule dont vous êtes responsable habituel », avec son « Dernier kilométrage validé » et le lien « Voir la fiche du véhicule » ;
- les trois actions portent sur ce véhicule : « Ajouter un kilométrage », « Ajouter un ticket carburant » et « Signaler un problème » ;
- si vous êtes responsable habituel de plusieurs véhicules, choisissez le bon avant d’envoyer : « Véhicule du kilométrage » pour un relevé, « Véhicule concerné * » pour un signalement, « Véhicule * » pour un ticket.

Pendant une utilisation en cours, les actions portent uniquement sur le véhicule remis, même si le paramètre est actif. Le serveur revérifie ce droit à chaque envoi.

Demandez à votre gestionnaire si ce paramètre est actif.

## 3. Les trois actions

Les trois gros boutons de l’écran : « Ajouter un kilométrage », « Ajouter un ticket carburant » et « Signaler un problème ». Chaque envoi réussi affiche un écran de confirmation avec la mention « Réponse du serveur reçue ». Tant que cet écran n’apparaît pas, rien n’est enregistré.

### Relevé de compteur avec photo

1. Touchez « Ajouter un kilométrage ».
2. Dans « Kilométrage affiché au compteur », tapez la valeur lue au tableau de bord, en kilomètres (par exemple 45230).
3. Vérifiez « Date et heure du relevé ». Par défaut, c’est maintenant. Une date future est refusée.
4. Touchez « Prendre ou choisir une photo » et photographiez le compteur. La photo est recommandée : elle aide à valider votre saisie. Elle est réduite en JPEG avant l’envoi.
5. Ajoutez un « Commentaire (facultatif) » si besoin.
6. Touchez « Envoyer le kilométrage ».
7. L’écran « Kilométrage envoyé » confirme l’envoi. Touchez « Ajouter un autre kilométrage » ou « Fermer ».

Votre relevé est toujours soumis à la validation du gestionnaire du parc. Il apparaît dans « Mes soumissions » avec le statut « En attente ». Une valeur impossible (plus basse que le compteur déjà validé, par exemple) est refusée tout de suite, avec un message sous le champ : corrigez-la puis renvoyez.

Si l’écran affiche « Kilométrage déjà enregistré », votre premier envoi était bien arrivé : « Ce relevé existait déjà : aucun doublon n’a été créé. »

### Ticket carburant

1. Touchez « Ajouter un ticket carburant ». Le formulaire « Déclarer un plein » s’ouvre.
2. Si plusieurs véhicules sont proposés, choisissez le bon. Après une restitution, le véhicule de votre dernière utilisation est proposé pour un ticket oublié.
3. Vérifiez « Date et heure du plein » : l’heure du ticket.
4. Saisissez les « Litres » et le « Montant payé ».
5. Choisissez le « Type de plein » : « Plein complet » ou « Plein partiel ».
6. Saisissez le « Kilométrage au compteur ». C’est facultatif mais recommandé : sans compteur, ce plein ne sert pas au calcul de consommation.
7. Le « Prix au litre » est facultatif, tel qu’imprimé sur le ticket.
8. Touchez « Prendre le ticket en photo ». La photo du ticket est obligatoire.
9. Touchez « Envoyer le ticket ».
10. L’écran « Ticket envoyé » confirme l’envoi. Touchez « Déclarer un autre plein » ou « Fermer ».

Le ticket ne devient une dépense qu’après validation par le gestionnaire du parc. Il est accepté s’il date de votre utilisation (une heure de marge avant la remise et après la restitution), et s’il est envoyé au plus tard 7 jours après la restitution (valeur par défaut). Pour le véhicule dont vous êtes responsable habituel, si le paramètre est actif, le ticket doit dater de moins de 7 jours.

Si le bouton est grisé, l’écran explique : « Aucun véhicule ne vous est attribué pour déclarer un plein : un ticket se déclare pendant une utilisation, ou juste après la restitution. »

### Signaler un problème

1. Touchez « Signaler un problème ». Le véhicule concerné s’affiche en tête du formulaire ; s’il y en a plusieurs, choisissez-le dans « Véhicule concerné * ».
2. Choisissez le « Type de problème » : « Panne », « Dommage », « Accident », « Crevaison », « Anomalie compteur », « Contravention » ou « Autre ».
3. Choisissez la « Gravité proposée », ou « Je ne sais pas (gravité par défaut) ». Le gestionnaire du parc peut la requalifier.
4. Décrivez le problème dans « Que se passe-t-il ? » (5 caractères au moins).
5. Indiquez le « Lieu » si utile, et vérifiez « Date et heure ».
6. Ajoutez des « Photos (recommandées) » avec « Prendre ou choisir une photo ».
7. Touchez « Envoyer le signalement ».
8. L’écran « Signalement enregistré » affiche la référence du dossier. Touchez « Signaler un autre problème » ou « Fermer ».

Le serveur rattache le signalement à votre utilisation en cours, ou à celle que vous venez de terminer (jusqu’à 24 heures après la restitution, par défaut). Sur le véhicule dont vous êtes responsable habituel (paramètre actif, aucune utilisation en cours), le signalement n’est rattaché à aucune utilisation, et le problème doit dater de moins de 24 heures (même délai, par défaut). Si aucun véhicule ne vous est proposé, le bouton est grisé : « Aucun véhicule ne vous est attribué pour un signalement : un problème se signale pendant une utilisation ou juste après la restitution, ou sur le véhicule dont vous êtes responsable habituel si votre organisation l’autorise. »

## 4. Suivre vos déclarations

Plus bas sur « Mon véhicule », trois listes montrent l’état de vos envois.

### « Mes soumissions » : vos relevés

| Statut | Ce que cela veut dire |
| --- | --- |
| « En attente » | « En attente de validation par le gestionnaire du parc. » Un « Motif d’attente » peut s’afficher. |
| « Accepté » | Le relevé est validé. Il compte pour le kilométrage du véhicule. |
| « Rejeté » | Le relevé est refusé. Lisez le « Motif du rejet ». |
| « Remplacé » | « Corrigé par le gestionnaire du parc : une nouvelle valeur remplace ce relevé. » |

« Voir la photo du compteur » ouvre la photo envoyée.

### « Mes déclarations de plein » : vos tickets

| Statut | Ce que cela veut dire |
| --- | --- |
| « Soumis (à valider) » | En attente de validation par le gestionnaire du parc. |
| « Validé » | Le ticket est accepté. |
| « Rejeté » | Le ticket est refusé. Lisez le « Motif du rejet ». |
| « Annulé » | La déclaration a été retirée ou annulée. |
| « Remplacé (corrigé) » | Le gestionnaire a corrigé le plein. |

Tant qu’un ticket est en attente, vous pouvez le retirer :

1. Touchez « Retirer la déclaration ».
2. Confirmez avec « Retirer », ou touchez « Garder ».

« Voir le ticket » ouvre la photo envoyée.

### « Mes signalements » : vos problèmes

Chaque signalement affiche son statut : « Ouvert », « En traitement », « Résolu » ou « Clôturé ».

1. Touchez « Voir les échanges et commenter ».
2. Lisez les réponses que le gestionnaire du parc a partagées avec vous.
3. Écrivez dans « Ajouter un commentaire », puis touchez « Publier le commentaire ». Un commentaire ne se modifie plus.

Quand le dossier est clôturé, l’écran affiche « Incident clôturé : les commentaires sont fermés. ».

## 5. Vos réservations

La liste « Mes prochaines réservations » montre vos cinq prochaines réservations confirmées : véhicule, créneau, motif et statut.

1. Touchez « Toutes mes réservations » pour la liste complète.
2. Filtrez par « Statut » (« Confirmée », « Convertie », « Annulée », « Non honorée ») ou par date.
3. Touchez « Voir le détail » sur une réservation.

Une réservation est un créneau prévu, pas une remise. Le jour venu, le gestionnaire du parc vous remet le véhicule. Vous ne pouvez ni créer, ni modifier, ni annuler une réservation : adressez-vous au gestionnaire du parc.

## 6. Le QR code du véhicule

Un QR code peut être collé dans le véhicule.

1. Scannez-le avec l’appareil photo du téléphone.
2. Connectez-vous si l’application le demande.
3. La fiche du véhicule s’ouvre, avec les onglets « Synthèse », « Localisation » et « Historique ».

La fiche ne s’ouvre que pour le véhicule de votre utilisation en cours, ou celui dont vous êtes responsable habituel. Pour un autre véhicule, l’écran affiche « Accès refusé ou élément hors de votre périmètre ».

Le QR code ne vous attribue pas le véhicule et ne crée aucune remise. Il ne remplace pas la remise par le gestionnaire du parc.

## 7. Vos documents

Touchez « Documents » dans le menu. La page affiche « Mes documents » (les documents enregistrés à votre nom : permis, habilitations) et, pendant une utilisation, les documents du véhicule remis que le parc a rendus consultables. Sans utilisation en cours, elle l’indique : « Aucune utilisation en cours : les documents d’un véhicule ne sont consultables que pendant son utilisation. » Les documents du véhicule dont vous êtes responsable habituel ne sont donc pas affichés hors utilisation.

## 8. Ce que vous ne voyez pas

L’application ne vous montre que ce qui vous concerne.

- **Pas de montants du parc.** Vous ne voyez ni les dépenses, ni le coût des réparations, ni les factures. Vous voyez seulement les litres et le montant que vous avez saisis sur vos propres tickets.
- **Pas les autres conducteurs.** Vous ne voyez ni leurs noms, ni leurs relevés, ni leurs tickets, ni leurs signalements, ni leurs réservations. La dernière localisation déclarée s’affiche sans son auteur.
- **Pas les données de gestion.** Plans d’entretien, conformité interne, commentaires internes des incidents, alertes, planning et rapports sont réservés au personnel. Si vous ouvrez un de ces écrans par son adresse, il affiche par exemple « Écran réservé au personnel du parc » ou « Centre d’alertes réservé au personnel de gestion ».
- **Pas d’e-mail d’alerte.** Les comptes conducteur ne reçoivent pas d’e-mails d’alerte. L’état de vos envois se lit dans « Mon véhicule ».

## 9. Hors connexion

L’application ne fonctionne pas hors ligne. Aucun envoi n’est mis en attente pour être envoyé plus tard : c’est à vous de renvoyer quand le réseau revient.

### Ce que vous voyez

- En haut de « Mon véhicule », un bandeau affiche « Vous êtes hors connexion. », suivi de : « Aucune saisie ne peut être envoyée : rien n’est enregistré tant que la connexion n’est pas rétablie. Les informations affichées peuvent ne pas être à jour. »
- Dans le formulaire de kilométrage : « Hors connexion : l’envoi échouera et rien ne sera enregistré. Votre saisie reste sur cet appareil ; envoyez-la quand la connexion revient. »
- Dans le formulaire de ticket : « Hors connexion : le ticket ne peut pas être envoyé et rien n’est enregistré. Votre saisie reste sur cet appareil ; envoyez-la quand la connexion revient. » Le bouton « Envoyer le ticket » est grisé.
- Dans le formulaire de signalement : « Hors connexion : le signalement ne peut pas être envoyé et rien n’est enregistré. Votre saisie reste affichée ; envoyez-la quand la connexion revient. » Le bouton « Envoyer le signalement » est grisé.

Si vous envoyez un kilométrage sans réseau, l’envoi échoue aussitôt : « Impossible de joindre le serveur. Vérifiez votre connexion : rien n’a été enregistré. ». Un message rappelle : « Non enregistré : vérifiez votre connexion puis réessayez. »

### Ce qui est gardé, et ce qui ne l’est pas

- **Kilométrage et ticket.** Votre saisie est gardée dans l’onglet ouvert du navigateur. Si vous rouvrez le formulaire dans ce même onglet, l’écran affiche « Brouillon non envoyé restauré : vérifiez les valeurs puis envoyez. Rien n’a été enregistré tant que la confirmation n’apparaît pas. ». Si vous fermez l’onglet, ou si vous touchez « Annuler », la saisie est perdue.
- **Signalement.** La saisie reste affichée tant que le formulaire est ouvert. Fermé, il repart vide.
- **Photos.** Une photo est envoyée dès que vous la prenez. Sans réseau, elle ne part pas : « Téléversement impossible : la photo n’est pas jointe. » ou un message de connexion s’affiche. Reprenez-la quand le réseau revient.
- **Affichage.** Les informations déjà affichées restent visibles, mais elles peuvent être anciennes.

### Renvoyer sans créer de doublon

Le réseau peut aussi couper pendant l’envoi. Vous ne savez pas alors si le serveur a reçu votre saisie.

1. Quand le réseau revient, touchez de nouveau le bouton d’envoi, sans modifier le formulaire.
2. Pour un kilométrage ou un ticket, l’écran le rappelle : « Votre saisie est conservée. Le nouvel envoi réutilise la même clé : aucun doublon ne sera créé. »
3. Pour un signalement : « Aucune confirmation reçue : renvoyez le signalement sans le modifier quand la connexion revient ; s’il a déjà été enregistré, le serveur renvoie le même signalement, sans doublon. »
4. Seul l’écran de confirmation (« Kilométrage envoyé », « Ticket envoyé » ou « Signalement enregistré ») prouve l’enregistrement.
