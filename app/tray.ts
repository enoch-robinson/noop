// The tray icon (the menu bar on macOS, the notification area on Windows, a StatusNotifierItem on Linux) and its menu.
import { effect, platform } from "nsh";
import { isAvailable as hasWindow, Tray, Window, type MenuItem } from "nsh/desktop";
import { L } from "./i18n";
import icon from "./tray.svg";

/** What the signed-in app adds to the menu: the decisions waiting, and where its items go. */
export type TrayChat = { pending: number; review: () => void; settings: () => void };

/** The tray's tooltip and menu for `chat` (null while signed out); `show` brings the window to the front. */
export function trayMenu(chat: TrayChat | null, show: () => void): { tooltip: string; menu: MenuItem[] } {
  const n = chat?.pending ?? 0;
  const waiting = n === 1 ? L("1 decision waiting", "1 件事等你拍板") : L(`${n} decisions waiting`, `${n} 件事等你拍板`);
  const items: (MenuItem | false)[] = [
    { label: L("Open Noop", "打开 Noop"), onSelect: show },
    n > 0 && { label: waiting, onSelect: () => { show(); chat!.review(); } },
    !!chat && { type: "separator" },
    !!chat && { label: L("Team Settings…", "团队设置…"), onSelect: () => { show(); chat.settings(); } },
    { type: "separator" },
    { role: "quit", label: L("Quit Noop", "退出 Noop") },
  ];
  return { tooltip: n > 0 ? `Noop · ${waiting}` : "Noop", menu: items.filter((i): i is MenuItem => !!i) };
}

/** Shows the tray icon on desktops, following `chat` and the language. On macOS a click opens the menu, as menu bar
 * icons do; elsewhere it brings the window to the front and a secondary click opens the menu. */
export function setupTray(chat: () => TrayChat | null) {
  if (!hasWindow) return;
  const show = () => Window.get("main")?.focus();
  const onClick = platform.os === "macos" ? undefined : show;
  effect(() => Tray.set({ icon, onClick, ...trayMenu(chat(), show) }));
}
