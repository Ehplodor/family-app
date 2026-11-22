# Architecture : partage, sécurité et notifications

Ce document explique **les choix faits pour Family App** : comment les données sont stockées, comment elles
sont partagées dans des cercles (famille, parents…), comment elles sont protégées et comment les rappels sont envoyés.

## Contraintes de départ

1. **Appli PWA publiée sur GitHub Pages** : un hébergement de fichiers statiques. Il n'y a **pas de serveur** pour
   faire tourner du code.
2. **Données enregistrées localement sur le téléphone**, utilisables hors ligne.
3. **Partage en temps réel dans la famille et dans des cercles plus restreints**, chiffré, avec une sécurité forte.
4. **Notifications fiables** pour tout ce qui mérite un rappel, **même appli fermée**.

Deux limites techniques en découlent :

- **Les téléphones d'une famille sont rarement allumés et connectés en même temps.** Une PWA est mise en pause par
  le système dès qu'elle passe en arrière-plan. Elle ne peut donc pas rester joignable.
- **Un navigateur ne peut pas réveiller une PWA fermée à une heure précise.** La seule façon d'afficher un rappel
  appli fermée est une notification **Web Push**, et une notification Web Push est forcément envoyée par un serveur.
  L'API « Notification Triggers », qui aurait permis des rappels locaux programmés, a été abandonnée. La
  « Periodic Background Sync » n'existe que sur Chrome Android, et c'est le navigateur qui décide de sa fréquence
  (en pratique quelques fois par jour).

**Conséquence :** sans aucun serveur, il est impossible d'avoir à la fois une synchronisation fiable et des rappels
à l'heure. La question est donc d'**utiliser un serveur auquel on n'a pas besoin de faire confiance**.

## Comparatif des stratégies de partage

| Stratégie | Temps réel | Téléphones pas en ligne en même temps | Rappels appli fermée | Infrastructure | Confidentialité | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **1. P2P WebRTC pur** (échange de connexion par QR code) | ✅ si les deux sont ouverts | ❌ aucune synchro | ❌ | Aucune | Excellente | Inadapté seul |
| **2. P2P WebRTC + signalisation publique** (trackers BitTorrent, Nostr, MQTT…) | ✅ | ❌ | ❌ | Services tiers publics, souvent un relais TURN pour la 4G/5G | Bonne, mais les métadonnées passent chez des tiers | Inadapté seul |
| **3. Relais public Nostr** (événements chiffrés) | ✅ | ⚠️ conservation non garantie | ❌ | Aucune à gérer | Contenu chiffré mais **publié publiquement, définitivement** | Déconseillé |
| **4. Base de données tierce** (Firebase, Supabase) + chiffrement de bout en bout | ✅ | ✅ | ✅ | Compte chez un tiers, SDK lourd | Bonne si tout est chiffré côté client | Possible |
| **5. Relais aveugle auto-hébergé** + chiffrement de bout en bout | ✅ | ✅ | ✅ (Web Push planifié) | 1 Worker Cloudflare, offre gratuite, sans maintenance | **Le relais ne voit que du chiffré** ; vous le contrôlez | ✅ **Retenu** |
| 6. Hybride 5 + P2P sur le Wi-Fi de la maison | ✅ | ✅ | ✅ | Comme 5 | Comme 5 | Évolution possible |

### Pourquoi le relais aveugle (stratégie 5)

- **Local d'abord :** chaque téléphone a une copie complète des données dans IndexedDB. L'appli s'ouvre et
  fonctionne sans réseau. Le relais n'est qu'une **boîte aux lettres**.
- **Boîte aux lettres :** le relais conserve les modifications chiffrées pour les appareils hors ligne. Ils
  rattrapent leur retard quand ils reviennent.
- **Temps réel :** quand plusieurs appareils sont ouverts, chaque modification est rediffusée instantanément
  (WebSocket). Un « ping » toutes les 25 s, et à chaque retour au premier plan, vérifie que la connexion
  répond encore : Android coupe souvent celle d'une appli en arrière-plan sans la fermer ; sans réponse en
  5 s, l'appli en ouvre une nouvelle et rattrape ce qu'elle a manqué.
