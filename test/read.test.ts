import { expect, test } from "bun:test";
import { isRead, markRead, toggleMessageRead, unreadEvents } from "../app/read";
const ev = (id: string, ts: string, kind = "notice", from = "lead") => ({ id, ts, kind, from, text: id });
const events = [ev("a", "1"), ev("owner", "2", "owner", "owner"), ev("c", "3"), ev("hub", "4", "system", "hub@x"), ev("e", "5")];
test("reads are per message: reading one preserves unrelated unread results", () => {
  const state = markRead({ through: "2", ids: [] }, [events[2]]);
  expect(unreadEvents(events, state).map((e) => e.id)).toEqual(["e"]);
  expect(isRead(events[2], state)).toBe(true);
  expect(markRead(state, [events[2]])).toBe(state);
});
test("the owner and quiet hub messages do not count as unread", () => {
  expect(unreadEvents(events, { through: "", ids: [] }).map((e) => e.id)).toEqual(["a", "c", "e"]);
});
test("manual unread marks survive automatic viewport reads until explicitly cleared", () => {
  const marked = toggleMessageRead({ through: "5", ids: [] }, events[0]);
  expect(isRead(events[0], marked)).toBe(false);
  expect(markRead(marked, [events[0]]).marked).toEqual(["a"]);
  expect(isRead(events[0], toggleMessageRead(marked, events[0]))).toBe(true);
});
test("toggling a new message read does not advance past other messages", () => {
  const state = toggleMessageRead({ through: "1", ids: [] }, events[4]);
  expect(state.through).toBe("1");
  expect(unreadEvents(events, state).map((e) => e.id)).toEqual(["c"]);
});
test("a read-all watermark clears old marks but new messages remain unread", () => {
  expect(unreadEvents([...events, ev("next", "6")], { through: "5", ids: [], marked: [] }).map((e) => e.id)).toEqual(["next"]);
});
