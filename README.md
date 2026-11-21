# Family App

Application familiale **auto-hébergée** (MVP) : un espace partagé pour toute la famille, sur téléphone comme sur ordinateur.
Tout est inclus, sans version « Premium » : c'est votre appli, vous la modifiez comme vous voulez.

![Aperçu : accueil, calendrier, liste, repas](docs/apercu.png)

## Fonctionnalités

| Module | Ce qu'il fait |
| --- | --- |
| **Listes** | Listes partagées (courses, à faire…), ajout multiple séparé par des virgules (`lait, pain, œufs`), on voit qui a coché quoi |
| **Calendrier** | Vue mois + agenda du jour, événements sur la journée ou avec horaires, sur plusieurs jours, répétés (semaine / mois / année), attribués à des membres. Les anniversaires y apparaissent automatiquement |
| **Messages** | Fil de discussion familial, compteur de messages non lus sur l'accueil |
| **Ma Famille** | Membres (avec ou sans téléphone, ex. les enfants), couleurs, code d'invitation à partager |
| **Contacts** | Numéros utiles (pédiatre, école, nounou…) avec appel / e-mail / carte en un geste |
| **Galerie** | Photos partagées (réduites automatiquement avant l'envoi), légendes |
| **Anniversaires** | Triés par date à venir, âge, idées cadeaux |
| **Repas** | Planning de la semaine (midi / soir), lié aux recettes, **génère la liste de courses** |
| **Recettes** | Livre de recettes (ingrédients, préparation, lien) |
| **Tâches** | Tâches ponctuelles ou **récurrentes** (jour / semaine / mois), assignées à un membre |
| **Budget** | Dépenses et entrées par mois, totaux par catégorie |
| **Personnaliser** | Choix et ordre des tuiles de l'accueil, couleur de l'appli, nom de la famille |

Tout est **synchronisé en temps réel** entre les membres (un élément coché sur un téléphone s'affiche immédiatement sur les autres).
L'appli est une **PWA** : elle s'installe sur l'écran d'accueil d'Android/iPhone comme une appli normale.

## Démarrage rapide (développement)

Prérequis : **Node.js 22.13 ou plus récent** (la base SQLite intégrée à Node est utilisée : aucune dépendance native).

```bash
npm install
npm run dev        # serveur API sur :3000 + front Vite sur http://localhost:5173
```

Ouvrez http://localhost:5173, créez votre famille, puis rejoignez-la depuis un autre navigateur avec le code d'invitation.

Autres commandes :

```bash
npm test           # tests de l'API
npm run typecheck  # vérification TypeScript
npm run build      # construit le front dans dist/
npm start          # production : un seul serveur sur http://localhost:3000
```

## Mise en ligne

Pour que toute la famille l'utilise depuis ses téléphones, il faut l'héberger sur une machine joignable depuis Internet
(NAS, Raspberry Pi, petit VPS…), **en HTTPS** (indispensable pour l'installation en appli et pour la sécurité des sessions).

### Avec Docker

```bash
docker compose up -d --build
```

Les données (base SQLite + photos) sont dans `./data`. **Sauvegardez ce dossier.**

Placez un reverse proxy HTTPS devant, par exemple [Caddy](https://caddyserver.com/) (certificat automatique) :

```
famille.mondomaine.fr {
  reverse_proxy localhost:3000
}
```

### Sans Docker

```bash
npm ci && npm run build
DATA_DIR=/chemin/vers/donnees PORT=3000 TRUST_PROXY=1 COOKIE_SECURE=1 npm start
```

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `PORT` | Port d'écoute | `3000` |
| `DATA_DIR` | Dossier de la base et des photos | `./data` |
| `TRUST_PROXY` | À mettre à `1` derrière un reverse proxy | — |
| `COOKIE_SECURE` | `1` pour des cookies uniquement HTTPS | — |

### Installer sur le téléphone

- **Android (Chrome)** : ouvrir l'adresse, menu ⋮ → *Ajouter à l'écran d'accueil* / *Installer l'application*.
- **iPhone (Safari)** : bouton Partager → *Sur l'écran d'accueil*.

## La mettre à votre goût

### Sans toucher au code

Onglet **Applications → À votre goût** (ou tuile *Personnaliser*) : modules affichés sur l'accueil, leur ordre, la couleur.

### Dans le code

```
server/            API Express + SQLite (Node)
  app.js           routes : familles, membres, documents, photos, temps réel
  db.js            schéma de la base
web/src/
  modules.tsx      ⭐ registre des modules (titre, icône, couleur, écran)
  pages/           un fichier par module
  styles.css       thème (variables en haut du fichier) et styles
  store.tsx        accès aux données + synchro temps réel
  ui.tsx           composants communs (Page, Sheet, Fab, Field…)
test/              tests de l'API
```

- **Changer l'apparence** : variables CSS en haut de `web/src/styles.css` (couleurs, arrondis, ombres). Le mode sombre suit le téléphone.
- **Renommer / réordonner / retirer un module** : éditez le tableau `MODULES` dans `web/src/modules.tsx`.
- **Ajouter un module** : le serveur stocke des documents JSON génériques, donc **aucune modification du serveur n'est nécessaire**.

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
       const notes = useCollection<Note>('notes'); // collection partagée, synchronisée en direct
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

  `useCollection` fournit `docs`, `create`, `update` (fusion partielle) et `remove` ; chaque document reçoit
  automatiquement `id`, `createdBy` (le membre), `createdAt` et `updatedAt`.

## API (résumé)

| Méthode | Route | Rôle |
| --- | --- | --- |
| `POST` | `/api/families` | Créer une famille (`familyName`, `memberName`, `color`) |
| `POST` | `/api/join/lookup` · `/api/join` | Rejoindre avec un code d'invitation |
| `GET` | `/api/me` | Session courante, famille, membres |
| `PATCH` | `/api/family` | Nom / réglages de la famille |
| `POST` · `PATCH` · `DELETE` | `/api/members[/:id]` | Gérer les membres |
| `GET` · `POST` | `/api/docs/:collection` | Lister / créer des documents |
| `PATCH` · `DELETE` | `/api/docs/:collection/:id` | Modifier (fusion) / supprimer |
| `POST` · `GET` | `/api/files[/:id]` | Envoyer / lire une photo |
| `GET` | `/api/stream` | Flux temps réel (Server-Sent Events) |

## Sécurité : ce qu'il faut savoir

- Il n'y a **pas de mot de passe** : un appareil rejoint la famille avec le **code d'invitation** (8 caractères, tentatives limitées),
  puis reste connecté via un cookie de session `HttpOnly` (valable 1 an). Ne diffusez le code qu'à vos proches.
  Vous pouvez le **régénérer** dans *Ma Famille* (les appareils déjà connectés restent connectés).
- Hébergez en **HTTPS** et activez `COOKIE_SECURE=1`.
- Chaque famille ne voit que ses propres données ; plusieurs familles peuvent coexister sur le même serveur.

## Pistes pour la suite

Notifications push (rappels d'événements, nouveaux messages), synchronisation avec Google Calendar (iCal),
partage de position, pièces jointes dans les messages, mode hors-ligne complet, comptes avec mot de passe
et révocation des appareils.
