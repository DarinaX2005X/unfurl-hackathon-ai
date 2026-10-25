import {describe,expect,it,vi} from "vitest";
import {z} from "zod";
vi.mock("server-only",()=>({}));
import {SearchInputSchema} from "../../src/server/research/ports";
import {AgentDecisionSchema,LegacyAgentDecisionSchema} from "../../src/server/agent-tools/contracts";
import {providerWireSchema} from "../../src/server/ai/wire-schema";
import {jsonDigest} from "../../src/server/ai/json";
import type {JsonObject} from "../../src/domain/common";

const before=SearchInputSchema.extend({domainHints:z.array(z.string().min(1).max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i)).max(10).optional()});
const search={query:"primary sources",language:"en",limit:5};
describe("domain hint whitespace normalization",()=>{
  it("trims only surrounding whitespace before the unchanged hostname constraints",()=>{
    expect(SearchInputSchema.parse({...search,domainHints:["mit.edu"," stanford.edu ","\tcmu.edu\n"]}).domainHints)
      .toEqual(["mit.edu","stanford.edu","cmu.edu"]);
    for(const domain of [" "," https://stanford.edu "," stanford.edu/path "," *.stanford.edu ","stan ford.edu","localhost"])
      expect(SearchInputSchema.safeParse({...search,domainHints:[domain]}).success).toBe(false);
  });
  it.each([LegacyAgentDecisionSchema,AgentDecisionSchema])("preserves the original decision wire schema and schema digest",schema=>{
    const oldSchema=z.discriminatedUnion("tool",[z.object({tool:z.literal("search"),input:before}).strict(),...schema.options.slice(1)]);
    const oldWire=providerWireSchema(z.toJSONSchema(oldSchema) as JsonObject),wire=providerWireSchema(z.toJSONSchema(schema) as JsonObject);
    expect(wire).toEqual(oldWire);expect(jsonDigest(wire)).toBe(jsonDigest(oldWire));
    const actualShape={tool:"search",input:{...search,domainHints:["mit.edu"," stanford.edu","cmu.edu","berkeley.edu","arxiv.org"]}};
    expect(oldSchema.safeParse(actualShape).success).toBe(false);
    expect(schema.parse(actualShape)).toEqual({...actualShape,input:{...actualShape.input,domainHints:["mit.edu","stanford.edu","cmu.edu","berkeley.edu","arxiv.org"]}});
  });
});
