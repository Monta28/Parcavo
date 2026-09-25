# Guide des imports

Ce guide décrit l’import assisté de l’application (cahier des charges 12.1 et 12.2 ; décisions D-277 à D-280). Il s’adresse aux chefs de parc et aux administrateurs, seuls habilités à importer, et uniquement pour les sociétés de leur périmètre.

## Parcours

1. **Choisir le modèle** dans l’écran « Imports » et télécharger le modèle vierge, en CSV (UTF-8) ou en XLSX. Le classeur XLSX contient une feuille « Données » (en-têtes seuls, cellules au format texte) et une feuille « Aide » qui décrit chaque colonne.
2. **Envoyer le fichier** : CSV UTF-8 ou XLSX, 5 Mo et 2 000 lignes de données au plus (paramètres `imports.maxSizeBytes` et `imports.maxRows`). À ce stade, rien n’est écrit dans les données du parc : le fichier est seulement conservé en stockage privé. Si le même fichier a déjà été importé, l’écran l’indique (« déjà importé le … »).
3. **Associer les colonnes** : l’application propose une association quand l’en-tête du fichier porte exactement le nom de la colonne du modèle (casse, espaces et tirets ignorés). Chaque colonne obligatoire doit être associée à un en-tête du fichier ; un même en-tête ne peut pas servir deux fois.
4. **Contrôler** : chaque ligne est appliquée exactement comme lors de la confirmation, puis tout est annulé. Le résultat donne, pour chaque ligne, son statut et les erreurs par colonne.
5. **Confirmer** : possible seulement si aucune ligne n’est en erreur. La confirmation revalide tout dans une transaction unique. Si les données ont changé depuis le contrôle (par exemple, une immatriculation créée entre-temps), rien n’est importé et le lot revient au contrôle avec les nouvelles erreurs.
6. **Consulter le rapport** : ligne, statut, colonne, message et objet créé ; téléchargeable en CSV.

Un lot non confirmé peut être abandonné.

## Garanties

- **Tout ou rien.** Aucune ligne n’est écrite avant la confirmation, et aucune n’est importée si le lot contient une erreur.
- **Confirmation idempotente.** Un double clic, un nouvel essai après une coupure réseau ou deux confirmations simultanées produisent une seule importation ; les confirmations suivantes renvoient le même rapport.
- **Pas d’écrasement.** L’import crée de nouveaux dossiers et ajoute des relevés ; il ne modifie jamais une fiche existante. Un code, une immatriculation ou un VIN déjà présents sont des erreurs.
- **Doublons dans le fichier.** Une même clé (code véhicule, immatriculation, VIN, code conducteur, compteur initial d’un véhicule, relevé d’un véhicule à la même minute, plan d’un véhicule pour une opération) ne peut apparaître qu’une fois par lot ; la ligne suivante est en erreur et cite la première.
- **Relevés déjà présents.** Un relevé identique à un relevé existant (même véhicule, même minute, même valeur) est ignoré (statut « Ignorée »), sans erreur (D-280). Une valeur différente à la même minute est une erreur.
- **Mêmes règles qu’à l’écran.** Chaque ligne passe par les services de saisie : formats des codes et longueurs, périmètre, contrôles de chronologie et de plausibilité des relevés, règles des plans d’entretien.
- **Audit.** Téléversement, contrôle, confirmation, refus de confirmation et abandon sont audités ; chaque objet créé l’est aussi.

## Formats acceptés

