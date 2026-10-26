import "server-only";
import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { z } from "zod";
import { SourceBlockSchema, type PdfContinuation } from "./ports";

/** Operational memory admission for the isolated parser, not a document text
 * limit. Text storage is paged independently and can continue to the real end. */
export const PDF_WORKER_HEAP_MIB = 512;
export const PDF_DOWNLOAD_MAX_BYTES = PDF_WORKER_HEAP_MIB * 1024 * 1024 / 8;
const position = z.object({page:z.number().int().positive(),offset:z.number().int().nonnegative()}).strict();
const output = z.object({title:z.string().max(1000).nullable(),blocks:z.array(SourceBlockSchema).min(1).max(512),
  totalPages:z.number().int().positive(),start:position,end:position,next:position.nullable()}).strict();
export type PdfTextPart = z.infer<typeof output>;
export interface PdfPartParser { parse(bytes:Uint8Array,continuation:PdfContinuation|undefined,signal:AbortSignal):Promise<PdfTextPart> }
export class PdfReadFailure extends Error {
  constructor(readonly status:"unsupported"|"unavailable"|"too_large"){super(status);}
}

export const isolatedPdfParser:PdfPartParser={
  async parse(bytes,continuation,signal){
    signal.throwIfAborted();
    if(bytes.byteLength>PDF_DOWNLOAD_MAX_BYTES)throw new PdfReadFailure("too_large");
    // A dedicated transferable buffer avoids detaching a pooled network Buffer.
    const data=Uint8Array.from(bytes);
    const worker=new Worker(resolve(process.cwd(),"src/server/research/pdf-parser.worker.mjs"),{
      workerData:{bytes:data.buffer,...(continuation?{start:{page:continuation.page,offset:continuation.offset},totalPages:continuation.totalPages}:{})},
      transferList:[data.buffer],resourceLimits:{maxOldGenerationSizeMb:PDF_WORKER_HEAP_MIB,maxYoungGenerationSizeMb:32,stackSizeMb:4},
    });
    try{
      return await new Promise<PdfTextPart>((resolvePart,reject)=>{
        let settled=false;
        const finish=(error:unknown,value?:PdfTextPart)=>{
          if(settled)return;settled=true;signal.removeEventListener("abort",abort);
          if(error)reject(error);else resolvePart(value!);
        };
        const abort=()=>{void worker.terminate();finish(signal.reason??new PdfReadFailure("unavailable"));};
        signal.addEventListener("abort",abort,{once:true});
        worker.once("message",message=>{
          const envelope=z.object({ok:z.boolean(),value:output.optional(),reason:z.literal("unsupported").optional()}).safeParse(message);
          if(!envelope.success||!envelope.data.ok||!envelope.data.value)finish(new PdfReadFailure("unsupported"));
          else finish(null,envelope.data.value);
        });
        worker.once("error",()=>finish(new PdfReadFailure("unavailable")));
        worker.once("exit",()=>finish(new PdfReadFailure("unavailable")));
        if(signal.aborted)abort();
      });
    }finally{await worker.terminate();}
  },
};
