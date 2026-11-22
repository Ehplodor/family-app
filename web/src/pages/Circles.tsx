/**
 * Cercles (« Famille », « Parents », « Moi seul »…) : tous fonctionnent de la même façon (voir lib/vault.ts).
 *  - chaque cercle a un admin, qui invite, fait entrer, exclut, et peut transmettre son rôle ;
 *  - sa masterkey permet de récupérer ce rôle sur un nouveau téléphone ;
 *  - si l'admin a tout perdu, les autres membres peuvent organiser une relève (majorité + 7 jours).
 */
import { useEffect, useState } from 'react';
import { Crown, KeyRound, Lock, ShieldAlert, Smartphone, Users } from 'lucide-react';
import { useCircles, useEngine, useMe, useMembers, useNotifier, useVault, setDefaultCircles, useDefaultGroups, type CircleInfo } from '../store';
import { Avatar, ColorPicker, Field, FieldGroup, Page, PALETTE } from '../ui';
import { jwkId } from '../lib/crypto';
import { RELIEF_DELAY } from '../lib/circles';
import { LocalAdminKeyring } from '../lib/adminKey';
import type { Device, Member } from '../lib/engine';

export { useDefaultGroups };

/** Nom affiché d'un cercle. */
export const groupLabel = (g: Pick<CircleInfo, 'name' | 'personal'>) => (g.personal ? 'Moi seul' : g.name);

/* ------------------------------------------------------------------ Choix « Visible par » */

/** Choix des cercles qui voient un élément (au moins un). */
export function VisibilityPicker({ value, onChange }: { value: string[]; onChange: (groups: string[]) => void }) {
  const circles = useCircles().filter((c) => c.writable);
  // Cercles de l'élément dont cet appareil n'a pas (ou plus) la clé : gardés, affichés à part.
  const others = value.filter((id) => !circles.some((g) => g.id === id));
  const toggle = (id: string) => {
    const next = value.includes(id) ? value.filter((v) => v !== id) : [...value, id];
    if (next.length) onChange(next);
  };
  return (
    <div className="chips">
      {circles.map((g) => {
        const on = value.includes(g.id);
        return (
          <button
            key={g.id}
            type="button"
            className={`chip ${on ? 'on' : ''}`}
            style={on ? { background: g.color, borderColor: g.color } : { borderColor: g.color }}
            onClick={() => toggle(g.id)}
          >
            {g.personal ? <Lock size={14} /> : <Users size={14} />} {groupLabel(g)}
          </button>
        );
      })}
      {others.map((id) => (
        <button key={id} type="button" className="chip on" onClick={() => toggle(id)} title="Retirer ce cercle">
          <Lock size={14} /> Autre cercle ✕
        </button>
      ))}
    </div>
  );
}

/** Champ « Visible par » prêt à l'emploi pour les formulaires des modules. */
export function VisibleBy({ value, onChange }: { value: string[]; onChange: (groups: string[]) => void }) {
  return (
    <FieldGroup label="Visible par">
      <VisibilityPicker value={value} onChange={onChange} />
    </FieldGroup>
  );
}

/** Ajoute les cercles choisis aux données d'un formulaire (lus par useCollection). */
export const withGroups = <T extends object>(data: T, groups: string[]): T => Object.assign(data, groups.length ? { groups } : {});

/** Cercles d'un élément en cours d'édition (ceux de l'élément, ou le réglage par défaut pour un nouveau). */
export function useItemGroups(initial?: object): [string[], (g: string[]) => void] {
  const defaults = useDefaultGroups();
  const given = (initial as { groups?: string[] } | undefined)?.groups;
  const [groups, setGroups] = useState<string[]>(given?.length ? given : defaults);
  useEffect(() => {
    if (!groups.length && defaults.length) setGroups(defaults);
  }, [defaults, groups.length]);
  return [groups, setGroups];
}

/* ------------------------------------------------------------------ Écran « Cercles » */

export function CirclesPage() {
  return (
    <Page title="Cercles" back="/">
      <CirclesSheet />
    </Page>
  );
}

const run = async (setError: (e: string) => void, fn: () => Promise<unknown>) => {
  setError('');
  try {
    await fn();
  } catch (e) {
    setError((e as Error).message);
  }
};

