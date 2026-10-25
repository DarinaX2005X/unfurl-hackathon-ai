import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { NextResponse,type NextRequest } from "next/server";
import { dispatchExecutionOutbox,inspectRecoveryProof,startRecoveryProof } from "@/server/runs/dispatcher";
export const runtime="nodejs";
export const maxDuration=60;
const bodySchema=z.discriminatedUnion("action",[z.object({action:z.literal("dispatch")}).strict(),z.object({action:z.literal("start_recovery_proof")}).strict(),
  z.object({action:z.literal("inspect_recovery_proof"),workflowRunId:z.string().min(1).max(256)}).strict()]);
export async function POST(request:NextRequest){
  const secret=process.env.INTERNAL_DISPATCH_SECRET;const authorization=request.headers.get("authorization")??"";
  const expected=secret?`Bearer ${secret}`:"";if(!secret||secret.length<32||authorization.length!==expected.length||!timingSafeEqual(Buffer.from(authorization),Buffer.from(expected)))return NextResponse.json({error:"unauthorized"},{status:401});
  try{if(Number(request.headers.get("content-length")??0)>1024)return NextResponse.json({error:"invalid_input"},{status:400});
    const input=bodySchema.parse(await request.json());const result=input.action==="dispatch"?await dispatchExecutionOutbox():input.action==="start_recovery_proof"?await startRecoveryProof():await inspectRecoveryProof(input.workflowRunId);
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
  }catch{return NextResponse.json({error:"dispatch_unavailable"},{status:503,headers:{"Cache-Control":"no-store"}});}
}
