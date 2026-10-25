import "server-only";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { digestBytes, jsonDigest } from "../ai/json";
import { SourceDocumentSchema, type SourceDocument, type SourceReadResult } from "./ports";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 200000;
type Address = { address: string; family: 4 | 6 };
type FailureStatus = Exclude<SourceReadResult["status"], "success">;
class ReadFailure extends Error { constructor(readonly status: FailureStatus) { super(status); } }
export interface PinnedResponse { status: number; headers: IncomingHttpHeaders; bytes: Uint8Array }
export interface SourceTransport {
  resolve(hostname: string, signal: AbortSignal): Promise<Address[]>;
  request(url: URL, address: Address, signal: AbortSignal): Promise<PinnedResponse>;
}
export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}
export function validateSourceUrl(value: string): URL {
  if (value.length > 4096) throw new ReadFailure("blocked");
  let url: URL;
  try { url = new URL(value); } catch { throw new ReadFailure("blocked"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    (url.port && url.port !== (url.protocol === "https:" ? "443" : "80"))) throw new ReadFailure("blocked");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!hostname || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(hostname) ||
    (isIP(hostname) && !isPublicAddress(hostname))) throw new ReadFailure("blocked");
  url.hash = "";
  return url;
}
async function boundedLookup(hostname: string, signal: AbortSignal): Promise<Address[]> {
  signal.throwIfAborted();
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  let abort: (() => void) | undefined;
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => { abort = () => reject(new ReadFailure("unavailable")); signal.addEventListener("abort", abort, { once: true }); }),
    ]);
    return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}
/** The request cannot do an unchecked second DNS lookup; TLS still verifies the original host. */
function pinnedRequest(url: URL, address: Address, signal: AbortSignal): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET", signal, agent: false, family: address.family,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers: { Accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/json", "Accept-Encoding": "identity", "User-Agent": "Unfurl-Research/1.0" },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy(); resolve({ status, headers: response.headers, bytes: new Uint8Array() }); return;
      }
      if (Number(response.headers["content-length"] ?? 0) > MAX_BYTES) {
        response.destroy(); reject(new ReadFailure("too_large")); return;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { response.destroy(new ReadFailure("too_large")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status, headers: response.headers, bytes: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}
export const nodeSourceTransport: SourceTransport = { resolve: boundedLookup, request: pinnedRequest };

type HtmlNode = DefaultTreeAdapterMap["node"];
const excluded = new Set(["script", "style", "nav", "header", "footer", "form", "template", "noscript", "svg", "canvas", "button", "input", "select"]);
const blockTags = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "pre", "blockquote", "td", "th"]);
function children(node: HtmlNode): HtmlNode[] { return "childNodes" in node ? node.childNodes : []; }
function textContent(node: HtmlNode): string {
  if ("tagName" in node && excluded.has(node.tagName)) return "";
  if (node.nodeName === "#text" && "value" in node) return node.value;
  return children(node).map(textContent).join(" ");
}
function extract(bytes: Uint8Array, mediaType: SourceDocument["mediaType"], finalUrl: URL) {
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new ReadFailure("unsupported"); }
  let title = finalUrl.hostname;
  let texts: string[] = [];
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    const tree = parse(raw);
    function visit(node: HtmlNode) {
      if ("tagName" in node) {
        if (excluded.has(node.tagName)) return;
        if (node.tagName === "title") { title = textContent(node).replace(/\s+/g, " ").trim().slice(0, 1000) || title; return; }
        if (blockTags.has(node.tagName)) { texts.push(textContent(node).replace(/\s+/g, " ").trim()); return; }
      }
      for (const child of children(node)) visit(child);
    }
    visit(tree);
    if (!texts.some(Boolean)) texts = [textContent(tree).replace(/\s+/g, " ").trim()];
  } else texts = raw.split(/\n\s*\n/).map((paragraph) => paragraph.trim());
  const blocks: SourceDocument["blocks"] = [];
  let length = 0;
  let truncated = false;
  for (const text of texts.filter(Boolean)) {
    for (let start = 0; start < text.length; start += 20000) {
      if (length >= MAX_TEXT || blocks.length >= 512) { truncated = true; break; }
      const part = text.slice(start, Math.min(start + 20000, start + MAX_TEXT - length));
      blocks.push({ id: `block-${blocks.length + 1}`, text: part });
      length += part.length;
      if (part.length < Math.min(20000, text.length - start)) truncated = true;
    }
  }
  if (blocks.length === 0) throw new ReadFailure("unsupported");
  return { title, blocks, extractionState: truncated ? "truncated" as const : "complete" as const };
}

export class SafeSourceReader {
  constructor(private readonly transport: SourceTransport = nodeSourceTransport) {}
  async read(input: { url: string }, signal: AbortSignal): Promise<SourceReadResult> {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
    try {
      let url = validateSourceUrl(input.url);
      const requestedUrl = url.toString();
      for (let redirect = 0; redirect <= 3; redirect++) {
        combined.throwIfAborted();
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = await this.transport.resolve(host, combined);
        if (addresses.length === 0 || addresses.some((item) => !isPublicAddress(item.address))) throw new ReadFailure("blocked");
        const response = await this.transport.request(url, addresses[0]!, combined);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirect === 3 || !response.headers.location) throw new ReadFailure("blocked");
          url = validateSourceUrl(new URL(response.headers.location, url).toString());
          continue;
        }
        if (response.status < 200 || response.status >= 300) throw new ReadFailure("unavailable");
        if (response.bytes.length > MAX_BYTES) throw new ReadFailure("too_large");
        if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") throw new ReadFailure("unsupported");
        const contentType = response.headers["content-type"]?.toLowerCase() ?? "";
        const mediaType = contentType.split(";")[0]?.trim();
        if (!mediaType || !["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "application/json"].includes(mediaType) ||
          (/charset=/.test(contentType) && !/charset=["']?(?:utf-8|utf8|us-ascii)(?:["';\s]|$)/.test(contentType))) throw new ReadFailure("unsupported");
        const extracted = extract(response.bytes, mediaType as SourceDocument["mediaType"], url);
        const document = SourceDocumentSchema.parse({ id: randomUUID(), requestedUrl, finalUrl: url.toString(),
          ...extracted, retrievedAt: new Date().toISOString(), publishedAt: null, mediaType,
          rawDigest: digestBytes(response.bytes), extractorVersion: "html-text-v1", contentDigest: jsonDigest(extracted.blocks, MAX_BYTES) });
        return { status: "success", document };
      }
      throw new ReadFailure("blocked");
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return { status: error instanceof ReadFailure ? error.status : "unavailable", requestedUrl: input.url.slice(0, 4096) };
    }
  }
}
