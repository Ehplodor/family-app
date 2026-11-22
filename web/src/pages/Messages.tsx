import { useEffect, useRef, useState } from 'react';
import { Lock, MessageSquareText, Send, Users } from 'lucide-react';
import { useCollection, useGroups, useLocalState, useMe, useMembers } from '../store';
import { navigate } from '../router';
import { PRIVATE_MESSAGES } from '../lib/groupManager';
import { relativeDay, timeOf, toISODate } from '../dates';
import { Avatar, Empty, Page } from '../ui';

export type Message = { text: string };

const LAST_SEEN_KEY = 'messages.lastSeen';

/**
 * Conversations : celle de toute la famille (collection `messages`, comme avant) et une par cercle restreint
 * (« Parents »…), dont les messages sont chiffrés pour le cercle seulement (collection `privateMessages`).
 */
function useConversations() {
  const groups = useGroups();
  const family = useCollection<Message>('messages').docs;
  const all = groups.privateDocs<Message>(PRIVATE_MESSAGES);
  const circles = groups.list().filter((g) => !g.personal && (g.access === 'ok' || all.some((m) => m.groups.includes(g.id))));
  return { family, circles, privateOf: (id: string) => all.filter((m) => m.groups[0] === id) };
}

export function MessagesSummary() {
  const { family, circles, privateOf } = useConversations();
  const me = useMe();
  const [lastSeen] = useLocalState<Record<string, string> | string>(LAST_SEEN_KEY, '');
  const seen = (id: string) => (typeof lastSeen === 'string' ? (id === '' ? lastSeen : '') : (lastSeen[id] ?? ''));
  const count = (docs: { createdAt: string; createdBy: string | null }[], id: string) =>
    docs.filter((m) => m.createdAt > seen(id) && m.createdBy !== me.member.id).length;
  const unread = count(family, '') + circles.reduce((n, g) => n + count(privateOf(g.id), g.id), 0);
  return <>{unread ? `${unread} nouveau${unread > 1 ? 'x' : ''} message${unread > 1 ? 's' : ''}` : 'Aucun nouveau message'}</>;
}

export function MessagesPage({ params = [] }: { params?: string[] }) {
  const familyMessages = useCollection<Message>('messages');
  const groups = useGroups();
  const { circles, privateOf } = useConversations();
  const me = useMe();
  const { byId } = useMembers();
  const [lastSeen, setLastSeen] = useLocalState<Record<string, string> | string>(LAST_SEEN_KEY, '');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const circle = circles.find((g) => g.id === params[0]) ?? null;
  const convId = circle?.id ?? '';
  const docs = circle ? privateOf(circle.id) : familyMessages.docs;
  const canWrite = !circle || circle.access === 'ok';
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
      if (circle) await groups.sendMessage(circle.id, t);
      else await familyMessages.create({ text: t });
    } catch (err) {
      setText(t);
      setError((err as Error).message);
    }
  };

  let previousDay = '';
  return (
    <Page title="Messages" className="chat-page">
      {circles.length > 0 && (
        <div className="chips chat-tabs">
          <button type="button" className={`chip ${!circle ? 'on' : ''}`} onClick={() => navigate('/m/messages')}>
            <Users size={14} /> Famille
          </button>
          {circles.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`chip ${circle?.id === g.id ? 'on' : ''}`}
              style={circle?.id === g.id ? { background: g.color, borderColor: g.color } : { borderColor: g.color }}
              onClick={() => navigate(`/m/messages/${g.id}`)}
            >
              <Lock size={14} /> {g.name}
            </button>
          ))}
        </div>
      )}
      <div className="chat">
        {messages.loaded && !messages.docs.length && (
          <Empty icon={<MessageSquareText size={48} />}>
            {circle
              ? `Conversation du cercle « ${circle.name} » : seuls ses membres la lisent (chiffrée pour eux).`
              : 'Le fil de discussion de la famille. Dites bonjour 👋'}
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
          placeholder={circle ? `Message pour « ${circle.name} »…` : 'Votre message…'}
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