- **Encodage et séparateur (CSV)** : UTF-8, avec ou sans BOM ; séparateur « ; » ou « , », détecté sur la ligne d’en-tête ; guillemets doubles RFC 4180 en début de champ.
- **Classeur (XLSX)** : feuille « Données », sinon la première feuille. Les formules sans valeur calculée et les cellules fusionnées sont refusées.
- **Dates** : `AAAA-MM-JJ` ou `JJ/MM/AAAA` (jour en premier, année sur quatre chiffres), ou cellule date d’un classeur. Refusés : années sur deux chiffres, mois en lettres, numéros de série de date dans un CSV, dates inexistantes.
- **Horodatages** (`observed_at`) : `AAAA-MM-JJ HH:mm[:ss]`, `JJ/MM/AAAA HH:mm[:ss]`, ou ISO 8601 avec décalage (`2026-09-24T10:30:00+01:00`). Sans décalage, l’heure est celle du fuseau du groupe. Une date seule vaut 00:00, heure locale, et la ligne porte la note « heure non fournie ».
- **Kilomètres** : entiers sans séparateur (`45230`). `45.230`, `45,230` ou `45 230` sont refusés comme ambigus.
- **Décimaux** (capacité du réservoir) : point décimal, trois décimales au plus.
- **Booléens** : oui/non, true/false, 1/0, actif/inactif, vrai/faux.
- **Taille d’un lot** : 5 Mo au plus (hors pièces jointes) et 2 000 lignes de données au plus (lignes vides non comptées) ; au-delà, le fichier est refusé dès l’envoi (`FICHIER_TROP_VOLUMINEUX`, `TROP_DE_LIGNES`) et rien n’est conservé. Ces valeurs initiales (CDC 17.1) se réduisent dans Administration › Paramètres (`imports.maxSizeBytes`, `imports.maxRows`), jamais au-delà.
- **Documents numérisés** : ils ne s’importent jamais par le fichier. Aucun modèle ne comporte de colonne de document ; seules les valeurs des cellules sont lues, et une image insérée, un lien ou une colonne supplémentaire (« carte_grise », « assurance.pdf »…) est ignoré. Cartes grises, assurances, visites et permis se chargent ensuite dans la fiche du véhicule ou du conducteur (onglet Documents), avec leurs dates de validité.

## Ordre des imports

Importer dans cet ordre : sociétés et sites (créés dans l’administration), véhicules, conducteurs, relevés, puis bases d’entretien. Les catégories de véhicule et les opérations d’entretien sont désignées par leur code du catalogue ; les sites, par leur nom exact parmi les sites actifs de la société.

## Relevés et compteurs

- `meter_reference = INITIAL` crée le premier compteur du véhicule avec le relevé de la ligne. Sans `initial_cumulative_km`, le cumul est égal au compteur ; avec cette colonne, il s’agit d’une base cumulée validée (compteur déjà remplacé). Un véhicule dont le compteur est déjà initialisé est en erreur, sauf si la ligne est identique au compteur initial existant (ligne ignorée).
- `meter_reference = COURANT` ajoute un relevé au compteur en service. Un véhicule sans compteur initialisé est en erreur : l’import n’initialise jamais implicitement un compteur et ne remplace jamais un compteur.
- Une hausse au-delà du seuil de plausibilité n’est pas une erreur : la ligne est importée et le relevé reste « en attente de validation », avec la raison affichée dans le rapport (D-153).

## Bases d’entretien

Une ligne crée un plan d’entretien pour le véhicule et l’opération. Il faut au moins un intervalle (km et/ou mois ou jours ; mois et jours sont exclusifs). Selon `base_mode` :

- `DERNIERE_OPERATION` ou `BASE_TECHNIQUE` : `base_km` requis avec un intervalle en km, `base_date` requis avec un intervalle en temps ;
- `ECHEANCE_INITIALE` : `next_due_km` et/ou `next_due_date` ;
- `AUCUNE` : le plan est créé « incomplet ».

`base_km` et `next_due_km` sont exprimés en kilomètres cumulés. L’import d’une base ne crée ni intervention ni dépense : il ne simule aucune prestation.

Une base importée ne fait jamais reculer un entretien déjà enregistré : si un plan actif existe pour le véhicule et l’opération, la ligne est en erreur (« Un plan actif existe déjà… ») et le plan reste inchangé ; si une opération de ce type a déjà été réalisée (intervention terminée, y compris sur un ancien plan désactivé) après la date importée, c’est cette dernière opération qui reste la base du plan créé, et l’échéance se calcule à partir d’elle.

## Colonnes des modèles

### Véhicules (`VEHICULES`)

