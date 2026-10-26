import "server-only";
import {z} from "zod";
import {IdSchema,type JsonValue} from "@/domain/common";
import {jsonDigest} from "@/server/ai/json";
import {ProviderFailure} from "@/server/ai/failure";
import type {ModelPort} from "@/server/ai/ports";
import type {ApprovedBuildBinding} from "@/server/curricula/build-binding";
import {continuationFromSource,SourceReadInputSchema,type ResearchPort,type SourceReadInput} from "@/server/research/ports";
import {ReaderCapabilitiesSchema,readerCapabilityInstructions,type ReaderCapabilities} from "@/server/research/reader-capabilities";
import {PostgresResearchRepository} from "@/server/research/repository";
import {validateSourceUrl} from "@/server/research/reader";
import type {RunContext,StepEffectContext} from "@/server/runs/ports";
import {readableSourceSelectionSchema,SourceSelectionSchema} from "./planning";
import {verifyStoredModelData} from "./repository";
import {checkpointJson,jsonCheckpointSchema,generationDigests,loadStage,modelStage,ModelStageSchema,pureStage,type StageIndex} from "./stages";
import {eligibleSourceHits,ReadCheckpointSchema,ReadOutputSchema,validateReadableSelection} from "./source-selection";
import {validateSourceReadPart,type SourceReadEvidence} from "./source-read-chain";

const PartAvailabilitySchema=z.object({stepId:IdSchema,sourceId:IdSchema.nullable(),
  status:z.enum(["read","unavailable","unsupported","blocked","too_large"])}).strict();
const ChainAvailabilitySchema=z.object({searchStepId:IdSchema,hitId:IdSchema,url:z.string().max(4096),
  parts:z.array(PartAvailabilitySchema).min(1),complete:z.boolean()}).strict();
export const SourcePartsAvailabilityCheckpointSchema=z.object({kind:z.literal("course.source.availability.v2"),moduleId:IdSchema,
  round:z.union([z.literal(0),z.literal(1)]),selectionStepId:IdSchema.nullable(),eligibleCount:z.number().int().nonnegative(),remainingCount:z.number().int().nonnegative(),
  chains:z.array(ChainAvailabilitySchema),status:z.enum(["readable","replacement_available","exhausted"])}).strict();
export type SelectedReadPart={searchStepId:string;hitId:string;readKey:string;claimsKey:string};

/** One durable effect per advance, with no total PDF-part cap. Only chains ending
 * in the saved reader's explicit null continuation can supply teaching evidence. */
