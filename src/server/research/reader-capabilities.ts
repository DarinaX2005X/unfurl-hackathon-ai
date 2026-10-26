import "server-only";
import {z} from "zod";
import type {JsonObject} from "../../domain/common";
import type {SourceReadResult} from "./ports";

/** Captured, never defaulted onto historical requests. Update the version when the reader changes. */
export const ReaderCapabilitiesSchema=z.object({
  version:z.literal("text-sources-v1"),
  supportedMediaTypes:z.tuple([z.literal("text/html"),z.literal("application/xhtml+xml"),z.literal("text/plain"),z.literal("text/markdown"),z.literal("application/json")]),
  pdf:z.literal(false),
}).strict();
export type ReaderCapabilities=z.infer<typeof ReaderCapabilitiesSchema>;
export function currentReaderCapabilities():ReaderCapabilities{
  return{version:"text-sources-v1",supportedMediaTypes:["text/html","application/xhtml+xml","text/plain","text/markdown","application/json"],pdf:false};
}
export const READER_CAPABILITY_INSTRUCTIONS="readerCapabilities describes the source reader available to this captured decision. It can extract text from HTML, XHTML, plain text, Markdown and JSON. PDF documents cannot be read by this reader. Search for accessible full-text primary-source web pages or supported text editions covering the same requested topics; do not deliberately search for PDF-only sources. A book's landing page or table of contents does not establish that its chapters were read. If an important reference is available only as PDF, find an accessible primary-source treatment of the same material or state the unresolved evidence gap. Preserve the full course goal and depth: do not drop subjects or replace substantive passages with titles, snippets or summaries to fit reader capabilities. An unsupported read can also mean an encoding or text-extraction limitation, so do not infer its exact file type from that status alone. Use a different readable representation or source rather than repeatedly fetching the unchanged unsupported URL.";

/** Additional recovery guidance is model data; public summaries stay short and human-readable. */
export function sourceReadFailureObservation(result:Exclude<SourceReadResult,{status:"success"}>,capabilities:ReaderCapabilities|undefined):{summary:string;data:JsonObject}{
  if(result.status!=="unsupported"||!capabilities)return{summary:`This source could not be read (${result.status}).`,data:{...result}};
  return{summary:"This source could not be read in a supported text format.",data:{...result,
    reason:"unsupported_format_encoding_or_text_extraction",readerCapabilities:{...capabilities},
    recovery:"Find an accessible full-text primary-source web page or supported text edition covering the same material. PDF is not supported. Do not infer which format or encoding failed, retry the unchanged URL, or reduce the course scope."}};
}