export function CirclesSheet() {
  const circles = useCircles();
  const engine = useEngine();
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const [error, setError] = useState('');
  const defaults = useDefaultGroups();

  return (
    <div className="form">
      <p className="muted small">
        Chaque cercle a sa propre clé : ce qui lui est réservé reste illisible pour les autres. Chaque élément a un auteur :
        lui seul peut le supprimer pour tout le monde. Chaque cercle a un admin, qui seul fait entrer ou sortir quelqu'un.
      </p>
      <MasterkeyCard />
      {error && <p className="error">{error}</p>}
      <ul className="cal-list">
        {circles.map((c) => (
          <li key={c.id}>
            <CircleRow circle={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} onError={setError} />
          </li>
        ))}
      </ul>

      <FieldGroup label="Mes nouveaux éléments sont visibles par">
        <VisibilityPicker value={defaults} onChange={setDefaultCircles} />
      </FieldGroup>

      {open === 'new' ? (
        <NewCircleForm onDone={() => setOpen(null)} onError={setError} />
      ) : (
        <button type="button" className="btn" onClick={() => setOpen('new')} disabled={!engine.memberId}>
          Nouveau cercle
        </button>
      )}
      <a className="btn" href="#/invite">
        Inviter quelqu'un ou ajouter un appareil
      </a>
      <DevicesSection onError={setError} />
      <details className="muted small">
        <summary>Comment ça marche ?</summary>
        <ul>
          <li>Chaque personne a son cercle « Moi seul ». Une personne peut être dans plusieurs cercles, même sans lien entre eux.</li>
          <li>
            Seul l'<b>admin</b> d'un cercle invite une nouvelle personne, la fait entrer ou l'exclut. Chacun ajoute lui-même ses
            propres appareils.
          </li>
          <li>
            Exclure quelqu'un change la clé du cercle : la personne garde ce qu'elle avait déjà vu, mais ne lit plus ce qui est
            ajouté ou modifié ensuite, et ne peut plus rien modifier.
          </li>
          <li>
            Tout ce qui est écrit est <b>signé</b> par l'appareil qui l'écrit. Une modification non signée, ou interdite (supprimer
            l'élément d'un autre, changer le titre d'une tâche qui n'est pas la sienne…), est ignorée par tous les autres
            appareils.
          </li>
          <li>
            L'admin garde sa <b>masterkey</b> dans un gestionnaire de mots de passe : elle lui rend son rôle sur un nouveau
            téléphone. S'il a tout perdu, les autres membres peuvent désigner un nouvel admin (relève : majorité, puis 7 jours
            pendant lesquels l'ancien admin peut s'y opposer).
          </li>
        </ul>
      </details>
    </div>
  );
}

/* ------------------------------------------------------------------ Masterkey */

