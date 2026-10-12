import { describe, it, expect } from 'vitest';
import { addDay, type Store } from '../src/core';
import { DailyService, QUEUE_PATH, parseQueue, readTasks, renderQueue, renderTemplate, reviewPayload, type Decision, type Review, type Layout, type BatchJournal, type Snapshot } from '../src/daily';
class Memory implements Store {
 files=new Map<string,string>(); reads:string[]=[]; failPath='';failOnce=false;
 async read(p:string){this.reads.push(p);return this.files.get(p)??null;}
 async list(){throw new Error('No historical scan permitted');return [];}
 async create(p:string,s:string){if(this.files.has(p))throw new Error('exists');this.fail(p);this.files.set(p,s);}
 async compareWrite(p:string,b:string,s:string){if(this.files.get(p)!==b)throw new Error('conflict');this.fail(p);this.files.set(p,s);}
 async compareRemove(p:string,b:string){if(this.files.get(p)!==b)throw new Error('conflict');this.files.set(p,'');}
 fail(p:string){if(p===this.failPath&&this.failOnce){this.failOnce=false;throw new Error('disk error');}}
}
const path=(day:string)=>`10 Daily/${day.slice(0,4)}/${day.slice(5,7)}/${day}.md`;
const template='99 System/Templates/Daily.md';
const layout=(day:string):Layout=>({day,todayPath:path(day),tomorrowPath:path(addDay(day,1)),templatePath:template,heading:'Tasks',enabled:true});
function fixture(raw='# 2026-10-05\n\n## Tasks\n\n- [x] 整理实验记录\n- [ ] 分析实验数据\n- [ ] 10 月 9 日提交周报\n\n## Work Log\n人工日志\n') {
 const store=new Memory();store.files.set(path('2026-10-05'),raw);
 store.files.set(template,'---\ntype: daily\ndate: {{date:YYYY-MM-DD}}\n---\n# {{title}}\n\n## Tasks\n\n- [ ] \n\n## Work Log\n保留模板正文\n');
 const service=new DailyService(store,async day=>layout(day));return {store,service};
}
const decision=(id:string,text:string,fields:Partial<Decision>={}):Decision=>({id,text,action:'tomorrow',date:'2026-10-06',deadline:null,start:null,end:null,priority:'normal',reason:'继续处理',...fields});
const completedKeeps=(s:Snapshot)=>s.completed.map(t=>decision(t.id,t.text,{action:'keep',date:null}));
const review=(decisions:Decision[]):Review=>({summary:'完成记录整理，明天继续分析。',decisions,questions:[]});
async function draftFixture(){const f=fixture();const s=await f.service.snapshot('2026-10-05');const open=s.tasks.filter(t=>!t.done);const r=review([decision(open[0].id,'分析实验数据'),decision(open[1].id,'提交周报',{action:'future',date:'2026-10-09'}),...completedKeeps(s)]);return {...f,s,r,d:f.service.draft(s,r,false)};}