| Colonne | Obligatoire | Contenu | Exemple |
| --- | --- | --- | --- |
| `company_code` | oui | Code de la société (dans votre périmètre) | `NORD` |
| `vehicle_code` | oui | Code interne unique du véhicule | `VN-001` |
| `registration` | oui | Immatriculation (unique) | `123 TU 4567` |
| `make` | oui | Marque | `Peugeot` |
| `model` | oui | Modèle | `208` |
| `category` | oui | Code de la catégorie de véhicule | `VP` |
| `vin` | non | Numéro VIN | `VF3XXXXXXXXXXXXXX` |
| `energy` | non | DIESEL, ESSENCE, GPL, HYBRIDE, ELECTRIQUE ou AUTRE | `DIESEL` |
| `site` | non | Nom exact d’un site actif de la société | `Dépôt Tunis` |
| `year` | non | Année du modèle (4 chiffres) | `2022` |
| `commissioning_date` | non | Mise en service (AAAA-MM-JJ ou JJ/MM/AAAA) | `2022-03-15` |
| `tank_capacity_liters` | non | Capacité du réservoir en litres | `50` |

### Conducteurs (`CONDUCTEURS`)

| Colonne | Obligatoire | Contenu | Exemple |
| --- | --- | --- | --- |
| `company_code` | oui | Code de la société (dans votre périmètre) | `NORD` |
| `driver_code` | oui | Code unique du conducteur dans l’organisation | `D-042` |
| `first_name` | oui | Prénom | `Salma` |
| `last_name` | oui | Nom | `Ben Ali` |
| `active` | oui | oui/non, true/false, 1/0, actif/inactif | `oui` |
| `phone` | non | Téléphone | `+216 20 000 000` |
| `email` | non | E-mail | `salma@exemple.tn` |
| `site` | non | Nom exact d’un site actif de la société | `Dépôt Tunis` |

### Relevés kilométriques (`RELEVES`)

| Colonne | Obligatoire | Contenu | Exemple |
| --- | --- | --- | --- |
| `company_code` | oui | Code de la société du véhicule | `NORD` |
| `vehicle_code` | oui | Code du véhicule | `VN-001` |
| `observed_at` | oui | Date et heure d’observation (heure locale du groupe sans décalage) | `2026-09-01 08:30` |
| `physical_km` | oui | Valeur affichée au compteur, entier sans séparateur | `45230` |
| `meter_reference` | oui | INITIAL (premier compteur) ou COURANT (compteur en service) | `COURANT` |
| `initial_cumulative_km` | non | INITIAL seulement : kilomètres cumulés validés si le compteur a déjà été remplacé | — |
| `note` | non | Commentaire | `Reprise de l’historique` |

### Bases d’entretien (`BASES_ENTRETIEN`)

| Colonne | Obligatoire | Contenu | Exemple |
| --- | --- | --- | --- |
| `company_code` | oui | Code de la société du véhicule | `NORD` |
| `vehicle_code` | oui | Code du véhicule | `VN-001` |
| `maintenance_type` | oui | Code de l’opération du catalogue | `VIDANGE` |
| `interval_km` | non | Intervalle en km (au moins un intervalle requis) | `10000` |
| `interval_months` | non | Intervalle en mois (ou interval_days) | `12` |
| `interval_days` | non | Intervalle en jours (exclusif de interval_months) | — |
| `base_mode` | oui | DERNIERE_OPERATION, BASE_TECHNIQUE, ECHEANCE_INITIALE ou AUCUNE | `DERNIERE_OPERATION` |
| `base_km` | non | Base en kilomètres cumulés (DERNIERE_OPERATION / BASE_TECHNIQUE) | `80000` |
| `base_date` | non | Date de la base | `2026-01-10` |
| `next_due_km` | non | ECHEANCE_INITIALE : prochaine échéance en km cumulés | — |
| `next_due_date` | non | ECHEANCE_INITIALE : prochaine échéance (date) | — |
| `notice_km` | non | Préavis en km (défaut paramétré) | `500` |
| `notice_days` | non | Préavis en jours (défaut paramétré) | `30` |
