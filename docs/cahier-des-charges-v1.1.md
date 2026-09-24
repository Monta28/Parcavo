# Cahier des charges - Gestion de parc automobile
## Version 1.1 | 24 septembre 2026

**Périmètre : application web multi-sociétés, kilométrage manuel en socle, collecte automatique du kilométrage et du carburant depuis le fournisseur GPS existant (module F11, activable par société).**

> Évolution 1.0 → 1.1 : ajout du module F11 (connecteur télématique). Sections modifiées : 1, 5.1, 5.6 (nouvelle), 8.5 (nouvelle), 9.1, 13.2, 14, 15.2, 17, 18, 19 et 21 (nouvelle). Principe inchangé : l'application fonctionne entièrement sans GPS ; le connecteur accélère et fiabilise la collecte, il ne la conditionne jamais.

Document de réalisation fonctionnelle et technique. Nom de travail : Parc Auto. Interface utilisateur en français. Les fonctions ci-dessous constituent une proposition de périmètre de livraison ; les paramètres initiaux restent modifiables par les utilisateurs autorisés.

# 1. Objectif et périmètre de livraison

## 1.1 Besoin principal
Centraliser le parc de trois sociétés et permettre aux chefs de parc de répondre sans fichiers parallèles aux questions suivantes : quel véhicule appartient à quelle société, qui en est responsable, qui l'utilise actuellement, où a-t-il été déclaré pour la dernière fois, quel est son dernier kilométrage validé, quels travaux ont été réalisés et quelles échéances approchent ?

La V1 doit fonctionner entièrement sans fournisseur GPS, carte, boîtier ou abonnement télématique. Lorsque le module F11 est activé pour une société, les véhicules équipés d'un boîtier du fournisseur GPS existant alimentent automatiquement le kilométrage, et le carburant lorsque le boîtier dispose de cette donnée. Les véhicules non équipés, ou dont la source est muette, restent gérés par relevés manuels. Sans observation automatique ni manuelle, le kilométrage réel entre deux observations reste inconnu.

## 1.2 Inclus dans la V1
- F01 : groupe, sociétés, sites, utilisateurs, rôles et habilitations.
- F02 : dossiers véhicules et conducteurs, documents et pièces jointes.
- F03 : responsable habituel, réservations, utilisations réelles, remise et restitution.
- F04 : kilométrage manuel, contrôles de cohérence, corrections et changements de compteur.
- F05 : plans d'entretien, vidanges, interventions, réparations et immobilisations.
- F06 : carburant, dépenses, fournisseurs et suivi des coûts sans comptabilité générale.
- F07 : incidents, anomalies, retours tardifs et indisponibilités.
- F08 : alertes dans l'application et notifications par e-mail lorsque le SMTP est configuré.
- F09 : tableaux de bord, rapports, imports, exports et documents imprimables.
- F10 : accès mobile conducteur, journal d'audit, sauvegarde, restauration et déploiement.
- F11 : connecteur télématique vers le fournisseur GPS existant : kilométrage et carburant automatiques, rapprochement avec les relevés manuels et alertes de source muette (activable par société).

## 1.3 Hors V1
Carte et suivi de position en temps réel, historique de trajets, géofencing, fourniture ou pose de boîtiers, lecture OBD/CAN directe par l'application, applications natives, fonctionnement hors ligne avec synchronisation, WhatsApp/SMS, reconnaissance automatique de documents, stock de pièces, paie, comptabilité, facturation client et signature électronique certifiée. Aucun de ces services ne doit être nécessaire pour utiliser la V1. Le module F11 lit uniquement le kilométrage et le carburant déjà collectés par le fournisseur GPS ; il ne remplace pas sa plateforme.

## 1.4 Hypothèses de départ
Un groupe exploite trois sociétés ; le nombre de sociétés est configurable et non codé en dur. Chaque chef peut recevoir une ou plusieurs sociétés. Un administrateur groupe dispose de la vue consolidée. Aucun abonnement SaaS ni portail d'inscription publique n'est demandé. L'architecture garde un identifiant d'organisation pour une extension future, sans imposer un produit SaaS multi-clients en V1. Le groupe dispose déjà d'un fournisseur GPS ; ses capacités (API, rapports, origine du kilométrage, capteurs carburant) sont qualifiées avant le lot F selon l'annexe A (section 21).

# 2. Organisation, utilisateurs et permissions

## 2.1 Structure des données
Organisation > Société > Site / service > Véhicules et conducteurs. Un véhicule possède une société gestionnaire courante. Une société comporte un code unique, une raison sociale, des coordonnées, un logo facultatif et un statut actif/archivé. Les sites comportent un nom, une adresse libre et un responsable facultatif ; leur adresse ne constitue pas une position GPS.

## 2.2 Rôles de base
| Rôle | Périmètre | Droits principaux |
| --- | --- | --- |
| Administrateur groupe | Toutes les sociétés de son organisation | Paramétrage, utilisateurs, transferts, gestion complète, consolidation et audit. |
| Chef de parc | Sociétés attribuées | Gestion opérationnelle, validation des relevés, corrections motivées, documents, coûts et rapports. |
| Opérateur | Sociétés attribuées | Création des dossiers et opérations courantes ; pas de gestion des droits, transfert ou correction historique validée. |
| Conducteur | Ses propres utilisations | Consultation de son véhicule en cours, proposition de relevé, signalement d'incident et soumission de justificatif carburant. |
| Lecteur | Sociétés attribuées | Lecture seule. Consultation des coûts et export soumis à permissions explicites. |

Les permissions fines complètent les rôles : costs.read, costs.write, reports.export, readings.approve, readings.correct, maintenance.complete, documents.manage, exceptions.override et users.manage. Par défaut, seuls l'administrateur et le chef disposent des corrections et dérogations. Le chef ne peut pas accorder des droits supérieurs aux siens. La gestion des utilisateurs reste à l'administrateur en V1.

## 2.3 Cloisonnement obligatoire
Chaque lecture, écriture, recherche, agrégat, export et téléchargement doit appliquer les habilitations côté serveur. Un filtre de société dans l'interface ne suffit pas. Les identifiants fournis par le navigateur ne font jamais autorité pour le périmètre. Les caches et traitements différés doivent aussi être contextualisés. Les contrôles d'autorisation doivent se trouver au point d'accès aux données et aux mutations [R1].

Un conducteur ne voit ni les autres utilisateurs, ni les anciens conducteurs, ni les factures, ni les justificatifs personnels d'autrui. Il consulte ses propres soumissions et les seules informations utiles à son utilisation en cours. Un conducteur peut exister sans compte de connexion.

## 2.4 Transfert entre sociétés
Seul l'administrateur transfère un véhicule. Le transfert est refusé tant qu'une utilisation, une immobilisation, une intervention ouverte ou une réservation future non traitée existe. Les affectations habituelles et plans d'entretien sont explicitement réexaminés. Les événements et dépenses conservent leur société historique. Le destinataire voit l'état technique courant et les documents véhicule partagés lors du transfert, mais pas les anciens coûts ni les données personnelles hors de ses habilitations. L'administrateur conserve la vue complète. Un conducteur ne peut utiliser que les véhicules de sa société courante en V1.

# 3. Dossiers véhicules et conducteurs

## 3.1 Fiche véhicule
Champs obligatoires : code interne, société, immatriculation ou identifiant provisoire, marque, modèle, catégorie et état d'exploitation. Champs facultatifs : VIN, année, date de mise en service, carburant/énergie, capacité du réservoir, site, service, acquisition/location/leasing, fournisseur, fin de contrat, photos et notes.

Les espaces et la casse sont normalisés pour contrôler les doublons d'immatriculation, sans détruire la valeur d'affichage. Unicité au sein de l'organisation pour le code et l'immatriculation normalisée ; VIN unique lorsqu'il est renseigné. Les formats restent compatibles avec des immatriculations non tunisiennes et provisoires. Le kilométrage inconnu est NULL, jamais zéro par défaut.

Le dossier propose les onglets : Synthèse, Affectations, Kilométrage, Entretiens, Documents, Carburant, Dépenses, Incidents et Historique. La synthèse affiche le responsable habituel, l'utilisateur actuel, le statut, la dernière localisation déclarée, le dernier relevé validé et les prochaines échéances.

## 3.2 Statuts et disponibilité
Séparer le cycle de vie (ACTIF, HORS_SERVICE, CEDE, ARCHIVE) des événements opérationnels. Pour un véhicule actif, calculer le statut courant avec la priorité : IMMOBILISE > EN_UTILISATION > DISPONIBLE. Une réservation future apparaît dans le calendrier sans transformer le véhicule en utilisation actuelle. Une non-conformité documentaire est un indicateur distinct, pouvant bloquer un nouveau départ.

Un changement manuel de statut ne doit pas masquer une utilisation ouverte. Archivage et cession sont refusés tant que les opérations ouvertes ne sont pas résolues. Les dossiers ayant un historique sont archivés, jamais supprimés physiquement depuis l'interface.