describe('Daily-only input and Markdown preservation',()=>{
 it('reads only current/target diary, template and queue; never scans history',async()=>{const {store,service}=fixture();store.files.set(path('2026-10-04'),'## Tasks\n- [ ] 不应读取');const s=await service.snapshot('2026-10-05');expect(store.reads).not.toContain(path('2026-10-04'));expect(s.tasks).toHaveLength(3);expect(reviewPayload(s,[],null).tasks).toHaveLength(2);});
 it('ignores task-like prose outside Tasks, code fences, empty template boxes',()=>{const raw='---\nexample: |\n  ## Tasks\n---\n## Captures\n- [ ] 非任务\n## Tasks\n- [ ] \n- [ ] 真任务\n```md\n## Tasks\n- [ ] 代码示例\n```\n### 子节\n- [x] 完成\n## End\n- [ ] 外部';expect(readTasks(raw).map(t=>t.text)).toEqual(['真任务','完成']);});
 it('rejects duplicate task headings rather than guessing',()=>expect(()=>readTasks('## Tasks\n- [ ] a\n## Tasks\n- [ ] b')).toThrow('多个'));
 it('retains task identity through next-day handoff; checkbox is completion authority',async()=>{const {service,store,d,s}=await draftFixture();await service.apply(d,async()=>{});const next=await service.snapshot('2026-10-06');expect(next.tasks[0].id).toBe(s.tasks[1].id);const p=path('2026-10-06');store.files.set(p,store.files.get(p)!.replace('- [ ] 分析','- [x] 分析'));expect(reviewPayload(await service.snapshot('2026-10-06'),[],null).tasks).toHaveLength(0);});
 it('human deletion is final; past diary does not revive the task',async()=>{const {service,store,d}=await draftFixture();await service.apply(d,async()=>{});const p=path('2026-10-06');store.files.set(p,store.files.get(p)!.replace(/^- \[ \] 分析.*\n/m,''));expect((await service.snapshot('2026-10-06')).tasks).toHaveLength(0);});
 it('preview is write-free; apply moves source without pretending completion',async()=>{const {store,service,s,d}=await draftFixture();expect(store.files.get(path('2026-10-05'))).toBe(s.today);expect(store.files.has(QUEUE_PATH)).toBe(false);await service.apply(d,async()=>{});const now=store.files.get(path('2026-10-05'))!;expect(now).toContain('- [x] 整理实验记录');expect(now).toContain('分析实验数据 → 已转至');expect(now).not.toContain('[x] 分析');expect(now).toContain('## Work Log\n人工日志\n');expect(now).toContain('## 晚间复盘');expect(parseQueue(store.files.get(QUEUE_PATH)!).tasks[0].date).toBe('2026-10-09');});
 it('merges an existing tomorrow preserving manual text and CRLF outside edits',async()=>{const {store,service}=fixture();const before='前言\r\n## Tasks\r\n- [ ] 10:00 - 11:00 培训\r\n\r\n## Work Log\r\n人工结尾';store.files.set(path('2026-10-06'),before);const s=await service.snapshot('2026-10-05');const d=service.draft(s,review([...s.tasks.filter(t=>!t.done).map(t=>decision(t.id,t.text)),...completedKeeps(s)]),false);const after=d.changes.find(c=>c.path===path('2026-10-06'))!.after;expect(after).toContain('- [ ] 10:00 - 11:00 培训\r\n');expect(after.endsWith('## Work Log\r\n人工结尾')).toBe(true);});
 it('only modifies source checkbox lines, preserving CRLF and accompanying notes',async()=>{const {service}=fixture('前言\r\n## Tasks\r\n- [ ] 分析\r\n  手工细节\r\n\r\n## Captures\r\n尾部');const s=await service.snapshot('2026-10-05');const d=service.draft(s,review([decision(s.tasks[0].id,'分析')]),false);expect(d.changes[1].after).toContain('  手工细节\r\n\r\n## Captures\r\n尾部');});
 it('uses the destination date for template variables; rejects unsupported scripts',()=>{expect(renderTemplate('{{date:YYYY-MM-DD}} {{title}}','2026-10-06','2026-10-06',(d)=>d)).toBe('2026-10-06 2026-10-06');expect(()=>renderTemplate('<% tp.file.title %>','2026-10-06','x',d=>d)).toThrow('Templater');});
 it('does not silently fall back when a configured template is absent',async()=>{const {store,service}=fixture();store.files.delete(template);await expect(service.snapshot('2026-10-05')).rejects.toThrow('模板');});
 it('creates missing current diary only after confirmation',async()=>{const {store,service}=fixture();store.files.delete(path('2026-10-05'));const s=await service.snapshot('2026-10-05');const d=service.draft(s,review([]),false);expect(store.files.has(path('2026-10-05'))).toBe(false);await service.apply(d,async()=>{});expect(store.files.get(path('2026-10-05'))).toContain('date: 2026-10-05');});
});

