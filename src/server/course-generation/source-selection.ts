import "server-only";
import {z} from "zod";
import {IdSchema,type JsonValue} from "@/domain/common";
import type {ApprovedBuildBinding} from "@/server/curricula/build-binding";
import {ProviderFailure} from "@/server/ai/failure";
import type {ModelPort} from "@/server/ai/ports";
import {jsonDigest} from "@/server/ai/json";
import {validateSourceUrl} from "@/server/research/reader";
import {ReaderCapabilitiesSchema,READER_CAPABILITY_INSTRUCTIONS,type ReaderCapabilities} from "@/server/research/reader-capabilities";
import {SourceDocumentSchema,type ResearchPort,type SearchResult} from "@/server/research/ports";
import {PostgresResearchRepository} from "@/server/research/repository";
import type {RunContext,StepEffectContext} from "@/server/runs/ports";
import {SourceReadCheckpointSchema} from "./checkpoints";
import {readableSourceSelectionSchema,SourceSelectionSchema} from "./planning";
import {verifyStoredModelData} from "./repository";
import {checkpointJson,jsonCheckpointSchema,generationDigests,loadStage,modelStage,ModelStageSchema,pureStage,type StageIndex} from "./stages";

export const ReadOutputSchema=z.discriminatedUnion("status",[
  z.object({status:z.literal("success"),document:SourceDocumentSchema}).strict(),
  z.object({status:z.enum(["unavailable","unsupported","blocked","too_large"]),requestedUrl:z.string()}).strict(),
]);
const ReadFailureSchema=z.object({kind:z.literal("course.source.unavailable"),moduleId:IdSchema,requestedUrl:z.string(),reason:z.string()}).strict();
export const ReadCheckpointSchema=z.union([SourceReadCheckpointSchema,ReadFailureSchema]);
const AvailabilityReadSchema=z.object({stepId:IdSchema,searchStepId:IdSchema,hitId:IdSchema,url:z.string().max(4096),
  status:z.enum(["read","unavailable","unsupported","blocked","too_large"]),sourceId:IdSchema.nullable()}).strict();
export const SourceAvailabilityCheckpointSchema=z.object({kind:z.literal("course.source.availability.v1"),moduleId:IdSchema,
  round:z.union([z.literal(0),z.literal(1)]),selectionStepId:IdSchema.nullable(),eligibleCount:z.number().int().nonnegative(),remainingCount:z.number().int().nonnegative(),
  reads:z.array(AvailabilityReadSchema),status:z.enum(["readable","replacement_available","exhausted"])}).strict();
type Search={stepId:string;result:SearchResult};
type Candidate={searchStepId:string;hitId:string;url:string;normalizedUrl:string;title:string;snippet:string;publishedAt:string|null};

/** Eligibility is only a URL-level prefilter. DNS, redirects, actual type and size
 * remain the unchanged SafeSourceReader's responsibility on every real read. */
export function eligibleSourceHits(searches:readonly Search[],includePdf=false):Candidate[]{
  const candidates:Candidate[]=[],seen=new Set<string>();
  for(const search of searches)for(const hit of search.result.hits){
    let url:URL;try{url=validateSourceUrl(hit.url);}catch{continue;}
    let path:string;try{path=decodeURIComponent(url.pathname);}catch{continue;}
    if(!includePdf&&/\.pdf(?:$|\/)/i.test(path))continue;
    const normalizedUrl=url.toString();if(seen.has(normalizedUrl))continue;seen.add(normalizedUrl);
    candidates.push({searchStepId:search.stepId,hitId:hit.id,url:hit.url,normalizedUrl,title:hit.title,snippet:hit.snippet,publishedAt:hit.publishedAt});
  }
  return candidates;
}
export function validateReadableSelection(value:unknown,candidates:readonly Candidate[],moduleId:string,outcomeIds:readonly string[]){
  const selection=readableSourceSelectionSchema(candidates.length).parse(value),pairs=new Set<string>(),urls=new Set<string>();
  if(selection.moduleId!==moduleId)throw new ProviderFailure("invalid_output");
  for(const selected of selection.selections){
    const pair=`${selected.searchStepId}:${selected.hitId}`,candidate=candidates.find(item=>item.searchStepId===selected.searchStepId&&item.hitId===selected.hitId);
    if(!candidate||pairs.has(pair)||urls.has(candidate.normalizedUrl)||selected.outcomeIds.some(id=>!outcomeIds.includes(id)))throw new ProviderFailure("invalid_output");
    pairs.add(pair);urls.add(candidate.normalizedUrl);
  }
  if(outcomeIds.some(id=>!selection.selections.some(item=>item.outcomeIds.includes(id))))throw new ProviderFailure("invalid_output");
  return selection;
}

/** Exactly one initial selection and, only after all its reads fail, one
 * replacement from remaining paid hits. Each advance commits at most one step. */
