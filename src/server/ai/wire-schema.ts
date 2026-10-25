import "server-only";
import type { JsonObject, JsonValue } from "../../domain/common";

export const WIRE_SCHEMA_VERSION="structural-json-schema-v1";
const validationOnly=new Set(["$schema","minLength","maxLength","pattern","format","minimum","maximum","exclusiveMinimum","exclusiveMaximum",
  "multipleOf","minItems","maxItems","uniqueItems","minProperties","maxProperties","default"]);

/** Conservative transport subset. Every dropped constraint remains enforced by the original Zod schema after response. */
export function providerWireSchema(schema:JsonObject):JsonObject{
  function visit(value:JsonValue):JsonValue{
    if(Array.isArray(value))return value.map(visit);
    if(value===null||typeof value!=="object")return value;
    const result:JsonObject={};
    for(const [key,item]of Object.entries(value)){
      if(validationOnly.has(key))continue;
      if(key==="const"){result.enum=[item];continue;}
      if(key==="properties"||key==="$defs"||key==="definitions"){
        // Property names are data: a field named "minimum" must not disappear.
        if(item&&typeof item==="object"&&!Array.isArray(item))result[key]=Object.fromEntries(Object.entries(item).map(([name,child])=>[name,visit(child)]));
        else result[key]=visit(item);
      }else result[key]=visit(item);
    }
    return result;
  }
  return visit(schema) as JsonObject;
}