describe('Future task ownership and strict decisions',()=>{
 it('keeps far-future and overdue queue tasks without any history lookback',async()=>{const {store,service}=fixture('## Tasks\n');const ids=[crypto.randomUUID(),crypto.randomUUID()];store.files.set(QUEUE_PATH,renderQueue({type:'research-planner-future',version:1,reviewed:[],tasks:ids.map((id,i)=>({id,text:i?'未来':'已过期',date:i?'2026-10-09':'2026-10-04',start:null,end:null,deadline:null,priority:'normal'}))}));const s=await service.snapshot('2026-10-05'),r=review(s.queue.tasks.map(t=>decision(t.id,t.text,{action:'keep',date:t.date})));const d=service.draft(s,r,false);await service.apply(d,async()=>{});expect(parseQueue(store.files.get(QUEUE_PATH)!).tasks).toHaveLength(2);});
 it('hands a queue task into tomorrow and removes it from the pending registry',async()=>{const {store,service}=fixture('## Tasks\n');const id=crypto.randomUUID();store.files.set(QUEUE_PATH,renderQueue({type:'research-planner-future',version:1,reviewed:[],tasks:[{id,text:'组会',date:'2026-10-06',start:'14:00',end:'15:00',deadline:null,priority:'normal'}]}));const s=await service.snapshot('2026-10-05');await service.apply(service.draft(s,review([decision(id,'组会',{start:'15:00',end:'16:00'})]),false,['组会安排在15:00到16:00。']),async()=>{});expect(parseQueue(store.files.get(QUEUE_PATH)!).tasks).toHaveLength(0);expect((await service.snapshot('2026-10-06')).tasks[0].id).toBe(id);});
 it('cancellation and keeping a today task have visibly different results',async()=>{const {service,s,r}=await draftFixture();r.decisions[0].action='cancel';r.decisions[1].action='keep';const d=service.draft(s,r,false,["10 月 9 日提交周报留在原日记，不交接。"]);expect(d.changes[1].after).toContain('分析实验数据 → 已取消');expect(d.changes[1].after).toContain('- [ ] 10 月 9 日提交周报');expect(parseQueue(d.changes[2].after).tasks).toHaveLength(0);});
 it('rejects omitted, duplicate, unknown IDs and incorrect target dates',async()=>{const {service,s,r}=await draftFixture();expect(()=>service.draft(s,review([]),false)).toThrow('遗漏');expect(()=>service.draft(s,review([...r.decisions,r.decisions[0]]),false)).toThrow('重复');expect(()=>service.draft(s,review([...r.decisions,decision('bad','bad')]),false)).toThrow('未知');r.decisions[0].date='2026-10-07';expect(()=>service.draft(s,r,false)).toThrow('日期');});
 it('new tasks require user feedback and get persistent UUIDs',async()=>{const {service,s,r}=await draftFixture();r.decisions.push(decision('new:1','准备材料',{action:'future',date:'2026-10-08'}));expect(()=>service.draft(s,r,false)).toThrow('未知');const d=service.draft(s,r,true,["准备材料安排在2026-10-08。"]);expect(parseQueue(d.changes[2].after).tasks[1].id).toMatch(/^[0-9a-f-]{36}$/);});
 it('rejects a stale queue entry duplicating an already completed diary task',async()=>{const id=crypto.randomUUID(),{store,service}=fixture(`## Tasks\n- [x] 已完成 <!-- rp:${id} -->`);store.files.set(QUEUE_PATH,renderQueue({type:'research-planner-future',version:1,reviewed:[],tasks:[{id,text:'已完成',date:'2026-10-06',deadline:null,start:null,end:null,priority:'normal'}]}));await expect(service.snapshot('2026-10-05')).rejects.toThrow('重复');});
 it('rejects summary headings that could create a duplicate task section',async()=>{const {service,s,r}=await draftFixture();r.summary='## Tasks\n- [ ] 注入';expect(()=>service.draft(s,r,false)).toThrow('总结');});
 it('rejects checkbox or internal-marker injection in titles',async()=>{const {service,s,r}=await draftFixture();r.decisions[0].text='bad\n- [ ] injected';expect(()=>service.draft(s,r,false)).toThrow();r.decisions[0].text='<!-- research-planner:review:end -->';expect(()=>service.draft(s,r,false)).toThrow();});
 it('never invents duration; accepts start-only tasks',async()=>{const {service,s,r}=await draftFixture();r.decisions[0].start='15:00';const d=service.draft(s,r,false,["分析实验数据15:00开始。"]);expect(d.changes[0].after).toContain('15:00 分析实验数据');expect(d.changes[0].after).not.toContain('分钟');});
 it('blocks unresolved questions and time overlap before writing',async()=>{const {service,s,r}=await draftFixture();r.questions=['日期不明确'];await expect(service.apply(service.draft(s,r,false),async()=>{})).rejects.toThrow('待确认');r.questions=[];s.tomorrow='## Tasks\n- [ ] 10:00 - 11:00 培训';s.existing=readTasks(s.tomorrow);r.decisions[0].start='10:30';r.decisions[0].end='11:30';const d=service.draft(s,r,false,["分析实验数据安排在10:30到11:30。"]);expect(d.warnings[0]).toContain('冲突');await expect(service.apply(d,async()=>{})).rejects.toThrow('冲突');});
 it('rejects duplicate tasks already in tomorrow instead of double scheduling',async()=>{const {service,s,r}=await draftFixture();s.tomorrow='## Tasks\n- [ ] 分析实验数据';s.existing=readTasks(s.tomorrow);expect(()=>service.draft(s,r,false)).toThrow('同名');});
});