- **Rappels :** le relais garde une file de notifications **déjà chiffrées** et les envoie à l'heure prévue.
- **Confiance minimale :** le relais n'a aucune clé. S'il était piraté, ou si Cloudflare lisait le disque, on n'y
  trouverait que des paquets illisibles (voir « Ce que le relais voit »).
- **Coût et maintenance :** l'offre gratuite de Cloudflare Workers et des Durable Objects suffit largement pour une
  famille. Il n'y a ni serveur à mettre à jour ni base de données à administrer. Le code du relais tient en environ
  400 lignes, lisibles dans `relay/src/`.

**Pourquoi pas le P2P seul ?** C'est séduisant (aucun intermédiaire), mais avec des téléphones la synchronisation
ne se ferait que si deux membres ont l'appli ouverte au même moment. Les rappels appli fermée seraient impossibles.
Sur les réseaux mobiles (NAT des opérateurs), il faut en plus souvent un relais TURN, qui redevient un
intermédiaire. Le P2P reste une **évolution intéressante en complément**, par exemple pour synchroniser directement
sur le Wi-Fi de la maison. Le moteur de synchronisation actuel le permettrait : les paquets chiffrés sont les mêmes,
seul le transport changerait.

## Modèle de sécurité

### Deux étages : l'espace et les cercles

```
ESPACE (un secret commun à tous les appareils, transport seulement)
   │ HKDF-SHA-256
   ├── identifiant de l'espace  → connu du relais (adresse de la boîte aux lettres)
   ├── jeton d'accès            → le relais n'en garde que l'empreinte SHA-256
   └── clé AES-256-GCM          → chiffre les paquets échangés avec le relais et les notifications

CERCLES (« Famille », « Parents », « Moi seul »…, tous identiques)        web/src/lib/vault.ts
   ├── secret du cercle, remis à chaque appareil autorisé, chiffré pour sa clé publique   → v2.keys
   ├── description chiffrée (nom, couleur) + liste des membres signée par l'admin          → v2.circles
   └── chaque élément (évènement, liste, message, photo…) :
          clé à usage unique → chiffre l'élément ; cette clé est « emballée » pour chacun de ses cercles
          le tout est SIGNÉ par l'appareil qui l'écrit                                    → v2.<collection>
```

- L'espace ne sert qu'à transporter : on n'y voit que des appareils **anonymes** (`v2.devices` : deux clés publiques,
  signées par l'appareil lui-même) et des paquets chiffrés pour des cercles. La famille n'est plus « la racine » :
  c'est un cercle comme les autres, et une personne peut être dans plusieurs cercles sans lien entre eux.
- **Chaque appareil a deux paires de clés P-256 non exportables** : ECDH (pour recevoir des secrets) et ECDSA (pour
  signer). Son identifiant est l'**empreinte de ses deux clés publiques** : personne ne peut publier d'autres clés sous
  l'identifiant d'un appareil existant.
- **Chiffrement authentifié AES-256-GCM** partout, avec des « données associées » qui lient chaque paquet à son usage.
  **WebCrypto uniquement :** aucune bibliothèque de cryptographie tierce, aucun script chargé depuis un CDN.

### Tout est signé, tout est vérifié sur l'appareil

Chaque document partagé est signé (ECDSA P-256) par l'appareil qui l'écrit. À la réception, chaque appareil vérifie
(`web/src/lib/vault.ts`, règles dans `web/src/lib/circles.ts`, testé dans `vault.test.ts`) :

1. la signature, par un appareil connu (et non déclaré perdu à ce moment-là) ;
2. que cet appareil est **autorisé** dans un des cercles de l'élément, pour un membre précis : son autorisation a été
   validée par l'admin du cercle, ou remise par un autre appareil du **même** membre, ou reconduite lors d'un
   renouvellement de clé. Un membre exclu ne peut plus écrire avec l'ancienne clé ;
3. les **droits** : chaque élément a un propriétaire (son auteur). Lui seul le supprime pour tout le monde ou change
   ses cercles ; les autres ne modifient que ce que permet le tableau ci-dessous, et « supprimer » ne le masque que
   pour eux ;
4. que la version est plus récente que la dernière bonne version gardée sur l'appareil.

Ce qui ne passe pas est **ignoré** : l'appareil garde la dernière bonne version. Un appareil qui ferait tourner une
version modifiée de l'appli ne peut donc ni écrire au nom d'un autre, ni supprimer ce qui ne lui appartient pas, ni
lire un cercle où il n'a pas été admis.

