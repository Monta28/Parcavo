# Guide : catalogue initial, conformité documentaire et dérogations

Ce guide s'adresse à l'administrateur groupe et aux chefs de parc. Il complète le cahier des charges (sections 6.1, 7.1 et 7.2) sans remplacer les obligations validées avec le client.

## Catalogue initial

Le logiciel est livré avec un catalogue initial **proposé**, jamais installé d'office :

- opérations d'entretien (6.1) : vidange moteur, filtres, freins, pneus, courroie, batterie, contrôle technique interne, autre opération ;
- types de documents (7.1) : pour le véhicule, assurance, visite technique, vignette / taxe de circulation, carte grise, licence de transport, autorisation de circulation spécifique, contrat de location, document libre ; pour le conducteur, licence / carte professionnelle, autorisation de conduite, document libre. Le permis de conduire se gère sur la fiche du conducteur (catégories, validité, scan) : il n'est pas dupliqué en type de document.

L'administrateur l'installe depuis `/entretiens` (onglet « Catalogue ») ou `/documents` (onglet « Types »), bouton « Installer le catalogue initial ». L'installation :

- n'ajoute que les éléments absents : un élément existant de même code, ou de même libellé (pour le même objet dans le cas des documents), actif ou archivé, est ignoré et **n'est jamais modifié ni réactivé** ;
- n'impose rien : aucune opération ne reçoit d'intervalle (les intervalles se fixent plan par plan selon les consignes retenues pour chaque véhicule) et les types de documents sont installés **facultatifs et non bloquants**, avec les préavis paramétrés (30, 15 et 7 jours par défaut) ;
- est rejouable sans effet et tracée dans le journal d'audit (une création par élément ajouté et une trace de l'installation).

Il appartient ensuite à l'administrateur de décider quels documents sont requis (absence = « Manquant ») et lesquels bloquent un nouveau départ.

## Blocage d'un départ et dérogation

Lorsqu'un document paramétré comme bloquant manque ou a expiré, ou lorsque le permis du conducteur ne couvre pas la catégorie exigée par la catégorie du véhicule, un **nouveau départ** est refusé. La **restitution** du véhicule reste toujours possible.

Une personne habilitée (permission « dérogation », chef de parc ou administrateur par défaut) peut lever ces blocages par une **dérogation motivée**. La dérogation est enregistrée avec son auteur et son motif dans le journal d'audit ; elle ne modifie ni l'expiration du document ni la règle paramétrée.

**La dérogation est un mécanisme administratif interne au parc : elle ne constitue pas une autorisation juridique de circuler.** Elle ne vaut ni assurance, ni visite technique, ni permis. Le respect des obligations légales du véhicule et du conducteur reste de la responsabilité de l'organisation. Cette mention est rappelée dans l'interface partout où une dérogation est saisie (remise d'un véhicule, réservation) ou restituée (fiche et fiche imprimable de l'utilisation).

## Calendrier des échéances d'entretien

L'onglet « Calendrier » de `/entretiens` présente, mois par mois, les échéances **en date** des plans actifs et les interventions planifiées. Les dates et statuts sont ceux calculés par le serveur (même valeur que la liste des échéances) ; les échéances uniquement kilométriques figurent dans l'onglet « Échéances ». Une intervention planifiée n'est pas une intervention réalisée : seule sa clôture met à jour la base du plan.

## Application d'un modèle de plan

Lorsqu'un modèle est appliqué à des véhicules qui suivent déjà l'une de ses opérations et que le choix est « mettre à jour », l'impact est **prévisualisé** avant validation : intervalles, préavis, prochaines échéances et statuts avant et après, calculés par le serveur sans rien enregistrer. La base de calcul et l'historique ne sont jamais modifiés ; seules les échéances futures changent.
