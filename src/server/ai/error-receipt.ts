import "server-only";
import { z } from "zod";
import type { ProviderResponseReceipt } from "../budget/ports";
import { boundedResponseText } from "./http";
import { digestBytes, jsonDigest } from "./json";
import { retryAfterMilliseconds } from "./failure";
import { JsonValueSchema,type JsonObject } from "../../domain/common";

const categorySchema = z.enum(["schema", "unsupported_parameter", "privacy_route", "credit", "auth", "rate", "unknown"]);
const parameterSchema = z.enum(["response_format", "response_format.json_schema", "response_format.json_schema.schema",
  "response_format.json_schema.strict", "response_format.json_schema.name", "max_tokens", "max_completion_tokens",
  "tools", "tool_choice", "provider", "provider.only", "provider.max_price", "provider.data_collection", "provider.zdr", "messages"]);
const schemaKeyword = z.enum(["$schema","type","properties","propertyNames","required","additionalProperties","items","anyOf","oneOf","allOf","enum","const","$ref","$defs",
  "minItems","maxItems","minLength","maxLength","minimum","maximum","exclusiveMinimum","exclusiveMaximum","multipleOf","pattern","format","uniqueItems"]);

export interface HttpFailureDiagnostic {version:"technical-error-diagnostic-v1";httpStatus:number;category:string;messages:string[]}
const diagnosticVocabulary=new Set((`a an the is are was be been being to of for in at on and or with without from by this that it has have had
  request response json schema invalid argument invalid_argument bad_request bad request error failed failure provider upstream input output
  unable submit because specifies specifies constraint constraints too many states much branching serving complexity complex large deep nested
  typical common causes include includes array arrays limit limits maximum minimum maxitems minitems maxlength minlength oneof anyof allof enum
  properties property required optional additionalproperties allowed supported unsupported not unknown name field fields cannot find value values type
  generation_config generationconfig response_schema responseschema response_json_schema responsejsonschema response_format json_schema strict const
  response_mime_type application json thinking thinking_level thinkinglevel thinking_budget thinkingbudget reasoning effort low medium high minimal none
  stream streaming stream_options include_usage max_tokens max_completion_tokens model parameter parameters expected must only object string number integer boolean null
  redacted one_of any_of additional_properties max_items min_items response_format format pattern size length validation validate malformed exhausted exceeded exceeds tokens token context budget permission denied unauthenticated unavailable
  400 401 402 403 404 408 413 422 429 500 502 503 504 0 1 2 3 4 5 6 7 8 9 10 32 64 128 256
  received allowed additional unsupported_parameter status code details fieldviolations description message propertyordering items data
  recursive recursion reference references resolve unresolved cycle cyclic union propertynames definitions defs ref
`).split(/\s+/).filter(Boolean));

/** Private diagnostics are technical vocabulary only: arbitrary prose, identifiers,
 * quoted user values and credentials are replaced rather than saved. */
