// One record per event, shared by the main chat and all channel views on this device.
type ReadEvent = { id: string; ts: string; kind: string; text: string; thread?: boolean; from?: string };
export type MessageReadState = { through: string; ids: string[]; marked?: string[] };
export const isRead = (e: ReadEvent, state: MessageReadState) => e.kind === "owner" || (e.kind === "system" && /^hub/.test(e.from ?? "")) || (!(state.marked ?? []).includes(e.id) && (e.ts <= state.through || state.ids.includes(e.id)));
export function unreadEvents<T extends ReadEvent>(events: T[], state: MessageReadState): T[] {
  const ids = new Set(state.ids);
  return events.filter((e) => !e.thread && e.kind !== "owner" && ((state.marked ?? []).includes(e.id) || (e.ts > state.through && !ids.has(e.id))) && !(e.kind === "system" && (/^hub/.test(e.from ?? "") || e.text.startsWith("⚙️ 设置已更新"))));
}
export function markRead(state: MessageReadState, events: ReadEvent[]): MessageReadState {
  const ids = new Set(state.ids);
  const add = events.filter((e) => e.kind !== "owner" && e.ts > state.through && !ids.has(e.id) && !(state.marked ?? []).includes(e.id));
  return add.length ? { ...state, ids: [...new Set([...state.ids, ...add.map((e) => e.id)])] } : state;
}

export function toggleMessageRead(state: MessageReadState, e: ReadEvent): MessageReadState {
  if (isRead(e, state)) return { ...state, marked: [...new Set([...(state.marked ?? []), e.id])] };
  return { ...state, marked: (state.marked ?? []).filter((id) => id !== e.id), ids: [...new Set([...state.ids, e.id])] };
}