| Qui peut modifier l'élément d'un autre ? | Collections |
| --- | --- |
| Tous les membres des cercles qui le voient | agenda, anniversaires, articles de listes, contacts, repas, recettes, emploi du temps, leçons, devoirs, fiches de révision, réglages communs |
| Seulement les champs « fait », « échéance », « fait par », « fait le » | tâches |
| Personne d'autre que l'auteur | calendriers importés, listes, messages, photos, réveils, budget, profils École, profils, appareils, préférences |

### Admin, masterkey et relève

- Chaque cercle a **un admin** (son créateur au départ). Lui seul fait entrer une nouvelle personne, valide l'entrée de
  ses appareils, l'exclut, ou transmet son rôle. Chacun ajoute lui-même ses propres appareils (approbation par un de
  ses appareils déjà admis).
- La liste des membres est **signée par la clé d'administration**. Chaque membre a la sienne, non exportable sur
  l'appareil, et aussi chiffrée par une **masterkey** (32 caractères, 160 bits) que l'admin range dans un gestionnaire
  de mots de passe : elle lui rend son rôle sur un nouveau téléphone. Elle peut être ré-affichée 30 secondes après
  empreinte ou visage quand le téléphone le permet (WebAuthn « PRF ») ; sinon on peut seulement **vérifier** une
  masterkey tapée. L'appli propose une vérification tous les 6 mois.
- **Transmettre le rôle** : la nouvelle liste nomme la clé du nouvel admin et est signée par l'ancienne, qui ne vaut
  plus rien pour ce cercle ensuite.
- **Relève** (l'admin a perdu son téléphone ET sa masterkey) : un membre se propose ; si la **majorité des autres
  membres** signe, il devient admin au bout de **7 jours**, sauf si l'ancien admin s'y oppose avec sa clé. Une
  opposition vue une fois est gardée par chaque appareil.

### Ajouter quelqu'un, ajouter un appareil

1. *Cercles → Inviter* affiche un **secret d'invitation à usage unique, valable 15 minutes** (QR code ou lien). Il ne
   contient aucune clé.
2. Le nouvel appareil envoie une demande chiffrée avec ses clés publiques ; **les deux écrans affichent un code de
   5 émojis** à comparer.
3. Celui qui invite choisit : « un autre de mes appareils » (n'importe quel membre), ou « une nouvelle personne » /
   « l'appareil de … » avec les cercles où la faire entrer (admin seulement). Les clés de ces cercles sont remises à
   l'appareil, **toutes époques comprises** (il lit aussi ce qui a été écrit avant son arrivée), puis le secret de
   l'espace lui est envoyé, chiffré pour lui seul.

### Exclure, appareil perdu

- **Exclure** quelqu'un d'un cercle (admin) : nouvelle liste des membres, puis nouvelle clé remise aux seuls appareils
  restants. La personne garde ce qu'elle avait déjà vu, ne lit plus la suite, et ce qu'elle écrirait est ignoré. Ce
  qu'elle avait écrit **avant** reste valable.
- **Appareil perdu ou volé** : son membre, ou l'admin d'un de ses cercles, le **déclare perdu** (*Cercles →
  Appareils*). Les cercles où il était autorisé changent de clé, et tout ce qu'il signerait ensuite est ignoré. Seul un
  **autre** appareil peut annuler la déclaration (« Retrouvé ») : les nouvelles clés lui sont alors remises. *Sécurité
  → Changer la clé d'accès au relais* déménage en plus tout le monde vers un nouvel espace, pour qu'il ne reçoive même
  plus les paquets chiffrés.

> Limite inhérente à tout système : un appareil retiré **garde les données qu'il avait déjà**. Le renouvellement
> protège l'avenir, pas le passé.

### Déménagement de l'espace et migration

Un déménagement (`v2.move`, signé) dépose dans l'ancien espace le nouveau secret chiffré pour chaque appareil gardé ;
l'ancien espace passe en lecture seule, puis est effacé par le relais au bout de 30 jours (avec une « pierre
tombale » qui l'empêche d'être recréé).

**Passage de l'ancien format (version précédente de l'appli) — changement imposé** (`web/src/lib/migrate.ts`) :
l'appareil du créateur de la famille (« admin ») lance la mise à jour. Le cercle « Famille » est créé avec le nom
actuel de la famille et tous ses membres, et un nouvel espace est remis aux anciens appareils. Chaque appareil mis à
jour suit, est reconnu à sa clé de l'ancien format et admis par l'admin, puis republie **ses** données (il en reste
l'auteur) ; l'admin republie celles des personnes sans appareil. Les applis pas encore à jour restent sur l'ancien
espace fermé : **elles ne communiquent plus jusqu'à leur mise à jour**. Au-delà de 30 jours, l'ancien espace est
effacé : un appareil mis à jour plus tard doit être invité à nouveau.

### Autres précautions

- **Résistance au sabotage** : autorisations, déclarations de perte, oppositions et dernières bonnes versions sont
  gardées sur chaque appareil ; un document écrasé dans l'espace ne les efface pas. Les clés publiques d'un appareil
  voyagent avec chacune de ses autorisations.
- **Clés concurrentes** (deux renouvellements simultanés) : on garde celle dont les appareils sont inclus dans ceux de
  l'autre ; sinon l'écriture est bloquée et l'appli propose de renouveler la clé.
- **Photos** : chacune est chiffrée avec sa propre clé, rangée dans l'élément (chiffré pour ses cercles).
- **Rappels** : chaque appareil a une liste à part **par cercle**, calculée seulement par les appareils autorisés de
  ce cercle, avec les seuls éléments qu'il voit (`PUT /c/<espace>/part-schedule/<appareil>/<cercle>`, au plus 16 par
  appareil). La liste principale ne contient que les réveils de l'appareil.
