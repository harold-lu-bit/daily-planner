import {build} from 'esbuild';
import {readFile,mkdir,writeFile,chmod} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const dir=path.resolve('.test-runtime');await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);
await build({entryPoints:['src/daily.ts','src/provider.ts','src/dialogue.ts'],bundle:true,packages:'external',platform:'node',format:'esm',outdir:dir,logLevel:'silent'});
const {DailyService,QUEUE_PATH,renderQueue,reviewPayload,reviewInstruction,parseQueue}=await import(pathToFileURL(path.join(dir,'daily.js')).href);
const {callModel}=await import(pathToFileURL(path.join(dir,'provider.js')).href);
const {modelReplySchema,mergeReply,dialogueInstruction}=await import(pathToFileURL(path.join(dir,'dialogue.js')).href);
async function reviewCall(payload){
 const r=await callModel(config,env.API_KEY,transport,modelReplySchema(payload.target),reviewInstruction+dialogueInstruction,{...payload,requestMode:'plan'});
 const value=mergeReply(r.value,payload.previous);assert.ok(value,'Expected plan or patch');return {value,usage:r.usage};
}
const env=process.env;
if(!env.API_BASE_URL||!env.API_KEY||!env.MODEL_NAME)throw new Error('Set API_BASE_URL, API_KEY and MODEL_NAME in the process environment; never commit credentials');
const config={baseUrl:env.API_BASE_URL,model:env.MODEL_NAME,format:'json_object',timeout:120,maxTokens:8192};
const transport=async(url,body,key)=>{const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body,signal:AbortSignal.timeout(125000)});return {status:r.status,json:await r.json()};};
const files=new Map([
 ['daily/2026-10-05.md','## Tasks\n- [x] 整理实验记录\n- [ ] 分析实验数据\n- [ ] 10 月 9 日提交周报\n'],
 ['daily/2026-10-06.md','## Tasks\n- [ ] 10:00 - 11:00 实验室培训\n'],
 [QUEUE_PATH,renderQueue({type:'research-planner-future',version:1,reviewed:[],tasks:[
  {id:crypto.randomUUID(),text:'联系学长确认设备使用方法',date:'2026-10-04',deadline:null,start:null,end:null,priority:'normal'},
  {id:crypto.randomUUID(),text:'组会',date:'2026-10-06',deadline:null,start:'14:00',end:'15:00',priority:'normal'}]})],
]);
const store={read:async p=>files.get(p)??null,list:async()=>{throw Error('No scan');},create:async(p,s)=>{if(files.has(p))throw Error('exists');files.set(p,s);},compareWrite:async(p,b,a)=>{assert.equal(files.get(p),b);files.set(p,a);},compareRemove:async(p,b)=>{assert.equal(files.get(p),b);files.set(p,'');}};
const service=new DailyService(store,async day=>({day,todayPath:'daily/2026-10-05.md',tomorrowPath:'daily/2026-10-06.md',templatePath:'template.md',heading:'Tasks',enabled:true}));
const version=JSON.parse(await readFile('manifest.json','utf8')).version;
const started=Date.now(),report={date:new Date().toISOString(),version,scope:'Legacy daily review, iteration and checked-task follow-up regression; no real Vault; catch-up/today not covered by this script',checks:[]};
try{
 const snapshot=await service.snapshot('2026-10-05');const before=new Map(files);
 const first=await reviewCall(reviewPayload(snapshot,[],null));
 service.draft(snapshot,first.value,false);assert.deepEqual(files,before);
 report.checks.push({name:'initial daily-only review: complete IDs, no writes',passed:true,usage:first.usage});
 const feedback=['不用联系学长了，设备已经会用了。组会改到 15:00 到 16:00。明天优先分析数据，不用排具体时间。周四（10月8日）提醒我准备周报材料，周五（10月9日）提交周报。培训保持原样。'];
 const second=await reviewCall(reviewPayload(snapshot,feedback,first.value));
 assert.equal(second.value.questions.length,0);
 const d=service.draft(snapshot,second.value,true,feedback);await service.apply(d,async()=>{});
 const queue=parseQueue(files.get(QUEUE_PATH));
 assert.ok(queue.tasks.some(t=>t.date==='2026-10-08'&&t.text.includes('周报')));
 assert.ok(queue.tasks.some(t=>t.date==='2026-10-09'&&t.text.includes('周报')));
 assert.ok(!queue.tasks.some(t=>t.text.includes('学长')));
 const analysis=second.value.decisions.find(t=>t.text.includes('分析'));
 assert.equal(analysis.action,'tomorrow');assert.equal(analysis.start,null);assert.equal(analysis.end,null);assert.equal(analysis.priority,'high');
 assert.match(files.get('daily/2026-10-06.md'),/15:00 - 16:00.*组会/);
 assert.match(files.get('daily/2026-10-06.md'),/10:00 - 11:00 实验室培训/);
 report.checks.push({name:'natural-language iteration, future/cancel/time/priority and confirmed merge',passed:true,usage:second.usage});
 files.clear();
 const completedText='## Tasks\n- [x] 今天完成初步调试，后续10月9日继续验证稳定性\n- [x] 初稿完成，明天补充实验结果\n- [x] 已发送报告\n- [x] 10月9日的实验已经提前做完，没有后续\n- [x] 今日测试结束\n  后续10月10日补测低温条件\n';
 files.set('daily/2026-10-05.md',completedText);files.set('daily/2026-10-06.md','## Tasks\n');
 const completedSnapshot=await service.snapshot('2026-10-05');
 const completedResult=await reviewCall(reviewPayload(completedSnapshot,[],null));
 assert.equal(completedResult.value.questions.length,0);
 const decisions=completedResult.value.decisions;
 const forSource=(fragment)=>decisions.find(d=>d.id===completedSnapshot.completed.find(t=>t.text.includes(fragment)).id);
 assert.equal(forSource('初步调试').action,'future');assert.equal(forSource('初步调试').date,'2026-10-09');assert.match(forSource('初步调试').text,/稳定性/);
 assert.equal(forSource('初稿').action,'tomorrow');assert.match(forSource('初稿').text,/实验结果/);
 assert.equal(forSource('已发送').action,'keep');assert.equal(forSource('提前做完').action,'keep');
 assert.equal(forSource('今日测试结束').action,'future');assert.equal(forSource('今日测试结束').date,'2026-10-10');
 const completedDraft=service.draft(completedSnapshot,completedResult.value,false);
 assert.equal(files.get('daily/2026-10-05.md'),completedText);
 await service.apply(completedDraft,async()=>{});
 assert.equal(parseQueue(files.get(QUEUE_PATH)).tasks.length,2);
 assert.equal((await service.snapshot('2026-10-05')).completed.length,0);
 assert.equal((files.get('daily/2026-10-05.md').match(/- \[x\]/g)||[]).length,5);
 report.checks.push({name:'checked-task continuation: future/next-day/indented prose, plain completion and past-event negatives, acceptance and reread deduplication',passed:true,usage:completedResult.usage});
 report.passed=true;
}catch(e){report.passed=false;report.error=e instanceof Error?e.message:'failed';}
report.durationSeconds=Math.round((Date.now()-started)/1000);
await writeFile(path.join(dir,`live-report-v${version}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
