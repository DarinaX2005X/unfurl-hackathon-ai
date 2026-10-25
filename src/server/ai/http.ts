import "server-only";
import { MAX_PROVIDER_RESPONSE_BYTES } from "./constants";
import { ProviderFailure } from "./failure";

export async function boundedResponseText(response: Response, limit = MAX_PROVIDER_RESPONSE_BYTES): Promise<string> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    await response.body?.cancel();
    throw new ProviderFailure("invalid_output");
  }
  if (!response.body) throw new ProviderFailure("invalid_output");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ProviderFailure("invalid_output");
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