export async function advanceReadableSources(input:{context:RunContext;binding:ApprovedBuildBinding;index:StageIndex;prefix:string;moduleId:string;
  searches:readonly Search[];model:ModelPort;research:(effect:StepEffectContext)=>ResearchPort;readerCapabilities:ReaderCapabilities;
  repair?:JsonValue}){
  const {context,binding,index,moduleId}=input,capabilities=ReaderCapabilitiesSchema.parse(input.readerCapabilities);
  const outcomes=binding.draft.outcomes.filter(outcome=>binding.draft.modules.find(module=>module.id===moduleId)!.outcomeIds.includes(outcome.id));
  const all=eligibleSourceHits(input.searches),failedUrls=new Set<string>(),failures:Array<z.infer<typeof AvailabilityReadSchema>>=[];
  const selections:Array<z.infer<typeof SourceSelectionSchema>>=[],sources=new PostgresResearchRepository();
  for(const round of [0,1] as const){
    const candidates=all.filter(candidate=>!failedUrls.has(candidate.normalizedUrl)),key=`${input.prefix}/source-selection-v1/round/${round}`;
    const reads:Array<z.infer<typeof AvailabilityReadSchema>>=[];
    let selectionStepId:string|null=null;
    if(candidates.length){
      const material={moduleId,outcomes,readerCapabilities:capabilities,candidates,readFailures:failures,...(input.repair?{repair:input.repair}:{})};
      const selected=await loadStage(context,binding,index,`${key}/selection`,ModelStageSchema);
      if(!selected){
        await modelStage({context,binding,model:input.model,key:`${key}/selection`,purpose:"module_knowledge",schema:readableSourceSelectionSchema(candidates.length),material,
          instructions:`Select the strongest set of actual candidate search hits needed to cover the approved scope. Cite exact searchStepId/hitId pairs from candidates. Cover every full approved outcome with authoritative sources and preserve its depth. Snippets are discovery only, never read evidence. Do not repeat URLs or choose failed/excluded sources. Record limitations honestly. ${READER_CAPABILITY_INSTRUCTIONS}`});
        return null;
      }
      if(selected.inputDigest!==jsonDigest(material))throw new ProviderFailure("invalid_output");
      const selection=validateReadableSelection(selected.result.data,candidates,moduleId,outcomes.map(outcome=>outcome.id));
      await context.read(tx=>verifyStoredModelData(tx,selected,selected.result.operationId,readableSourceSelectionSchema(candidates.length),selection));
      selectionStepId=selected.id;selections.push(selection);
      for(const item of selection.selections){
        const candidate=candidates.find(value=>value.searchStepId===item.searchStepId&&value.hitId===item.hitId)!;
        const readKey=`${input.prefix}/read/${item.hitId}`,read=await loadStage(context,binding,index,readKey,ReadCheckpointSchema);
        if(!read){
          await context.step({key:readKey,input:{url:candidate.url},digests:generationDigests(binding),outputSchema:jsonCheckpointSchema(ReadOutputSchema),resultSchema:jsonCheckpointSchema(ReadCheckpointSchema),
            async effect(effect,request){return checkpointJson(await input.research(effect).read(request,effect.signal));},
            async commit(tx,value){const output=ReadOutputSchema.parse(value);
              if(output.status!=="success")return{kind:"course.source.unavailable" as const,moduleId,requestedUrl:output.requestedUrl,reason:output.status};
              const source=await sources.saveSource(tx,output.document);
              return{kind:"course.source.read" as const,moduleId,approvalDigest:binding.approval.contentDigest,sourceId:source.id,contentDigest:source.contentDigest};
            }});
          return null;
        }
        if(read.inputDigest!==jsonDigest({url:candidate.url})||read.result.moduleId!==moduleId)throw new ProviderFailure("invalid_output");
        if(read.result.kind==="course.source.read"){
          const source=await context.read(tx=>sources.getSource(tx,read.result.kind==="course.source.read"?read.result.sourceId:""));
          if(read.result.approvalDigest!==binding.approval.contentDigest||!source||source.contentDigest!==read.result.contentDigest||validateSourceUrl(source.requestedUrl).toString()!==candidate.normalizedUrl)throw new ProviderFailure("invalid_output");
          reads.push({stepId:read.id,searchStepId:item.searchStepId,hitId:item.hitId,url:candidate.url,status:"read",sourceId:source.id});
        }else{
          if(validateSourceUrl(read.result.requestedUrl).toString()!==candidate.normalizedUrl)throw new ProviderFailure("invalid_output");
          const failure=AvailabilityReadSchema.parse({stepId:read.id,searchStepId:item.searchStepId,hitId:item.hitId,url:candidate.url,status:read.result.reason,sourceId:null});
          reads.push(failure);failedUrls.add(candidate.normalizedUrl);
        }
      }
    }
    const remaining=all.filter(candidate=>!failedUrls.has(candidate.normalizedUrl)).length;
    const result=SourceAvailabilityCheckpointSchema.parse({kind:"course.source.availability.v1",moduleId,round,selectionStepId,eligibleCount:candidates.length,remainingCount:remaining,reads,
      status:reads.some(read=>read.status==="read")?"readable":round===0&&remaining>0?"replacement_available":"exhausted"});
    const material={selectionStepId,readStepIds:reads.map(read=>read.stepId),candidatesDigest:jsonDigest(candidates),readerCapabilities:capabilities};
    const saved=await loadStage(context,binding,index,`${key}/availability`,SourceAvailabilityCheckpointSchema);
    if(!saved){await pureStage({context,binding,key:`${key}/availability`,material,schema:SourceAvailabilityCheckpointSchema,async commit(){return result;}});return null;}
    if(saved.inputDigest!==jsonDigest(material)||jsonDigest(saved.result)!==jsonDigest(result))throw new ProviderFailure("invalid_output");
    if(result.status==="readable")return{moduleId,selections:selections.flatMap(selection=>selection.selections),limitations:selections.flatMap(selection=>selection.limitations)};
    if(result.status==="exhausted")throw new ProviderFailure("unavailable");
    failures.push(...reads);
  }
  throw new ProviderFailure("unavailable");
}