export function sanitizeTechnicalError(message:string,secrets:readonly string[]=[]):string{
  let safe=message.slice(0,12000);
  for(const secret of secrets)if(secret)safe=safe.split(secret).join(" redacted ");
  safe=safe.replace(/Bearer\s+[^\s"\\]+/gi," redacted ").replace(/sk-[A-Za-z0-9_-]+/g," redacted ");
  // Reconstruct from the vocabulary. Mutating the original prose would retain
  // arbitrary punctuation, emoji and symbolic user values between word tokens.
  return (safe.match(/[\p{L}\p{N}_$-]+|[^\s\p{L}\p{N}_$-]+/gu)??[]).map(token=>{
    const word=token.toLowerCase();
    return word!=="redacted"&&(diagnosticVocabulary.has(word)||schemaKeyword.options.some(key=>key.toLowerCase()===word))?word:"[REDACTED]";
  }).join(" ").replace(/(?:\[REDACTED\]\s*){2,}/g,"[REDACTED] ").trim().slice(0,2048);
}
function diagnosticMessages(decoded:unknown,secrets:readonly string[]){
  const messages:string[]=[];
  function inspect(value:unknown,depth=0){
    if(depth>6||messages.length>=4||!value||typeof value!=="object"||Array.isArray(value))return;
    const item=value as Record<string,unknown>;
    for(const key of ["message","description"])if(typeof item[key]==="string")messages.push(sanitizeTechnicalError(item[key],secrets));
    for(const key of ["error","metadata"])inspect(item[key],depth+1);
    if(typeof item.raw==="string"&&item.raw.length<=12000){try{inspect(JSON.parse(item.raw) as unknown,depth+1);}catch{messages.push(sanitizeTechnicalError(item.raw,secrets));}}
    else inspect(item.raw,depth+1);
    for(const key of ["details","fieldViolations"])if(Array.isArray(item[key]))for(const child of item[key].slice(0,4))inspect(child,depth+1);
  }
  inspect(decoded);return [...new Set(messages)].slice(0,4);
}

export const httpFailureReceiptSchema = z.object({
  kind: z.literal("http_error"), receivedAt: z.iso.datetime(), httpStatus: z.number().int().min(400).max(599),
  failure: z.enum(["unavailable", "rate_limited"]), retryAfterMs: z.number().int().nonnegative().nullable(),
  upstreamCode: z.number().int().min(400).max(599).nullable(), correlationId: z.string().max(128).nullable(),
  bodyDigestAvailable: z.boolean(),
  category: categorySchema.default("unknown"), rejectedParameters: z.array(parameterSchema).max(8).default([]),
  schemaKeywords:z.array(schemaKeyword).max(24).default([]),schemaPaths:z.array(z.string().max(512)).max(16).default([]),
  diagnostic:z.object({version:z.literal("technical-error-diagnostic-v1"),messages:z.array(z.string().max(2048)).max(4)}).strict().optional(),
});

/** Free-form provider prose is inspected only in memory; persisted values come from fixed enums. */
function classify(decoded: unknown, status: number, schema?:JsonObject) {
  const envelope = z.object({ error: z.object({ message: z.string().max(16384).optional(), param: z.string().max(200).optional(),
    type: z.string().max(80).optional(), metadata: z.object({ raw: z.unknown().optional(), param: z.string().max(200).optional(),
      limit_source: z.string().max(80).optional() }).optional() }) }).safeParse(decoded);
  if (!envelope.success) return { category: categorySchema.parse(status === 401 ? "auth" : status === 402 ? "credit" : status === 429 ? "rate" : "unknown"), rejectedParameters: [] };
  const error = envelope.data.error;
  let upstream = error.metadata?.raw;
  if (typeof upstream === "string" && upstream.length <= 12000) { try { upstream = JSON.parse(upstream) as unknown; } catch { /* Never persist it. */ } }
  const details = z.object({ error: z.object({ message: z.string().max(12000).optional(), param: z.string().max(200).optional(), type: z.string().max(80).optional() }).optional(),
    message: z.string().max(12000).optional(), param: z.string().max(200).optional() }).safeParse(upstream);
  const rawMessage = details.success ? details.data.error?.message ?? details.data.message ?? "" : typeof upstream === "string" ? upstream.slice(0,12000) : "";
  const message = [error.message ?? "", rawMessage, error.type ?? "", error.metadata?.limit_source ?? ""].join(" ").toLowerCase();
  const candidates = [error.param, error.metadata?.param, ...(details.success ? [details.data.param, details.data.error?.param] : [])];
  const rejectedParameters = [...new Set(candidates.flatMap(value => { const match = parameterSchema.safeParse(value); return match.success ? [match.data] : []; }))].slice(0,8);
  const category = status === 401 ? "auth" : status === 402 || /insufficient.{0,30}credit|openrouter_(?:guardrail_budget|workspace_budget|key_limit|in_flight_budget)/.test(message) ? "credit"
    : status === 429 ? "rate" : /privacy|data policy|data collection|zero.data.retention|no endpoints.{0,80}(?:policy|zdr)/.test(message) ? "privacy_route"
    : /(?:invalid|unsupported|not supported|not permitted).{0,60}(?:schema|additionalproperties|anyof)|(?:schema|additionalproperties|anyof).{0,60}(?:invalid|unsupported|not supported|not permitted)|too many states|too much branching|schema.{0,120}(?:complex|constraint)/.test(message) ? "schema"
    : /unsupported.{0,30}param|param.{0,40}(?:not supported|not permitted)|unknown parameter/.test(message) ? "unsupported_parameter" : "unknown";
  const schemaKeywords=category==="schema"?schemaKeyword.options.filter(key=>new RegExp(`(?:^|[^a-z])${key.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?:$|[^a-z])`,"i").test(message)).slice(0,24):[];
  const schemaPaths:string[]=[];
  if(category==="schema"&&schema){
    const normalized=message.replace(/[\s'"()[\]]/g,"");
    function visit(value:unknown,path:string[]){
      if(path.length&&path.length<24){
        const pointer="/"+path.map(part=>part.replace(/~/g,"~0").replace(/\//g,"~1")).join("/");
        const variants=[pointer,path.join("."),path.join(",")];
        if(pointer.length<=512&&variants.some(candidate=>candidate.length>=12&&normalized.includes(candidate.toLowerCase())))schemaPaths.push(pointer);
      }
      if(value&&typeof value==="object")for(const [key,child]of Object.entries(value))if(!["description","enum","const","default","required"].includes(key))visit(child,[...path,key]);
    }
    visit(schema,[]);
  }
  return { category: categorySchema.parse(category), rejectedParameters,schemaKeywords,schemaPaths:[...new Set(schemaPaths)].sort((a,b)=>b.length-a.length).slice(0,16) };
}

/** Private receipts retain only bounded technical vocabulary, never raw upstream prose. */
export async function httpFailureReceipt(response: Response,schema?:JsonObject,diagnostic?:{secrets?:readonly string[];onDiagnostic?:(value:HttpFailureDiagnostic)=>Promise<void>}): Promise<ProviderResponseReceipt> {
  let raw: string | null = null;
  let decoded: unknown = null;
  try { raw = await boundedResponseText(response, 16 * 1024); decoded = JSON.parse(raw) as unknown; } catch { /* Metadata still identifies this failure. */ }
  const parsed = z.object({ id: z.string().regex(/^gen-[A-Za-z0-9_-]{1,200}$/).optional(),
    error: z.object({ code: z.number().int().min(400).max(599).optional() }).optional() }).safeParse(decoded);
  const header = response.headers.get("x-request-id") ?? response.headers.get("cf-ray");
  const messages=diagnosticMessages(decoded,diagnostic?.secrets??[]);
  const result = httpFailureReceiptSchema.parse({ kind: "http_error", receivedAt: new Date().toISOString(),
    httpStatus: response.status, failure: response.status === 429 ? "rate_limited" : "unavailable",
    retryAfterMs: retryAfterMilliseconds(response.headers.get("retry-after")),
    upstreamCode: parsed.success ? parsed.data.error?.code ?? null : null,
    correlationId: header && /^[A-Za-z0-9_-]{1,128}$/.test(header)&&!(diagnostic?.secrets??[]).some(secret=>Boolean(secret)&&header.includes(secret)) ? header : null,
    bodyDigestAvailable: raw !== null, ...classify(decoded, response.status,schema),
    ...(messages.length?{diagnostic:{version:"technical-error-diagnostic-v1",messages}}:{}) });
  if(diagnostic?.onDiagnostic)try{await diagnostic.onDiagnostic({version:"technical-error-diagnostic-v1",httpStatus:response.status,category:result.category,messages});}catch{/* Private diagnostic I/O must never prevent the durable accounting receipt. */}
  const providerRequestId=parsed.success?parsed.data.id??null:null;
  return { providerRequestId:providerRequestId&&!(diagnostic?.secrets??[]).some(secret=>Boolean(secret)&&providerRequestId.includes(secret))?providerRequestId:null,
    responseDigest: raw === null ? jsonDigest(result) : digestBytes(raw), reportedCostUsd: null, usage: {}, result:JsonValueSchema.parse(result) };
}
