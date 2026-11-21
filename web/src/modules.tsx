import type { ComponentType } from 'react';
import {
  Cake,
  CalendarDays,
  Camera,
  Contact,
  CookingPot,
  ListChecks,
  MessageSquareText,
  PiggyBank,
  Repeat,
  Users,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import { ListsPage, ListsSummary } from './pages/Lists';
import { CalendarPage, CalendarSummary } from './pages/Calendar';
import { BirthdaysPage, BirthdaysSummary } from './pages/Birthdays';
import { MessagesPage, MessagesSummary } from './pages/Messages';
import { FamilyPage, FamilySummary } from './pages/Family';
import { ContactsPage, ContactsSummary } from './pages/Contacts';
import { GalleryPage, GallerySummary } from './pages/Gallery';
import { MealsPage, MealsSummary } from './pages/Meals';
import { RecipesPage, RecipesSummary } from './pages/Recipes';
import { TasksPage, TasksSummary } from './pages/Tasks';
import { BudgetPage, BudgetSummary } from './pages/Budget';

export type ModuleDef = {
  id: string;
  title: string;
  icon: LucideIcon;
  color: string;
  section: 'Essentiels' | 'Organisation';
  /** Écran du module. `params` = la suite de l'URL (#/m/<id>/<params…>). */
  Page: ComponentType<{ params: string[] }>;
  /** Sous-titre affiché sur la tuile de l'accueil. */
  Summary?: ComponentType;
};

/**
 * ✏️ Le registre des modules : c'est ici qu'on ajoute, retire ou réordonne
 * les fonctionnalités de l'application. Voir le README pour créer un module.
 */
export const MODULES: ModuleDef[] = [
  { id: 'lists', title: 'Listes', icon: ListChecks, color: '#2D9CDB', section: 'Essentiels', Page: ListsPage, Summary: ListsSummary },
  { id: 'calendar', title: 'Calendrier', icon: CalendarDays, color: '#27AE60', section: 'Essentiels', Page: CalendarPage, Summary: CalendarSummary },
  { id: 'messages', title: 'Messages', icon: MessageSquareText, color: '#8E5CE6', section: 'Essentiels', Page: MessagesPage, Summary: MessagesSummary },
  { id: 'family', title: 'Ma Famille', icon: Users, color: '#2F80ED', section: 'Essentiels', Page: FamilyPage, Summary: FamilySummary },
  { id: 'contacts', title: 'Contacts', icon: Contact, color: '#A36BE0', section: 'Essentiels', Page: ContactsPage, Summary: ContactsSummary },
  { id: 'gallery', title: 'Galerie', icon: Camera, color: '#E2A400', section: 'Essentiels', Page: GalleryPage, Summary: GallerySummary },
  { id: 'birthdays', title: 'Anniversaires', icon: Cake, color: '#F2784B', section: 'Organisation', Page: BirthdaysPage, Summary: BirthdaysSummary },
  { id: 'meals', title: 'Repas', icon: UtensilsCrossed, color: '#4F6BED', section: 'Organisation', Page: MealsPage, Summary: MealsSummary },
  { id: 'recipes', title: 'Recettes', icon: CookingPot, color: '#F2994A', section: 'Organisation', Page: RecipesPage, Summary: RecipesSummary },
  { id: 'tasks', title: 'Tâches', icon: Repeat, color: '#D6409F', section: 'Organisation', Page: TasksPage, Summary: TasksSummary },
  { id: 'budget', title: 'Budget', icon: PiggyBank, color: '#30A46C', section: 'Organisation', Page: BudgetPage, Summary: BudgetSummary },
];

export const DEFAULT_HOME = ['lists', 'calendar', 'birthdays', 'messages', 'family', 'tasks', 'meals', 'gallery'];

export const moduleById = (id: string) => MODULES.find((m) => m.id === id);
