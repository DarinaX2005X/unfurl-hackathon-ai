import { parentPort, workerData } from "node:worker_threads";
import { getResolvedPDFJS } from "unpdf";

// This worker never receives a URL or credentials. PDF.js sees only immutable
// bytes from the pinned source transport, and no rendering/OCR path is invoked.
const MAX_PART_TEXT = 200000;
const MAX_PART_BLOCKS = 512;
const MAX_BLOCK_TEXT = 20000;

function pageText(items) {
  return items.flatMap(item => typeof item.str === "string" ? [item.str, item.hasEOL ? "\n" : " "] : [])
    .join("").replace(/[^\S\r\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

let loadingTask;
try {
  const { getDocument, version } = await getResolvedPDFJS();
  if (version !== "6.4.299") throw new Error("extractor_version_changed");
  // Keep even an accidental auxiliary-font/image fetch inside this isolated
  // worker unavailable. PDF text must come from the supplied bytes alone.
  globalThis.fetch = async () => { throw new Error("external_pdf_resource_disabled"); };
  loadingTask = getDocument({ data: new Uint8Array(workerData.bytes),
    isEvalSupported: false, useWorkerFetch: false, disableAutoFetch: true, disableRange: true, disableStream: true,
    disableFontFace: true, useSystemFonts: false, enableXfa: false, maxImageSize: 0, stopAtErrors: true,
    verbosity: 0 });
  const pdf = await loadingTask.promise;
  const requested = workerData.start ?? { page: 1, offset: 0 };
  if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || requested.page > pdf.numPages ||
      workerData.totalPages !== undefined && workerData.totalPages !== pdf.numPages) throw new Error("source_changed");
  const blocks = [];
  let length = 0;
  let end = { ...requested };
  let next = null;
  for (let pageNumber = requested.page; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    let text;
    try { text = pageText((await page.getTextContent({ disableNormalization: false, includeMarkedContent: false })).items); }
    finally { page.cleanup(); }
    let offset = pageNumber === requested.page ? requested.offset : 0;
    if (offset > text.length) throw new Error("cursor_out_of_bounds");
    while (offset < text.length) {
      if (length >= MAX_PART_TEXT || blocks.length >= MAX_PART_BLOCKS) {
        next = { page: pageNumber, offset }; break;
      }
      let stop = Math.min(text.length, offset + MAX_BLOCK_TEXT, offset + MAX_PART_TEXT - length);
      // Preserve UTF-16 characters while keeping quote offsets deterministic.
      if (stop < text.length && /[\uD800-\uDBFF]/.test(text[stop - 1])) stop--;
      if (stop === offset) { next = { page: pageNumber, offset }; break; }
      const value = text.slice(offset, stop);
      blocks.push({ id: `page-${pageNumber}-offset-${offset}`, text: value });
      length += value.length; offset = stop; end = { page: pageNumber, offset };
    }
    if (next) break;
    // Looking ahead through empty pages makes next refer to remaining actual
    // text, so a completed chain never needs a fabricated empty final source.
  }
  if (!blocks.length) throw new Error("no_extractable_text");
  let title = null;
  try {
    const metadata = await pdf.getMetadata();
    if (typeof metadata.info?.Title === "string") title = metadata.info.Title.replace(/\s+/g, " ").trim().slice(0, 1000) || null;
  } catch { /* Metadata is optional; the actual text is not. */ }
  parentPort.postMessage({ ok: true, value: { title, blocks, totalPages: pdf.numPages, start: requested, end, next } });
} catch {
  parentPort.postMessage({ ok: false, reason: "unsupported" });
} finally {
  try { await loadingTask?.destroy(); } catch { /* The parent also terminates the worker. */ }
}
