# Consignes pour les agents (Claude, Copilot, Codex…)

Ce fichier s'adresse aux assistants de code qui travaillent sur ce dépôt. Les humains trouveront le mode d'emploi
dans le [README](README.md) et l'architecture dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Le projet en bref

Application familiale **local-first** (PWA) : les données vivent sur les appareils, elles sont partagées entre
membres via un **relais aveugle** qui ne voit que du chiffré de bout en bout.

- `web/` : l'appli (React + Vite), publiée sur **GitHub Pages** (`https://ehplodor.github.io/family-app/`).
- `relay/` : le relais (Cloudflare Worker + Durable Objects), déployé sur `family-app-relay.ehplodor.workers.dev`.
- Le site est **public** : n'importe qui peut créer sa famille. Le relais est donc un **service partagé** par
  des familles inconnues.

## Le propriétaire

- Il **n'a qu'un téléphone** : tout doit pouvoir se faire depuis l'interface web de GitHub (fusion de PR,
  *Actions → Run workflow*, *Settings*). Ne jamais proposer une étape qui exige un terminal ou un ordinateur
  sans alternative depuis GitHub.
- **Écrire en français** : messages, PR, commentaires de code, messages de commit, textes de l'appli. Des
  explications simples, écran par écran, sans jargon inutile.
- La branche `main` est protégée : **toujours passer par une pull request**, jamais de push direct ni de
  force-push sur `main`.

## Commandes

| Commande | Rôle |
| --- | --- |
| `npm ci && npm --prefix relay ci` | Installer les dépendances |
| `npm test` | Tests unitaires de l'appli (CRDT, crypto, rappels, école) |
| `npm run typecheck` | Vérification TypeScript de l'appli |
| `npm run build` | Construit l'appli et le service worker dans `dist/` |
| `npm --prefix relay run test:ci` | Tests d'intégration du relais (lance et arrête un relais local) |
| `cd relay && npx tsc -p .` | Vérification TypeScript du relais |

Avant toute PR : `npm test`, `npm run typecheck`, `npm run build`, et si `relay/` change, les deux commandes du
relais. Les workflows dans `.github/workflows/` ne se lancent que sur `main` ou à la main : **il n'y a pas de CI
sur les PR**, c'est à l'agent de lancer les vérifications.

## Déploiement

- **Site** : workflow « GitHub Pages », à chaque push sur `main`. Il construit avec la variable de dépôt
  `RELAY_URL`.
- **Relais** : workflow « Relay », à chaque push sur `main` qui touche `relay/**`, ou via *Run workflow*.
- Fusionner une PR = mise en production. Le relais est mis à jour **immédiatement**, les applis installées
  **à leur prochaine ouverture** (voir plus bas).

## Règles à ne jamais enfreindre

### Clés de notification (VAPID)

- Les secrets Cloudflare `VAPID_PUBLIC_KEY` et `VAPID_PRIVATE_JWK` sont créés **une seule fois** par le workflow
  « Relay ». **Ne jamais les régénérer ni les écraser** : tous les abonnements aux notifications déjà activés
  cesseraient de fonctionner.
- Le workflow s'arrête sans rien modifier si la liste des secrets est illisible ou si une seule des deux clés
  existe. Garder ce comportement « en cas de doute, ne rien toucher ».

### Chiffrement et confidentialité

- Le relais ne doit **jamais** recevoir de donnée en clair : contenu, prénoms, nom de la famille, texte des
  notifications. Tout passe par `web/src/lib/crypto.ts` (AES-256-GCM, ECDH P-256, HKDF), **WebCrypto
  uniquement**, aucune bibliothèque crypto tierce.
- Ne pas changer la dérivation des clés, le format des messages chiffrés ou les « données associées » sans un plan
  de compatibilité : les familles existantes ne pourraient plus se lire.
- Aucun script ou ressource chargé depuis un CDN ou un site tiers. La CSP (`vite.config.ts`) n'autorise que le
  site lui-même et le relais configuré : ne pas l'élargir sans raison forte.
- Ne jamais journaliser de secret, de jeton ou de contenu, ni côté appli ni côté relais.

### Adresse du site

- Les données locales et les clés sont liées à l'**adresse du site** (origine du navigateur). Changer d'adresse
  ou de domaine oblige **chaque appareil à rejoindre la famille à nouveau**. Ne jamais proposer ce changement à
  la légère.
