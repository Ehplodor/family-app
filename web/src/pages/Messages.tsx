import { useEffect, useRef, useState } from 'react';
import { MessageSquareText, Send } from 'lucide-react';
import { useCollection, useLocalState, useMe, useMembers } from '../store';
import { relativeDay, timeOf, toISODate } from '../dates';
import { Avatar, Empty, Page } from '../ui';

export type Message = { text: string };

const LAST_SEEN_KEY = 'messages.lastSeen';

export function MessagesSummary() {
  const { docs } = useCollection<Message>('messages');
  const me = useMe();
  const [lastSeen] = useLocalState(LAST_SEEN_KEY, '');
  const unread = docs.filter((m) => m.createdAt > lastSeen && m.createdBy !== me.member.id).length;
  return <>{unread ? `${unread} nouveau${unread > 1 ? 'x' : ''} message${unread > 1 ? 's' : ''}` : 'Aucun nouveau message'}</>;
}

export function MessagesPage() {
  const messages = useCollection<Message>('messages');
  const me = useMe();
  const { byId } = useMembers();
  const [, setLastSeen] = useLocalState(LAST_SEEN_KEY, '');
  const [text, setText] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  const last = messages.docs[messages.docs.length - 1];
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
    if (last) setLastSeen(last.createdAt);
  }, [last, setLastSeen]);

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText('');
    messages.create({ text: t });
  };

  let previousDay = '';
  return (
    <Page title="Messages" className="chat-page">
      <div className="chat">
        {messages.loaded && !messages.docs.length && (
          <Empty icon={<MessageSquareText size={48} />}>Le fil de discussion de la famille. Dites bonjour 👋</Empty>
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
      <form className="chat-input" onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Votre message…" enterKeyHint="send" />
        <button className="icon-btn send" disabled={!text.trim()} aria-label="Envoyer">
          <Send size={20} />
        </button>
      </form>
    </Page>
  );
}
