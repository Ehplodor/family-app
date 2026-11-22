import type { Device } from '../../lib/engine';
import { profileOf, type CopyKind, type SchoolProfile } from '../../lib/school';
import { useCollection, useDoc, useEngine, useMembers } from '../../store';
import { Field, FieldGroup, MemberChips, TimeInput } from '../../ui';

const DAY_NAMES = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const COPY_KINDS: [CopyKind, string][] = [
  ['sessions', 'Travail du jour'],
  ['bag', 'Cartable de la veille'],
  ['quiz', 'Petites questions'],
];

export function SettingsTab({ childId }: { childId: string }) {
  const engine = useEngine();
  const { members, byId } = useMembers();
  const p = profileOf(useDoc<Partial<SchoolProfile>>('schoolProfiles', childId));
  const { docs: devices } = useCollection<Device>('deviceInfo');
  const child = byId(childId);
  const set = (patch: Partial<SchoolProfile>) => engine.data.upsert<SchoolProfile>('schoolProfiles', childId, patch);
  const setCopy = (patch: Partial<SchoolProfile['parentCopy']>) => set({ parentCopy: { ...p.parentCopy, ...patch } });
  const parents = members.filter((m) => m.kind !== 'child');
  const childHasPush = devices.some((d) => d.memberId === childId && d.push && !d.revoked);

  return (
    <div className="stack">
      <div className="card form">
        <h3>Rythme de travail</h3>
        <Field label="Classe (option)">
          <input value={p.grade ?? ''} onChange={(e) => set({ grade: e.target.value })} placeholder="CM2, 5e…" />
        </Field>
        <div className="row">
          <Field label="Heure des devoirs">
            <TimeInput required value={p.studyTime} onChange={(v) => set({ studyTime: v })} />
          </Field>
          <Field label="Mercredi / week-end">
            <TimeInput required value={p.freeDayTime} onChange={(v) => set({ freeDayTime: v })} />
          </Field>
        </div>
        <Field label="Durée d'une séance">
          <select value={p.sessionMinutes} onChange={(e) => set({ sessionMinutes: Number(e.target.value) })}>
            {[10, 15, 20, 25, 30, 45].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </Field>
        <FieldGroup label="Travail maximum par jour (minutes)">
          <div className="capacity">
            {DAY_NAMES.map((d, i) => (
              <label key={d}>
                <small>{d}</small>
                <input
                  inputMode="numeric"
                  value={p.capacity[i]}
                  onChange={(e) => {
                    const capacity = [...p.capacity];
                    capacity[i] = Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0);
                    set({ capacity });
                  }}
                />
              </label>
            ))}
          </div>
        </FieldGroup>
      </div>

      <div className="card form">
        <h3>Rappels</h3>
        <label className="toggle">
          <input type="checkbox" checked={!!p.bagTime} onChange={(e) => set({ bagTime: e.target.checked ? '19:30' : null })} />
          <span className="grow">Cartable de la veille</span>
          {p.bagTime && <TimeInput required className="inline-time" value={p.bagTime} onChange={(v) => set({ bagTime: v })} />}
        </label>
        <Field label="Petites questions par jour">
          <select value={p.quizPerDay} onChange={(e) => set({ quizPerDay: Number(e.target.value) })}>
            <option value={0}>Aucune</option>
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </Field>
        {p.quizPerDay > 0 && (
          <div className="row">
            {Array.from({ length: p.quizPerDay }, (_, i) => (
              <Field key={i} label={`Question ${i + 1}`}>
                <TimeInput
                  required
                  value={p.quizTimes[i] ?? ['07:45', '18:45', '12:30'][i]}
                  onChange={(v) => {
                    const quizTimes = [...p.quizTimes];
                    quizTimes[i] = v;
                    set({ quizTimes });
                  }}
                />
              </Field>
            ))}
          </div>
        )}
        <p className="muted small">Aucune notification n'est envoyée pendant les cours : elle attend la fin du cours.</p>
      </div>

      <div className="card form">
        <h3>Copie aux parents</h3>
        {!childHasPush && (
          <p className="banner-info">
            {child?.name ?? "L'enfant"} n'a pas d'appareil avec notifications : activez la copie pour que les parents reçoivent ses rappels.
          </p>
        )}
        <label className="toggle">
          <input type="checkbox" checked={p.parentCopy.enabled} onChange={(e) => setCopy({ enabled: e.target.checked })} />
          Envoyer aussi les rappels de {child?.name ?? "l'enfant"} aux parents
        </label>
        {p.parentCopy.enabled && (
          <>
            <FieldGroup label="À qui ?">
              <MemberChips members={parents} value={p.parentCopy.parentIds} onChange={(parentIds) => setCopy({ parentIds })} />
            </FieldGroup>
            <FieldGroup label="Quels rappels ?">
              <div className="stack">
                {COPY_KINDS.map(([k, label]) => (
                  <label key={k} className="toggle">
                    <input
                      type="checkbox"
                      checked={p.parentCopy.kinds.includes(k)}
                      onChange={(e) => setCopy({ kinds: e.target.checked ? [...p.parentCopy.kinds, k] : p.parentCopy.kinds.filter((x) => x !== k) })}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </FieldGroup>
            <Field label="Quand ? (travail du jour)">
              <select value={p.parentCopy.delay} onChange={(e) => setCopy({ delay: Number(e.target.value) })}>
                <option value={0}>En même temps que l'enfant</option>
                <option value={30}>30 min après, seulement si pas fait</option>
                <option value={60}>1 h après, seulement si pas fait</option>
                <option value={120}>2 h après, seulement si pas fait</option>
              </select>
            </Field>
            {!p.parentCopy.parentIds.length && <p className="muted small">Aucun choisi : tous les adultes de la famille la reçoivent.</p>}
          </>
        )}
      </div>
    </div>
  );
}