describe('Multi-file confirmation, conflicts and recovery',()=>{
 it.each(['today','tomorrow','queue'])('rejects %s edits after preview before any write',async key=>{const {service,store,d}=await draftFixture();const p=key==='today'?path('2026-10-05'):key==='tomorrow'?path('2026-10-06'):QUEUE_PATH;store.files.set(p,'人工修改');const before=new Map(store.files);await expect(service.apply(d,async()=>{})).rejects.toThrow('变化');expect(store.files).toEqual(before);});
 it('checks unchanged tomorrow files too',async()=>{const {service,store}=fixture('## Tasks\n');store.files.set(path('2026-10-06'),'## Tasks\n- [ ] 预先安排');const s=await service.snapshot('2026-10-05'),d=service.draft(s,review([]),false);store.files.set(path('2026-10-06'),'改动');await expect(service.apply(d,async()=>{})).rejects.toThrow('变化');});
 it('checks template drift',async()=>{const {service,store,d}=await draftFixture();store.files.set(template,'新模板');await expect(service.apply(d,async()=>{})).rejects.toThrow('模板');});
 it('failure to persist the recovery journal prevents all writes',async()=>{const {service,store,d}=await draftFixture();const before=new Map(store.files);await expect(service.apply(d,async()=>{throw new Error('storage full');})).rejects.toThrow('storage full');expect(store.files).toEqual(before);});
 it('mid-batch failure rolls back previous changes without deleting files',async()=>{const {service,store,d,s}=await draftFixture();store.failPath=path('2026-10-05');store.failOnce=true;let journal!:BatchJournal;await expect(service.apply(d,async j=>{journal=j;})).rejects.toThrow('已恢复');expect(store.files.get(path('2026-10-05'))).toBe(s.today);expect(store.files.get(path('2026-10-06'))).toBe('');expect(journal.state).toBe('reverted');});
 it('undo restores all three files, but refuses later edits',async()=>{const {service,store,d,s}=await draftFixture();let j!:BatchJournal;await service.apply(d,async x=>{j=x;});const saved=store.files.get(QUEUE_PATH)!;store.files.set(QUEUE_PATH,saved+'edited');await expect(service.revert(j)).rejects.toThrow('拒绝');store.files.set(QUEUE_PATH,saved);await service.revert(j);expect(store.files.get(path('2026-10-05'))).toBe(s.today);expect(store.files.get(path('2026-10-06'))).toBe('');expect(store.files.get(QUEUE_PATH)).toBe('');});
 it('repeating confirmation or accepting a stale second-device preview fails safely',async()=>{const {service,store,d}=await draftFixture();const other=new DailyService(store,async day=>layout(day));const s2=await other.snapshot('2026-10-05'),d2=other.draft(s2,review([...s2.tasks.filter(t=>!t.done).map(t=>decision(t.id,t.text)),...completedKeeps(s2)]),false);await service.apply(d,async()=>{});await expect(service.apply(d,async()=>{})).rejects.toThrow('变化');await expect(other.apply(d2,async()=>{})).rejects.toThrow('变化');expect(readTasks(store.files.get(path('2026-10-06'))!)).toHaveLength(1);});
 it('retains a pending recovery record when concurrent edits prevent rollback',async()=>{const {service,store,d}=await draftFixture();const write=store.compareWrite.bind(store);store.compareWrite=async(p,b,a)=>{if(p===path('2026-10-05')){store.files.set(path('2026-10-06'),'另一设备编辑');throw new Error('failure');}await write(p,b,a);};let j!:BatchJournal;await expect(service.apply(d,async x=>{j=x;})).rejects.toThrow('未覆盖');expect(j.state).toBe('pending');expect(store.files.get(path('2026-10-06'))).toBe('另一设备编辑');});
 it('can start again after reverting newly created queue and diary files',async()=>{const {service,store,d}=await draftFixture();let j!:BatchJournal;await service.apply(d,async x=>{j=x;});await service.revert(j);const s=await service.snapshot('2026-10-05');expect(s.queue.tasks).toHaveLength(0);const r=review([...s.tasks.filter(t=>!t.done).map(t=>decision(t.id,t.text)),...completedKeeps(s)]);const retry=service.draft(s,r,false);expect(retry.changes.find(c=>c.path===path('2026-10-06'))!.after).toContain('date: 2026-10-06');});
 it('adjacent time blocks do not conflict; a start-only task inside a block does',async()=>{const {service,s,r}=await draftFixture();s.tomorrow='## Tasks\n- [ ] 10:00 - 11:00 培训';s.existing=readTasks(s.tomorrow);r.decisions[0].start='09:00';r.decisions[0].end='10:00';expect(service.draft(s,r,false,["分析实验数据安排在09:00到10:00。"]).warnings).toEqual([]);r.decisions[0].start='10:30';r.decisions[0].end=null;expect(service.draft(s,r,false,["分析实验数据10:30开始。"]).warnings[0]).toContain('冲突');});
 it('refuses invalid recovery paths',async()=>{const {service}=fixture();await expect(service.revert({version:2,day:'2026-10-05',state:'pending',changes:[{path:'private.md',before:'a',after:'b'}]})).rejects.toThrow('路径');});
 it('respects disabled writes in central config',async()=>{const {store,d}=await draftFixture();const service=new DailyService(store,async day=>({...layout(day),enabled:false}));await expect(service.apply(d,async()=>{})).rejects.toThrow('false');});
});