- `vite.config.ts` utilise `base: './'` : l'appli fonctionne sous `/family-app/` comme à la racine d'un domaine.
  Ne pas remplacer par un chemin absolu.
- Avec un domaine personnalisé, la variable de dépôt `RELAY_ALLOWED_ORIGINS` doit être mise à jour et le
  workflow « Relay » relancé, sinon le relais refuse le site.

### Garde-fous du relais (service public)

Le relais protège le compte Cloudflare gratuit du propriétaire contre les abus. Ne pas affaiblir sans le
demander explicitement :

- quota progressif par famille (`CIRCLE_QUOTA_*`), limite de nouvelles familles par connexion et au total
  (`NEW_CIRCLES_*`), effacement des familles inactives (`INACTIVE_DAYS`) ;
- relais réservé au site (`ALLOWED_ORIGINS`, refus des WebSocket d'une autre origine, CORS) ;
- ne conserver que des empreintes (jamais d'adresse IP en clair), effacées rapidement.

Les réglages sont dans `relay/wrangler.toml`. Toute nouvelle route doit respecter ces garde-fous et ne rien
révéler d'utile à un inconnu.

## Faire évoluer l'appli sans casser les familles existantes

Les applis installées se mettent à jour seules : la page est chargée « réseau d'abord » (`web/src/sw.ts`), donc
une nouvelle version est utilisée **à la prochaine ouverture**. Une appli restée ouverte en arrière-plan garde
l'ancienne version. Conséquences :

1. **Plusieurs versions cohabitent** pendant des heures ou des jours et se synchronisent entre elles. Les
   données partagées (`web/src/lib/replica.ts`) doivent rester lisibles **dans les deux sens** :
   - ajouter des champs **facultatifs**, avec une valeur par défaut à la lecture ;
   - ne jamais renommer, supprimer ou changer le type d'un champ existant ; ajouter plutôt un nouveau champ ;
   - une ancienne version doit ignorer sans planter une collection ou un champ qu'elle ne connaît pas.
2. **Données locales** (`web/src/lib/idb.ts`, `VERSION`) : une mise à jour ne doit jamais effacer les données
   d'un appareil. Si le schéma IndexedDB change, incrémenter `VERSION` et écrire la migration dans
   `onupgradeneeded`.
3. **Le relais est mis à jour avant les applis** : il doit continuer d'accepter les messages et routes des
   anciennes versions. Ajouter, ne pas retirer ni changer de sens.
4. **Durable Objects** : les `[[migrations]]` de `relay/wrangler.toml` s'ajoutent à la suite, avec un nouveau
   `tag`. Ne jamais modifier ou supprimer une migration existante ni renommer une classe (perte des données).
5. **Service worker** : changer `CACHE` dans `web/src/sw.ts` seulement si la stratégie de cache change.
   `skipWaiting` et `clients.claim` doivent rester.
6. **Notifications** : le format chiffré lu par `sw.ts` doit rester compatible avec les rappels déjà planifiés
   sur le relais.

En cas de changement incompatible inévitable, le signaler clairement dans la PR et proposer un plan de
transition (lecture des deux formats pendant une période, puis nettoyage).

## Organisation du code

- Les modules (listes, agenda, école…) sont déclarés dans `web/src/modules.tsx`, un écran par module dans
  `web/src/pages/`.
- Les calculs (rappels, planification école, fusion des données) sont des fonctions pures testées : ajouter des
  tests à côté (`*.test.ts`) pour toute logique nouvelle.
- Le relais tient en quelques centaines de lignes (`relay/src/`) : le garder petit et lisible.
- Le relais est « aveugle » : toute logique qui a besoin du contenu se fait dans l'appli, pas sur le relais.

## Pull requests

- Une PR par sujet, en brouillon d'abord, description en français avec : contexte, changements, ce qui a été
  vérifié, ce qui n'a **pas** pu l'être (ex. déploiement réel sur Cloudflare), et ce que le propriétaire doit
  faire après la fusion (réglage GitHub, relance d'un workflow…), écran par écran.
- Mettre à jour le README et `docs/ARCHITECTURE.md` quand le comportement ou la sécurité changent.
