import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
vi.mock("server-only", () => ({}));
import { httpFailureReceipt } from "../../src/server/ai/error-receipt";
import { RubricJudgementSchema } from "../../src/server/evaluation/contracts";
import { providerWireSchema } from "../../src/server/ai/wire-schema";
import { sanitizeProbeError } from "./diagnostic-fetch";
import type { JsonObject } from "../../src/domain/common";

describe("bounded private error diagnostics", () => {
  it.each([
    [400,{message:"Invalid JSON schema",param:"response_format.json_schema.schema"},"schema"],
    [400,{message:"Provider error",metadata:{raw:JSON.stringify({error:{message:"Parameter max_tokens is not supported",param:"max_tokens"}})}},"unsupported_parameter"],
    [404,{message:"No endpoints found matching your data policy"},"privacy_route"],
    [402,{message:"private account credit detail"},"credit"],
    [401,{message:"secret API credential"},"auth"],
    [429,{message:"private rate diagnostic"},"rate"],
  ])("classifies status %s without persisting prose", async (status,error,category) => {
    const receipt = await httpFailureReceipt(new Response(JSON.stringify({error}),{status:Number(status)}));
    expect(receipt.result).toMatchObject({category});
    expect(JSON.stringify(receipt)).not.toMatch(/secret API|private account|private rate|Provider error/);
  });
  it("rejects arbitrary field paths and stores only fixed approved parameters", async () => {
    const receipt = await httpFailureReceipt(new Response(JSON.stringify({error:{message:"Invalid schema secret-data",param:"messages.0.content.secret-data",metadata:{param:"response_format.json_schema.schema"}}}),{status:400}));
    expect(receipt.result).toMatchObject({category:"schema",rejectedParameters:["response_format.json_schema.schema"]});
    expect(JSON.stringify(receipt)).not.toContain("secret-data");
  });
  it("inspects the actual rubric wire schema: closed required objects, no root union, no unsupported composition", async () => {
    const schema = z.toJSONSchema(RubricJudgementSchema);
    expect(schema.type).toBe("object"); expect(schema.anyOf).toBeUndefined();
    const unsupported: string[] = []; let objects = 0;
    function visit(value: unknown) {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string,unknown>;
      for (const key of ["allOf","not","if","then","else","dependentRequired","dependentSchemas"]) if (key in node) unsupported.push(key);
      if (node.type === "object") { objects++; expect(node.additionalProperties).toBe(false); expect(node.required).toEqual(Object.keys(node.properties as object)); }
      for (const child of Object.values(node)) { if (Array.isArray(child)) child.forEach(visit); else visit(child); }
    }
    visit(schema); expect(objects).toBe(4); expect(unsupported).toEqual([]);
    if (process.env.WRITE_SCHEMA_DIAGNOSTIC === "1") { await mkdir(".cache",{recursive:true}); await writeFile(".cache/rubric-wire-schema.json",JSON.stringify(schema,null,2)); }
  });
  it("retains exact known schema keyword and only a path present in the supplied request schema",async()=>{
    const schema={type:"object",properties:{dimensions:{type:"array",items:{type:"string"}}}};
    const receipt=await httpFailureReceipt(new Response(JSON.stringify({error:{message:"Invalid schema: unsupported maxItems at ('properties', 'dimensions'); secret user prompt",param:"response_format.json_schema.schema"}}),{status:400}),schema);
    expect(receipt.result).toMatchObject({schemaKeywords:expect.arrayContaining(["maxItems"]),schemaPaths:["/properties/dimensions"]});
    expect(JSON.stringify(receipt)).not.toContain("secret user prompt");
  });
  it("preserves the bounded canonical schema for prompt instructions and retains full domain validation",()=>{
    const original=z.toJSONSchema(RubricJudgementSchema) as JsonObject;const wire=providerWireSchema(original);
    expect(wire).toEqual(original); expect(JSON.stringify(wire)).toContain("minItems");
    expect(wire).toMatchObject({type:"object",additionalProperties:false,required:["dimensions","feedback","uncertainReasons"]});
    expect(RubricJudgementSchema.safeParse({dimensions:[],feedback:"",uncertainReasons:[]}).success).toBe(false);
    expect(providerWireSchema({type:"object",properties:{minimum:{type:"string",maxLength:2}},required:["minimum"]})).toEqual({type:"object",properties:{minimum:{type:"string",maxLength:2}},required:["minimum"]});
    expect(()=>providerWireSchema({description:"x".repeat(65537)})).toThrow();
    expect(sanitizeProbeError("Invalid response_format type; Bearer abc123 sk-secret " + "x".repeat(50),["secret"])).not.toMatch(/abc123|sk-secret|x{40}/);
  });
});
