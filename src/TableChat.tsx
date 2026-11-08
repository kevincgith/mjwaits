// The online table's chat room: a button with the count of new lines, and a
// small panel - the box at the top, newest line under it, so a phone's
// keyboard, held sideways, doesn't cover what you're typing or reading.

import { useState, type FormEvent } from "react";
import { CHAT_MAX } from "@mjwaits/shared/protocol/limits";
import type { ChatMessage } from "@mjwaits/shared/protocol/table";

export interface OnlineChat {
  messages: ChatMessage[]; // oldest first, leaving out anyone muted
  unread: number;
  open: boolean;
  setOpen: (open: boolean) => void;
  send: (text: string) => boolean; // false: not connected, nothing sent
  // The last line from someone in a seat (a new id each time).
  bubble: { seat: number; text: string; id: number } | null;
  me: string | null;
}

export function TableChat({ chat, onOpen }: { chat: OnlineChat; onOpen?: () => void }) {
  const [draft, setDraft] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim() && chat.send(draft)) setDraft("");
  };
  return (
    <>
      <button
        type="button"
        className={`play-icon-button play-chat-button${chat.open ? " is-on" : ""}`}
        aria-label={chat.unread ? `Chat, ${chat.unread} new` : "Chat"}
        aria-expanded={chat.open}
        onClick={() => {
          if (!chat.open) onOpen?.();
          chat.setOpen(!chat.open);
        }}
      >
        💬
        {chat.unread > 0 && <span className="play-chat-count">{chat.unread > 9 ? "9+" : chat.unread}</span>}
      </button>
      {chat.open && (
        <div className="play-chat" role="dialog" aria-label="Table chat">
          <form className="play-chat-form" onSubmit={submit}>
            <input value={draft} maxLength={CHAT_MAX} onChange={(e) => setDraft(e.target.value)} placeholder="Say something…" enterKeyHint="send" autoComplete="off" aria-label="Message" />
            <button type="submit" disabled={!draft.trim()}>
              Send
            </button>
          </form>
          <div className="play-chat-lines" aria-live="polite">
            {chat.messages.length === 0 && <p className="play-chat-empty">No messages yet</p>}
            {[...chat.messages].reverse().map((m) => (
              <p key={m.k} className={m.id === chat.me ? "is-mine" : undefined}>
                <strong>{m.id === chat.me ? "You" : m.name}</strong>
                <span>{m.text}</span>
              </p>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
