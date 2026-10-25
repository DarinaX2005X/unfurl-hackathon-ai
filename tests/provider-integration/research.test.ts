import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { isPublicAddress, SafeSourceReader, validateSourceUrl, type SourceTransport } from "../../src/server/research/reader";
import { verifyPassage } from "../../src/server/research/repository";
import { jsonDigest } from "../../src/server/ai/json";
const signal = () => new AbortController().signal;
function transport(text = "<html><title>Primary source</title><body><nav>Unrelated nav</nav><h1>Energy</h1><p>Energy is conserved.</p><script>Do not read this script</script></body></html>", mediaType = "text/html"): SourceTransport {
  return { resolve: vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]),
    request: vi.fn(async () => ({ status: 200, headers: { "content-type": mediaType }, bytes: Buffer.from(text) })) };
}
describe("source connection boundary", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1"])("rejects nonpublic address %s", (address) => expect(isPublicAddress(address)).toBe(false));
  it("accepts only public unicast and rejects credentials, obfuscated loopback and nondefault ports", () => {
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    for (const url of ["file:///etc/passwd", "http://2130706433/", "http://0x7f000001/", "http://user:pass@example.org", "https://example.org:8443", "http://localhost."]) {
      expect(() => validateSourceUrl(url)).toThrow();
    }
  });
  it("rejects mixed public/private DNS answers before opening a connection", async () => {
    const network = transport(); vi.mocked(network.resolve).mockResolvedValue([{ address: "1.1.1.1", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    expect(await new SafeSourceReader(network).read({ url: "https://docs.example.org" }, signal())).toMatchObject({ status: "blocked" });
    expect(network.request).not.toHaveBeenCalled();
  });
  it("passes the exact validated address into transport and rechecks every redirect", async () => {
    const network = transport();
    vi.mocked(network.request).mockResolvedValueOnce({ status: 302, headers: { location: "http://169.254.169.254/latest" }, bytes: new Uint8Array() });
    expect(await new SafeSourceReader(network).read({ url: "https://docs.example.org" }, signal())).toMatchObject({ status: "blocked" });
    expect(network.request).toHaveBeenCalledTimes(1);
    expect(network.request).toHaveBeenCalledWith(expect.any(URL), { address: "93.184.216.34", family: 4 }, expect.any(AbortSignal));
  });
  it("bounds redirects and retains the final URL when a public redirect succeeds", async () => {
    const network = transport(); vi.mocked(network.request).mockResolvedValueOnce({ status: 301, headers: { location: "/guide" }, bytes: new Uint8Array() });
    const result = await new SafeSourceReader(network).read({ url: "https://docs.example.org" }, signal());
    expect(result).toMatchObject({ status: "success", document: { finalUrl: "https://docs.example.org/guide" } });
    expect(network.resolve).toHaveBeenCalledTimes(2);
    const loop = transport(); vi.mocked(loop.request).mockResolvedValue({ status: 302, headers: { location: "/again" }, bytes: new Uint8Array() });
    expect(await new SafeSourceReader(loop).read({ url: "https://docs.example.org" }, signal())).toMatchObject({ status: "blocked" });
    expect(loop.request).toHaveBeenCalledTimes(4);
  });
});
describe("actual extraction and exact provenance", () => {
  it("extracts actual article blocks, excludes executable/navigation content and hashes stored text", async () => {
    const result = await new SafeSourceReader(transport()).read({ url: "https://docs.example.org" }, signal());
    expect(result.status).toBe("success"); if (result.status !== "success") return;
    expect(result.document.title).toBe("Primary source");
    expect(result.document.blocks.map((block) => block.text)).toEqual(["Energy", "Energy is conserved."]);
    expect(result.document.contentDigest).toBe(jsonDigest(result.document.blocks));
    expect(result.document.publishedAt).toBeNull();
    expect(result.document.extractionState).toBe("complete");
  });
  it("checks passage quotes against immutable UTF-16 offsets, not approximate text matching", async () => {
    const result = await new SafeSourceReader(transport("A🌱B", "text/plain")).read({ url: "https://docs.example.org" }, signal());
    if (result.status !== "success") throw new Error("Expected source");
    const passage = { id: randomUUID(), sourceId: result.document.id, blockId: "block-1", start: 1, end: 3, quote: "🌱" };
    expect(() => verifyPassage(result.document, passage)).not.toThrow();
    expect(() => verifyPassage(result.document, { ...passage, end: 2 })).toThrow();
    expect(() => verifyPassage(result.document, { ...passage, quote: "B" })).toThrow();
  });
  it("reports unsupported bytes/formats and download overflow honestly", async () => {
    expect(await new SafeSourceReader(transport("%PDF-1.7", "application/pdf")).read({ url: "https://docs.example.org/doc.pdf" }, signal())).toMatchObject({ status: "unsupported" });
    expect(await new SafeSourceReader(transport("x".repeat(2 * 1024 * 1024 + 1), "text/plain")).read({ url: "https://docs.example.org" }, signal())).toMatchObject({ status: "too_large" });
    expect(await new SafeSourceReader(transport("text", "text/plain; charset=iso-8859-1")).read({ url: "https://docs.example.org" }, signal())).toMatchObject({ status: "unsupported" });
  });
  it("marks bounded extraction as truncated instead of claiming a complete source", async () => {
    const result = await new SafeSourceReader(transport("x".repeat(200001), "text/plain")).read({ url: "https://docs.example.org" }, signal());
    expect(result).toMatchObject({ status: "success", document: { extractionState: "truncated" } });
    if (result.status === "success") expect(result.document.blocks.reduce((sum, block) => sum + block.text.length, 0)).toBe(200000);
  });
});
