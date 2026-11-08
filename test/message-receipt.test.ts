import { expect, test } from "bun:test";
import { startServer } from "../src/server";
import type { Cfg } from "../src/core";

test("retrying a message returns the original receipt and dispatches it only once", async () => {
  let dispatched = 0;
  const server = startServer({ server: { host: "127.0.0.1", port: 0, token: "test" } } as Cfg, async () => { dispatched++; })!;
  const send = (body: object) => fetch(`http://127.0.0.1:${server.port}/api/messages`, {
    method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const first: any = await (await send({ text: "Receipt test", client_id: "local:receipt-test" })).json();
    const retry = await (await send({ text: "Receipt test", client_id: "local:receipt-test" })).json();
    expect(retry).toEqual(first);
    expect(dispatched).toBe(1);
    const next: any = await (await send({ text: "Receipt test", client_id: "local:another-message" })).json();
    expect(next.id).not.toBe(first.id);
    expect(dispatched).toBe(2);
    expect((await send({ text: "bad", client_id: {} })).status).toBe(400);
    const legacy = await send({ text: "Legacy client" });
    expect(legacy.status).toBe(200);
  } finally { server.stop(true); }
});
