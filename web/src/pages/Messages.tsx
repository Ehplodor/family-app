import { useEffect, useRef, useState } from 'react';
import { Lock, MessageSquareText, Send, Users } from 'lucide-react';
import { useCircles, useCollection, useLocalState, useMe, useMembers } from '../store';
import { navigate } from '../router';
import { groupLabel } from './Circles';
import { relativeDay, timeOf, toISODate } from '../dates';
import { Avatar, Empty, Page } from '../ui';

export type Message = { text: string };

const LAST_SEEN_KEY = 'messages.lastSeen';

/**
 * Une conversation par cercle : ses messages ne sont chiffrés que pour lui. Le cercle partagé le plus large
 * (la famille, en général) vient en premier. « Moi seul » a aussi la sienne : notes, liens, idées à garder
 * pour soi (synchronisées entre ses appareils).
 */
function useConversations() {
  const all = useCollection<Message>('messages').docs;
  const circles = [...useCircles()]
    .filter((g) => !g.outdated || all.some((m) => m.groups[0] === g.id))
    .sort((a, b) => (a.personal ? 1 : 0) - (b.personal ? 1 : 0) || b.members.length - a.members.length);
  return { circles, privateOf: (id: string) => all.filter((m) => m.groups[0] === id) };
}

export function MessagesSummary() {
  const { circles, privateOf } = useConversations();
  const me = useMe();
  const [lastSeen] = useLocalState<Record<string, string> | string>(LAST_SEEN_KEY, '');
  const seen = (id: string) => (typeof lastSeen === 'string' ? (id === '' ? lastSeen : '') : (lastSeen[id] ?? ''));
  const count = (docs: { createdAt: string; createdBy: string | null }[], id: string) =>
    docs.filter((m) => m.createdAt > seen(id) && m.createdBy !== me.member.id).length;
  const unread = circles.reduce((n, g) => n + count(privateOf(g.id), g.id), 0);
  return <>{unread ? `${unread} nouveau${unread > 1 ? 'x' : ''} message${unread > 1 ? 's' : ''}` : 'Aucun nouveau message'}</>;
}

export function MessagesPage({ params = [] }: { params?: string[] }) {
  const messagesCol = useCollection<Message>('messages');
  const { circles, privateOf } = useConversations();
  const me = useMe();
  const { byId } = useMembers();
  const [lastSeen, setLastSeen] = useLocalState<Record<string, string> | string>(LAST_SEEN_KEY, '');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const circle = circles.find((g) => g.id === params[0]) ?? circles[0] ?? null;
  const convId = circle?.id ?? '';
  const docs = circle ? privateOf(circle.id) : [];
  const canWrite = !!circle?.writable;
  const messages = { docs, loaded: true };

  const last = docs[docs.length - 1];
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
    if (!last) return;
    // Dernier message lu, par conversation (l'ancien format, une simple date, vaut pour la famille).
    const prev = typeof lastSeen === 'string' ? { '': lastSeen } : lastSeen;
    if (prev[convId] !== last.createdAt) setLastSeen({ ...prev, [convId]: last.createdAt });
  }, [last, convId, lastSeen, setLastSeen]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText('');
    setError('');
    try {
      if (circle) await messagesCol.create({ text: t, groups: [circle.id] });
    } catch (err) {
      setText(t);
      setError((err as Error).message);
    }
  };

  let previousDay = '';
  return (
    <Page title="Messages" className="chat-page">
      {circles.length > 1 && (
        <div className="chips chat-tabs">
          {circles.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`chip ${circle?.id === g.id ? 'on' : ''}`}
              style={circle?.id === g.id ? { background: g.color, borderColor: g.color } : { borderColor: g.color }}
              onClick={() => navigate(`/m/messages/${g.id}`)}
            >
              {g.personal ? <Lock size={14} /> : <Users size={14} />} {groupLabel(g)}
            </button>
          ))}
        </div>
      )}
      <div className="chat">
        {messages.loaded && !messages.docs.length && (
          <Empty icon={<MessageSquareText size={48} />}>
            {circle?.personal
              ? 'Vos notes personnelles : visibles seulement sur vos appareils autorisés (chiffrées). Pratique pour un lien, une idée, une liste à garder pour soi.'
              : `Conversation du cercle « ${circle?.name ?? ''} » : seuls ses membres la lisent (chiffrée pour eux). Dites bonjour 👋`}
          </Empty>
        )}
        {messages.docs.map((m, i) => {
          const day = toISODate(new Date(m.createdAt));
          const showDay = day !== previousDay;
          previousDay = day;
          const mine = m.createdBy === me.member.id;
          const author = byId(m.createdBy);
          const sameAuthorAsPrev = !showDay && messages.docs[i - 1]?.createdBy === m.createdBy;
          return (
            <div key={m.id}>
              {showDay && <div className="chat-day">{relativeDay(day)}</div>}
              <div className={`bubble-row ${mine ? 'mine' : ''}`}>
                {!mine && (sameAuthorAsPrev ? <span style={{ width: 30 }} /> : <Avatar member={author} size={30} />)}
                <div className="bubble" style={mine ? undefined : { borderColor: `${author?.color ?? '#999'}55` }}>
                  {!mine && !sameAuthorAsPrev && (
                    <strong style={{ color: author?.color }}>{author?.name ?? 'Ancien membre'}</strong>
                  )}
                  <p>{m.text}</p>
                  <small>{timeOf(m.createdAt)}</small>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
      {error && <p className="error">{error}</p>}
      {!canWrite && <p className="muted small center">Cet appareil n'a plus accès à ce cercle : vous pouvez relire, pas écrire.</p>}
      <form className="chat-input" onSubmit={send}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={circle?.personal ? 'Note pour moi…' : `Message pour « ${circle?.name ?? ''} »…`}
          enterKeyHint="send"
          disabled={!canWrite}
        />
        <button className="icon-btn send" disabled={!text.trim() || !canWrite} aria-label="Envoyer">
          <Send size={20} />
        </button>
      </form>
    </Page>
  );
}
