import { boundedResponseText } from "../../src/server/ai/http";
import { writeFile } from "node:fs/promises";

/** Explicit innocuous probe only. Never used for product or learner requests. */
export function sanitizeProbeError(raw:string,secrets:readonly string[]):string{
  let safe=raw.slice(0,16384);
  for(const secret of secrets)if(secret)safe=safe.split(secret).join("[REDACTED]");
  return safe.replace(/Bearer\s+[^\s"\\]+/gi,"Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g,"[REDACTED]")
    .replace(/[A-Za-z0-9_+/=-]{40,}/g,"[REDACTED_LONG_TOKEN]").slice(0,8192);
}
export const diagnosticFetcher:typeof fetch=async(input,init)=>{
  const response=await fetch(input,init);
  if(!response.ok){
    let raw="[Body unavailable or over 16 KiB]";try{raw=await boundedResponseText(response.clone(),16384);}catch{}
    await writeFile(".cache/provider-diagnostic-private-error.json",JSON.stringify({httpStatus:response.status,
      body:sanitizeProbeError(raw,[process.env.OPENROUTER_API_KEY??""])},null,2));
  }
  return response;
};
