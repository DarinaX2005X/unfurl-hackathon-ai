import {afterEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import type {JsonValue} from "@/domain/common";
import {jsonDigest} from "@/server/ai/json";
import type {ModelPort,StructuredRequest} from "@/server/ai/ports";
import type {ApprovedBuildBinding} from "@/server/curricula/build-binding";
import type {DbTransaction} from "@/server/db";
import {PostgresCurriculumResearchRepository} from "@/server/curriculum-research/repository";
import {currentReaderCapabilities} from "@/server/research/reader-capabilities";
import {continuationFromSource,PDF_EXTRACTOR_VERSION,SourceDocumentSchema,type Passage,type SourceDocument,type SourceReadInput,type SourceReadResult,type SearchResult} from "@/server/research/ports";
import {PostgresResearchRepository,verifyPassage} from "@/server/research/repository";
import {stableExecutionId} from "@/server/runs/identity";
import type {RunContext,StepEffectContext} from "@/server/runs/ports";
import {advanceModuleResearch} from "@/server/course-generation/research-stages";
import {ModuleKnowledgeCheckpointSchema,SourceReadCheckpointSchema,SourceClaimsCheckpointSchema,CourseGenerationPolicyCheckpointSchema,
  COURSE_GENERATION_SCHEMA_DIGEST,COURSE_VALIDATION_POLICY_DIGEST,COURSE_GENERATION_V2_SCHEMA_DIGEST,COURSE_VALIDATION_V2_POLICY_DIGEST} from "@/server/course-generation/checkpoints";
import {getCapabilityCatalogDigest} from "@/server/mechanics/catalog";
import {advanceReadableSourceParts,SourcePartsAvailabilityCheckpointSchema} from "@/server/course-generation/source-selection-parts";
import {eligibleSourceHits} from "@/server/course-generation/source-selection";
import {validateCompleteSourceReadChains,validateSourceReadPart,type SourceReadEvidence} from "@/server/course-generation/source-read-chain";
import * as repository from "@/server/course-generation/repository";
import * as stages from "@/server/course-generation/stages";
import {fixture,id,digest,now} from "./fixtures";

afterEach(()=>vi.restoreAllMocks());
const pdfUrl="https://example.edu/full-paper.pdf";
function pdfSource(part:number,total:number,url=pdfUrl):SourceDocument{
  const text=`Page ${part+1}: An affine function has a fixed slope and intercept; distinct input observations determine them.`,blocks=[{id:`page-${part+1}-offset-0`,text}];
  return SourceDocumentSchema.parse({id:id(2000+part),requestedUrl:url,finalUrl:url,title:"Primary paper",retrievedAt:now,publishedAt:null,
    mediaType:"application/pdf",rawDigest:digest,extractorVersion:PDF_EXTRACTOR_VERSION,contentDigest:jsonDigest(blocks),blocks,
    extractionState:total===1?"complete":"truncated",pdfPart:{kind:"pdf-text-v1",totalPages:total,start:{page:part+1,offset:0},end:{page:part+1,offset:text.length},
      next:part+1<total?{kind:"pdf-text-v1",rawDigest:digest,extractorVersion:PDF_EXTRACTOR_VERSION,totalPages:total,page:part+2,offset:0}:null}});
}
function evidenceChain(total=3):SourceReadEvidence[]{
  const data=fixture(),reads:SourceReadEvidence[]=[];
  for(let part=0;part<total;part++){
    const source=pdfSource(part,total),input=part?continuationFromSource(reads[part-1]!.source)!:{url:pdfUrl,readerPolicy:"text-pdf-parts-v2" as const};
    reads.push({id:id(2100+part),inputDigest:jsonDigest(input),source,result:{kind:"course.source.read",moduleId:data.draft.modules[0]!.id,approvalDigest:digest,
      sourceId:source.id,contentDigest:source.contentDigest,readProof:{version:"source-read-parts-v2",input,previousReadStepId:part?reads[part-1]!.id:null}}});
  }
  return reads;
}

describe("saved PDF chain authority",()=>{
  it("accepts the whole immutable chain and a one-part complete PDF",()=>{
    expect(()=>validateCompleteSourceReadChains(evidenceChain())).not.toThrow();expect(()=>validateCompleteSourceReadChains(evidenceChain(1))).not.toThrow();
  });
  it.each(["missing-first","missing-middle","missing-final","duplicate","raw-digest","cursor","input-digest","source-id","parent","cycle","proof-stripped"])("rejects %s evidence",kind=>{
    const reads=evidenceChain();
    if(kind==="missing-first")reads.shift();if(kind==="missing-middle")reads.splice(1,1);if(kind==="missing-final")reads.pop();if(kind==="duplicate")reads.push(reads[1]!);
    if(kind==="raw-digest"){reads[2]!.source.rawDigest="b".repeat(64);}
    if(kind==="cursor")reads[1]!.source.pdfPart!.start.offset=1;
    if(kind==="input-digest")reads[1]!.inputDigest="0".repeat(64);
    if(kind==="source-id")reads[1]!.result.sourceId=id(9999);
    if(kind==="parent")reads[2]!.result.readProof!.previousReadStepId=id(9999);
    if(kind==="cycle")reads[0]!.result.readProof!.previousReadStepId=reads[2]!.id;
    if(kind==="proof-stripped")delete reads[0]!.result.readProof;
    expect(()=>validateCompleteSourceReadChains(reads)).toThrow();
  });
  it("rejects a second child and a continuation after the saved final part",()=>{
    const reads=evidenceChain(),duplicate=structuredClone(reads[1]!);duplicate.id=id(2222);reads.push(duplicate);
    expect(()=>validateCompleteSourceReadChains(reads)).toThrow();
    const complete=evidenceChain(1),extra=structuredClone(complete[0]!);extra.id=id(2223);extra.result.readProof!.previousReadStepId=complete[0]!.id;
    expect(()=>validateCompleteSourceReadChains([...complete,extra])).toThrow();
  });
  it("normalizes only source URL comparison while preserving the exact first request digest",()=>{
    const read=evidenceChain(1)[0]!;read.result.readProof!.input.url=pdfUrl+"#chapter";read.inputDigest=jsonDigest(read.result.readProof!.input);
    expect(()=>validateSourceReadPart(read)).not.toThrow();read.inputDigest=jsonDigest({url:pdfUrl,readerPolicy:"text-pdf-parts-v2"});
    expect(()=>validateSourceReadPart(read)).toThrow();
  });
  it("requires matching captured versions and leaves historical checkpoint shapes valid",()=>{
    const base={kind:"course.generation.policy",version:"course-generation-batch-v2",batchSize:5,maxOutputTokens:16384,approvalDigest:digest};
    expect(CourseGenerationPolicyCheckpointSchema.safeParse(base).success).toBe(true);
    expect(CourseGenerationPolicyCheckpointSchema.safeParse({...base,sourceSelectionPolicy:"source-selection-v2",readerCapabilities:currentReaderCapabilities()}).success).toBe(true);
    expect(CourseGenerationPolicyCheckpointSchema.safeParse({...base,sourceSelectionPolicy:"source-selection-v1",readerCapabilities:currentReaderCapabilities()}).success).toBe(false);
    const read=evidenceChain(1)[0]!.result,{readProof:_proof,...legacy}=read;void _proof;
    expect(SourceReadCheckpointSchema.parse(legacy)).toEqual(legacy);
  });
  it("binds a new read proof to its own captured policy and rejects stripped proofs",async()=>{
    const read=evidenceChain(1)[0]!,data=fixture(),binding={run:{id:id(2300)},course:{id:data.draft.courseId,ownerId:data.context.ownerId},
      approval:{id:id(2301),draftRevision:1,contentDigest:digest}} as ApprovedBuildBinding;
    const policy={kind:"course.generation.policy",version:"course-generation-batch-v2",batchSize:5,maxOutputTokens:16384,approvalDigest:digest,
      sourceSelectionPolicy:"source-selection-v2",readerCapabilities:currentReaderCapabilities()};
    const row={id:read.id,input_digest:read.inputDigest,result_reference:structuredClone(read.result),schema_digest:COURSE_GENERATION_V2_SCHEMA_DIGEST,
      validation_policy_digest:COURSE_VALIDATION_V2_POLICY_DIGEST,capability_digest:getCapabilityCatalogDigest(),approval_digest:digest,
      generation_policy:{result:policy,schema:COURSE_GENERATION_SCHEMA_DIGEST,validationPolicy:COURSE_VALIDATION_POLICY_DIGEST,capability:getCapabilityCatalogDigest(),approval:digest}};
    const tx={query:async()=>({rows:[row]})} as unknown as DbTransaction;
    await expect(repository.loadGenerationStep(tx,binding,read.id,SourceReadCheckpointSchema)).resolves.toMatchObject({result:read.result});
    delete row.result_reference.readProof;await expect(repository.loadGenerationStep(tx,binding,read.id,SourceReadCheckpointSchema)).rejects.toThrow("provider.invalid_output");
    row.result_reference=structuredClone(read.result);row.generation_policy.result={...policy,sourceSelectionPolicy:"source-selection-v1"};
    await expect(repository.loadGenerationStep(tx,binding,read.id,SourceReadCheckpointSchema)).rejects.toThrow("provider.invalid_output");
    row.schema_digest=COURSE_GENERATION_SCHEMA_DIGEST;row.validation_policy_digest=COURSE_VALIDATION_POLICY_DIGEST;
    await expect(repository.loadGenerationStep(tx,binding,read.id,SourceReadCheckpointSchema)).rejects.toThrow("provider.invalid_output");
  });
});

type Candidate=ReturnType<typeof eligibleSourceHits>[number];
function harness(options:{parts?:number;failPart?:number;fallback?:boolean}={}){
  const data=fixture(),moduleId=data.draft.modules[0]!.id,prefix=`course/${moduleId}/research`,total=options.parts??3;
  const binding={run:{id:id(2300),phase:"module_research"},course:{id:data.draft.courseId,ownerId:data.context.ownerId},approval:{id:id(2301),draftRevision:1,contentDigest:digest},draft:data.draft,
    facts:{...data.context,sources:[],claims:[],passages:[],authorizedSourceIds:new Set<string>()}} as unknown as ApprovedBuildBinding;
  const result:SearchResult={id:id(2302),operationId:id(2303),provider:"openrouter:parallel",providerRequestId:"synthetic-search",requestedQuery:"affine proof",executedQuery:null,
    contentLanguage:"en",retrievedAt:now,requestDigest:digest,limitations:["snippets_are_not_read_sources"],hits:[{id:id(2304),url:pdfUrl,title:"Primary paper",snippet:"Discovery only",publishedAt:null},
      ...(options.fallback?[{id:id(2305),url:"https://example.edu/theorem.html",title:"Primary theorem",snippet:"Discovery only",publishedAt:null}]:[])]};
  const searches=[{stepId:id(2306),result}],stored=new Map<string,repository.StoredGenerationStep<JsonValue>>(),documents=new Map<string,SourceDocument>();
  const providerData=new Map<string,unknown>(),requests:StructuredRequest<unknown>[]=[],writes:string[]=[],savedPassages:Passage[]=[];
  vi.spyOn(stages,"loadStage").mockImplementation(async(_context,_binding,_index,key,schema)=>{
    const row=stored.get(key);return row?{...row,result:schema.parse(row.result)}:null;
  });
  vi.spyOn(repository,"verifyStoredModelData").mockImplementation(async(_tx,_step,operationId,_schema,expected)=>{expect(providerData.get(operationId)).toEqual(expected);});
  vi.spyOn(PostgresResearchRepository.prototype,"saveSource").mockImplementation(async(_tx,source)=>{documents.set(source.id,source);return source;});
  vi.spyOn(PostgresResearchRepository.prototype,"getSource").mockImplementation(async(_tx,sourceId)=>documents.get(sourceId)??null);
  vi.spyOn(PostgresResearchRepository.prototype,"getSources").mockImplementation(async(_tx,sourceIds)=>sourceIds.map(sourceId=>documents.get(sourceId)!));
  vi.spyOn(PostgresResearchRepository.prototype,"savePassage").mockImplementation(async(_tx,passage)=>{verifyPassage(documents.get(passage.sourceId)!,passage);savedPassages.push(passage);return passage;});
  vi.spyOn(PostgresCurriculumResearchRepository.prototype,"saveClaim").mockImplementation(async(_tx,claim,allowed)=>{expect(allowed).toEqual(new Set([savedPassages.find(p=>claim.passageIds.includes(p.id))!.sourceId]));return claim;});
  const read=vi.fn(async(request:SourceReadInput):Promise<SourceReadResult>=>{
    const part=(request.continuation?.page??1)-1;
    if(request.url===pdfUrl){if(part===options.failPart)return{status:"unsupported",requestedUrl:request.url};return{status:"success",document:pdfSource(part,total)};}
    const source={...data.source,id:id(2390),requestedUrl:request.url,finalUrl:request.url};return{status:"success",document:source};
  });
  const search=vi.fn(async()=>{throw new Error("No additional searches allowed");}),research=()=>({read,search});
  const model={generateStructured:vi.fn(async(request:StructuredRequest<unknown>)=>{
    requests.push(request);const material=request.untrustedInput as {candidates?:Candidate[];document?:SourceDocument;claims?:{id:string}[]};let output:unknown;
    if(material.candidates){const candidate=material.candidates[0]!;output={moduleId,selections:[{searchStepId:candidate.searchStepId,hitId:candidate.hitId,outcomeIds:data.draft.modules[0]!.outcomeIds,reason:"Focused primary treatment"}],limitations:[]};}
    else if(material.document){
      const document=material.document,index=document.pdfPart!.start.page,block=document.blocks[0]!,passageId=id(2400+index);
      output={passages:[{id:passageId,sourceId:document.id,blockId:block.id,start:0,end:block.text.length,quote:block.text}],
        claims:[{id:id(2500+index),text:block.text,passageIds:[passageId],outcomeIds:data.draft.modules[0]!.outcomeIds,scope:{subject:"Affine functions",version:null},support:"direct",unresolvedConflicts:[]}]};
    }else{const known=structuredClone(data.knowledge[0]!);for(const item of [...known.outcomes[0]!.concepts,...known.outcomes[0]!.misconceptions])item.claimIds=material.claims!.map(claim=>claim.id);output=known;}
    const parsed=request.schema.parse(output);providerData.set(request.budget.reservationId,parsed);return{data:parsed};
  })} as unknown as ModelPort;
  const tx={} as DbTransaction,context={claim:{jobId:id(2310)},read:async<T>(work:(tx:DbTransaction)=>Promise<T>)=>work(tx),
    async step(spec:Parameters<RunContext["step"]>[0]){
      const stepId=stableExecutionId(id(2310),spec.key),effect={stepId,deadlineAt:Date.now()+60000,signal:new AbortController().signal,
        budgetOperation:(name:string)=>{const logicalOperationId=stableExecutionId(stepId,name);return{logicalOperationId,reservationId:stableExecutionId(logicalOperationId,"attempt:1"),attempt:1,runStepId:stepId,probe:false};}} as StepEffectContext;
      const output=spec.outputSchema.parse(await spec.effect(effect,spec.input)),checkpoint=spec.resultSchema.parse(await spec.commit(tx,output));
      stored.set(spec.key,{id:stepId,inputDigest:jsonDigest(spec.input),result:checkpoint});writes.push(spec.key);return checkpoint;
    }} as unknown as RunContext;
  const args={context,binding,index:new Map(),prefix,moduleId,searches,model,research,readerCapabilities:currentReaderCapabilities()};
  const advance=()=>advanceReadableSourceParts(args),complete=async()=>{for(let count=0;count<total+10;count++){const result=await advance();if(result)return result;}throw new Error("Source loop did not finish");};
  const advanceResearch=()=>advanceModuleResearch({...args,priorKnowledge:[],sourceSelectionPolicy:"source-selection-v2"});
  stored.set(`${prefix}/plan`,{id:id(2311),inputDigest:digest,result:{kind:"course.model",operationId:id(2312),data:{moduleId,queries:[{key:"primary",query:"affine proof",domainHints:[],outcomeIds:data.draft.modules[0]!.outcomeIds,knowledgeGap:"Full proof"}]}}});
  stored.set(`${prefix}/search/primary`,{id:searches[0]!.stepId,inputDigest:digest,result});
  return{advance,complete,advanceResearch,stored,documents,requests,writes,read,search,prefix,savedPassages};
}

describe("durable PDF research parts",()=>{
  it("admits actual PDFs in v2 while retaining the v1 filter",()=>{
    const h=harness();expect(h).toBeDefined();
    const search={stepId:id(2306),result:{hits:[{id:id(2304),url:pdfUrl,title:"Paper",snippet:"Discovery",publishedAt:null}]} as SearchResult};
    expect(eligibleSourceHits([search])).toHaveLength(0);expect(eligibleSourceHits([search],true)).toHaveLength(1);
  });
  it("reads every actual part before availability and reuses the entire chain after resume",async()=>{
    const h=harness({parts:7});const result=await h.complete();
    expect(h.read).toHaveBeenCalledTimes(7);expect(result.readParts).toHaveLength(7);expect(h.requests).toHaveLength(1);expect(h.search).not.toHaveBeenCalled();
    expect(h.requests[0]!.trustedInstructions).toContain("focused primary-source pages or papers");
    h.read.mock.calls.forEach(([input],index)=>expect(input).toEqual(index?continuationFromSource(pdfSource(index-1,7)):{url:pdfUrl,readerPolicy:"text-pdf-parts-v2"}));
    const before=h.writes.length;expect(await h.advance()).toEqual(result);expect(h.writes).toHaveLength(before);expect(h.read).toHaveBeenCalledTimes(7);
  });
  it("performs at most one durable effect per advance",async()=>{
    const h=harness();for(let i=0;i<5;i++){const before=h.writes.length;expect(await h.advance()).toBeNull();expect(h.writes.length-before).toBe(1);}
    expect((await h.advance())?.readParts).toHaveLength(3);
  });
  it("discards a partial failed chain and uses one remaining paid candidate",async()=>{
    const h=harness({failPart:1,fallback:true}),result=await h.complete();
    expect(h.read).toHaveBeenCalledTimes(3);expect(h.requests).toHaveLength(2);expect(result.readParts).toHaveLength(1);expect(result.readParts[0]!.hitId).toBe(id(2305));
    const availability=[...h.stored.entries()].filter(([key])=>key.endsWith("/availability")).map(([,step])=>SourcePartsAvailabilityCheckpointSchema.parse(step.result));
    expect(availability.map(value=>value.status)).toEqual(["replacement_available","readable"]);expect(availability[0]!.chains[0]).toMatchObject({complete:false,parts:[{status:"read"},{status:"unsupported"}]});
    expect(h.search).not.toHaveBeenCalled();
  });
  it("does not expose a partial failed PDF as usable evidence when no alternative remains",async()=>{
    const h=harness({failPart:1});await expect(h.complete()).rejects.toThrow("provider.unavailable");
    expect(h.read).toHaveBeenCalledTimes(2);expect(h.writes.some(key=>key.includes("/claims/"))).toBe(false);
    const final=[...h.stored.entries()].find(([key])=>key.endsWith("/availability"))![1];expect(final.result).toMatchObject({status:"exhausted"});
  });
  it("blocks replay tampering before any continuation or model call",async()=>{
    const h=harness();await h.advance();await h.advance();const first=[...h.stored.entries()].find(([key])=>key.endsWith("/part/0"))![1];
    first.inputDigest="0".repeat(64);await expect(h.advance()).rejects.toThrow("provider.invalid_output");expect(h.read).toHaveBeenCalledTimes(1);expect(h.requests).toHaveLength(1);
  });
  it("extracts claims from all parts and only then authors knowledge from their union",async()=>{
    const h=harness({parts:4});
    for(let count=0;count<12&&!h.stored.has(`${h.prefix}/knowledge`);count++)await h.advanceResearch();
    const knowledge=ModuleKnowledgeCheckpointSchema.parse(h.stored.get(`${h.prefix}/knowledge`)!.result);
    const claims=[...h.stored.entries()].filter(([key])=>key.includes("/claims/")).map(([,step])=>SourceClaimsCheckpointSchema.parse(step.result));
    expect(h.read).toHaveBeenCalledTimes(4);expect(claims).toHaveLength(4);expect(knowledge.sourceReadStepIds).toEqual(claims.flatMap(claim=>claim.sourceReadStepIds));
    expect(knowledge.knowledge.outcomes[0]!.concepts[0]!.claimIds).toEqual(claims.flatMap(claim=>claim.claims.map(item=>item.id)));
    expect(h.savedPassages.map(passage=>passage.blockId)).toEqual(["page-1-offset-0","page-2-offset-0","page-3-offset-0","page-4-offset-0"]);
    const lastRead=Math.max(...h.writes.map((key,index)=>key.includes("/read/")?index:-1)),firstClaim=h.writes.findIndex(key=>key.includes("/claims/"));
    expect(firstClaim).toBeGreaterThan(lastRead);expect(h.requests.at(-1)!.purpose).toBe("module_knowledge");
    const evidence=[...h.stored.entries()].filter(([key])=>key.includes("/read/")).map(([,step])=>{
      const result=SourceReadCheckpointSchema.parse(step.result);return{id:step.id,inputDigest:step.inputDigest,result,source:h.documents.get(result.sourceId)!};
    });expect(()=>validateCompleteSourceReadChains(evidence)).not.toThrow();
  });
});
