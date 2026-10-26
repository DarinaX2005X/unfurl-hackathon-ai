import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {z} from "zod";
import type {JsonObject} from "../../src/domain/common";
import {geminiNativeShapeV2,geminiNativeShapeV3} from "../../src/server/ai/wire-schema";
import {buildProviderRequestBody} from "../../src/server/ai/openrouter";
import {CANDIDATE_MODEL_POLICY,GEMINI_SCHEMA_V2_POLICY,modelPolicy} from "../../src/server/ai/model-policy";
import {jsonDigest} from "../../src/server/ai/json";
import {KnowledgeCoverageReviewSchema,KNOWLEDGE_COVERAGE_CATEGORIES,createKnowledgeCoverageInput,assessKnowledgeCoverageReview} from "../../src/server/course-validation/knowledge";
import {ModuleReviewSchema} from "../../src/server/course-validation/module-review";
import {ContentReviewSchema} from "../../src/server/course-validation/content-review";
import {SpecializedReviewSchema} from "../../src/server/course-validation/specialized-review";
import {batchResponseSchema} from "../../src/server/course-generation/checkpoints";
import {fixture,id} from "../course-generation/fixtures";

function evidenceItems(schema:JsonObject):JsonObject[]{
  const found:JsonObject[]=[];
  function visit(value:unknown){if(!value||typeof value!=="object")return;if(Array.isArray(value)){value.forEach(visit);return;}
    const node=value as JsonObject,properties=node.properties as JsonObject|undefined;
    if(node.type==="object"&&properties?.path&&properties.value)found.push(node);Object.values(node).forEach(visit);
  }
  visit(schema);return found;
}

describe("immutable Gemini schema v3 projection",()=>{
  it.each([['coverage',KnowledgeCoverageReviewSchema],['module',ModuleReviewSchema],['content',ContentReviewSchema],['specialized',SpecializedReviewSchema],
    ['content batch',batchResponseSchema(ContentReviewSchema)]] as const)("preserves complete canonical %s evidence while making only the native recursive value optional",(_name,schema)=>{
    const canonical=z.toJSONSchema(schema) as JsonObject,before=jsonDigest(canonical),v2=geminiNativeShapeV2(canonical),v3=geminiNativeShapeV3(canonical);
    expect(JSON.stringify(v2)).toContain('"propertyNames"');expect(JSON.stringify(v3)).not.toContain('"propertyNames"');
    expect(v3.$defs).toBeDefined();expect(v3.required).toEqual(v2.required);
    const oldItems=evidenceItems(v2),items=evidenceItems(v3);expect(items.length).toBeGreaterThan(0);expect(items).toHaveLength(oldItems.length);
    for(let index=0;index<items.length;index++){
      const next=items[index]!,old=oldItems[index]!;expect(old.required).toEqual(["path","value"]);expect(next.required).toEqual(["path"]);
      expect(next.properties).toEqual(old.properties);expect(next.additionalProperties).toBe(false);
    }
    expect(evidenceItems(canonical).every(item=>JSON.stringify(item.required)==='["path","value"]')).toBe(true);
    expect(jsonDigest(canonical)).toBe(before);
  });
  it("keeps the exact failed V2 native coverage schema bytes and original canonical system instructions",()=>{
    const schema=z.toJSONSchema(KnowledgeCoverageReviewSchema) as JsonObject;
    expect(jsonDigest(geminiNativeShapeV2(schema))).toBe("e5784bfee5ca533705b70f88e97ac5791fd32e8593b3bf9ac98fed6676cc9295");
    const request={operationId:id(900),purpose:"content_review" as const,instructionVersion:"coverage-fixture",trustedInstructions:"Review the actual input.",
      untrustedInput:{synthetic:true},model:modelPolicy(CANDIDATE_MODEL_POLICY).model,maxOutputTokens:16384,deadlineAt:0,budget:{logicalOperationId:id(900),reservationId:id(901),attempt:1,runStepId:id(902),probe:false}};
    const options={schema,schemaName:"coverage_3"},old=buildProviderRequestBody({...request,modelPolicy:GEMINI_SCHEMA_V2_POLICY},options),next=buildProviderRequestBody({...request,modelPolicy:CANDIDATE_MODEL_POLICY},options);
    expect(old.messages).toEqual(next.messages);expect(old.messages[0]!.content).toContain('"propertyNames"');
    expect(evidenceItems(old.response_format!.json_schema.schema)[0]!.required).toEqual(["path","value"]);
    expect(evidenceItems(next.response_format!.json_schema.schema)[0]!.required).toEqual(["path"]);
  });
  it("finds cycles structurally and preserves required ordinary refs, IDs and schema property names",()=>{
    const schema:JsonObject={type:"object",properties:{id:{$ref:"#/$defs/identifier"},proof:{$ref:"#/$defs/evidence~1node"},propertyNames:{type:"string"}},
      required:["id","proof","propertyNames"],$defs:{identifier:{type:"string"},"evidence/node":{anyOf:[{type:"string"},{type:"array",items:{$ref:"#/$defs/evidence~1node"}}]}}};
    const next=geminiNativeShapeV3(schema);expect(next.required).toEqual(["id","propertyNames"]);
    expect((next.properties as JsonObject).propertyNames).toEqual({type:"string"});
    expect((next.properties as JsonObject).proof).toEqual({$ref:"#/$defs/evidence~1node"});
  });
  it("still rejects missing values, changed values and invented paths with full object/array evidence allowed",()=>{
    const data=fixture(),knowledge=data.knowledge[0]!,material=createKnowledgeCoverageInput({draft:data.draft,knowledge,sourceKnowledgeStepId:id(910),outcomeId:knowledge.outcomes[0]!.outcomeId,facts:data.context,correction:null});
    const review={knowledgeDigest:(material as JsonObject).knowledgeDigest,outcomeId:knowledge.outcomes[0]!.outcomeId,publicCommentary:null,
      checks:KNOWLEDGE_COVERAGE_CATEGORIES.map(category=>({category,status:"passed",explanation:"Synthetic complete evidence.",correction:null,evidence:[
        {path:["approvedOutcome","demonstration"],value:data.draft.outcomes[0]!.demonstration},{path:["knowledge"],value:knowledge}]})),invalidCriteria:[],unsupportedClaimIds:[]};
    expect(assessKnowledgeCoverageReview(review,material).passed).toBe(true);
    const missing=structuredClone(review) as unknown as {checks:{evidence:{value?:unknown;path:unknown[]}[]}[]};delete missing.checks[0]!.evidence[0]!.value;
    expect(()=>assessKnowledgeCoverageReview(missing,material)).toThrow();
    const changed=structuredClone(review);changed.checks[0]!.evidence[0]!.value="fabricated";expect(()=>assessKnowledgeCoverageReview(changed,material)).toThrow();
    const invented=structuredClone(review);invented.checks[0]!.evidence[0]!.path=["missing"];expect(()=>assessKnowledgeCoverageReview(invented,material)).toThrow();
  });
});