## 3.3 Fiche conducteur
Identifiant interne, nom, prénom, société, service, téléphone facultatif, e-mail facultatif, statut actif/inactif, compte utilisateur lié facultatif et informations du permis : numéro, catégories, dates et justificatif. Les informations personnelles inutiles à la gestion du parc ne sont pas collectées.

Afficher ses utilisations, incidents et soumissions, selon les droits. Un conducteur inactif ne peut pas recevoir un nouveau véhicule ; ses utilisations ouvertes doivent être traitées explicitement. Les catégories de permis exigées et les justificatifs obligatoires sont paramétrés par l'organisation, sans règles juridiques inventées par le logiciel.

## 3.4 Localisation déclarative
Saisir un site ou un lieu libre, une date d'observation et un commentaire. Toujours afficher « Dernière localisation déclarée » avec sa date et son auteur. Ne jamais afficher « Position actuelle » ni un faux marqueur temps réel. Une remise, restitution ou entrée au garage peut produire une nouvelle déclaration de lieu.

# 4. Affectations, réservations et utilisations

## 4.1 Distinguer trois concepts
Affectation habituelle : responsable principal du véhicule sur une période, sans preuve qu'il le conduit aujourd'hui. Réservation : créneau prévu pour un conducteur et un véhicule. Utilisation : possession réelle constatée par une remise puis une restitution. Une utilisation ponctuelle ne remplace pas silencieusement le responsable habituel.

## 4.2 Réservation
Champs : société, véhicule, conducteur, début et fin prévus, motif, destination/site facultatif, commentaire et créateur. Statuts : CONFIRMEE, CONVERTIE, ANNULEE, NON_HONOREE. Une confirmation vérifie les chevauchements, les habilitations, le conducteur actif et les blocages connus. La vérification est refaite au départ. Annulation ou modification conserve auteur, date et motif.

## 4.3 Remise du véhicule
Sélectionner conducteur et véhicule, date/heure réelle, retour prévu, motif, compteur physique et lieu de remise. Ajouter niveau de carburant approximatif, clés/documents/accessoires remis, observations et photos facultatives. Le relevé doit être accepté pour valider le départ ; aucune augmentation du compteur n'est inventée. Un départ sans relevé constitue une exception motivée réservée au chef ou à l'administrateur, avec alerte persistante et distance indéterminée.

La remise crée une utilisation EN_COURS et, le cas échéant, convertit la réservation. Un conducteur ne peut avoir qu'une utilisation EN_COURS ; idem pour le véhicule. Les actions réalisées en double doivent produire un seul résultat.

## 4.4 Restitution
Saisir date/heure réelle, compteur, lieu, niveau de carburant, checklist de retour, observations et photos. Afficher la distance issue de deux relevés valides et permettre l'ouverture d'un incident pour un dommage constaté. Le retour ne clôture pas automatiquement cet incident. Un relevé absent ou contesté permet au chef de constater le retour physique avec motif ; le trajet est marqué « distance non validée » jusqu'à régularisation.

Une restitution valide passe l'utilisation à TERMINEE ; le véhicule devient disponible seulement si aucun autre blocage n'existe. Une fiche de remise/restitution imprimable comporte les noms, dates, relevés, accessoires et réserves. Une confirmation nominative peut être conservée ; elle ne doit pas être présentée comme une signature certifiée.

