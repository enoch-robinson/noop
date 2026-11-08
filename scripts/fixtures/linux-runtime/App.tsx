import { mount, Text } from "nsh";

// Exercise the global used by Chat.send in the packaged runner, whose Cargo
// features differ from the CLI and the native development/test hosts.
const id = crypto.randomUUID();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
  throw new Error("Invalid message UUID");
}
console.log("NOOP_LINUX_RUNTIME_OK");
mount(() => <Text>Runtime OK</Text>);
