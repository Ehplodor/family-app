/**
 * Clé d'administration du membre de cet appareil (une par membre).
 *
 *  - Elle signe la liste des membres des cercles dont il est l'admin, et valide l'entrée des appareils.
 *  - Elle est gardée sur l'appareil, NON exportable, et aussi chiffrée par une masterkey (32 caractères)
 *    que l'admin range dans un gestionnaire de mots de passe : c'est ce qui permet de la récupérer sur un
 *    nouveau téléphone (la version chiffrée est publiée dans la liste des membres de ses cercles).
 *  - La masterkey peut être ré-affichée 30 secondes après empreinte ou visage (WebAuthn « PRF ») quand le
 *    téléphone le permet ; sinon on peut seulement VÉRIFIER une masterkey tapée.
 */
import * as idb from './idb';
import { b64url, fromB64url, fromUtf8, randomBytes, utf8 } from './bytes';
import { newMasterkey, newSigningKeys, normalizeMasterkey, open, prfKey, seal, unwrapAdminKey, wrapAdminKey } from './crypto';
import type { AdminKeyring, AdminKeys } from './vault';

type Stored = AdminKeys & {
  member: string;
  /** Masterkey pas encore confirmée comme rangée (affichée à la prochaine occasion). */
  pending?: string;
  /** Dernière vérification ou ré-affichage (rappel tous les 6 mois). */
  checkedAt?: number;
  /** Masterkey chiffrée par le secret de l'empreinte (si le téléphone le permet). */
  prf?: { cred: string; salt: string; box: string };
};

const KEY = 'adminKey';
export const CHECK_EVERY = 182 * 86400_000;

export class LocalAdminKeyring implements AdminKeyring {
  private cached: Stored | null | undefined;
  constructor(private member: () => string | null) {}

  private async load(): Promise<Stored | null> {
    if (this.cached === undefined) this.cached = (await idb.get<Stored>('kv', KEY)) ?? null;
    const m = this.member();
    return this.cached && this.cached.member === m ? this.cached : null;
  }
  private async store(s: Stored) {
    this.cached = s;
    await idb.put('kv', KEY, s);
  }

  /** Clé d'administration (créée au besoin, avec une nouvelle masterkey à faire ranger). */
  async get(): Promise<AdminKeys | null> {
    const m = this.member();
    if (!m) return null;
    const cur = await this.load();
    if (cur) return cur;
    return this.create(m);
  }

  private async create(member: string): Promise<Stored> {
    const k = await newSigningKeys(true);
    const masterkey = newMasterkey();
    const wrapped = await wrapAdminKey(k.signKey, masterkey, member);
    // On ne garde que la version non exportable.
    const key = (await unwrapAdminKey(wrapped, masterkey, member))!;
    const s: Stored = { member, spub: k.signJwk, wrapped, key, pending: masterkey, checkedAt: Date.now() };
    await this.store(s);
    return s;
  }

  /** Masterkey à faire ranger (null une fois confirmée). */
  async pending(): Promise<string | null> {
    return (await this.load())?.pending ?? null;
  }
  async confirmSaved() {
    const s = await this.load();
    if (s) await this.store({ ...s, pending: undefined, checkedAt: Date.now() });
  }

  /** Une vérification est conseillée (tous les 6 mois). */
  async checkDue(): Promise<boolean> {
    const s = await this.load();
    return !!s && !s.pending && Date.now() - (s.checkedAt ?? 0) > CHECK_EVERY;
  }

  /** La masterkey tapée est-elle la bonne ? */
  async verify(text: string): Promise<boolean> {
    const s = await this.load();
    const m = this.member();
    if (!s || !m || !normalizeMasterkey(text)) return false;
    const ok = !!(await unwrapAdminKey(s.wrapped, text, m));
    if (ok) await this.store({ ...s, checkedAt: Date.now() });
    return ok;
  }

  /** Nouveau téléphone : reprend la clé d'administration avec la masterkey (version chiffrée publiée). */
  async restore(text: string, wrapped: string, spub: JsonWebKey): Promise<boolean> {
    const m = this.member();
    if (!m) return false;
    const key = await unwrapAdminKey(wrapped, text, m);
    if (!key) return false;
    await this.store({ member: m, spub, wrapped, key, checkedAt: Date.now() });
    return true;
  }

  /** Nouvelle clé et nouvelle masterkey (l'ancienne ne vaut plus rien pour les cercles qui changent d'admin). */
  async replace(): Promise<AdminKeys> {
    const m = this.member();
    if (!m) throw new Error('Profil inconnu');
    return this.create(m);
  }

  /* ------------------------------------------------------------ ré-affichage par empreinte (WebAuthn PRF) */

  /** Le navigateur sait-il protéger la masterkey par empreinte/visage ? */
  static async prfAvailable(): Promise<boolean> {
    return !!window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.().catch(() => false)) === true;
  }

  async hasPrf() {
    return !!(await this.load())?.prf;
  }

  /** À la création : enregistre l'empreinte et chiffre la masterkey avec son secret. Renvoie false si non pris en charge. */
  async protectWithPrf(masterkey: string): Promise<boolean> {
    const s = await this.load();
    if (!s || !normalizeMasterkey(masterkey)) return false;
    try {
      const salt = randomBytes(32);
      const cred = (await navigator.credentials.create({
        publicKey: {
          rp: { name: 'Famille' },
          user: { id: randomBytes(16), name: 'masterkey', displayName: 'Masterkey' },
          challenge: randomBytes(32),
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
          extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      if (!cred || !(cred.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf?.enabled) return false;
      const out = await this.prfOutput(new Uint8Array(cred.rawId), salt);
      if (!out) return false;
      const box = await seal(await prfKey(out), utf8.encode(normalizeMasterkey(masterkey)!), 'masterkey');
      await this.store({ ...s, prf: { cred: b64url(new Uint8Array(cred.rawId)), salt: b64url(salt), box } });
      return true;
    } catch {
      return false;
    }
  }

  private async prfOutput(credId: Uint8Array, salt: Uint8Array): Promise<Uint8Array<ArrayBuffer> | null> {
    const a = (await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ type: 'public-key', id: credId as Uint8Array<ArrayBuffer> }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    const r = (a?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } })?.prf?.results?.first;
    return r ? new Uint8Array(r) : null;
  }

  /** Ré-affiche la masterkey après empreinte/visage ; null si refusé ou non pris en charge. */
  async reveal(): Promise<string | null> {
    const s = await this.load();
    if (!s?.prf) return null;
    try {
      const out = await this.prfOutput(fromB64url(s.prf.cred), fromB64url(s.prf.salt));
      if (!out) return null;
      const mk = fromUtf8.decode(await open(await prfKey(out), s.prf.box, 'masterkey'));
      await this.store({ ...s, checkedAt: Date.now() });
      return mk.match(/.{4}/g)!.join('-');
    } catch {
      return null;
    }
  }
}
