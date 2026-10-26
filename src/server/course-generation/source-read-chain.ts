import "server-only";
import type {z} from "zod";
import {jsonDigest} from "@/server/ai/json";
import {ProviderFailure} from "@/server/ai/failure";
import {continuationFromSource,SourceDocumentSchema,type SourceDocument} from "@/server/research/ports";
import {validateSourceUrl} from "@/server/research/reader";
import type {SourceReadCheckpointSchema} from "./checkpoints";

export type SourceReadEvidence={id:string;inputDigest:string;result:z.infer<typeof SourceReadCheckpointSchema>;source:SourceDocument};
const invalid=():never=>{throw new ProviderFailure("invalid_output");};

/** Validate one durable part before it can authorize the next external read. */
export function validateSourceReadPart(read:SourceReadEvidence,previous?:SourceReadEvidence){
  const source=SourceDocumentSchema.parse(read.source),proof=read.result.readProof;
  if(!proof||proof.input.readerPolicy!=="text-pdf-parts-v2"||read.inputDigest!==jsonDigest(proof.input)||
    source.id!==read.result.sourceId||source.contentDigest!==read.result.contentDigest||jsonDigest(source.blocks,2*1024*1024)!==source.contentDigest||
    validateSourceUrl(proof.input.url).toString()!==validateSourceUrl(source.requestedUrl).toString())return invalid();
  if(previous){
    const next=continuationFromSource(previous.source);
    if(proof.previousReadStepId!==previous.id||!next||jsonDigest(next)!==jsonDigest(proof.input)||
      source.rawDigest!==previous.source.rawDigest||source.extractorVersion!==previous.source.extractorVersion||
      !source.pdfPart||source.pdfPart.totalPages!==previous.source.pdfPart?.totalPages||
      source.pdfPart.start.page!==next.continuation?.page||source.pdfPart.start.offset!==next.continuation?.offset)return invalid();
  }else if(proof.previousReadStepId!==null||proof.input.continuation||
    (source.pdfPart&&(source.pdfPart.start.page!==1||source.pdfPart.start.offset!==0)))return invalid();
  return source;
}

/** A knowledge checkpoint must retain every part of each successful PDF chain.
 * Local checks alone cannot prove completion: each saved `next` needs exactly one
 * saved child, and only an explicit null next ends the chain. */
export function validateCompleteSourceReadChains(reads:readonly SourceReadEvidence[]){
  const byId=new Map(reads.map(read=>[read.id,read]));
  if(byId.size!==reads.length)return invalid();
  const children=new Map<string,SourceReadEvidence[]>(),roots:SourceReadEvidence[]=[];
  for(const read of reads){
    if(!read.result.readProof){if(read.source.pdfPart)return invalid();continue;}
    const previous=read.result.readProof.previousReadStepId;
    if(previous===null)roots.push(read);
    else{if(!byId.has(previous)||!byId.get(previous)!.result.readProof)return invalid();children.set(previous,[...(children.get(previous)??[]),read]);}
  }
  const visited=new Set<string>();
  for(const root of roots){
    let read:SourceReadEvidence|undefined=root,previous:SourceReadEvidence|undefined;
    while(read){
      if(visited.has(read.id))return invalid();visited.add(read.id);validateSourceReadPart(read,previous);
      const next=continuationFromSource(read.source),following:SourceReadEvidence[]=children.get(read.id)??[];
      if(next?following.length!==1:following.length!==0)return invalid();
      previous=read;read=following[0];
    }
  }
  if(visited.size!==reads.filter(read=>read.result.readProof).length)return invalid();
}
