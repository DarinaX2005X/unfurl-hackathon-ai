import {readFile,mkdir,mkdtemp,copyFile} from "node:fs/promises";
import {dirname,resolve,relative,sep} from "node:path";
import {spawn} from "node:child_process";
import {it,expect} from "vitest";
import {pdfFixture} from "./pdf-fixture";

/** Unpaid build proof: execute the actual parser from only the files traced by
 * Next for the deployed server routes, without access to repository modules. */
it.skipIf(process.env.PDF_WORKER_BUILD_PROOF!=="1")("ships and executes the PDF worker from production route traces",async()=>{
  const root=process.cwd(),worker=resolve(root,"src/server/research/pdf-parser.worker.mjs"),packageRoot=resolve(root,"node_modules/unpdf");
  const routes=[".next/server/app/api/internal/dispatch/route.js.nft.json",".next/server/app/.well-known/workflow/v1/flow/route.js.nft.json"];
  let packaged:string[]=[];
  for(const route of routes){
    const tracePath=resolve(root,route),trace=JSON.parse(await readFile(tracePath,"utf8")) as {files:string[]};
    const files=trace.files.map(path=>resolve(dirname(tracePath),path));
    expect(files).toContain(worker);expect(files).toContain(resolve(packageRoot,"package.json"));
    expect(files).toContain(resolve(packageRoot,"dist/pdfjs.mjs"));
    packaged=files.filter(path=>path===worker||path.startsWith(`${packageRoot}${sep}`));
  }
  await mkdir(resolve(root,".cache"),{recursive:true});
  const target=await mkdtemp(resolve(root,".cache/pdf-worker-build-"));
  for(const source of packaged){
    const rel=relative(root,source);if(rel.startsWith("..")||resolve(root,rel)!==source)throw new Error("Unexpected build trace path");
    const destination=resolve(target,rel);await mkdir(dirname(destination),{recursive:true});await copyFile(source,destination);
  }
  // Use a real child process with an isolated cwd: module resolution must work
  // from the trace copy, never from the development repository's node_modules.
  const script=`import {Worker} from 'node:worker_threads';
const w=new Worker(new URL('./src/server/research/pdf-parser.worker.mjs', 'file:///'+process.cwd().replaceAll('\\\\','/')+'/'),{workerData:{bytes:Uint8Array.from(${JSON.stringify([...pdfFixture(["Production PDF worker extracts actual source text."])])}).buffer},execArgv:[]});
w.once('message',m=>{if(!m.ok||!m.value.blocks.some(b=>b.text.includes('Production PDF worker')))process.exitCode=1;else console.log(JSON.stringify({worker:true,pages:m.value.totalPages,networkCalls:0,inferenceCalls:0}));void w.terminate();});w.once('error',()=>{process.exitCode=1;});`;
  const child=spawn(process.execPath,["--input-type=module","-e",script],{cwd:target,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{PATH:process.env.PATH??"",NODE_ENV:"production"}});
  let stdout="",stderr="";child.stdout.on("data",chunk=>stdout+=String(chunk));child.stderr.on("data",chunk=>stderr+=String(chunk));
  const code=await new Promise<number|null>((done,reject)=>{child.once("error",reject);child.once("exit",done);});
  expect(code,stderr.slice(0,2000)).toBe(0);expect(JSON.parse(stdout)).toMatchObject({worker:true,pages:1,networkCalls:0,inferenceCalls:0});
  console.log(JSON.stringify({buildTraceVerified:true,isolatedWorkerVerified:true,routes,artifactDirectory:target,networkCalls:0,inferenceCalls:0}));
},30000);
