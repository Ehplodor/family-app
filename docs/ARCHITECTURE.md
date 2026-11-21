# Architecture : partage, sécurité et notifications

Ce document explique **les choix faits pour Family App** : comment les données sont stockées, comment elles
sont partagées dans le cercle familial, comment elles sont protégées et comment les rappels sont envoyés.

## Contraintes de départ

1. **Appli PWA publiée sur GitHub Pages** : un hébergement de fichiers statiques. Il n'y a **pas de serveur** pour
   faire tourner du code.
2. **Données enregistrées localement sur le téléphone**, utilisables hors ligne.
3. **Partage en temps réel dans un cercle familial**, chiffré, avec une sécurité forte.
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
  (WebSocket).
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

### Les clés

```
Secret du cercle (256 bits aléatoires, ne quitte jamais un appareil en clair)
   │ HKDF-SHA-256
   ├── identifiant du cercle  → connu du relais (adresse de la boîte aux lettres)
   ├── jeton d'accès           → le relais n'en garde que l'empreinte SHA-256
   └── clé de contenu AES-256-GCM → chiffre TOUT : modifications, photos, notifications, instantanés
```

- **Chiffrement authentifié AES-256-GCM.** Chaque message a un vecteur d'initialisation (IV) aléatoire et des
  « données associées » (identifiant du cercle + usage). Un message modifié est rejeté, et un message ne peut pas
  être rejoué dans un autre contexte (une notification ne peut pas passer pour une modification de données).
- **Chaque appareil a une paire de clés ECDH P-256**, dont la clé privée n'est pas exportable. Elle sert à lui
  transmettre le secret du cercle de façon que **lui seul** puisse le lire.
- **WebCrypto uniquement :** aucune bibliothèque de cryptographie tierce, aucun script chargé depuis un CDN.

### Ajouter un appareil : invitation avec approbation

1. Un membre ouvre *Ma Famille → Inviter*. Un **secret d'invitation à usage unique, valable 15 minutes**, est
   affiché sous forme de QR code ou de lien. **Il ne contient pas la clé du cercle.**
2. Le nouvel appareil envoie une demande chiffrée qui contient sa clé publique.
3. **Les deux écrans affichent un code de 5 émojis**, à comparer de vive voix ou en visio. Ce code est calculé à
   partir du secret d'invitation et de la clé publique du demandeur.
4. Le membre approuve. Le secret du cercle est alors chiffré **pour la clé publique de cet appareil précis**.

Si le lien d'invitation fuite (capture d'écran, message intercepté), il ne suffit pas pour entrer dans le cercle.
Il faut aussi l'approbation d'un membre, et l'intrus n'aura pas le bon code de vérification. Par ailleurs, chaque
nouvel appareil déclenche une **alerte de sécurité** chez tous les membres.

### Retirer un appareil (téléphone perdu, membre qui part) : renouvellement de clé

1. Un nouveau secret est créé.
2. Il est chiffré séparément pour chaque appareil **restant**, avec sa clé publique. Ces enveloppes sont
   déposées dans l'ancien cercle.
3. Les appareils restants basculent automatiquement vers le nouveau cercle, même s'ils étaient hors ligne : ils
   trouvent leur enveloppe en revenant.
4. L'appareil retiré ne peut ouvrir aucune enveloppe et ne reçoit plus rien. L'ancien cercle passe en lecture
   seule, puis est effacé par le relais au bout de 30 jours.

> Limite inhérente à tout système : un appareil retiré **garde les données qu'il avait déjà**. Le renouvellement
> protège l'avenir, pas le passé.

### Ce que le relais voit (métadonnées)

| Le relais connaît | Le relais ne connaît pas |
| --- | --- |
| Un identifiant de cercle aléatoire | Le nom de la famille, les prénoms |
| Des identifiants d'appareils aléatoires | Le contenu des listes, de l'agenda, des messages, des photos |
| La taille et l'heure des paquets chiffrés | Le titre et le texte des notifications |
| L'**heure** d'envoi des rappels planifiés | La clé du cercle, et le jeton d'accès en clair (seulement son empreinte) |
| L'adresse des services push (Google, Apple, Mozilla) | Qui a écrit quoi |

Les services push des navigateurs (FCM, APNs, Mozilla) ne voient eux aussi que du chiffré : les notifications
sont chiffrées une première fois pour le navigateur (RFC 8291), et leur contenu est déjà chiffré une seconde fois
avec la clé du cercle.

### Menaces couvertes, et celles qui ne le sont pas

| Menace | Protection |
| --- | --- |
| Piratage du relais, de Cloudflare, ou d'un service push | Chiffrement de bout en bout : aucune donnée lisible |
| Écoute du réseau | HTTPS/WSS + chiffrement de bout en bout |
| Lien d'invitation intercepté | Usage unique, 15 min, approbation, code de vérification, alerte « nouvel appareil » |
| Téléphone perdu ou volé | Retrait de l'appareil avec renouvellement de clé ; verrouillage et chiffrement du téléphone par le système |
| Altération ou rejeu de messages par le relais | AES-GCM authentifié, données associées au contexte |
| Données effacées par le navigateur | Demande de stockage persistant + **sauvegarde chiffrée** (PBKDF2 600 000 itérations + AES-256-GCM) |
| Code malveillant injecté dans la page | Politique CSP stricte : code et connexions limités à l'appli et au relais configuré |
| **Compromission du dépôt GitHub** | ⚠️ Non couvert techniquement : le code servi par GitHub Pages a accès aux clés. **Activez l'authentification à deux facteurs, protégez la branche `main`, relisez les modifications.** Les actions GitHub sont épinglées par empreinte. |
| **Autre site sur la même origine** | ⚠️ Toutes les pages `https://<compte>.github.io/*` partagent la même origine, donc le même stockage. **N'hébergez pas d'autres projets GitHub Pages sur ce compte, ou utilisez un domaine personnalisé** (ex. `famille.mondomaine.fr`). |
| Membre malveillant dans le cercle | Hors périmètre : tous les appareils du cercle sont de confiance. Un membre pourrait écrire au nom d'un autre. |

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
