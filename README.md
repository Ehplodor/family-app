# Family App

Application familiale **local-first** (PWA) : les données vivent sur vos téléphones et sont partagées dans le
cercle familial **chiffrées de bout en bout**. Elle se publie sur **GitHub Pages** et s'appuie sur un petit relais
« aveugle » (Cloudflare Worker gratuit) qui ne voit jamais vos données en clair.

![Aperçu : accueil, calendrier, liste, repas](docs/apercu.png)

> 📐 **Choix d'architecture, comparatif des stratégies de partage, modèle de sécurité et conception des
> notifications : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).**

## En bref

- **Données locales** : tout est enregistré sur l'appareil (IndexedDB). L'appli s'ouvre et fonctionne sans réseau,
  et les modifications faites hors ligne partent au retour du réseau.
- **Partage temps réel chiffré** : AES-256-GCM, clés générées et conservées uniquement sur les appareils. Le relais
  ne fait que stocker et rediffuser des paquets illisibles.
- **Ajout d'appareil sécurisé** : QR code à usage unique (15 min), approbation par un membre, code de vérification
  de 5 émojis, alerte « nouvel appareil » envoyée à toute la famille.
- **Téléphone perdu** : on retire l'appareil, une nouvelle clé est transmise aux seuls appareils restants.
- **Rappels, même appli fermée** : rendez-vous, résumé du matin, anniversaires (J-7 et jour J), tâches (et
  relances), repas du lendemain, planning de la semaine, messages, listes… Les rappels sont ciblés sur les
  personnes concernées, respectent les heures calmes et sont regroupés. **Leur contenu est chiffré** : le relais ne
  connaît que l'heure d'envoi.
- **Sauvegarde chiffrée** par phrase secrète, à garder hors du téléphone.

| Module | Ce qu'il fait |
| --- | --- |
| Listes | Listes partagées, ajout multiple (`lait, pain, œufs`), on voit qui a coché quoi |
| Calendrier | Vue mois + agenda, événements récurrents ou sur plusieurs jours, attribués, avec un rappel réglable par événement |
| Messages | Fil de discussion familial |
| Ma Famille | Membres, invitations d'appareils |
| Contacts | Numéros utiles, appel, e-mail et carte en un geste |
| Galerie | Photos réduites puis chiffrées avant l'envoi |
| Anniversaires | Triés par date à venir, âge, idées cadeaux |
| Repas / Recettes | Planning de la semaine lié aux recettes, **génère la liste de courses** |
| Tâches | Ponctuelles ou récurrentes, assignées, avec une heure optionnelle |
| Budget | Dépenses et entrées par mois, par catégorie |
| Rappels | Notifications de l'appareil, préférences par membre, heures calmes, aperçu des prochains rappels |
| Sécurité | Appareils, retrait d'un appareil, code du cercle, sauvegarde, effacement |
| Personnaliser | Tuiles de l'accueil, ordre, couleur, nom de la famille |

## Mise en ligne (une fois, environ 15 minutes)

### 1. Le relais (Cloudflare Workers, offre gratuite)

Il faut un compte Cloudflare gratuit.

```bash
cd relay
npm ci
npx wrangler login
npm run vapid            # génère les clés d'identification push (VAPID)
```

- Copiez la **clé publique** affichée dans `relay/wrangler.toml`, section `[vars]` : `VAPID_PUBLIC_KEY = "…"`.
- Réglez aussi :
  - `ALLOWED_ORIGINS = "https://<votre-compte>.github.io"` ;
  - `VAPID_SUBJECT = "mailto:<une adresse de contact>"`.
- Enregistrez la **clé privée** comme secret (collez-la quand on vous la demande) :

```bash
npx wrangler secret put VAPID_PRIVATE_JWK
npx wrangler deploy      # affiche l'adresse : https://family-app-relay.<compte>.workers.dev
```

Vous pouvez aussi déployer le relais depuis GitHub (onglet *Actions → Relay*) avec les secrets
`CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID`.

### 2. L'appli sur GitHub Pages

1. *Settings → Pages → Build and deployment → Source* : **GitHub Actions**.
2. *Settings → Secrets and variables → Actions → Variables* : créez `RELAY_URL` = l'adresse du relais.
3. Poussez sur `main` : le workflow lance les tests, construit et publie l'appli sur
   `https://<compte>.github.io/family-app/`.

> 🔐 **Important pour la sécurité :**
> - Activez l'**authentification à deux facteurs** sur GitHub et protégez la branche `main` : le code publié a accès
>   aux clés.
> - Tous les sites `https://<compte>.github.io/…` partagent le même stockage navigateur. **N'hébergez pas d'autres
>   projets GitHub Pages sur ce compte**, ou utilisez un **domaine personnalisé** (*Settings → Pages → Custom
>   domain*, puis mettez-le dans `ALLOWED_ORIGINS`).

