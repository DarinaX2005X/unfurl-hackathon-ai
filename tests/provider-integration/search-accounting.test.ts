import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {verifyNativeSearchAccounting} from "../../src/server/ai/search-accounting";

const rate={contextTokens:262144,pricing:{prompt:"0.00000057",completion:"0.0000024",input_cache_read:"0.000000114"},
  search:{engine:"parallel",mode:"advanced",max_uses:1,maxToolCalls:1,inferencePasses:2}};
// Exact native counters and decimal strings from the stalled authenticated receipt.
const native={prompt_tokens:3971,completion_tokens:1576,total_tokens:5547,cost:"0.010812397999999999",
  prompt_tokens_details:{cached_tokens:512},completion_tokens_details:{reasoning_tokens:1154},
  cost_details:{upstream_inference_cost:"0.005812398"},
  server_tool_use_details:{web_search_requests:1,tool_calls_requested:1,tool_calls_executed:1}};
function verify(data:Record<string,unknown>=native,card:unknown=rate){
  return verifyNativeSearchAccounting(data,card,{reportedCostUsd:typeof data.cost==="string"?data.cost:null,finishReason:"stop",failure:null,annotationCount:5});
}
describe("native search fee serialization precision",()=>{
  it("keeps the saved provider total and conservatively settles its verified charge",()=>{
    const before=JSON.stringify(native);
    expect(verify()).toMatchObject({costMicroUsd:"10813",evidence:{totalCostUsd:native.cost,searchFeeVerified:true,feeComparison:"binary64-relative-2epsilon-v1"}});
    expect(JSON.stringify(native)).toBe(before);
    expect(verify({...native,cost:"0.010812398"})).toMatchObject({costMicroUsd:"10813",evidence:{feeComparison:"exact"}});
    expect(verify({...native,cost:"0.010812398000000001"})).toMatchObject({costMicroUsd:"10813"});
  });
  it.each(["0.01081239799999999","0.01081239800000001","0.010812397","0.010813398","0.005812398","0.015812398","-0.010812398"])("retains the hold for a missing/doubled fee or larger mismatch: %s",cost=>{
    expect(verify({...native,cost})).toBeNull();
  });
  it("still requires the tool envelope, independent rates and matching usage",()=>{
    for(const changed of [
      {cost_details:{}},
      {server_tool_use_details:{web_search_requests:2,tool_calls_requested:2,tool_calls_executed:2}},
      {server_tool_use_details:{web_search_requests:1,tool_calls_requested:1,tool_calls_executed:0}},
      {server_tool_use:{web_search_requests:0}},
      {total_tokens:5548},
      {prompt_tokens_details:{cached_tokens:5000}},
      {cost:"0.011812398",cost_details:{upstream_inference_cost:"0.006812398"}},
    ])expect(verify({...native,...changed})).toBeNull();
    expect(verify(native,{...rate,search:{...rate.search,engine:"exa"}})).toBeNull();
    expect(verifyNativeSearchAccounting(native,rate,{reportedCostUsd:"0.010812398",finishReason:"stop",failure:null,annotationCount:5})).toBeNull();
  });
});