export async function advanceReadableSourceParts(input:{context:RunContext;binding:ApprovedBuildBinding;index:StageIndex;prefix:string;moduleId:string;
  searches:Parameters<typeof eligibleSourceHits>[0];model:ModelPort;research:(effect:StepEffectContext)=>ResearchPort;
  readerCapabilities:ReaderCapabilities;repair?:JsonValue}){
  const {context,binding,index,moduleId}=input,capabilities=ReaderCapabilitiesSchema.parse(input.readerCapabilities);
  if(capabilities.version!=="text-pdf-parts-v2")throw new ProviderFailure("invalid_output");
  const outcomes=binding.draft.outcomes.filter(outcome=>binding.draft.modules.find(module=>module.id===moduleId)!.outcomeIds.includes(outcome.id));
  const all=eligibleSourceHits(input.searches,true),failedUrls=new Set<string>(),failures:Array<z.infer<typeof ChainAvailabilitySchema>>=[];
  const selections:Array<z.infer<typeof SourceSelectionSchema>>=[],completedParts:SelectedReadPart[]=[],sources=new PostgresResearchRepository();
  for(const round of [0,1] as const){
    const candidates=all.filter(candidate=>!failedUrls.has(candidate.normalizedUrl)),key=`${input.prefix}/source-selection-v2/round/${round}`;
    const chains:Array<z.infer<typeof ChainAvailabilitySchema>>=[];
    let selectionStepId:string|null=null;
    if(candidates.length){
      const material={moduleId,outcomes,readerCapabilities:capabilities,candidates,readFailures:failures,...(input.repair?{repair:input.repair}:{})};
      const selected=await loadStage(context,binding,index,`${key}/selection`,ModelStageSchema);
      if(!selected){
        await modelStage({context,binding,model:input.model,key:`${key}/selection`,purpose:"module_knowledge",schema:readableSourceSelectionSchema(candidates.length),material,
          instructions:`Select actual candidate search hits that together cover the full approved outcomes and depth. Cite exact searchStepId/hitId pairs. Prefer focused primary-source pages or papers over a whole large manual when they provide the needed substantive treatment; avoid redundant coverage without imposing a fixed source count or reducing scope. Snippets and landing pages are discovery only, never evidence that their linked contents were read. Do not repeat URLs or choose failed sources. Record limitations honestly. ${readerCapabilityInstructions(capabilities)}`});
        return null;
      }
      if(selected.inputDigest!==jsonDigest(material))throw new ProviderFailure("invalid_output");
      const selection=validateReadableSelection(selected.result.data,candidates,moduleId,outcomes.map(outcome=>outcome.id));
      await context.read(tx=>verifyStoredModelData(tx,selected,selected.result.operationId,readableSourceSelectionSchema(candidates.length),selection));
      selectionStepId=selected.id;selections.push(selection);
      for(const item of selection.selections){
        const candidate=candidates.find(value=>value.searchStepId===item.searchStepId&&value.hitId===item.hitId)!;
        const parts:Array<z.infer<typeof PartAvailabilitySchema>>=[],targets:SelectedReadPart[]=[];
        let request:SourceReadInput={url:candidate.url,readerPolicy:"text-pdf-parts-v2"},previous:SourceReadEvidence|undefined,partIndex=0,complete=false;
        for(;;partIndex++){
          const readKey=`${input.prefix}/source-selection-v2/read/${item.hitId}/part/${partIndex}`;
          const read=await loadStage(context,binding,index,readKey,ReadCheckpointSchema);
          if(!read){
            const readProof={version:"source-read-parts-v2" as const,input:request,previousReadStepId:previous?.id??null};
            await context.step({key:readKey,input:checkpointJson(request),digests:generationDigests(binding),outputSchema:jsonCheckpointSchema(ReadOutputSchema),resultSchema:jsonCheckpointSchema(ReadCheckpointSchema),
              async effect(effect,readInput){return checkpointJson(await input.research(effect).read(SourceReadInputSchema.parse(readInput),effect.signal));},
              async commit(tx,value){const output=ReadOutputSchema.parse(value);
                if(output.status!=="success")return{kind:"course.source.unavailable" as const,moduleId,requestedUrl:output.requestedUrl,reason:output.status};
                const source=await sources.saveSource(tx,output.document);
                const result={kind:"course.source.read" as const,moduleId,approvalDigest:binding.approval.contentDigest,sourceId:source.id,contentDigest:source.contentDigest,readProof};
                validateSourceReadPart({id:"pending",inputDigest:jsonDigest(request),result,source},previous);
                return checkpointJson(result);
              }});
            return null;
          }
          if(read.inputDigest!==jsonDigest(request)||read.result.moduleId!==moduleId)throw new ProviderFailure("invalid_output");
          if(read.result.kind!=="course.source.read"){
            if(validateSourceUrl(read.result.requestedUrl).toString()!==candidate.normalizedUrl)throw new ProviderFailure("invalid_output");
            parts.push(PartAvailabilitySchema.parse({stepId:read.id,sourceId:null,status:read.result.reason}));failedUrls.add(candidate.normalizedUrl);break;
          }
          const sourceId=read.result.sourceId,source=await context.read(tx=>sources.getSource(tx,sourceId));
          if(!source||read.result.approvalDigest!==binding.approval.contentDigest)throw new ProviderFailure("invalid_output");
          const evidence:SourceReadEvidence={id:read.id,inputDigest:read.inputDigest,result:read.result,source};
          validateSourceReadPart(evidence,previous);
          parts.push({stepId:read.id,sourceId:source.id,status:"read"});
          targets.push({searchStepId:item.searchStepId,hitId:item.hitId,readKey,claimsKey:`${input.prefix}/source-selection-v2/claims/${item.hitId}/part/${partIndex}`});
          const next=continuationFromSource(source);if(!next){complete=true;completedParts.push(...targets);break;}
          previous=evidence;request=next;
        }
        chains.push({searchStepId:item.searchStepId,hitId:item.hitId,url:candidate.url,parts,complete});
      }
    }
    const remaining=all.filter(candidate=>!failedUrls.has(candidate.normalizedUrl)).length;
    const result=SourcePartsAvailabilityCheckpointSchema.parse({kind:"course.source.availability.v2",moduleId,round,selectionStepId,eligibleCount:candidates.length,remainingCount:remaining,chains,
      status:chains.some(chain=>chain.complete)?"readable":round===0&&remaining>0?"replacement_available":"exhausted"});
    const material={selectionStepId,readStepIds:chains.flatMap(chain=>chain.parts.map(part=>part.stepId)),candidatesDigest:jsonDigest(candidates),readerCapabilities:capabilities};
    const saved=await loadStage(context,binding,index,`${key}/availability`,SourcePartsAvailabilityCheckpointSchema);
    if(!saved){await pureStage({context,binding,key:`${key}/availability`,material,schema:SourcePartsAvailabilityCheckpointSchema,async commit(){return result;}});return null;}
    if(saved.inputDigest!==jsonDigest(material)||jsonDigest(saved.result)!==jsonDigest(result))throw new ProviderFailure("invalid_output");
    if(result.status==="readable")return{moduleId,selections:selections.flatMap(selection=>selection.selections),limitations:selections.flatMap(selection=>selection.limitations),readParts:completedParts};
    if(result.status==="exhausted")throw new ProviderFailure("unavailable");
    failures.push(...chains);
  }
  throw new ProviderFailure("unavailable");
}
