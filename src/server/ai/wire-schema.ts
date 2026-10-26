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

/** Additive projection for the GenerateContent JSON-schema subset used by the route.
 * https://ai.google.dev/api/generate-content (GenerationConfig.responseJsonSchema)
 * propertyNames is outside that documented subset;
 * cyclic refs must occur within non-required native properties. The complete
 * canonical schema and application validation still require evidence values.
 * V2 stays immutable for paid replay. Property names in maps remain data.
 */
export function geminiNativeShapeV3(schema:JsonObject):JsonObject{
  const shaped=geminiNativeShapeV2(schema),schemaChildren=["items","prefixItems","anyOf","allOf","additionalProperties"];
  const object=(value:JsonValue|undefined):value is JsonObject=>value!==null&&typeof value==="object"&&!Array.isArray(value);
  function referenced(ref:string):JsonValue|undefined{
    if(ref==="#")return shaped;
    if(!ref.startsWith("#/"))return undefined;
    let value:JsonValue|undefined=shaped;
    for(const part of ref.slice(2).split("/")){
      const key=part.replace(/~1/g,"/").replace(/~0/g,"~");
      if(!object(value)||!Object.hasOwn(value,key))return undefined;value=value[key];
    }
    return value;
  }
  function cyclic(value:JsonValue,refs:Set<string>):boolean{
    if(Array.isArray(value))return value.some(child=>cyclic(child,refs));
    if(!object(value))return false;
    if(typeof value.$ref==="string"){
      if(refs.has(value.$ref))return true;
      const target=referenced(value.$ref);
      if(target!==undefined&&cyclic(target,new Set([...refs,value.$ref])))return true;
    }
    if(object(value.properties)&&Object.values(value.properties).some(child=>cyclic(child,refs)))return true;
    return schemaChildren.some(key=>value[key]!==undefined&&cyclic(value[key]!,refs));
  }
  const referenceCycles=new Map<string,boolean>();
  function exposedCycle(value:JsonValue):boolean{
    if(Array.isArray(value))return value.some(exposedCycle);
    if(!object(value))return false;
    if(typeof value.$ref==="string"){
      const ref=value.$ref;
      if(!referenceCycles.has(ref)){const target=referenced(ref);referenceCycles.set(ref,target!==undefined&&cyclic(target,new Set([ref])));}
      if(referenceCycles.get(ref))return true;
    }
    // Nested object properties have their own required list. Keep their parent
    // arrays/objects required rather than weakening the whole review envelope.
    return schemaChildren.some(key=>value[key]!==undefined&&exposedCycle(value[key]!));
  }
  function project(value:JsonValue):JsonValue{
    if(value===null||typeof value!=="object")return value;
    if(Array.isArray(value))return value.map(project);
    const result:JsonObject={};
    for(const [key,child]of Object.entries(value)){
      if(key==="propertyNames")continue;
      if(["properties","$defs","definitions"].includes(key)&&child!==null&&typeof child==="object"&&!Array.isArray(child))
        result[key]=Object.fromEntries(Object.entries(child).map(([name,item])=>[name,project(item)]));
      else if(["items","prefixItems","anyOf","allOf","additionalProperties"].includes(key))result[key]=project(child);
      else result[key]=child;
    }
    if(Array.isArray(result.required)&&object(value.properties)){
      const properties=value.properties;
      result.required=result.required.filter(name=>typeof name!=="string"||properties[name]===undefined||!exposedCycle(properties[name]!));
    }
    return result;
  }
  const result=project(shaped) as JsonObject;canonicalJson(result,65536);return result;
}
