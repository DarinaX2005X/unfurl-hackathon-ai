import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {SafeSourceReader,type SourceTransport} from "../../src/server/research/reader";
import {continuationFromSource,SourceDocumentSchema,type SourceDocument} from "../../src/server/research/ports";
import {isolatedPdfParser,PDF_DOWNLOAD_MAX_BYTES} from "../../src/server/research/pdf-reader";
import {verifyPassage} from "../../src/server/research/repository";
import {pdfFixture} from "./pdf-fixture";

const url="https://papers.example.org/astar.pdf";
const input={url,readerPolicy:"text-pdf-parts-v2" as const};
function network(bytes:Uint8Array,mediaType="application/pdf"):SourceTransport{
  return{resolve:vi.fn(async()=>[{address:"93.184.216.34",family:4 as const}]),
    request:vi.fn(async()=>({status:200,headers:{"content-type":mediaType},bytes}))};
}
function document(result:Awaited<ReturnType<SafeSourceReader["read"]>>):SourceDocument{
  if(result.status!=="success")throw new Error(`Expected a real PDF source, received ${result.status}`);return result.document;
}

describe("actual isolated PDF text reader",()=>{
  it("extracts page-addressed text and verifies exact quotes, without rendering or OCR",async()=>{
    const reader=new SafeSourceReader(network(pdfFixture(["An admissible heuristic never overestimates the true remaining cost.","A star searches using f(n) = g(n) + h(n)."],{title:"Heuristic search"})));
    const saved=document(await reader.read(input,AbortSignal.timeout(20000)));
    expect(saved).toMatchObject({mediaType:"application/pdf",title:"Heuristic search",extractorVersion:"pdfjs-6.4.299-text-v1",extractionState:"complete",
      pdfPart:{totalPages:2,start:{page:1,offset:0},next:null}});
    expect(saved.blocks.map(block=>block.id)).toEqual(["page-1-offset-0","page-2-offset-0"]);
    const block=saved.blocks[0]!,quote="never overestimates",start=block.text.indexOf(quote);
    const passage={id:randomUUID(),sourceId:saved.id,blockId:block.id,start,end:start+quote.length,quote};
    expect(()=>verifyPassage(saved,passage)).not.toThrow();
    expect(()=>verifyPassage(saved,{...passage,quote:"always overestimates"})).toThrow();
    expect(continuationFromSource(saved)).toBeNull();
  },30000);

  it("accepts a normal PDF above the old 2 MiB transport cap while legacy reads remain unchanged",async()=>{
    const transport=network(pdfFixture(["Primary source text remains available."],{paddingBytes:2*1024*1024+1}));
    const reader=new SafeSourceReader(transport);
    expect(await reader.read({url},AbortSignal.timeout(20000))).toMatchObject({status:"too_large"});
    expect(document(await reader.read(input,AbortSignal.timeout(20000))).blocks[0]?.text).toContain("Primary source text");
    expect(transport.request).toHaveBeenLastCalledWith(expect.any(URL),expect.any(Object),expect.any(AbortSignal),{maxBytes:PDF_DOWNLOAD_MAX_BYTES,acceptPdf:true});
  },30000);

  it("continues beyond the source-part text boundary without losing or duplicating page text",async()=>{
    const tokens=Array.from({length:12},(_,page)=>Array.from({length:2500},(_,i)=>`P${String(page).padStart(2,"0")}w${String(i).padStart(4,"0")}`));
    const reader=new SafeSourceReader(network(pdfFixture(tokens.map(page=>page.join(" ")))));
    const parts:SourceDocument[]=[];
    let request:typeof input|NonNullable<ReturnType<typeof continuationFromSource>>=input;
    for(;;){
      const saved=document(await reader.read(request,AbortSignal.timeout(30000)));parts.push(saved);
      const next=continuationFromSource(saved);if(!next)break;
      expect(next.continuation?.rawDigest).toBe(parts[0]!.rawDigest);
      if(parts.length>10)throw new Error("Source continuation failed to advance");
      request=next;
    }
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part=>part.extractionState==="truncated")).toBe(true);
    expect(parts.at(-1)?.pdfPart?.next).toBeNull();
    for(let i=1;i<parts.length;i++)expect(parts[i]!.pdfPart?.start).toEqual({page:parts[i-1]!.pdfPart!.next!.page,offset:parts[i-1]!.pdfPart!.next!.offset});
    const restored=parts.flatMap(part=>part.blocks).map(block=>block.text).join("").match(/P\d\d[w]\d{4}/g);
    expect(restored).toEqual(tokens.flat());
  },60000);

  it("does not apply the isolated PDF memory allowance to main-thread HTML parsing",async()=>{
    const parser={parse:vi.fn(isolatedPdfParser.parse)};
    const bytes=Buffer.from(`<html><body><p>${"x".repeat(2*1024*1024)}</p></body></html>`);
    const reader=new SafeSourceReader(network(bytes,"text/html"),parser);
    expect(await reader.read({...input,url:"https://papers.example.org/article"},AbortSignal.timeout(10000))).toMatchObject({status:"too_large"});
    expect(parser.parse).not.toHaveBeenCalled();
  });

  it("rejects a changed PDF before parsing its continuation and does not invent a completed read",async()=>{
    const bytes=pdfFixture(["x".repeat(210000)]),transport=network(bytes),parser={parse:vi.fn(isolatedPdfParser.parse)};
    const reader=new SafeSourceReader(transport,parser);
    const first=document(await reader.read(input,AbortSignal.timeout(30000))),next=continuationFromSource(first)!;
    expect(next).not.toBeNull();const before=parser.parse.mock.calls.length;
    vi.mocked(transport.request).mockResolvedValue({status:200,headers:{"content-type":"application/pdf"},bytes:pdfFixture(["changed content"])});
    expect(await reader.read(next,AbortSignal.timeout(10000))).toMatchObject({status:"unavailable"});
    expect(parser.parse).toHaveBeenCalledTimes(before);
  },40000);

  it("reports malformed and textless documents without fabricated text",async()=>{
    expect(await new SafeSourceReader(network(Buffer.from("%PDF-1.7\nnot a real document"))).read(input,AbortSignal.timeout(20000))).toMatchObject({status:"unsupported"});
    expect(await new SafeSourceReader(network(pdfFixture([""]))).read(input,AbortSignal.timeout(20000))).toMatchObject({status:"unsupported"});
  },30000);

  it("retains SSRF checks and propagates the enclosing cancellation to an active parser",async()=>{
    const blocked=network(pdfFixture(["not reached"]));vi.mocked(blocked.resolve).mockResolvedValue([{address:"127.0.0.1",family:4}]);
    expect(await new SafeSourceReader(blocked).read(input,AbortSignal.timeout(20000))).toMatchObject({status:"blocked"});
    expect(blocked.request).not.toHaveBeenCalled();
    const abort=new AbortController(),pending=isolatedPdfParser.parse(pdfFixture(["text"]),undefined,abort.signal);
    abort.abort(new Error("outer cancelled"));await expect(pending).rejects.toThrow("outer cancelled");
  });

  it("rejects forged part completeness and cursor identities at the saved-source boundary",async()=>{
    const saved=document(await new SafeSourceReader(network(pdfFixture(["A real page."]))).read(input,AbortSignal.timeout(20000)));
    expect(SourceDocumentSchema.safeParse({...saved,pdfPart:{...saved.pdfPart,start:{page:1,offset:1}}}).success).toBe(false);
    expect(SourceDocumentSchema.safeParse({...saved,pdfPart:{...saved.pdfPart,next:{kind:"pdf-text-v1",rawDigest:"f".repeat(64),extractorVersion:saved.extractorVersion,totalPages:1,page:1,offset:1}}}).success).toBe(false);
  },30000);
});
