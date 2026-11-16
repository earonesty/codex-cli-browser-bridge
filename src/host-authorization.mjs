import net from "node:net";
import { createPublicKey, randomBytes, verify } from "node:crypto";

export function verifyAuthorizationResponse(result, request, publicKey) {
  if (typeof result?.payload !== "string" || typeof result?.signature !== "string") {
    throw new Error("Desktop host returned a malformed authorization response");
  }
  const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), type: "spki", format: "der" });
  if (!verify(null, Buffer.from(result.payload), key, Buffer.from(result.signature, "base64"))) {
    throw new Error("Desktop browser authorization signature did not verify");
  }
  for (const allowed of [true, false]) {
    if (result.payload === JSON.stringify({ domain: "codex.browserAccess.v1", request, allowed })) return allowed;
  }
  throw new Error("Desktop browser authorization response does not match this request");
}

/** Request authorization from the real desktop host; never manufacture a grant. */
export async function checkHostAuthorization(env, { sessionId, turnId, timeoutMs = 10000 }) {
  if (!sessionId || !turnId) throw new Error("Browser authorization requires a session and turn ID");
  const request = {
    executorId: env.BROWSER_USE_ACCESS_EXECUTOR_ID,
    sessionId, turnId, nonce: randomBytes(32).toString("hex"),
  };
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "browser/access", params: request }));
  const frame = Buffer.alloc(body.length + 4);
  frame.writeUInt32LE(body.length);
  body.copy(frame, 4);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(env.BROWSER_USE_ACCESS_PIPE_PATH);
    let buffer = Buffer.alloc(0), settled = false;
    const finish = (error, allowed) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(allowed);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("Desktop browser authorization timed out")));
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish(new Error("Desktop host closed before returning authorization")));
    socket.on("connect", () => socket.write(frame));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length > 8 * 1024 * 1024) return finish(new Error("Desktop authorization response exceeds frame limit"));
      if (buffer.length < length + 4) return;
      try {
        const response = JSON.parse(buffer.subarray(4, length + 4));
        if (response.id !== 1) throw new Error("Desktop authorization response has an unexpected request ID");
        if (response.error) throw new Error(`Desktop browser authorization failed: ${response.error.message}`);
        finish(null, verifyAuthorizationResponse(response.result, request, env.BROWSER_USE_ACCESS_VERIFYING_IDENTITY));
      } catch (error) { finish(error); }
    });
  });
}