function MasterkeyCard() {
  const engine = useEngine();
  const circles = useCircles();
  const kr = engine.adminKeys;
  const [pending, setPending] = useState<string | null>(null);
  const [due, setDue] = useState(false);
  const [mine, setMine] = useState<string>('');
  const [shown, setShown] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [msg, setMsg] = useState('');
  const [prf, setPrf] = useState(false);
  const [tick, setTick] = useState(0);
  const adminOf = circles.filter((c) => c.isAdmin && !c.personal);

  useEffect(() => {
    kr.pending().then(setPending);
    kr.checkDue().then(setDue);
    kr.get().then((k) => setMine(k ? jwkId(k.spub) : ''));
    kr.hasPrf().then(setPrf);
  }, [kr, tick, circles]);

  // Ré-affichage limité à 30 secondes.
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), 30_000);
    return () => clearTimeout(t);
  }, [shown]);

  // Nouveau téléphone de l'admin : la clé de cet appareil n'est pas celle du cercle.
  const toRestore = adminOf.find((c) => jwkId(c.adminKey.spub) !== mine);
  if (toRestore && mine) {
    return (
      <div className="card form">
        <p>
          <KeyRound size={16} /> Vous êtes l'admin de « {toRestore.name} », mais ce téléphone n'a pas votre clé d'administration.
          Saisissez votre <b>masterkey</b> pour la récupérer.
        </p>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="XXXX-XXXX-…" autoCapitalize="characters" />
        {msg && <p className="error small">{msg}</p>}
        <button
          className="btn primary"
          onClick={async () => {
            const ok = await kr.restore(typed, toRestore.adminKey.wrapped, toRestore.adminKey.spub);
            setMsg(ok ? '' : 'Cette masterkey ne correspond pas.');
            if (ok) {
              setTyped('');
              await engine.saveProfile({});
              setTick((t) => t + 1);
            }
          }}
        >
          Récupérer mon rôle d'admin
        </button>
      </div>
    );
  }
  if (!adminOf.length) return null;

  if (pending) {
    return (
      <div className="card form">
        <p>
          <KeyRound size={16} /> <b>Votre masterkey d'admin</b>. Rangez-la dans un gestionnaire de mots de passe (pas en photo,
          pas dans vos notes). Elle seule vous rendra votre rôle d'admin si vous changez de téléphone.
        </p>
        <div className="masterkey">
          {pending}
        </div>
        <button className="btn" onClick={() => navigator.clipboard?.writeText(pending)}>
          Copier
        </button>
        <button
          className="btn primary"
          onClick={async () => {
            if ((await LocalAdminKeyring.prfAvailable()) && confirm('Protéger aussi la masterkey par empreinte ou visage, pour pouvoir la revoir plus tard ?'))
              await kr.protectWithPrf(pending);
            await kr.confirmSaved();
            setTick((t) => t + 1);
          }}
        >
          Je l'ai rangée
        </button>
      </div>
    );
  }

  return (
    <details className="card" open={due || !!shown}>
      <summary>
        <KeyRound size={16} /> Ma masterkey d'admin {due && <span className="pill">à vérifier</span>}
      </summary>
      <div className="form">
        {due && <p className="small">Cela fait plus de 6 mois : vérifiez que vous retrouvez toujours votre masterkey.</p>}
        {shown ? (
          <div className="masterkey">
            {shown}
          </div>
        ) : (
          prf && (
            <button className="btn" onClick={async () => setShown((await kr.reveal()) ?? (setMsg('Non disponible.'), null))}>
              Afficher 30 secondes (empreinte ou visage)
            </button>
          )
        )}
        <Field label="Vérifier une masterkey">
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="XXXX-XXXX-…" autoCapitalize="characters" />
        </Field>
        <button
          className="btn"
          disabled={!typed.trim()}
          onClick={async () => {
            const ok = await kr.verify(typed);
            setMsg(ok ? '✅ C’est bien votre masterkey.' : '❌ Ce n’est pas votre masterkey.');
            setTyped('');
            setTick((t) => t + 1);
          }}
        >
          Vérifier
        </button>
        {msg && <p className="small">{msg}</p>}
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ Un cercle */

function CircleRow({ circle: c, open, onToggle, onError }: { circle: CircleInfo; open: boolean; onToggle: () => void; onError: (e: string) => void }) {
  const engine = useEngine();
  const vault = useVault();
  const notifier = useNotifier();
  const { byId } = useMembers();
  const { member: me } = useMe();
  const [name, setName] = useState(c.name);
  const [color, setColor] = useState(c.color);
  const [busy, setBusy] = useState(false);
  const label = (id: string) => byId(id)?.name ?? 'Nouvelle personne';
  const act = (fn: () => Promise<unknown>) => run(onError, async () => (setBusy(true), await fn().finally(() => setBusy(false))));
  const people = [...vault.membersOf(vault.circles().map((x) => x.id))].filter((m) => !c.members.includes(m) && byId(m));
  const reliefs = vault.reliefs(c.id);

  return (
    <div className="stack" style={{ flexBasis: '100%' }}>
      <div className="toggle">
        <i className="cal-swatch" style={{ background: c.color }} />
        <span className="grow">
          {c.personal ? <Lock size={14} /> : <Users size={14} />} {groupLabel(c)} {c.isAdmin && !c.personal && <Crown size={14} />}
          {c.conflict && <span className="pill">clé à renouveler</span>}
          {c.outdated && <span className="pill">plus d'accès</span>}
        </span>
        <span className="avatars">
          {c.members.map((m) => (
            <Avatar key={m} member={byId(m)} size={22} />
          ))}
        </span>
        <button type="button" className="btn small" onClick={onToggle}>
          {open ? 'Fermer' : 'Détails'}
        </button>
      </div>
      {open && (
        <div className="card form">
          {c.outdated && <p className="banner-info small">Cet appareil n'a plus accès à ce cercle (exclu, ou appareil déclaré perdu). Ce qui avait déjà été reçu reste lisible.</p>}
          {c.conflict && (
            <p className="banner-info small">
              Deux clés concurrentes existent (modifications simultanées).{' '}
              <button className="link" disabled={busy} onClick={() => act(() => vault.renew(c.id))}>
                Renouveler la clé
              </button>
            </p>
          )}
          {!c.personal && (
            <>
              <Field label="Nom">
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <ColorPicker value={color} onChange={setColor} />
              <button className="btn" disabled={busy || !c.writable || (!name.trim() || (name === c.name && color === c.color))} onClick={() => act(() => vault.updateCircle(c.id, { name: name.trim(), color }))}>
                Enregistrer
              </button>
            </>
          )}
          <FieldGroup label="Membres">
            <ul className="plain">
              {c.members.map((m) => (
                <li key={m} className="row" style={{ alignItems: 'center', gap: 8 }}>
                  <Avatar member={byId(m)} size={28} />
                  <span className="grow">
                    {label(m)} {m === c.admin && <small className="muted">(admin)</small>}
                  </span>
                  {c.isAdmin && m !== c.admin && !c.personal && (
                    <>
                      <button
                        className="link"
                        disabled={busy}
                        onClick={() => {
                          const target = engine.vault.get<Member>('members', m);
                          if (!target?.admin || target.owner !== m) return onError(`${label(m)} doit d'abord ouvrir la dernière version de l'appli.`);
                          if (confirm(`Transmettre le rôle d'admin de « ${c.name} » à ${label(m)} ? Votre masterkey ne vaudra plus rien pour ce cercle.`))
                            act(() => vault.transferAdmin(c.id, m, target.admin!.spub, target.admin!.wrapped));
                        }}
                      >
                        Rendre admin
                      </button>
                      <button
                        className="link danger"
                        disabled={busy}
                        onClick={() => {
                          if (!confirm(`Exclure ${label(m)} de « ${c.name} » ? Ce qui a déjà été vu le reste, mais plus rien de nouveau.`)) return;
                          const devices = [...vault.holders(c.id)].filter(([, mm]) => mm === m).map(([d]) => d);
                          act(async () => {
                            await vault.exclude(c.id, m);
                            await notifier.clearParts(c.id, devices);
                          });
                        }}
                      >
                        Exclure
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </FieldGroup>
          {c.isAdmin && !c.personal && people.length > 0 && (
            <FieldGroup label="Faire entrer une personne de mes autres cercles">
              <div className="chips">
                {people.map((m) => (
                  <button
                    key={m}
                    className="chip"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        const devices = vault.knownDevices().filter((d) => d.member === m && !d.lost);
                        if (!devices.length) throw new Error('Aucun appareil connu pour cette personne');
                        for (const d of devices) await vault.admit(c.id, m, d.id);
                      })
                    }
                  >
                    + {label(m)}
                  </button>
                ))}
              </div>
            </FieldGroup>
          )}
          {!c.personal && !c.isAdmin && (
            <details className="small">
              <summary>L'admin a perdu son téléphone et sa masterkey ?</summary>
              <p className="muted">
                Un membre se propose comme nouvel admin. Si la majorité des autres membres approuve, il le devient au bout de 7
                jours, sauf si l'admin actuel s'y oppose d'ici là.
              </p>
              {!reliefs.some((r) => r.proposal.candidate === me.id) && (
                <button className="btn" disabled={busy} onClick={() => act(() => vault.proposeRelief(c.id))}>
                  Me proposer comme admin
                </button>
              )}
            </details>
          )}
          {reliefs.map((r) => {
            const ready = Date.now() - r.proposal.at >= RELIEF_DELAY;
            return (
              <div key={r.id} className="banner-info small">
                <ShieldAlert size={14} /> {label(r.proposal.candidate)} se propose comme admin ({r.votes}/{r.voters} voix, il en faut plus de la moitié).
                {r.vetoed && <b> L'admin s'y oppose.</b>}{' '}
                {!r.vetoed && !ready && <>Possible à partir du {new Date(r.proposal.at + RELIEF_DELAY).toLocaleDateString('fr-FR')}.</>}
                <div className="row">
                  {!r.mine && c.admin !== me.id && (
                    <button className="link" disabled={busy} onClick={() => act(() => vault.voteRelief(r.id))}>
                      J'approuve
                    </button>
                  )}
                  {c.isAdmin && !r.vetoed && (
                    <button className="link danger" disabled={busy} onClick={() => act(() => vault.vetoRelief(r.id))}>
                      Je m'y oppose
                    </button>
                  )}
                  {r.proposal.candidate === me.id && ready && !r.vetoed && (
                    <button className="link" disabled={busy} onClick={() => act(() => vault.completeRelief(r.id))}>
                      Devenir admin
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {c.isAdmin && !c.personal && (
            <button
              className="btn danger"
              disabled={busy}
              onClick={() => confirm(`Supprimer le cercle « ${c.name} » ?`) && act(() => vault.deleteCircle(c.id))}
            >
              Supprimer le cercle
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NewCircleForm({ onDone, onError }: { onDone: () => void; onError: (e: string) => void }) {
  const vault = useVault();
  const { byId } = useMembers();
  const { member: me } = useMe();
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[3]);
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const people = [...vault.membersOf(vault.circles().map((x) => x.id))].filter((m) => m !== me.id && byId(m));
  return (
    <div className="card form">
      <Field label="Nom du cercle">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Parents, Grands-parents…" />
      </Field>
      <ColorPicker value={color} onChange={setColor} />
      <FieldGroup label="Avec">
        <div className="chips">
          {people.map((m) => {
            const on = members.includes(m);
            return (
              <button key={m} type="button" className={`chip ${on ? 'on plain-on' : ''}`} onClick={() => setMembers(on ? members.filter((x) => x !== m) : [...members, m])}>
                {byId(m)?.name}
              </button>
            );
          })}
        </div>
      </FieldGroup>
      <p className="muted small">Vous serez l'admin de ce cercle. Pour une personne qui n'utilise pas encore l'appli, invitez-la ensuite.</p>
      <div className="form-actions">
        <button className="btn" onClick={onDone}>
          Annuler
        </button>
        <button
          className="btn primary grow"
          disabled={busy || !name.trim()}
          onClick={() =>
            run(onError, async () => {
              setBusy(true);
              try {
                const id = await vault.createCircle({ name: name.trim(), color }, undefined, members);
                for (const m of members) for (const d of vault.knownDevices().filter((x) => x.member === m && !x.lost)) await vault.admit(id, m, d.id);
                onDone();
              } finally {
                setBusy(false);
              }
            })
          }
        >
          Créer
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Appareils */

function DevicesSection({ onError }: { onError: (e: string) => void }) {
  const engine = useEngine();
  const vault = useVault();
  const { byId } = useMembers();
  const circles = useCircles();
  const me = engine.memberId;
  const info = (id: string) => vault.get<Device>('deviceInfo', id);
  const devices = vault.knownDevices().sort((a, b) => (a.member === me ? -1 : 0) - (b.member === me ? -1 : 0));
  const canDeclare = (member: string) => member === me || circles.some((c) => c.isAdmin && c.members.includes(member));
  return (
    <FieldGroup label="Appareils">
      <ul className="plain">
        {devices.map((d) => (
          <li key={d.id} className="row" style={{ alignItems: 'center', gap: 8 }}>
            <Smartphone size={18} />
            <span className="grow">
              {info(d.id)?.label ?? 'Appareil'} · {byId(d.member)?.name ?? '?'}
              {d.id === engine.deviceId && <small className="muted"> (celui-ci)</small>}
              {d.lost && <small className="error"> · déclaré perdu</small>}
            </span>
            {d.id !== engine.deviceId && canDeclare(d.member) && (
              <button
                className={`link ${d.lost ? '' : 'danger'}`}
                onClick={() => {
                  if (!d.lost && !confirm("Déclarer cet appareil perdu ? Il ne recevra plus rien de nouveau, et ce qu'il écrirait désormais sera ignoré. Vous pourrez lui rendre l'accès s'il est retrouvé.")) return;
                  run(onError, () => vault.declareLost(d.id, !d.lost));
                }}
              >
                {d.lost ? "Retrouvé : rendre l'accès" : 'Déclarer perdu'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </FieldGroup>
  );
}
