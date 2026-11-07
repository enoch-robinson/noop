# Work channels

The main chat remains the place to talk to Noop. Channels are read-only views of work topics chosen by the AI from their goals, such as NSH internationalization or Omamail quality. A task can belong to several channels or none. Channels are not repository mappings.

Definitions live in `channels/<slug>.md`; tasks carry a comma-separated `channels` field. The chat brain and task planner classify new tasks using channel goals. Agents choose channels again when returning results. Follow-up tasks inherit only active channels. Existing membership remains available as history after archive.

The sidebar shows unread **messages**, using the same per-event state as the main chat and task pages. Opening an item marks its messages read in every view on that device. Opening a channel alone does not mark unseen results read. The account menu shows the total unread count and offers **Mark all as read**. The old main-chat timestamp migrates into this state once. Read state is local to each device.

Channel views show tasks, their decision cards, and existing Markdown reports referenced by those tasks, newest first. The owner can edit goals and archive or restore channels. Seven quiet days mark a channel idle. Routine multi-project results must use a separate line for each topic so the owner can find a project's result.

## Traffic budget

There is no channel poller. The existing pushed status invalidates the channel snapshot only when task/decision membership or channel definitions change; activity-only heartbeat changes do not fetch it again. Requests overlap within 150 ms and stale responses are discarded. With three owner clients observing the budget fixture's 120 tasks/day, at most 723 initial/claim/completion snapshot requests are added. With no owner clients, the channel UI costs zero requests or writes. Definitions and task memberships ride the existing file-sync commits; reads use the file mirror's indexed directory ranges and cache. Report existence lookups are memoized within a snapshot. No new dependencies or cloud tables are required.

The initial seven-day backfill populates the same channel and task files; subsequent syncs distribute them to each host. Later work is classified at creation and completion; this is not a recurring historical rescan.