describe('Completed work with explicit follow-up',()=>{
 it('offers checked tasks and their indented continuation, excluding a separate unchecked subtask',async()=>{
  const {service}=fixture('## Tasks\n- [x] 调试告一段落\n  后续10月9日继续验证稳定性\n  - [ ] 独立子任务\n## Work Log\n后续不从这里创建任务\n');
  const s=await service.snapshot('2026-10-05'),payload=reviewPayload(s,[],null);
  expect(payload.completed).toHaveLength(1);expect(payload.completed[0].details).toBe('后续10月9日继续验证稳定性');
  expect(payload.tasks).toHaveLength(1);expect(payload.completed[0].text).toBe('调试告一段落');
 });
 it('keeps checked text and CRLF while registering an independent future task only after acceptance',async()=>{
  const id=crypto.randomUUID(),raw=`## Tasks\r\n- [X] 今天调试结束，后续10月9日验证稳定性 <!-- rp:${id} -->\r\n\r\n## Work Log\r\n人工日志\r\n`;
  const {service,store}=fixture(raw),s=await service.snapshot('2026-10-05');
  const d=service.draft(s,review([decision(s.completed[0].id,'验证稳定性',{action:'future',date:'2026-10-09'})]),false);
  expect(store.files.get(path('2026-10-05'))).toBe(raw);expect(store.files.has(QUEUE_PATH)).toBe(false);
  await service.apply(d,async()=>{});
  const after=store.files.get(path('2026-10-05'))!,q=parseQueue(store.files.get(QUEUE_PATH)!);
  expect(after).toContain('- [X] 今天调试结束，后续10月9日验证稳定性\r\n');expect(after).not.toContain('<!-- rp');expect(q.diaries?.find(n=>n.day==='2026-10-05')?.tasks[0].reviewedDigest).toBe(s.completed[0].digest);
  expect(after).toContain('\r\n\r\n## Work Log\r\n人工日志\r\n');expect(q.tasks[0].id).not.toBe(id);expect(q.tasks[0].text).toBe('验证稳定性');
  const again=await service.snapshot('2026-10-05');expect(again.completed).toHaveLength(0);expect(again.tasks[0].done).toBe(true);
  const second=service.draft(again,review(again.queue.tasks.map(t=>decision(t.id,t.text,{action:'keep',date:t.date}))),false);
  await service.apply(second,async()=>{});expect(parseQueue(store.files.get(QUEUE_PATH)!).tasks).toHaveLength(1);
 });
 it('hands completed follow-up to tomorrow without reusing the completed task ID',async()=>{
  const {service,store}=fixture('## Tasks\n- [x] 已整理初稿，明天补充实验部分\n'),s=await service.snapshot('2026-10-05');
  await service.apply(service.draft(s,review([decision(s.completed[0].id,'补充实验部分')]),false),async()=>{});
  const next=readTasks(store.files.get(path('2026-10-06'))!);expect(next[0].text).toBe('补充实验部分');expect(next[0].done).toBe(false);expect(next[0].id).not.toBe(s.completed[0].id);
  expect((await service.snapshot('2026-10-05')).completed).toHaveLength(0);
 });
 it('plain completion may be acknowledged without inventing work; changed continuation is rechecked',async()=>{
  const {service,store}=fixture('## Tasks\n- [x] 已提交报告\n'),s=await service.snapshot('2026-10-05');
  await service.apply(service.draft(s,review(completedKeeps(s)),false),async()=>{});
  expect(parseQueue(store.files.get(QUEUE_PATH)!).tasks).toHaveLength(0);
  expect((await service.snapshot('2026-10-05')).completed).toHaveLength(0);
  store.files.set(path('2026-10-05'),store.files.get(path('2026-10-05'))!.replace('已提交报告','已提交报告，10月9日收集反馈'));
  expect((await service.snapshot('2026-10-05')).completed).toHaveLength(1);
 });
 it('changed indented prose also invalidates the receipt',async()=>{
  const {service,store}=fixture('## Tasks\n- [x] 调试\n  今日已完成\n'),s=await service.snapshot('2026-10-05');
  await service.apply(service.draft(s,review(completedKeeps(s)),false),async()=>{});
  store.files.set(path('2026-10-05'),store.files.get(path('2026-10-05'))!.replace('今日已完成','后续10月9日继续验证'));
  expect((await service.snapshot('2026-10-05')).completed[0].details).toBe('后续10月9日继续验证');
 });
 it('does not silently omit a checked item; ambiguous follow-up blocks writes and creates no receipt',async()=>{
  const {service,store}=fixture('## Tasks\n- [x] 调试完成，过几天继续验证\n'),s=await service.snapshot('2026-10-05');
  expect(()=>service.draft(s,review([]),false)).toThrow('遗漏');
  const r=review(completedKeeps(s));r.questions=['具体哪天验证？'];
  await expect(service.apply(service.draft(s,r,false),async()=>{})).rejects.toThrow('待确认');
  expect(store.files.get(path('2026-10-05'))).not.toContain('rp-reviewed');
  expect(()=>service.draft(s,review([decision(s.completed[0].id,'调试',{action:'cancel',date:null})]),false)).toThrow('原状态');
 });
 it('blocks duplicate future work already in the queue',async()=>{
  const {service,store}=fixture('## Tasks\n- [x] 调试完成，10月9日验证\n');
  store.files.set(QUEUE_PATH,renderQueue({type:'research-planner-future',version:1,reviewed:[],tasks:[{id:crypto.randomUUID(),text:'验证',date:'2026-10-09',deadline:null,start:null,end:null,priority:'normal'}]}));
  const s=await service.snapshot('2026-10-05');
  expect(()=>service.draft(s,review([decision(s.completed[0].id,'验证',{action:'future',date:'2026-10-09'}),decision(s.queue.tasks[0].id,'验证',{action:'keep',date:'2026-10-09'})]),false)).toThrow('同日期同名');
 });
 it('undo removes the processed receipt along with the registered follow-up',async()=>{
  const {service,store}=fixture('## Tasks\n- [x] 调试完成，10月9日验证\n'),s=await service.snapshot('2026-10-05');let journal!:BatchJournal;
  await service.apply(service.draft(s,review([decision(s.completed[0].id,'验证',{action:'future',date:'2026-10-09'})]),false),async j=>{journal=j;});
  await service.revert(journal);expect(store.files.get(path('2026-10-05'))).toBe(s.today);expect((await service.snapshot('2026-10-05')).completed).toHaveLength(1);
 });
 it('accepting an old disabled configuration needs a fresh snapshot; fresh review succeeds',async()=>{
  const {store}=fixture('## Tasks\n- [ ] 验证\n');let enabled=false;
  const service=new DailyService(store,async day=>({...layout(day),enabled})),s=await service.snapshot('2026-10-05');
  const d=service.draft(s,review([decision(s.tasks[0].id,'验证')]),false);enabled=true;
  await expect(service.apply(d,async()=>{})).rejects.toThrow('重新读取');
  const fresh=await service.snapshot('2026-10-05');await service.apply(service.draft(fresh,review([decision(fresh.tasks[0].id,'验证')]),false),async()=>{});
  expect(store.files.get(path('2026-10-06'))).toContain('- [ ] 验证');
 });
});