Sans `RELAY_URL`, l'appli fonctionne en **mode local** : un seul appareil, sans partage ni notifications.

### 3. Sur les téléphones

- **Android** : ouvrir l'adresse dans Chrome, puis menu ⋮ → *Installer l'application*.
- **iPhone** : Safari → Partager → *Sur l'écran d'accueil*, puis **ouvrir depuis l'icône**. Le stockage de l'appli
  installée est séparé de Safari : rejoignez le cercle depuis l'appli installée.
- Le premier membre crée le cercle. Chaque autre appareil : *J'ai une invitation* → scanner le QR code affiché par un
  membre (*Ma Famille → Inviter*) → comparer les émojis → le membre approuve.
- Activez les rappels : *Ma Famille → Rappels → Activer les notifications*.

## Développement

```bash
npm install && npm --prefix relay install
node relay/scripts/vapid.mjs --dev-vars > relay/.dev.vars   # clés VAPID locales
npm run relay:dev                                            # relais local sur http://127.0.0.1:8787
VITE_RELAY_URL=http://127.0.0.1:8787 npm run dev             # appli sur http://localhost:5173
```

Pour tester le service worker, les notifications et le hors ligne, construisez l'appli :
`VITE_RELAY_URL=http://127.0.0.1:8787 npm run build && npm run preview`.

| Commande | Rôle |
| --- | --- |
| `npm test` | Tests unitaires : fusion des données (CRDT), cryptographie, calcul des rappels |
| `npm run relay:test` | Tests d'intégration du relais : authentification, synchro, Web Push déchiffré par une implémentation de référence, invitations (relais local lancé) |
| `npm run typecheck` | Vérification TypeScript |
| `npm run build` | Construit l'appli et le service worker dans `dist/` |

## Structure

```
web/src/
  lib/
    crypto.ts      clés, chiffrement AES-GCM, ECDH, codes de vérification, sauvegardes
    replica.ts     données locales + fusion sans conflit (CRDT, horloge hybride)
    sync.ts        synchronisation chiffrée avec le relais (WebSocket)
    engine.ts      cercle, appareils, renouvellement de clé, photos, sauvegardes
    invite.ts      invitation avec approbation
    reminders.ts   calcul des rappels (fonction pure, testée)
    notify.ts      abonnement push, envoi des rappels et de l'activité
    idb.ts         stockage IndexedDB
  sw.ts            service worker : hors ligne + déchiffrement des notifications
  modules.tsx      ⭐ registre des modules
  pages/           un écran par module
  styles.css       thème
relay/src/         relais aveugle (Cloudflare Worker + Durable Objects)
docs/              architecture et sécurité
```

## La mettre à votre goût

- **Sans code** : *Applications → À votre goût* (modules de l'accueil, ordre, couleur).
- **Apparence** : variables CSS en haut de `web/src/styles.css`.
- **Ajouter un module** : les données sont des documents génériques, synchronisés et chiffrés automatiquement.
  **Ni le relais ni la synchronisation n'ont besoin d'être modifiés.**

  1. Créez `web/src/pages/Notes.tsx` :

     ```tsx
     import { useState } from 'react';
     import { useCollection } from '../store';
     import { Page } from '../ui';

     type Note = { text: string };

     export function NotesSummary() {
       const { docs } = useCollection<Note>('notes');
       return <>{docs.length} note(s)</>;
     }

     export function NotesPage() {
       const notes = useCollection<Note>('notes'); // collection partagée, chiffrée, synchronisée en direct
       const [text, setText] = useState('');
       return (
         <Page title="Notes">
           <form className="add-row" onSubmit={(e) => { e.preventDefault(); notes.create({ text }); setText(''); }}>
             <input value={text} onChange={(e) => setText(e.target.value)} />
             <button className="btn primary">Ajouter</button>
           </form>
           <ul className="items">
             {notes.docs.map((n) => (
               <li key={n.id} className="item" onClick={() => notes.remove(n.id)}>{n.text}</li>
             ))}
           </ul>
         </Page>
       );
     }
     ```

  2. Déclarez-le dans `MODULES` (`web/src/modules.tsx`) avec une icône de [lucide.dev](https://lucide.dev/icons) :

     ```tsx
     { id: 'notes', title: 'Notes', icon: StickyNote, color: '#F2B705', section: 'Organisation', Page: NotesPage, Summary: NotesSummary },
     ```

  `useCollection` fournit `docs`, `create`, `update` (fusion champ par champ) et `remove` ; chaque document reçoit
  automatiquement `id`, `createdBy` (le membre), `createdAt` et `updatedAt`.
- **Ajouter un type de rappel** : complétez `computeReminders` dans `web/src/lib/reminders.ts` (et son test).
