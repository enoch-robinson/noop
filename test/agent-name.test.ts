import { expect, test } from "bun:test";
import { agentDisplayName } from "../app/avatars";
test("agent names follow the client language", () => {
  expect(agentDisplayName("Tripitaka@host", true)).toBe("唐僧");
  expect(agentDisplayName("Tripitaka@host", false)).toBe("Tripitaka");
  expect(agentDisplayName("Argus@h", false)).toBe("Monkey");
  expect(agentDisplayName("reviewer", true)).toBe("悟空");
  expect(agentDisplayName("hub@h", true)).toBe("hub");
});