- **Sauvegarde** : chiffrée par phrase secrète, elle contient les clés des cercles de l'appareil. Un appareil restauré
  peut tout relire ; pour écrire, il doit être admis (par un de ses autres appareils ou par l'admin).
- **Limites** : le code de 5 émojis ne protège que si on le compare vraiment. Un membre peut toujours renouveler la
  clé d'un cercle en laissant de côté d'autres appareils : ils voient « plus d'accès » et l'admin peut les faire
  rentrer. Un appareil qui arrive ne reçoit que la version actuelle d'un élément : si un appareil malveillant l'a
  écrasée, il en est privé (sans jamais lire un faux). Avec une seule masterkey et sans relève possible (cercle de
  deux personnes dont l'admin), un admin qui a tout perdu ne peut pas être remplacé.

### Ce que le relais voit (métadonnées)

| Le relais connaît | Le relais ne connaît pas |
| --- | --- |
| Un identifiant de cercle aléatoire | Le nom de la famille, les prénoms |
| Des identifiants d'appareils (empreintes de clés) | Le contenu des listes, de l'agenda, des messages, des photos |
| La taille et l'heure des paquets chiffrés | Le titre et le texte des notifications |
| L'**heure** d'envoi des rappels planifiés | La clé du cercle, et le jeton d'accès en clair (seulement son empreinte) |
| Pour chaque appareil, le nombre de cercles dont il reçoit des rappels (identifiants aléatoires) | Le nom, les membres et le contenu des cercles |
| L'adresse des services push (Google, Apple, Mozilla) | Qui a écrit quoi |

**Seule exception, choisie par l'utilisateur : les abonnements à un calendrier en ligne (.ics).** Les sites de
calendriers (Google, Outlook, clubs…) n'autorisent pas un navigateur à lire leurs fichiers depuis un autre site
(CORS), et la CSP de l'appli n'autorise que le relais. Quand une famille s'abonne à une adresse, c'est donc le
relais qui télécharge le fichier (route `POST /c/<cercle>/ics`, `relay/src/ics.ts`) : il voit alors l'adresse et
le contenu de ce calendrier, sans rien stocker ni journaliser. L'appli le dit avant l'abonnement et propose
l'alternative 100 % privée : importer le fichier `.ics`. Une fois reçus, les événements sont stockés et partagés
chiffrés comme le reste (collection `calendars`). Garde-fous : jeton du cercle obligatoire, 60 téléchargements par
cercle et par jour, https et noms de domaine publics uniquement (y compris après chaque redirection, au plus 3),
2 Mo et 10 s maximum, réponse refusée si ce n'est pas un calendrier (le relais ne peut pas servir de proxy vers
n'importe quelle page). Côté appli, un calendrier est limité à environ 200 Ko (les événements les plus proches
d'aujourd'hui sont gardés) pour ne jamais dépasser la taille d'un paquet de synchronisation.

Les jours fériés (calculés) et les vacances scolaires (données embarquées dans l'appli, `web/src/lib/calendars.ts`,
à compléter chaque année) ne demandent aucun accès réseau.

Les services push des navigateurs (FCM, APNs, Mozilla) ne voient eux aussi que du chiffré : les notifications
sont chiffrées une première fois pour le navigateur (RFC 8291), et leur contenu est déjà chiffré une seconde fois
avec la clé de l'espace.

### Un relais partagé par de nombreuses familles

Le site public est le même pour tout le monde. Chaque famille crée son cercle avec un secret aléatoire de 256 bits.
Les identifiants de cercle ne se devinent pas, et les jetons d'accès sont propres à chaque cercle. Pour un relais
ouvert, les abus de ressources sont limités :

- nombre de nouveaux cercles par connexion et par jour, compté avec une empreinte « adresse + jour » effacée sous
  2 jours (une adresse IPv6 compte pour tout son préfixe /64), ainsi qu'un plafond global journalier ;
- **quota progressif** par cercle : 20 Mo à l'arrivée, puis +10 Mo par jour jusqu'à 250 Mo. Le relais ne peut pas
  distinguer une vraie photo chiffrée de données inutiles ; c'est donc le temps qui rend l'abus coûteux. Avec ces
  réglages, remplir l'espace gratuit (environ 5 Go) demanderait des semaines d'efforts visibles au lieu de quelques
  minutes ;
- effacement des cercles inactifs ;
- nombre de rappels en attente plafonné par cercle (6 000), et rappels à plus de 40 jours ignorés ;
- notifications envoyées **uniquement** aux services push des navigateurs (Google, Mozilla, Apple,
  Microsoft) : le relais ne peut pas servir à envoyer des requêtes vers d'autres sites ;
- seul le site configuré (`ALLOWED_ORIGINS`) peut utiliser le relais depuis un navigateur.

Lors d'un renouvellement de clé, le nouveau cercle prouve détenir le jeton de l'ancien : il garde son ancienneté
(quota) et n'est pas compté comme une création. Un cercle ne transmet son ancienneté **qu'une seule fois**, et
il est alors fermé ; ces renouvellements sont eux aussi limités par connexion et par jour. On ne peut donc pas
multiplier les cercles « anciens » à partir d'un seul.

### Menaces couvertes, et celles qui ne le sont pas

| Menace | Protection |
| --- | --- |
| Piratage du relais, de Cloudflare, ou d'un service push | Chiffrement de bout en bout : aucune donnée lisible |
| Écoute du réseau | HTTPS/WSS + chiffrement de bout en bout |
| Lien d'invitation intercepté | Usage unique, 15 min, approbation, code de vérification, alerte « nouvel appareil » |
| Téléphone perdu ou volé | Déclaration de perte (nouvelles clés, écritures ignorées), changement de clé d'accès au relais ; verrouillage et chiffrement du téléphone par le système |
| Altération ou rejeu de messages par le relais | AES-GCM authentifié, données associées au contexte |
| Données effacées par le navigateur | Demande de stockage persistant + **sauvegarde chiffrée** (PBKDF2 600 000 itérations + AES-256-GCM) |
| Code malveillant injecté dans la page | Politique CSP stricte : code et connexions limités à l'appli et au relais configuré ; liens des recettes limités à `http(s)` |
| Site piégé qui affiche l'appli dans un cadre invisible (clickjacking) | L'appli refuse de s'afficher dans un cadre |
| **Compromission du dépôt GitHub** | ⚠️ Non couvert techniquement : le code servi par GitHub Pages a accès aux clés. **Activez l'authentification à deux facteurs, protégez la branche `main`, relisez les modifications.** Les actions GitHub sont épinglées par empreinte. |
| **Autre site sur la même origine** | ⚠️ Toutes les pages `https://<compte>.github.io/*` partagent la même origine, donc le même stockage. **N'hébergez pas d'autres projets GitHub Pages sur ce compte, ou utilisez un domaine personnalisé** (ex. `famille.mondomaine.fr`). |
| Visiteur malveillant qui crée des cercles en masse ou remplit l'espace | Limites de création (par connexion et au total, par jour), quota progressif par cercle, effacement des cercles abandonnés |
| Autre site (fork) qui se branche sur votre relais | `ALLOWED_ORIGINS` (navigateurs), et dans tous les cas les mêmes garde-fous |
| Membre malveillant dans un cercle | Il ne peut ni écrire au nom d'un autre (signatures), ni supprimer ou modifier au-delà de ses droits, ni faire entrer quelqu'un (admin seulement). Il peut lire ce que le cercle voit et écrire ce que ses droits permettent. |
| Appareil de la famille (version modifiée) | Il ne lit aucun cercle où il n'a pas été admis, ne peut pas faire adopter une fausse clé ni une fausse liste de membres, ni abîmer un élément sur les appareils qui en ont la bonne version ; un membre exclu ne lit pas la suite. |

## Synchronisation : comment les modifications se fusionnent

- Chaque modification est une **opération** : document, champs modifiés, horloge logique hybride (HLC).
- **Fusion champ par champ, la plus récente gagne** (CRDT « last-writer-wins »). Si Julie coche « lait » pendant que
  Paul renomme ce même article, les deux modifications sont conservées.
- Deux appareils qui reçoivent les mêmes opérations, **dans n'importe quel ordre**, aboutissent au même état. C'est
  vérifié par les tests, y compris quand l'horloge d'un téléphone retarde.
- Les opérations faites hors ligne attendent dans une file locale persistante (`outbox`) et partent au retour du
  réseau.
- Pour que le journal du relais ne grossisse pas indéfiniment, un appareil envoie régulièrement un **instantané
  chiffré** de l'état, et l'historique antérieur est supprimé.

## Notifications : la conception

### Principes

1. **Prévenir seulement les personnes concernées** : membres d'un événement, personne à qui la tâche est confiée.
   Quand personne n'est indiqué, toute la famille est prévenue.
2. **Ne pas réveiller la maison** : des **heures calmes** sont réglables par membre (21:30 → 7:30 par défaut). Les
   rappels non urgents attendent le réveil. Les rendez-vous et les tâches à heure fixe passent toujours.
3. **Regrouper plutôt qu'empiler** : « Courses · 5 ajouts » au lieu de 5 notifications. Chaque notification porte
   une étiquette, et une nouvelle version remplace l'ancienne, aussi bien sur le téléphone que chez le service push
   (en-tête `Topic`).
4. **Ne pas notifier l'auteur** de sa propre action.
5. **Les alertes de sécurité passent toujours.**
6. **Chaque membre règle ses préférences** : catégories, délai par défaut, heures calmes, heure du résumé.
7. **Action « Rappeler dans 1 h »** sur les rappels (Android ; iOS n'affiche pas les boutons d'action).

### Catalogue

| Catalogue | Quand | Qui | Heures calmes |
| --- | --- | --- | --- |
| **Rendez-vous** | Délai réglable par événement (aucun, à l'heure, 10 min, 30 min, 1 h, 2 h, la veille) ou par défaut | Membres de l'événement | Ignorées (heure précise) |
| Événement « toute la journée » | Le jour même, à 8:00 | Membres de l'événement | Respectées |
| Événements récurrents | Chaque occurrence (hebdo, mensuel, annuel) | Membres de l'événement | Selon le type |
| **Résumé du matin** | 7:30 par défaut, seulement s'il y a quelque chose : agenda, tâches, anniversaires, repas | Chaque membre, contenu personnalisé | Respectées |
| **Anniversaires** | 7 jours avant (avec les idées cadeaux), puis le jour J | Toute la famille | Respectées |
| **Tâches** | À l'échéance (heure de la tâche ou 9:00), puis **une** relance si elle est en retard | Personne assignée, ou tout le monde | Ignorées si l'heure est précise |
| **Repas** | La veille à 18:00 : « Demain soir : crêpes » (courses, décongélation) | Toute la famille | Respectées |
| **Planning des repas** | Dimanche 17:00 si la semaine suivante est presque vide | Toute la famille | Respectées |
| Nouveau **message** | Immédiat | Les autres membres | Respectées (attend le matin) |
| Ajouts dans une **liste** | Regroupés sur environ 8 s | Les autres membres | Respectées |
| **Agenda** modifié par quelqu'un d'autre | Regroupé | Membres concernés | Respectées |
| **Tâche confiée** | Immédiat | La personne assignée | Respectées |
| Nouvelles **photos** | Regroupées | Les autres membres | Respectées |
| 🔐 **Nouvel appareil dans le cercle** | Immédiat | Tous les appareils | **Toujours envoyée** |
| 🏫 **Travail du jour** (école) | Heure des devoirs (17:30, ou 10:30 les jours sans cours l'après-midi) | L'enfant ; copie facultative aux parents, éventuellement « 1 h après, si pas fait » | Respectées, et jamais pendant un cours |
| 🎒 **Cartable de la veille** | 19:30 : cours du lendemain, contrôles, choses à prévoir | L'enfant (+ copie) | Respectées |
| 🧠 **Petite question** | 1 à 3 par jour (7:45, 18:45…) avec le bouton « Voir la réponse » | L'enfant seulement par défaut | Respectées, et jamais pendant un cours |
| 🏫 Devoir ajouté par un parent | Immédiat | L'enfant | Respectées |

### Fonctionnement technique

- Les rappels des **14 prochains jours** sont calculés **sur les appareils** (`web/src/lib/reminders.ts`), chiffrés
  un par un, puis confiés au relais avec leur heure d'envoi.
- Après une modification locale, l'appareil recalcule les rappels de **tous** les appareils, car les autres n'ont
  peut-être pas ouvert l'appli depuis. Après une modification reçue d'un autre appareil, il ne recalcule que les
  siens. La liste envoyée remplace la précédente, donc il n'y a pas de doublon.
- Le relais réveille son Durable Object à l'heure prévue (`alarm`) et envoie la notification Web Push (VAPID,
  RFC 8291/8292).
- Le service worker du téléphone **déchiffre** le contenu avec la clé du cercle et l'affiche. Si le contenu est
  illisible (clé renouvelée entre-temps), il affiche une notification neutre, sans détail.

### Réveils

- Un réveil (`alarms`) appartient à un membre **et** à un appareil (`deviceId`). Il est rangé, chiffré, dans les
  données du cercle pour pouvoir être **transféré** d'un appareil à l'autre (changer `deviceId`), mais l'appli ne
  l'affiche qu'à son propriétaire et seul l'appareil choisi sonne. Calculs : `web/src/lib/alarms.ts` (testé).
- **Appli ouverte** (`AlarmWatcher`, idéalement en « mode chevet » avec l'écran maintenu allumé) : écran de
  sonnerie plein écran, bip en boucle généré par WebAudio, vibration, grand bouton « répéter », glisser vers le
  haut pour arrêter ou passer au défi.
- **Mode chevet** : un site ne peut pas régler la luminosité du téléphone. L'écran reste donc noir (pixels
  éteints sur OLED) avec une horloge très pâle qui se déplace chaque minute (anti-marquage). Un toucher ou un
  mouvement du téléphone (`devicemotion`, Android) la rend lisible 10 s ; l'écran de sonnerie est lumineux.
  Au choix : horloge pâle, noir complet (rien d'allumé hors toucher), ou fonds animés originaux très sombres
  (tuyaux, aquarium ; canvas à environ 12 images/s, `web/src/pages/Screensaver.tsx`).
- **Appli fermée** : les sonneries des 7 prochains jours sont envoyées au relais avec les autres rappels de
  l'appareil (une notification à l'heure, puis deux relances à +3 et +6 min, même étiquette). La notification
  est insistante (`requireInteraction`, vibration) avec « Répéter » et, sans défi, « Arrêter ». L'heure de la
  dernière sonnerie arrêtée est gardée **sur l'appareil** (IndexedDB `kv`, `alarmDone:<id>`) : le service worker
  n'affiche pas les relances d'un réveil déjà arrêté.
- **Limite honnête d'une PWA** : aucun navigateur ne permet à un site de jouer une sonnerie continue appli fermée,
  ni de passer outre le mode silencieux / Ne pas déranger. Appli fermée, le réveil = le son et la vibration d'une
  notification. Il faut aussi du réseau à l'heure du réveil, et ouvrir l'appli au moins une fois par semaine.

### Particularités des plateformes

- **Android (Chrome, Edge, Firefox)** : fonctionne dans le navigateur ou une fois installée, avec les boutons
  d'action.
- **iPhone/iPad (iOS 16.4 ou plus)** : il faut d'abord **ajouter l'appli à l'écran d'accueil**, puis activer les
  notifications depuis l'appli installée. Il n'y a pas de boutons d'action. Sur iOS, le stockage de l'appli
  installée est séparé de celui de Safari : il faut rejoindre le cercle **depuis l'appli installée**, avec le
  scanner de QR intégré ou en collant le lien.

## Espace École : rappels « intelligents »

Toute la logique est dans `web/src/lib/school.ts` (fonctions pures, testées dans `school.test.ts`).

### Ne pas tout faire au dernier moment

Chaque élément du cahier de textes a un **temps de travail estimé** (20 min pour un devoir, 1 h de révision
pour un contrôle, 2 h pour un exposé, modifiables). Ce temps est **découpé en séances courtes** (20 min par défaut),
réparties **avant l'échéance** :

| Type | Placement des séances | Pourquoi |
| --- | --- | --- |
| Devoir | Le plus tôt possible | Prendre l'habitude de faire le travail le jour où il est donné |
| Exposé / projet | Étalé régulièrement jusqu'à la veille | Éviter le rush final |
| Contrôle | J-1, J-3, J-6, J-10… | **Révisions espacées** : on retient bien mieux en révisant plusieurs fois qu'une seule fois la veille |
| Leçon à apprendre | Le jour même, puis la veille du cours | Apprendre puis se rappeler, le lendemain ou plus tard |

- Le planning respecte une **charge maximale par jour** (45 min en semaine, 60 le mercredi, réglables) et traite
  d'abord les échéances les plus proches.
- Il se **recalcule en continu** : quand l'enfant appuie sur « Fait », le reste est replanifié. Si une séance est
  ratée, elle est reportée sur les jours suivants. S'il n'y a plus assez de temps, la notification passe en
  « ⏰ il est temps ».
- **L'emploi du temps sert partout :**
  - proposer la date « prochain cours de Maths » ;
  - préparer le cartable de la veille ;
  - choisir l'heure des devoirs (le mercredi après-midi est libre) ;
  - **ne jamais envoyer de notification pendant un cours**.

  Les semaines A/B sont gérées.

### Apprendre ses leçons sans s'en rendre compte

- Une leçon se saisit en quelques lignes `question = réponse`.
- **Répétition espacée (boîtes de Leitner) :** une bonne réponse fait passer la question dans la boîte suivante et
  l'espace davantage (1, 2, 4, 8 puis 16 jours). Une erreur la ramène au lendemain.
- **Une ou deux questions par jour arrivent en notification**, à des moments creux (petit-déjeuner, après
  l'école). Sur Android, le bouton « Voir la réponse » l'affiche sans ouvrir l'appli : 10 secondes, sans effort.
- **Avant un contrôle**, les questions des leçons concernées passent en priorité pendant les 5 jours précédents.
- L'onglet *Révisions* propose aussi une série de 10 questions.

### Copie aux parents (facultative)

Elle se règle par enfant, dans *École → Réglages* :

- quels parents la reçoivent (tous par défaut) ;
- quels rappels (travail du jour, cartable, petites questions) ;
- quand : en même temps, ou **30 min, 1 h ou 2 h après, seulement si ce n'est pas fait**.

La copie disparaît d'elle-même dès que l'enfant note son travail comme fait, car les rappels sont recalculés à
chaque modification. Pour un enfant sans téléphone, la copie est le moyen de recevoir ses rappels. Chaque parent
peut aussi couper toutes les copies dans ses réglages de rappels.

## Pistes d'évolution

- Verrouillage de l'appli par code PIN ou biométrie (WebAuthn), avec chiffrement local de la base.
- Synchronisation P2P directe (WebRTC) sur le réseau local, en plus du relais.
- Signature des opérations par appareil, pour se protéger d'un membre malveillant.
- Pièces jointes dans les messages, documents (passeports, carnets de santé) avec rappels d'expiration.
- Export iCal de l'agenda (lecture seule, chiffrement à préserver).
- École : enregistrer « je savais / à revoir » directement depuis la notification ; import de l'emploi du temps
  depuis l'ENT (Pronote, EcoleDirecte…) si un export est disponible ; statistiques de régularité pour l'enfant.
