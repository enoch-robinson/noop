/** Channels: work topics the AI opens (like Slack channels in a company), read-only drill-downs of the main chat. */
export type ChannelItem = { id: string; kind: "task" | "decision" | "report"; title: string; state: string; updated: string; task?: string };
export type Channel = { slug: string; name: string; goal: string; status: "active" | "archived"; created: string; last_activity: string; stale: boolean; count: number; refs?: string[]; items: ChannelItem[] };

/** Sidebar order: active first, the most recently busy on top; archived last. */
export function sortChannels(cs: readonly Channel[]): Channel[] {
  return [...cs].sort((a, b) => (a.status === b.status ? b.last_activity.localeCompare(a.last_activity) : a.status === "active" ? -1 : 1));
}