## 4.5 Conflits et retards
Pour les réservations, utiliser des intervalles [début, fin[ : deux créneaux consécutifs sont autorisés, des créneaux qui se chevauchent sont refusés pour un même véhicule ou conducteur. Une utilisation réelle en cours bloque toujours un nouveau départ, même si son retour prévu est dépassé. Un retard ne clôture rien automatiquement et signale les réservations suivantes affectées.

Une immobilisation urgente peut survenir pendant une utilisation : conserver les deux événements, prévenir le chef et bloquer les départs suivants. Le retour physique doit toujours pouvoir être enregistré. Les conflits doivent être traités dans des transactions, avec contraintes ou verrous en base, et non seulement dans l'interface [R2, R3].

# 5. Kilométrage manuel et qualité des relevés

## 5.1 Modèle de relevé
Chaque relevé comprend : véhicule, société au moment de l'observation, compteur concerné, valeur physique affichée, date/heure observée, date/heure de saisie, auteur, origine de l'opération, photo facultative, commentaire et statut. Sources actives : MANUAL, IMPORT et TELEMATICS (module F11). Les contextes sont relevé libre, remise, restitution, carburant, entretien et synchronisation. Aucun endpoint public n'accepte la source TELEMATICS : elle est réservée au worker du connecteur.

Statuts : EN_ATTENTE, ACCEPTE, REJETE et REMPLACE. Les saisies cohérentes du chef et de l'opérateur sont acceptées directement. Les relevés TELEMATICS cohérents sont acceptés automatiquement selon la section 5.6. Les soumissions conducteur attendent validation. Une anomalie importante est mise en attente, y compris pour un opérateur. Seuls les relevés acceptés participent aux calculs.

## 5.2 Contrôles
Valeur numérique non négative, date non future et véhicule accessible. Vérifier le relevé accepté précédent et suivant dans le même segment de compteur : une saisie rétroactive ne doit pas casser la chronologie. Deux relevés identiques au même instant sont idempotents lorsqu'ils représentent la même opération ; deux valeurs différentes au même instant constituent un conflit à traiter.

Une diminution inexpliquée est refusée. Une hausse supérieure au seuil de plausibilité configuré est proposée à validation avec explication, sans devenir un relevé courant. Le seuil est un filtre administratif configurable, pas une limite physique universelle.

## 5.3 Compteur courant et corrections
Le compteur courant est le dernier relevé accepté selon la date d'observation, et non selon la date de saisie. Afficher valeur, date, source et fraîcheur. Un relevé historique ne fait pas reculer le compteur courant.

Un relevé accepté n'est jamais écrasé : le chef demande une correction motivée ; le système conserve l'original, crée son remplacement et recalcule les données dépendantes. Un motif, l'auteur et les valeurs avant/après figurent dans l'audit. Si des remises, entretiens ou périodes de consommation deviennent incohérents, bloquer la correction ou exiger leur régularisation dans un parcours explicite.

## 5.4 Remplacement de compteur
Séparer compteur physique et kilométrage cumulé du véhicule. À l'initialisation ordinaire, les deux sont égaux. Lors d'un remplacement autorisé, clôturer l'ancien segment et créer un segment avec date, dernière distance cumulée validée, nouvelle valeur physique et justificatif.

Formule : kmCumules = kmCumulesDebutSegment + (compteurPhysique - compteurPhysiqueDebutSegment). Exemple : remplacement à 120 000 km par un compteur affichant 0 ; une lecture ultérieure de 500 correspond à 120 500 km cumulés. Les entretiens utilisent les kilomètres cumulés. Si l'historique du véhicule est inconnu, demander une base technique validée ou afficher « cumul incomplet » ; ne pas fabriquer une distance.

## 5.5 Fraîcheur et alertes
Un relevé absent donne l'état INCONNU. Au-delà de sept jours sans observation validée, par défaut, afficher A_ACTUALISER et notifier le chef. Le seuil est configurable. Un relevé peut être accepté mais ancien. L'état de fraîcheur est indépendant de l'échéance d'entretien : une vidange non atteinte selon un ancien relevé ne doit pas être présentée comme garantie à jour.

## 5.6 Relevés automatiques (module F11)
Chaque relevé automatique porte en plus : canal (API, RAPPORT, RPA), identifiant de l'unité chez le fournisseur, sourceReference, receivedAt et measurementKind :
- COMPTEUR_CAN : valeur du compteur du tableau de bord lue par le boîtier sur le bus CAN/FMS. Traitée comme un compteur physique.
- DISTANCE_GPS : odomètre virtuel calculé par le fournisseur à partir des positions. Jamais présentée comme la valeur du compteur.

Une DISTANCE_GPS est convertie en kilométrage estimé par calibrage : kmEstime = kmManuelReference + (distanceGps - distanceGpsReference). Chaque relevé manuel accepté (remise, restitution, entretien, relevé libre) devient la nouvelle référence. L'écart entre l'estimation et le relevé manuel est historisé en pourcentage de la distance parcourue depuis la référence ; au-delà du seuil configurable, alerte « dérive GPS » au chef. Les distances et ratios issus d'une DISTANCE_GPS sont affichés comme estimations (section 11.3).

Acceptation automatique : valeur croissante dans le segment, hausse compatible avec le seuil de plausibilité rapporté à la durée écoulée, unité mappée à un véhicule actif à la date d'observation. Un relevé automatique incohérent passe EN_ATTENTE avec motif ; il ne bloque ni une remise ni une saisie manuelle. Idempotence par (fournisseur, unité, sourceReference) ou, à défaut, (unité, observedAt, valeur).

Compteur courant : le relevé accepté le plus récent selon observedAt, toutes sources confondues ; une DISTANCE_GPS calibrée est affichée « estimé GPS » avec la date de sa référence manuelle. Un plan d'entretien peut être paramétré pour n'accepter que des relevés manuels ou COMPTEUR_CAN. Lors d'une remise ou d'une restitution, le formulaire propose la dernière valeur automatique comme aide ; la valeur enregistrée reste celle lue sur le tableau de bord.

Volume : le dernier état reçu de chaque unité est mis à jour à chaque synchronisation (TelemetryUnitState) ; un OdometerReading TELEMATICS est historisé au plus une fois par heure et par véhicule lorsqu'il a progressé, et une fois par jour à minuit local.

Fraîcheur : avec F11 actif, la fraîcheur de la section 5.5 porte sur la dernière observation acceptée toutes sources confondues. Une unité mappée sans donnée au-delà du seuil configurable produit l'alerte « source GPS muette » (boîtier débranché, hors couverture, abonnement suspendu) ; le véhicule retombe dans le régime manuel.

# 6. Entretien préventif, vidanges et interventions

## 6.1 Catalogue et plans
Catalogue configurable : vidange moteur, filtres, freins, pneus, courroie, batterie, contrôle technique interne et autres opérations. Un modèle de plan peut être copié vers plusieurs véhicules. La copie ne modifie pas rétroactivement leurs historiques.

Chaque plan véhicule/opération contient un intervalle en km, un intervalle en mois/jours, ou les deux ; les deux ne peuvent être vides. Il contient aussi la base de calcul, les seuils d'anticipation, un responsable et un statut actif. Les intervalles proviennent des consignes retenues par le client pour chaque véhicule ; aucun intervalle universel n'est imposé.

Sans historique fiable, demander une prochaine échéance initiale et son mode d'initialisation, ou laisser le plan INCOMPLET avec alerte. Ne pas créer de fausse vidange à zéro kilomètre. Une base technique peut être initialisée sans inventer une facture.

## 6.2 Calculs et statuts
prochaineEcheanceKm = kmCumulesDerniereOperation + intervalleKm. prochaineEcheanceDate = dateDerniereOperation + intervalleTemps. Lorsqu'il existe deux seuils, le premier atteint déclenche l'action. L'addition de mois se fait en mois calendaires ; une date inexistante est ramenée au dernier jour du mois cible.

Statuts : INCOMPLET, A_JOUR, A_PREVOIR, A_FAIRE et EN_RETARD. A_PREVOIR correspond à une distance restante positive inférieure ou égale au seuil d'anticipation, ou à une échéance dans la fenêtre de préavis. À la valeur kilométrique exacte ou le jour de l'échéance, A_FAIRE. Au-delà du kilométrage ou après ce jour local, EN_RETARD. Retenir le niveau le plus urgent et afficher séparément les données manquantes ou anciennes.

Exemple de recette, sans valeur de recommandation d'entretien : dernière vidange 80 000 km, intervalle 10 000, préavis 500. À 89 500 : A_PREVOIR ; à 90 000 : A_FAIRE ; à 90 200 : EN_RETARD. Une saisie qui passe directement de 89 500 à 90 200 doit déclencher le retard.

## 6.3 Intervention
Champs : référence, société historique, véhicule, type préventif/correctif, opérations ou plans concernés, garage/fournisseur, dates prévues et réelles, relevé d'exécution, diagnostic, travaux, lignes pièces/main-d'oeuvre, total et pièces jointes. Statuts : BROUILLON, PLANIFIEE, EN_COURS, TERMINEE, ANNULEE.

Planifier une intervention ne signifie pas qu'elle a été exécutée. L'immobilisation se gère explicitement, avec début, fin et motif. Une intervention urgente peut être ouverte depuis un incident.

## 6.4 Clôture et prochaine échéance
Pour terminer une opération récurrente, exiger date effective et relevé validé correspondant lorsque le plan utilise des km. Lier chaque ligne de travail au plan qu'elle réalise. Seules les opérations effectivement terminées mettent à jour leur propre plan. Changer une batterie ne remet pas la vidange à zéro.

Clôturer dans une transaction : intervention, travaux effectués, bases des plans, échéances suivantes, dépense liée et alertes. Recalculer depuis l'opération effective la plus récente, pas la dernière saisie. L'import d'un entretien ancien ne doit pas faire reculer la base courante. Une réouverture/correction est réservée au chef, motivée et auditée.

# 7. Documents, conformité et incidents

## 7.1 Documents et renouvellements
Types configurables par objet : assurance, visite technique, carte grise, vignette/taxe, licence, autorisation, contrat de location, permis et document libre. Chaque type précise s'il possède une expiration et si son absence/expiration bloque un départ. Le logiciel ne calcule pas de calendrier réglementaire non fourni.

Champs : objet propriétaire, type, numéro, organisme, date d'émission, début et fin de validité, fichier, notes et auteur. Un renouvellement crée une nouvelle version. La version valable à une date donnée est retenue ; un document futur ne remplace pas prématurément un document encore valide.

Statuts : MANQUANT, VALIDE, A_RENOUVELER et EXPIRE, avec le détail de la date. Une date de fin reste valable jusqu'à la fin de ce jour dans le fuseau du groupe. Les préavis par défaut sont 30, 15 et 7 jours, configurables. Les documents sans expiration ne produisent pas de fausse alerte d'échéance.

## 7.2 Blocages et exceptions
Lorsqu'un document paramétré comme bloquant manque ou expire, refuser un nouveau départ, mais autoriser une restitution. Une dérogation exige une permission spécifique, un motif et une trace d'audit ; elle ne modifie ni l'expiration ni la règle. Ce mécanisme administratif ne constitue pas une autorisation juridique de circuler.

## 7.3 Incidents
Types : panne, dommage, accident, crevaison, anomalie compteur, contravention et autre. Champs : société, véhicule, conducteur/utilisation facultatifs, date, lieu déclaré, description, gravité, photos, responsable de suivi, immobilisation éventuelle et coût lié. Statuts : OUVERT, EN_TRAITEMENT, RESOLU, CLOTURE.

Un conducteur peut déclarer un incident sur son utilisation ; il ne peut pas modifier un dossier concernant autrui. La résolution technique et la clôture administrative sont distinctes. Conserver les commentaires chronologiques. Une contravention reste une information de suivi ; aucune responsabilité personnelle ou retenue sur salaire n'est déduite automatiquement.

## 7.4 Immobilisations
Enregistrer cause, début, fin prévue, fin réelle, garage/site et incident/intervention source. Empêcher les doublons incohérents ; plusieurs motifs simultanés peuvent être regroupés sous une immobilisation active. La disponibilité est rétablie seulement après clôture de toutes les causes bloquantes. Les durées de plusieurs causes superposées ne doivent pas être additionnées deux fois dans les rapports.

# 8. Carburant, fournisseurs et dépenses

## 8.1 Fournisseurs
Répertoire par société : nom, catégorie (garage, station, assurance, loueur, autre), contact et notes. Archivage sans suppression de l'historique. La gestion des commandes, du stock et des comptes fournisseurs n'appartient pas à la V1.

## 8.2 Pleins et achats de carburant
Champs : véhicule, date, conducteur facultatif, station/fournisseur, litres, prix unitaire facultatif, montant total, type de carburant, indicateur plein complet/partiel, relevé compteur et ticket. Valeurs positives ; montant et prix unitaires utilisent des décimaux exacts. Un écart entre litres x prix unitaire et total doit être signalé selon une tolérance configurable, pas corrigé silencieusement.

Une soumission conducteur est un brouillon à valider ; elle ne produit pas de dépense ni de relevé accepté avant validation. Le chef peut enregistrer une dépense réelle avec compteur non validé : le coût compte dans les rapports, mais cette opération est exclue des calculs de consommation tant qu'elle n'est pas régularisée.

## 8.3 Consommation
Calculer une consommation uniquement entre deux pleins complets admissibles A et B, avec compteur cumulé croissant et tous les achats intermédiaires saisis pour la période. Litres consommés = somme des litres achetés après A, B inclus. Consommation = litres / (kmB - kmA) x 100. Le carburant acheté en A n'est pas inclus.

Exemple : A à 10 000 km, achat intermédiaire 20 L, B à 10 400 km avec 30 L : 50 / 400 x 100 = 12,5 L/100 km. Sans base fiable, afficher N/D avec le motif. Présenter ce résultat comme estimation fondée sur les saisies, pas comme mesure télématique. Les véhicules électriques sont gérables comme véhicules, mais le module énergie en kWh est hors V1.

## 8.4 Registre unique des dépenses
Catégories : entretien/réparation, carburant, assurance, location, taxes, péage, stationnement et autre. Champs : société au fait générateur, véhicule, date, catégorie, fournisseur, référence, montant TTC, devise, justificatif et source liée facultative. Les coûts sont imputés à la société historique, pas automatiquement au propriétaire courant du véhicule.

Un plein ou une intervention validée génère exactement une dépense de synthèse liée. Les lignes de pièces ne sont pas comptées à nouveau. Le tableau de bord additionne le registre des dépenses, pas simultanément les factures et leurs objets sources. Une référence source est unique ; un même justificatif ne doit pas générer deux écritures sur une relance.

V1 en devise unique du groupe, paramétrée TND avec trois décimales pour ce projet. Pas de conversion monétaire. Les achats de véhicules peuvent être conservés à titre informatif, mais sont exclus par défaut du coût d'exploitation. Le registre ne remplace pas la comptabilité et ne calcule pas d'obligations fiscales. Une correction d'une dépense validée crée une version ou une annulation traçable ; un avoir explicite réduit le coût, sans être confondu avec un paiement.

## 8.5 Carburant télématique (module F11)
Le carburant n'est collecté que si le fournisseur l'expose. Trois natures sont distinguées et affichées comme telles :
- NIVEAU_CAN : niveau de la jauge lu sur le bus CAN, en % ou en litres ; précision limitée, utile pour la tendance et le contrôle grossier.
- NIVEAU_SONDE : sonde de réservoir dédiée et étalonnée ; seule nature exploitable pour détecter une baisse anormale.
- CONSOMMATION_CAN : compteur de litres consommés fourni par le calculateur (fréquent sur poids lourds FMS).
Une consommation théorique calculée par la plateforme à partir d'un taux fixe n'est pas importée comme mesure.

Événements dérivés : remplissage détecté (hausse de niveau supérieure au seuil), baisse anormale à l'arrêt (moteur coupé, vitesse nulle, baisse supérieure au seuil sur une fenêtre configurable) et écart entre remplissage détecté et ticket saisi (litres hors tolérance ou absence de ticket dans une fenêtre de deux heures). Chaque événement devient une anomalie à qualifier par le chef ; aucune dépense, responsabilité ou retenue n'est déduite automatiquement.

La consommation de la section 8.3 reste calculée sur les pleins validés. Lorsque CONSOMMATION_CAN ou NIVEAU_SONDE existe, afficher en parallèle la consommation télématique, sa nature et l'écart avec la consommation déclarée. Les échantillons de niveau sont stockés au pas de cinq minutes maximum et conservés selon la rétention configurée ; les événements dérivés suivent l'historique du véhicule.

# 9. Alertes, notifications et traitements planifiés

## 9.1 Types d'alertes
Entretien à prévoir/à faire/en retard, document manquant ou proche d'expiration/expiré, kilométrage absent ou ancien, relevé à valider, retour dépassé, réservation compromise et incident critique non traité. Avec F11 : source GPS muette, dérive GPS, unité non mappée, baisse anormale de carburant et écart entre remplissage détecté et ticket. Chaque alerte contient type, gravité, objet, société, condition de déclenchement, date, responsable et lien vers l'action utile.

## 9.2 Cycle de vie
Une alerte métier peut être ACTIVE ou RESOLUE. « Lu » est un état propre à chaque utilisateur, distinct de la résolution. Masquer ou lire l'alerte ne signifie pas qu'une vidange a été réalisée. Un report jusqu'à une date doit afficher le motif et ne retire pas le statut de retard.

Résoudre seulement lorsque la condition cesse : entretien effectué, document valide, relevé récent ou retour constaté. La récurrence suivante crée une nouvelle occurrence. Dédupliquer par organisation, société, type, objet et occurrence ; évolution de gravité sur la même alerte, pas création de dizaines de doublons.

## 9.3 Déclenchement
Après validation d'un relevé, d'un entretien, d'un document ou d'une restitution, recalculer les conditions concernées. Une tâche de rattrapage toutes les quinze minutes gère échéances temporelles et événements manqués. Objectif de recette : alerte visible au plus tard une minute après une validation réussie ; alerte temporelle au plus tard quinze minutes après son seuil, lorsque les services sont disponibles.

Le fuseau de référence est Africa/Tunis, configurable au niveau groupe. Horodatages stockés en UTC ; dates civiles de validité conservées comme dates, sans décalage artificiel.

## 9.4 E-mail et fiabilité
Le centre d'alertes fonctionne sans SMTP. Lorsque le SMTP est activé, envoyer les alertes critiques et un récapitulatif quotidien à 08:00 locale aux destinataires autorisés. Les horaires, gravités et préférences sont configurables. Sans SMTP, afficher « Canal e-mail non configuré » ; ne jamais afficher un succès fictif.

Utiliser une outbox persistante avec statut, nombre de tentatives, prochaine tentative, erreur expurgée et date d'envoi. Prévoir reprise après redémarrage et verrouillage des traitements concurrents. Dédupliquer les jobs ; documenter qu'un e-mail peut exceptionnellement être livré deux fois si le fournisseur a accepté le message avant une rupture de confirmation. Les autorisations du destinataire sont revérifiées avant envoi. Aucun PDF personnel ou secret n'est inclus dans une notification par défaut.

# 10. Interface, navigation et parcours mobile

## 10.1 Principes d'interface
Application en français, responsive, utilisable sur ordinateur, tablette et smartphone. Prévoir une structure de traduction sans imposer une interface arabe en V1. Tables lisibles, filtres persistants, recherche, pagination, tri, confirmation des actions sensibles et messages d'erreur attachés aux champs.

Afficher le sélecteur de société et le périmètre courant. La vue « Toutes mes sociétés » existe seulement pour les personnes habilitées. Toute liste présente des états chargement, vide, erreur et accès refusé. Les statuts ne dépendent pas uniquement d'une couleur. Les boutons doivent être accessibles au clavier et les formulaires posséder des libellés.

## 10.2 Écrans attendus
| Route indicative | Contenu et actions |
| --- | --- |
| /login, /mot-de-passe-oublie | Connexion, réinitialisation, expiration de session ; aucune inscription publique. |
| /tableau-de-bord | Indicateurs, alertes prioritaires, retours attendus et actions rapides. |
| /vehicules, /vehicules/:id | Recherche multicritère, création, onglets du dossier, remise, relevé et entretien. |
| /conducteurs, /conducteurs/:id | Fiches, permis, historique autorisé et liaison au compte. |
| /planning | Vue jour/semaine/mois des réservations, utilisations et immobilisations. |
| /utilisations, /utilisations/:id | En cours, historique, remise, retour, retard et fiche imprimable. |
| /kilometrage | Saisie rapide par parc, photos, anomalies, validation et correction. |
| /entretiens, /interventions/:id | Plans, échéances, calendrier, travaux, clôture et coûts. |
| /documents | Échéances, documents manquants, renouvellement et accès aux fichiers. |
| /incidents, /immobilisations | Déclaration, traitement, suivi du garage et remise en disponibilité. |
| /carburant, /depenses | Saisies, justificatifs, validation, filtres et analyse des coûts. |
| /fournisseurs | Répertoire, contacts et historique autorisé. |
| /alertes | Centre d'alertes, lecture, responsable et action de résolution. |
| /rapports, /imports | Rapports filtrés, exports, modèles et import avec prévisualisation. |
| /administration | Sociétés, sites, utilisateurs, rôles, paramètres et audit. |
| /mon-vehicule | Vue mobile conducteur : utilisation en cours et trois actions principales. |

## 10.3 Mobile conducteur
Trois actions visibles : « Ajouter un kilométrage », « Signaler un problème » et « Ajouter un ticket carburant ». Accès à l'appareil photo via le navigateur. Afficher clairement si une soumission est en attente, acceptée ou refusée. Hors connexion, afficher une erreur explicite et ne pas prétendre avoir enregistré les données.

Un QR code interne sur le véhicule peut ouvrir sa fiche après authentification. Il contient uniquement un identifiant opaque/lien ; ce n'est ni une clé d'accès publique ni un moyen de contourner les permissions. Il ne remplace pas l'affectation d'un conducteur.

# 11. Tableaux de bord et rapports

## 11.1 Indicateurs
Par société, période et véhicule : parc actif, disponibles, en utilisation, immobilisés, hors service, entretiens urgents, documents expirés, relevés anciens et coûts d'exploitation. Chaque indicateur permet d'ouvrir sa liste justificative.

Pour les véhicules ACTIFS, disponible/en utilisation/immobilisé forment des groupes exclusifs avec les priorités de la section 3. Les véhicules hors service, cédés et archivés ne gonflent pas le parc disponible. Un taux doit afficher son numérateur, son dénominateur et sa période ; aucun indicateur opaque.

## 11.2 Rapports V1
Inventaire du parc, affectations et utilisations, relevés et qualité des données, entretiens réalisés/à venir, expirations documentaires, carburant, dépenses par catégorie/véhicule/société/fournisseur, incidents et durées d'immobilisation. Export CSV et XLSX des données autorisées ; fiches véhicule et remise/restitution imprimables en PDF via l'impression du navigateur.

Les exports reprennent les filtres, unités, fuseau et date de génération. Les droits sont revérifiés à l'exécution et au téléchargement. Protéger les exports contre l'interprétation de cellules textuelles comme formules. Un export ne donne pas accès à davantage de données que l'écran.

## 11.3 Distances et ratios honnêtes
Les distances sont des différences de kilomètres cumulés validés. Sans relevés délimitant exactement une période, afficher la période observée ou N/D ; ne pas interpoler une distance mensuelle en silence. Le coût/km est calculé seulement si coûts et distance couvrent un même intervalle explicitement défini et fiable. Ne pas diviser par zéro ni afficher zéro lorsque la donnée manque.

Un transfert de société au milieu d'une période ne doit pas attribuer tous les coûts ou kilomètres au propriétaire courant. Les dépenses sont historiques ; la distance entre deux relevés de sociétés différentes exige un relevé de transfert ou est marquée non ventilable.

# 12. Imports et initialisation

## 12.1 Import assisté
Fournir des modèles CSV UTF-8 et XLSX pour véhicules, conducteurs, relevés initiaux et bases d'entretien. Parcours : télécharger le modèle, envoyer le fichier, associer les colonnes, prévisualiser, contrôler, confirmer et consulter le rapport. Valeurs de date acceptées explicitement documentées ; dates ambiguës refusées.

Valider les sociétés autorisées, champs requis, formats, doublons de fichier/base et références. Le mode V1 crée de nouveaux dossiers et ajoute des relevés ; il n'écrase pas implicitement les fiches existantes. Pour un lot, aucune ligne n'est écrite avant confirmation et aucune ligne n'est validée si le lot comporte des erreurs. Maximum initial proposé : 2 000 lignes par lot et 5 Mo hors pièces jointes.

La confirmation est idempotente par identifiant de lot et empreinte du contenu. Fournir un rapport ligne/colonne/message. L'import de bases d'entretien ne simule pas une prestation facturée. Les documents numérisés se chargent dans leurs fiches, pas dans les cellules Excel.

## 12.2 Colonnes minimales
| Modèle | Colonnes obligatoires |
| --- | --- |
| Véhicules | company_code, vehicle_code, registration, make, model, category. |
| Conducteurs | company_code, driver_code, first_name, last_name, active. |
| Relevés | company_code, vehicle_code, observed_at, physical_km, meter_reference. |
| Bases d'entretien | company_code, vehicle_code, maintenance_type, interval_km et/ou interval_months, base_mode, base_date/base_km ou next_due_date/next_due_km. |

Les dépendances sont importées dans l'ordre : sociétés/sites, véhicules, conducteurs, compteurs/relevés, plans et bases. Chaque import est audité. Les compteurs initiaux peuvent être créés à partir d'une base clairement spécifiée ; aucun remplacement de compteur implicite.

# 13. Modèle de données attendu

## 13.1 Conventions
Identifiants UUID ; champs created_at, updated_at, created_by et version sur les objets modifiables. organisation_id sur toutes les données métier ; company_id sur les objets appartenant à une société. Les événements portent leur company_id historique. Les tables techniques globales sont explicitement documentées. Ne pas accepter une relation entre objets de groupes ou sociétés incompatibles.

Montants DECIMAL(18,3), quantités DECIMAL(18,3), kilomètres DECIMAL(15,3), affichage compteur manuel entier par défaut. Horodatages avec fuseau pour les événements ; dates seules pour les échéances civiles. Utiliser des énumérations cohérentes pour les statuts et une politique explicite d'archivage.

## 13.2 Entités principales
| Entité | Données et relations essentielles |
| --- | --- |
| Organisation, Company, Site | Hiérarchie, codes, coordonnées, statut, paramètres de fuseau/devise. |
| User, Session, Membership | Identité de connexion, sessions révocables, rôles par société et permissions additionnelles. |
| Driver, DriverPermit | Employé conducteur, société, compte facultatif, catégories et justificatifs du permis. |
| Vehicle, VehicleCompanyHistory | Identité, société courante, cycle de vie, dates des transferts et instantané technique. |
| VehicleResponsibleAssignment | Véhicule, conducteur habituel, début/fin ; historique indépendant des utilisations. |
| Reservation | Couple conducteur/véhicule, intervalle prévu, motif, statut et utilisation convertie. |
| VehicleUsage | Remise, retour, conducteur, relevés de départ/fin, checklist, retard et anomalies. |
| VehicleLocationReport | Lieu déclaré, date observée, auteur, contexte ; aucune position temps réel V1. |
| OdometerSegment | Dates du compteur, valeur physique initiale, base cumulée, justificatif de remplacement. |
| OdometerReading | Valeurs physique/cumulée, dates, source, contexte, statut, auteur et remplacement éventuel. |
| MaintenanceType, VehicleMaintenancePlan | Catalogue, intervalles, bases, seuils, prochaines échéances calculées. |
| Intervention, InterventionTask | Statuts, garage, travaux, relevé effectif, plans réalisés, lignes et total. |
| DocumentType, DocumentVersion | Objet véhicule/conducteur, validité, caractère bloquant et versions successives. |
| Incident, IncidentComment, Immobilization | Signalement, suivi chronologique, causes, début/fin et liens aux travaux. |
| Supplier, FuelEntry, Expense | Fournisseurs, achats, relevés, plein complet, dépense source unique et corrections. |
| Attachment | Propriétaire métier explicite, objet de stockage privé, type, taille, empreinte et auteur. |
| Alert, AlertRecipientState | Occurrence, gravité, condition, résolution, lecture/report par destinataire. |
| NotificationOutbox, JobLease | E-mails à traiter, tentatives, idempotence, verrou et battement du worker. |
| TelemetryProvider, TelemetryCredential | Fournisseur, canal (API, RAPPORT, RPA), paramètres, secret chiffré, sociétés couvertes, statut. |
| TelemetryVehicleMapping | Unité fournisseur ↔ véhicule, début/fin, nature du kilométrage, capteurs carburant disponibles. |
| TelemetryUnitState, TelemetrySyncRun | Dernière valeur reçue par unité et erreurs ; exécutions de synchronisation, volumes, durée, résultat. |
| FuelLevelSample, FuelEvent | Échantillons de niveau à rétention bornée ; remplissages, baisses anormales et rapprochements tickets. |
| AuditEvent, ImportBatch, ImportRow | Traces, avant/après expurgés, rapport d'import et identifiant de confirmation. |
| Settings, IdempotencyRecord | Paramètres versionnés, périmètre des clés et réponses rejouables. |

## 13.3 Intégrité et concurrence
Indexer les colonnes de périmètre, dates, statuts et clés de recherche. Garantir l'unicité d'une utilisation ouverte par véhicule et conducteur en base. Les réservations peuvent utiliser des contraintes d'exclusion sur intervalles PostgreSQL, adaptées au périmètre et aux statuts [R3]. Toute contrainte non représentable dans le schéma ORM doit être livrée par migration SQL versionnée.

Les remises, retours, corrections de relevés, validations de pleins, clôtures d'entretien et transferts sont transactionnels. Verrouiller dans un ordre constant les objets concernés ou utiliser un niveau d'isolation adapté avec reprises bornées. Prisma documente l'isolation Serializable et la reprise des conflits P2034 [R2]. Une erreur de concurrence doit devenir une réponse métier lisible, pas une double affectation.

Les relations doivent protéger organisation et société par des clés composites quand approprié, et par les validations des transitions historiques. Les champs calculés peuvent être matérialisés pour la lecture, mais doivent rester recalculables depuis les événements validés.

# 14. Architecture applicative et connecteur télématique

## 14.1 Socle proposé
Frontend Next.js avec App Router, TypeScript, Tailwind CSS et composants shadcn/ui. Backend NestJS avec API REST, logique métier centralisée et validation serveur. PostgreSQL et Prisma pour la persistance. Tests unitaires et d'intégration côté backend ; parcours navigateur avec Playwright ou outil équivalent.

Choisir des versions stables compatibles lors de l'initialisation, les figer dans le lockfile et documenter Node.js/PostgreSQL utilisés. Ne pas imposer des numéros de versions non vérifiés ni des images Docker :latest. Si un dépôt existant impose un socle compatible, conserver sa cohérence et documenter les adaptations.

Monorepo proposé : apps/web, apps/api, apps/worker, apps/telemetry-rpa (uniquement si le canal RPA est retenu), packages/contracts, packages/config, prisma/migrations, tests et docs. Le worker peut réutiliser les modules NestJS sans devenir un microservice métier distinct. Une outbox et des jobs PostgreSQL suffisent pour le périmètre initial ; Redis n'est pas imposé.

## 14.2 Modules et responsabilités
Auth, AccessControl, Companies, Drivers, Vehicles, Assignments, Odometer, Maintenance, Documents, Incidents, Fuel, Expenses, Reports, Notifications, Imports, Telemetry et Audit. Les règles de validation du kilométrage n'existent qu'à un seul endroit. Les pages ne recalculent pas une échéance selon une formule différente de celle du backend.

Les contrats REST sont documentés avec OpenAPI. Utiliser des DTO explicites plutôt que renvoyer directement des objets ORM contenant des données personnelles ou des champs techniques.

## 14.3 Connecteur télématique (module F11)
Un service d'ingestion unique, indépendant du formulaire, traite MANUAL, IMPORT et TELEMATICS avec les mêmes contrôles de validation, d'idempotence, de source et de fraîcheur. Un drapeau telemetryEnabled par société est faux par défaut. Chaque canal implémente le même contrat :

```ts
interface TelemetryProvider {
  listUnits(): Promise<ProviderUnit[]>;                        // id, libellé, immatriculation déclarée
  getOdometers(unitIds: string[]): Promise<OdometerSample[]>;  // valeur, measurementKind, observedAt
  getFuel(unitIds: string[], from: Date, to: Date): Promise<FuelSample[]>;
  healthCheck(): Promise<ProviderHealth>;
}
```

Trois canaux, retenus dans cet ordre selon la qualification de l'annexe A :
1. API : API officielle du fournisseur (REST, JSON-RPC ou webhook) avec compte ou jeton en lecture seule. Canal de référence.
2. RAPPORT : rapports planifiés du fournisseur (CSV/XLSX horaires ou quotidiens) envoyés vers une boîte e-mail dédiée ou un SFTP, lus par le worker. Sans temps réel, mais stable et conforme au contrat fournisseur.
3. RPA : automate Playwright authentifié sur le portail web du fournisseur avec un compte dédié en lecture seule. Il ne parcourt pas les écrans véhicule par véhicule : il ouvre une session puis appelle les requêtes JSON internes du portail, identifiées lors d'une phase de découverte, pour tout le parc en un appel. Dernier recours, soumis à accord écrit du fournisseur, sans contournement de captcha ni de double authentification. Le connecteur échoue proprement et alerte si le portail change.

Beaucoup de fournisseurs exploitent une plateforme en marque blanche (par exemple Wialon, Traccar, Navixy, GPS-Server) ; identifier la plateforme permet d'utiliser son API documentée. Exemples à vérifier sur la version utilisée : Wialon expose un compteur de kilométrage par unité et les valeurs de capteurs via sa Remote API ; Traccar expose totalDistance (distance GPS) et odometer (compteur véhicule lorsque le boîtier le remonte), en mètres.

## 14.4 Planification et résilience
Synchronisation du kilométrage et du carburant toutes les quinze minutes par défaut, cinq minutes au minimum selon le quota du fournisseur ; webhook utilisé s'il existe. Le kilométrage n'exige pas un temps réel à la seconde : l'objectif est une fraîcheur inférieure à une heure pour les alertes d'entretien. Un job par fournisseur et par société, verrouillé par JobLease, avec reprise exponentielle bornée, respect des quotas et coupe-circuit après échecs répétés. Chaque exécution est tracée dans TelemetrySyncRun. Une reprise initiale récupère l'historique disponible sur une période configurable. Une panne fournisseur ne bloque aucun parcours manuel.

## 14.5 Mapping des unités
Première synchronisation : lister les unités du fournisseur et proposer un rapprochement par immatriculation normalisée ; le chef confirme chaque association, aucun relevé n'est ingéré avant confirmation. Les unités non mappées et les véhicules sans unité active sont listés. Un changement de boîtier clôt le mapping précédent et en ouvre un nouveau sans modifier le kilométrage cumulé ; une valeur COMPTEUR_CAN inférieure après changement de boîtier est une anomalie, jamais un remplacement de compteur implicite.

## 14.6 Sécurité des accès fournisseur
Compte fournisseur dédié, en lecture seule, distinct des comptes personnels. Secrets (jeton, mot de passe RPA, accès boîte e-mail ou SFTP) chiffrés au repos avec une clé hors base, jamais renvoyés par l'API ni journalisés ; procédure de rotation documentée. Seul l'administrateur configure un fournisseur ; le chef consulte l'état de synchronisation de ses sociétés. Le canal RPA s'exécute dans un conteneur isolé, sans accès aux autres secrets. Les tests automatisés utilisent un simulateur explicitement nommé comme tel, impossible à activer en production.

# 15. API et contrats des opérations critiques

## 15.1 Conventions
Préfixe /api/v1. Requêtes authentifiées, pagination bornée, filtres validés, tri sur liste autorisée et dates ISO documentées. Les identifiants de société peuvent servir de filtre mais sont toujours recoupés avec les habilitations serveur. Les réponses de liste comportent items, total, page et pageSize.

Erreurs structurées : code, message français, fieldErrors facultatifs et requestId. Utiliser 401 pour absence d'authentification, 403 pour action interdite, 404 pour objet inaccessible/non trouvé, 409 pour conflit d'état ou de concurrence, 422 pour validation métier et 429 pour limitation de débit. Ne pas révéler l'existence d'un dossier hors périmètre.

## 15.2 Routes métier minimales
| Ressource | Opérations |
| --- | --- |
| /auth | login, logout, session, forgot-password, reset-password, revoke-sessions. |
| /companies, /sites, /users, /drivers | Liste, fiche, création, modification autorisée, archivage et habilitations. |
| /vehicles | CRUD contrôlé, synthèse, timeline, archive, transfer et location-reports. |
| /responsible-assignments, /reservations | Créer, modifier, terminer/annuler, calendrier et conversion. |
| /usages | Liste, détail, checkout et return ; aucune clôture par simple PATCH status. |
| /vehicles/:id/readings | Créer, consulter ; /readings/:id/approve, reject et correct. |
| /vehicles/:id/odometer-segments | Initialiser un compteur ou enregistrer son remplacement autorisé. |
| /maintenance-plans, /interventions | Bases, échéances, planification, start, complete, cancel et correction. |
| /documents, /attachments | Versions, renouvellement, upload et téléchargement privé autorisé. |
| /incidents, /immobilizations | Création, commentaires, transitions de traitement et fin d'immobilisation. |
| /fuel-entries, /expenses, /suppliers | Saisie, validation, annulation/correction, pièces et listes filtrées. |
| /alerts, /reports | Lecture, report motivé, compteurs et exports dans le périmètre. |
| /imports | Upload, preview, validate, commit et rapport par lot. |
| /telemetry | providers (administrateur), units, mappings, sync-runs, sync manuelle, fuel-events et qualification des anomalies. |
| /settings, /audit | Paramètres autorisés et consultation des traces. |

## 15.3 Contrats à verrouiller dans OpenAPI
Checkout : vehicleId, driverId, checkedOutAt, expectedReturnAt, reading ou motif d'exception, location, checklist et idempotencyKey. Return : usageId, returnedAt, reading ou exception autorisée, location, checklist et expectedVersion. Aucun companyId ne permet de contourner les relations réelles.

Reading : vehicleId, odometerSegmentId, physicalKm, observedAt, context, attachmentId facultatif et note. L'auteur, la société historique et la source autorisée sont déterminés/contrôlés par le serveur. Une approbation requiert expectedVersion ; une correction exige reason et replacementReading.

CompleteIntervention : interventionId, performedAt, acceptedReadingId lorsque nécessaire, completedTaskIds, lignes de coût, supplierId, pièces jointes, expectedVersion et idempotencyKey. Une transaction refuse les plans, fournisseurs ou documents hors périmètre.

Les clés d'idempotence sont liées à l'utilisateur, à l'organisation et à l'opération. Même clé/même corps : renvoyer le résultat initial ; même clé/corps différent : 409. Le verrou optimiste via version évite d'écraser une modification concurrente.

# 16. Sécurité, fichiers et exploitation

## 16.1 Authentification et sécurité
Comptes créés/invités par l'administrateur ; mot de passe haché avec un algorithme adapté tel qu'Argon2id, jamais stocké en clair. Session serveur révocable, cookie Secure et HttpOnly en production, protection CSRF des mutations et contrôle d'origine. Réinitialisation par jeton court, à usage unique, stocké sous forme non exploitable et invalidé après usage.

Prévoir limitation des tentatives, messages de connexion non énumérants, invalidation des sessions lors d'une désactivation et journalisation des événements sensibles. En V1, délai de session proposé de douze heures, configurable. Aucun secret en dur, dans le dépôt, dans les journaux ou exposé au bundle frontend. Aucun jeton de session persisté dans localStorage.

L'autorisation métier reste dans NestJS. Un contrôle de navigation Next.js ne remplace pas les contrôles des APIs [R1]. Toute action sensible produit un audit avec acteur, date, objet, motif et valeurs pertinentes avant/après, sans mot de passe ni jeton.

## 16.2 Pièces jointes
Stockage privé sur volume persistant en V1, via une abstraction permettant un stockage objet ultérieur. Autoriser PDF, JPEG et PNG ; contrôler taille, type réel, nom et chemin, avec maximum initial de 10 Mo par fichier. Ne pas accepter d'HTML, SVG exécutable ou scripts. Noms internes aléatoires, pas de chemin utilisateur utilisé directement.

Le téléchargement passe par une autorisation du propriétaire métier ou une URL signée courte émise après contrôle. Un UUID n'est pas une autorisation. Nettoyer les fichiers temporaires abandonnés ; journaliser les suppressions autorisées et définir la conservation selon les obligations validées avec le client. Ne pas annoncer une conformité juridique universelle.

## 16.3 Déploiement
Livrer Dockerfiles, compose de production avec web, api, worker, PostgreSQL et reverse proxy, volumes persistants et fichier .env.example. Utiliser HTTPS en production, garder PostgreSQL et le stockage privés, exécuter les migrations explicitement et fournir une procédure de mise à jour avec retour arrière de l'application. Ne pas promettre un rollback de migration destructrice sans sauvegarde.

Les endpoints de santé distinguent processus vivant et service prêt. Contrôler la base, le stockage et le battement du worker sans exposer de secret. Fournir les instructions de surveillance par un service extérieur au serveur applicatif : une panne totale du VPS ne doit pas dépendre d'une alerte envoyée par ce même VPS.

## 16.4 Sauvegarde et restauration
Sauvegarde quotidienne de la base et des pièces jointes, copie chiffrée hors du VPS, rétention initiale proposée de trente jours. Documenter la cohérence entre données et fichiers et tester une restauration complète dans un environnement isolé. Objectifs de conception à mesurer en recette : perte maximale de vingt-quatre heures de données et reprise en quatre heures selon infrastructure et volume ; ce ne sont pas des garanties acquises avant test.

# 17. Paramètres et exigences non fonctionnelles

## 17.1 Valeurs initiales proposées
| Paramètre | Valeur initiale |
| --- | --- |
| Langue / fuseau | Français / Africa/Tunis. |
| Devise / affichage | TND / trois décimales pour les montants. |
| Kilométrage ancien | Sept jours sans observation acceptée. |
| Préavis entretien | 500 km et/ou 30 jours, ajustables par plan. |
| Préavis documents | 30, 15 et 7 jours avant expiration. |
| Délai de retour | Alerte dès dépassement ; tolérance configurable. |
| Rattrapage d'alertes | Toutes les quinze minutes. |
| Récapitulatif e-mail | 08:00 locale si canal et destinataire activés. |
| Pièces jointes / imports | 10 Mo par pièce ; 5 Mo et 2 000 lignes par import. |
| Pagination | 25 lignes par défaut, maximum 100 par requête. |
| Télématique (F11) | Désactivée par défaut ; activable par société ; aucune dépendance externe sans activation. |
| Synchronisation | Kilométrage et carburant toutes les 15 min ; minimum 5 min selon quota fournisseur. |
| Source GPS muette | Alerte après 24 h sans donnée d'une unité mappée. |
| Dérive GPS | Alerte au-delà de 3 % d'écart avec un relevé manuel. |
| Historisation automatique | Au plus un relevé par heure et par véhicule s'il a progressé, plus un relevé quotidien. |
| Baisse carburant à l'arrêt | 10 L ou 5 % en 30 min, ajustable par véhicule. |
| Échantillons carburant | Pas de 5 min maximum ; rétention 90 jours. |

Une modification de paramètre est auditée. Les paramètres du groupe peuvent servir de valeurs par défaut ; les surcharges par société/plan sont explicites. Modifier un intervalle d'entretien affecte les échéances futures, pas les travaux historiques ; prévisualiser les impacts avant validation.

## 17.2 Qualité et dimensionnement
Cible de test initiale proposée : trois sociétés, 500 véhicules, 1 000 conducteurs, 300 000 relevés et cinquante sessions actives. Ce sont des hypothèses de dimensionnement, pas des volumes annoncés par le client. Avec F11 actif sur tout le parc : environ deux millions de relevés automatiques par an et treize millions d'échantillons carburant sur 90 jours ; partitionnement mensuel des tables d'échantillons et purge planifiée. Documenter le matériel, le jeu de données et le scénario de charge.

Objectifs de recette : p95 inférieur à deux secondes pour les lectures paginées courantes et trois secondes pour une mutation simple, hors réseau lent et transfert de fichier. Les rapports volumineux utilisent un job avec progression et droits revérifiés. Aucun chargement de l'historique complet pour afficher une page de 25 lignes.

L'application doit conserver les données après redémarrage, exposer des erreurs exploitables, assurer l'accessibilité des parcours principaux et ne présenter aucune action factice. La couverture de tests doit privilégier permissions, concurrence, chronologie, échéances et coûts plutôt qu'un simple pourcentage de lignes.

# 18. Recette fonctionnelle et tests d'acceptation

Les scénarios suivants sont bloquants pour la livraison. Les tests doivent utiliser une base de test et des données fictives, jamais les comptes ou documents réels du client. Les cas de temps utilisent une horloge contrôlable. Les tests T35 à T44 sont bloquants pour le lot F et utilisent le simulateur de fournisseur.

| Test | Action / données | Résultat attendu |
| --- | --- | --- |
| T01 - Périmètre | Chef A appelle fiche, recherche, rapport et fichier de B par leurs identifiants. | Aucun contenu de B ; refus cohérent et aucune fuite dans les compteurs. |
| T02 - Consolidation | Administrateur ouvre toutes les sociétés, puis filtre A. | Totaux consolidés puis limités à A ; données justifiables. |
| T03 - Conducteur | Conducteur tente de voir un autre conducteur ou un ancien utilisateur du véhicule. | Refus, même si l'identifiant est connu. |
| T04 - Double remise | Deux requêtes simultanées remettent le même véhicule à deux conducteurs. | Une seule réussite ; autre requête en conflit ; une seule utilisation ouverte. |
| T05 - Double conducteur | Même conducteur, deux véhicules au même instant. | Une seule utilisation en cours autorisée. |
| T06 - Réservations | Créneaux qui se chevauchent puis créneaux exactement consécutifs. | Chevauchement refusé ; succession [début, fin[ acceptée. |
| T07 - Retour tardif | Retour prévu dépassé avec une réservation suivante. | Alerte, utilisation toujours ouverte, départ suivant bloqué. |
| T08 - Responsabilité | Responsable habituel A, utilisation ponctuelle B. | Les deux informations restent distinctes ; historique conservé. |
| T09 - Chronologie km | Relevé de 89 000 après 89 500 dans le même segment. | Diminution refusée sans correction ou remplacement de compteur. |
| T10 - Rétroactivité | Insérer un ancien relevé entre deux relevés valides. | Contrôle des voisins ; compteur courant inchangé. |
| T11 - Validation | Conducteur soumet 90 200 ; relevé non encore approuvé. | Soumission visible en attente ; aucun compteur officiel modifié. |
| T12 - Fraîcheur | Aucun relevé ou dernier relevé antérieur au seuil. | INCONNU ou A_ACTUALISER ; pas de faux « à jour » garanti. |
| T13 - Correction | Chef corrige une lecture acceptée avec motif. | Original conservé, remplacement et audit ; calculs recalculés. |
| T14 - Compteur | Remplacement à 120 000 par 0 puis lecture 500. | Physique 500, cumul 120 500 ; entretien sur le cumul. |
| T15 - Vidange | Base 80 000, intervalle 10 000, relevés 89 500 / 90 000 / 90 200. | A_PREVOIR / A_FAIRE / EN_RETARD sans dépendance GPS. |
| T16 - Temps ou km | Date d'entretien atteinte avant le kilométrage. | Entretien à faire puis en retard selon le jour local. |
| T17 - Clôture ciblée | Terminer une batterie, puis une vidange à 90 300. | Batterie sans effet sur la vidange ; vidange suivante 100 300 si intervalle 10 000. |
| T18 - Historique entretien | Ajouter après coup une vidange antérieure à la dernière opération. | Base courante non régressée. |
| T19 - Alertes | Relancer dix fois le calcul d'une même occurrence. | Une alerte active ; aucune duplication de job logique. |
| T20 - Lecture d'alerte | Marquer « lu » une vidange en retard. | Le retard et l'alerte métier persistent. |
| T21 - Document | Fin de validité aujourd'hui, puis lendemain local ; renouvellement futur. | Valable jusqu'à la fin du jour ; expiré ensuite sauf version valide. |
| T22 - Blocage | Nouveau départ avec document bloquant expiré, puis restitution. | Départ refusé sauf dérogation autorisée ; retour autorisé. |
| T23 - Immobilisation | Immobiliser pendant une utilisation, puis restituer. | Utilisation conservée ; retour possible ; véhicule toujours immobilisé. |
| T24 - Coûts uniques | Valider deux fois la même intervention et le même plein. | Une seule dépense par source ; pas de double comptage. |
| T25 - Consommation | Deux pleins complets, partiel intermédiaire 20 L, dernier 30 L, distance 400 km. | 12,5 L/100 km ; N/D si distance ou historique insuffisants. |
| T26 - Transfert | Transfert avec opération ouverte, puis après résolution. | Refus initial ; transfert autorisé ensuite ; coûts historiques inchangés. |
| T27 - Import | Lot contenant doublon et mauvaise société, puis lot corrigé confirmé deux fois. | Aucune écriture du lot invalide ; une seule importation du lot corrigé. |
| T28 - Fichiers | Fichier privé de B, type interdit ou taille excessive. | Refus de lecture ou d'upload ; pas de fichier public. |
| T29 - SMTP/worker | SMTP absent, puis panne SMTP et redémarrage du worker. | Alertes internes disponibles, statut exact et reprise des tentatives. |
| T30 - Persistance | Redémarrer les services puis restaurer une sauvegarde isolée. | Base et fichiers retrouvés ; procédure de restauration vérifiée. |
| T31 - Sans GPS | F11 désactivé, puis F11 actif avec fournisseur injoignable. | Tous les parcours manuels fonctionnent ; alerte « source GPS muette » si F11 actif ; aucun faux suivi en direct. |
| T32 - Sessions | Désactiver un compte connecté ; rejouer une mutation/export. | Session refusée et accès révoqué. |
| T33 - Idempotence | Même clé avec corps identique, puis corps différent. | Réponse initiale rejouée, puis conflit 409. |
| T34 - Exports | Export filtré avec texte commençant comme une formule. | Périmètre respecté, texte neutralisé, aucun calcul injecté. |
| T35 - Mapping | Première synchronisation : 12 unités, 10 immatriculations reconnues, 2 inconnues. | 10 propositions à confirmer, 2 unités non mappées ; aucun relevé avant confirmation. |
| T36 - Idempotence synchro | Même lot fournisseur reçu deux fois. | Aucun doublon de relevé ni d'événement carburant. |
| T37 - Compteur CAN | CAN 50 000 puis 50 120 ; relevé manuel 50 130 une heure après. | Relevés acceptés ; compteur courant 50 130. |
| T38 - Calibrage GPS | Référence manuelle 80 000 à distanceGps 12 000 ; distanceGps 12 450. | Kilométrage 80 450 affiché « estimé GPS ». |
| T39 - Dérive | Estimation 81 000 depuis la référence 80 000 ; restitution manuelle 80 960. | Écart 4,2 % : alerte dérive ; nouvelle référence 80 960. |
| T40 - Régression automatique | Valeur CAN inférieure à la précédente. | Relevé EN_ATTENTE avec motif ; compteur courant inchangé ; remises non bloquées. |
| T41 - Source muette | Unité mappée sans donnée pendant 25 h. | Alerte source muette ; saisie manuelle possible ; fraîcheur sur la dernière observation. |
| T42 - Entretien automatique | Base vidange 80 000, intervalle 10 000 ; synchro CAN 89 500 puis 90 000. | A_PREVOIR puis A_FAIRE sans saisie manuelle ; alerte au plus une minute après ingestion. |
| T43 - Carburant | Sonde : baisse de 25 L moteur coupé en 20 min ; remplissage de 40 L sans ticket. | Deux anomalies à qualifier ; aucune dépense créée automatiquement. |
| T44 - Secrets | Lire la configuration fournisseur via l'API et les journaux. | Aucun secret restitué ni journalisé. |

# 19. Plan de réalisation et livrables

## 19.1 Lots d'implémentation
Lot A : socle, authentification, habilitations, sociétés, sites, fichiers privés, véhicules et conducteurs. Lot B : responsable habituel, réservations, utilisations, relevés, corrections et localisation déclarative. Lot C : plans d'entretien, interventions, documents, incidents et immobilisations. Lot D : carburant, registre de dépenses, alertes, e-mail et worker. Lot E : tableaux de bord, mobile, imports/exports, audit, tests complets et déploiement. Lot F : qualification du fournisseur GPS (annexe A), connecteur du canal retenu, mapping des unités, ingestion du kilométrage, carburant si disponible, alertes F11 et tests T35 à T44 ; il peut démarrer après le lot B, une fois les relevés manuels et leurs contrôles en place.

Ces lots sont un ordre de construction, pas une autorisation de livrer seulement une maquette. Chaque lot comprend API, base, interface, droits et tests. La V1 est complète seulement lorsque tous les lots et les tests de recette sont traités. Les ajouts hors périmètre doivent être distingués des exigences ci-dessus.

## 19.2 Livrables obligatoires
Dépôt complet frontend/backend/worker ; schéma et migrations ; jeu de démonstration fictif ; OpenAPI ; tests automatisés ; Dockerfiles et compose ; .env.example sans secrets ; procédures d'installation, mise à jour, sauvegarde et restauration ; guide utilisateur chef/conducteur ; documentation du connecteur télématique (canal retenu, mapping, rotation des secrets, reprise sur incident) ; rapport de recette avec commandes et résultats réels.

Le jeu de démonstration comporte trois sociétés, un administrateur, trois chefs, plusieurs conducteurs, douze véhicules et des cas illustrant vidange proche/en retard, document expiré, relevé ancien, retour tardif et immobilisation. Les mots de passe de démonstration ne sont jamais créés automatiquement en production. Un environnement vierge permet de créer un premier administrateur par commande sécurisée.

## 19.3 Définition de terminé
Chaque bouton réalise une action persistée ; aucun module obligatoire ne se limite à un mock ou à localStorage. Les permissions sont testées côté API. Lint, types, tests et build réussissent avec commandes reproductibles. La recette couvre les transitions et pas seulement l'affichage des pages. Une sauvegarde a effectivement été restaurée en test.

Le rapport final distingue : implémenté, testé avec succès, non testé et dépendance externe à configurer. Ne jamais annoncer « production ready » sur la seule base d'un build. Les identifiants SMTP, accès du fournisseur GPS, nom de domaine, stockage hors site et comptes réels sont des données d'exploitation à fournir, non des raisons pour remplacer les modules par de faux succès.

# 20. Références techniques

Les références suivantes étayent les points techniques signalés. Les règles métier, seuils et choix de périmètre du présent document sont des spécifications proposées pour ce projet, non des prescriptions de ces sources.

[R1] Next.js, Guide Authentication, sections Authorization, Data Access Layer et contrôle des mutations. Documentation consultée le 22 septembre 2026 : https://nextjs.org/docs/app/guides/authentication

[R2] Prisma, Transactions and batch queries, isolation Serializable et conflits/reprises P2034. Documentation consultée le 22 septembre 2026 : https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions

[R3] PostgreSQL, Range Types, section Constraints on Ranges, contraintes d'exclusion des chevauchements. Documentation consultée le 22 septembre 2026 : https://www.postgresql.org/docs/current/rangetypes.html

# 21. Annexe A - Qualification du fournisseur GPS

À conduire avant le lot F. Les réponses écrites du fournisseur déterminent le canal retenu et la nature des données par véhicule.

| Question | Réponse attendue | Conséquence |
| --- | --- | --- |
| Plateforme utilisée : développement propre ou marque blanche (Wialon, Traccar, Navixy, autre) ? | Nom et version | Identifie l'API documentée disponible. |
| API ouverte au client : documentation, authentification, quotas, coût ? | Oui/non et documentation | Oui : canal API. |
| Compte ou jeton dédié en lecture seule ? | Oui/non | Obligatoire pour API et RPA. |
| Origine du kilométrage par véhicule : compteur CAN ou calcul GPS ? | Liste par véhicule | COMPTEUR_CAN ou DISTANCE_GPS. |
| Carburant par véhicule : jauge CAN, sonde, compteur de consommation ou estimation théorique ? | Liste par véhicule | Nature carburant ; l'estimation théorique n'est pas importée. |
| Fréquence de remontée et profondeur d'historique ? | Minutes, mois | Paramètres de synchronisation et reprise initiale. |
| Webhook ou envoi push ? | Oui/non | Réduit la latence. |
| Rapports planifiés CSV/XLSX par e-mail ou SFTP ? | Oui/non et format | Canal RAPPORT à défaut d'API. |
| Lecture automatisée du portail web autorisée par écrit ? | Accord écrit | Condition du canal RPA. |
| Identifiant stable d'unité et immatriculation associée ? | Nom du champ | Mapping des unités. |

Décision : API disponible → canal API. Sinon rapports planifiés → canal RAPPORT, complété par RPA seulement si la fraîcheur horaire est indispensable et autorisée. Sinon RPA autorisé → canal RPA. Sinon F11 reste inactif et le régime manuel s'applique sans dégradation.
