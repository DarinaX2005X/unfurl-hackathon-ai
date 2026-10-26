import "server-only";
import type { JsonObject } from "../../domain/common";
import { canonicalJson } from "./json";
import type {JsonValue} from "../../domain/common";

/** Canonical schema instructions with application validation; this does not claim provider-native schema enforcement. */
export const WIRE_SCHEMA_VERSION="prompt-canonical-json-schema-local-validation-v1";
export function providerWireSchema(schema:JsonObject):JsonObject{
  canonicalJson(schema,65536);
  return schema;
}

/** Gemini documents grammar-state limits for nested maxItems, numeric bounds and unions.
 * This projection only guides native decoding. The original complete schema remains in
 * the system instructions and the original Zod parser remains the acceptance authority.
 * https://ai.google.dev/gemini-api/docs/structured-output#limitations
 */
export function geminiNativeShapeV2(schema:JsonObject):JsonObject{
  const applicationConstraints=new Set(["$schema","minItems","maxItems","minimum","maximum","exclusiveMinimum","exclusiveMaximum",
    "multipleOf","minLength","maxLength","pattern","format","uniqueItems","minProperties","maxProperties"]);
  function project(value:JsonValue):JsonValue{
    if(value===null||typeof value!=="object")return value;
    if(Array.isArray(value))return value.map(project);
    const result:JsonObject={};
    for(const [key,child]of Object.entries(value)){
      if(applicationConstraints.has(key))continue;
      // Property names are data at this level, even if a property is named "minimum".
      if(key==="properties"||key==="$defs"||key==="definitions"){
        if(child!==null&&typeof child==="object"&&!Array.isArray(child))result[key]=Object.fromEntries(Object.entries(child).map(([name,item])=>[name,project(item)]));
        else throw new Error("Invalid schema property map");
      }else if(key==="const")result.enum=[child];
      else if(key==="oneOf")result.anyOf=project(child);
      else if(["items","prefixItems","anyOf","allOf","additionalProperties"].includes(key))result[key]=project(child);
      else result[key]=child;
    }
    const variants=result.anyOf;
    if(Array.isArray(variants)&&variants.length&&variants.every(item=>item!==null&&typeof item==="object"&&!Array.isArray(item)&&item.type==="object"))result.type="object";
    return result;
  }
  const result=project(schema) as JsonObject;canonicalJson(result,65536);return result;
}
