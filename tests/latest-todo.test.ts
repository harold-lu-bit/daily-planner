import {describe,it,expect} from 'vitest';
import {addDay,type Store} from '../src/core';
import {DailyService,QUEUE_PATH,parseQueue,pendingTasks,readTasks,renderQueue,reviewPayload,type Snapshot,type Review,type BatchJournal} from '../src/daily';
const day='2026-10-12',path=(d:string)=>`daily/${d}.md`;
function fixture(){
 const files=new Map<string,string>([['template.md','## Tasks\n'],[QUEUE_PATH,renderQueue({type:'research-planner-future',version:2,reviewed:['2026-10-09'],tasks:[]})]]),reads:string[]=[];
 const store:Store={read:async p=>{reads.push(p);return files.get(p)??null;},list:async()=>{throw Error('No Vault scan');},create:async(p,s)=>{if(files.has(p))throw Error('exists');files.set(p,s);},compareWrite:async(p,b,s)=>{if(files.get(p)!==b)throw Error('conflict');files.set(p,s);},compareRemove:async(p,b)=>{if(files.get(p)!==b)throw Error('conflict');files.set(p,'');}};
 const service=new DailyService(store,async d=>({day:d,todayPath:path(d),tomorrowPath:path(addDay(d,1)),templatePath:'template.md',heading:'Tasks',enabled:true}));
 return {files,reads,service};
}
function review(s:Snapshot):Review{return {summary:'接续最新清单。',questions:[],decisions:[...pendingTasks(s).map(t=>({id:t.id,text:t.text,action:s.target,date:s.targetDay,start:null,end:null,deadline:null,priority:'normal' as const,reason:'继续'})),...s.completed.map(t=>({id:t.id,text:t.text,action:'keep' as const,date:null,start:null,end:null,deadline:null,priority:'normal' as const,reason:'保留完成'})),...s.queue.tasks.map(t=>({...t,action:'keep' as const,reason:'旧清单继续保留'}))]};}
const latest={sourceMode:'latest' as const,catchUp:true};
describe('Resume the latest manually maintained TODO',()=>{
 it.each(['today','tomorrow'] as const)('resumes a reviewed old checklist after a gap for %s, including edits and additions',async target=>{
  const {files,reads,service}=fixture();files.set(path('2026-10-09'),'## Tasks\n- [ ] 项目\n  - [x] 已完成步骤\n  - [ ] 修改后的步骤\n- [ ] 新增任务\n');files.set(path('2026-10-08'),'## Tasks\n- [ ] 不应复活的旧清单\n');
  const before=new Map(files),s=await service.snapshot(day,{...latest,target});
  expect(s.history.map(n=>n.day)).toEqual(['2026-10-09']);expect(reads).not.toContain(path('2026-10-08'));
  expect(reviewPayload(s,[],null).authoritativeTodoDay).toBe('2026-10-09');expect(pendingTasks(s).map(t=>t.text)).toEqual(['项目','修改后的步骤','新增任务']);
  const r=review(s);
  const d=service.draft(s,r,false);expect(files).toEqual(before);expect(d.review.decisions.filter(t=>t.action===target)).toHaveLength(3);
  await service.apply(d,async()=>{});const raw=files.get(path(s.targetDay))!;expect(raw).toContain('- [ ] 项目\n    - [ ] 修改后的步骤');expect(raw).toContain('- [ ] 新增任务');expect(raw).not.toContain('已完成步骤');
  expect(files.get(path('2026-10-09'))).toContain('- [x] 已完成步骤');expect(parseQueue(files.get(QUEUE_PATH)! ).tasks).toHaveLength(0);expect(files.has(path('2026-10-10'))).toBe(false);
 });
 it('uses today when it has a checklist, without merging older versions',async()=>{
  const {files,reads,service}=fixture();files.set(path(day),'## Tasks\n- [ ] 当前整理稿\n');files.set(path('2026-10-09'),'## Tasks\n- [ ] 旧版\n');const s=await service.snapshot(day,latest);
  expect(s.history).toHaveLength(0);expect(pendingTasks(s).map(t=>t.text)).toEqual(['当前整理稿']);expect(reads).not.toContain(path('2026-10-09'));
 });
 it('stops at an all-completed latest checklist instead of resurrecting older work',async()=>{
  const {files,reads,service}=fixture();files.set(path('2026-10-11'),'## Tasks\n- [x] 已经完成\n');files.set(path('2026-10-09'),'## Tasks\n- [ ] 旧状态\n');const s=await service.snapshot(day,latest);
  expect(pendingTasks(s)).toHaveLength(0);expect(s.completed).toHaveLength(1);expect(reads).not.toContain(path('2026-10-09'));
 });
 it.each([day,'2026-10-11'])('honors deletion of a known checklist on %s',async d=>{
  const {files,reads,service}=fixture();files.set(path(d),'## Tasks\n');files.set(path('2026-10-09'),'## Tasks\n- [ ] 旧状态\n');files.set(QUEUE_PATH,renderQueue({type:'research-planner-future',version:2,reviewed:[],tasks:[],diaries:[{day:d,path:path(d),tasks:[{id:crypto.randomUUID(),text:'已删除',details:''}]}]}));
  const s=await service.snapshot(day,latest);expect(pendingTasks(s)).toHaveLength(0);expect(reads).not.toContain(path('2026-10-09'));
  await service.apply(service.draft(s,review(s),false),async()=>{});
  const again=await service.snapshot(day,latest);expect(pendingTasks(again)).toHaveLength(0);expect(reads).not.toContain(path('2026-10-09'));
  expect(parseQueue(files.get(QUEUE_PATH)!).diaries?.find(n=>n.path===path(d))).toMatchObject({wasChecklist:true,tasks:[]});
 });
 it.each(['2026-10-11','2026-10-09'])('rejects changes to source or a newer empty/missing note (%s) before writing',async changed=>{
  const {files,service}=fixture();files.set(path('2026-10-09'),'## Tasks\n- [ ] 待办\n');const s=await service.snapshot(day,latest),d=service.draft(s,review(s),false);
  files.set(path(changed),'## Tasks\n- [ ] 新编辑\n');const before=new Map(files);await expect(service.apply(d,async()=>{})).rejects.toThrow('变化');expect(files).toEqual(before);
 });
 it('does not mutate newer empty diary prose and restores the source checklist on undo',async()=>{
  const {files,service}=fixture();files.set(path('2026-10-09'),'## Tasks\n- [ ] 待办\n');const empty='## Tasks\n\n## Work Log\n只写了日志\n';files.set(path('2026-10-11'),empty);
  const s=await service.snapshot(day,latest),d=service.draft(s,review(s),false);expect(d.changes.some(c=>c.path===path('2026-10-11'))).toBe(false);
  let journal!:BatchJournal;await service.apply(d,async j=>{journal=j;});await service.revert(journal);expect(files.get(path('2026-10-09'))).toBe('## Tasks\n- [ ] 待办\n');expect(files.get(path('2026-10-11'))).toBe(empty);
 });
 it('bounds the search and explicitly reports when no checklist was found',async()=>{
  const {service,reads}=fixture();const s=await service.snapshot(day,latest);expect(s.probes).toHaveLength(30);expect(s.warnings.join()).toContain('未找到 TODO');expect(reads).not.toContain(path(addDay(day,-31)));
 });
 it('schedules model-classified overdue/due queue items, while retaining a genuinely future appointment',async()=>{
  const {files,service}=fixture();files.set(QUEUE_PATH,renderQueue({type:'research-planner-future',version:2,reviewed:[],tasks:['2026-10-09','2026-10-12','2026-10-20'].map((date,i)=>({id:crypto.randomUUID(),text:'事项'+i,date,deadline:null,start:null,end:null,priority:'normal'}))}));
  const s=await service.snapshot(day,{...latest,target:'today'}),r=review(s);for(const t of r.decisions)if(t.date!<=day)Object.assign(t,{action:'today',date:day,timing:'asap'});const d=service.draft(s,r,false);await service.apply(d,async()=>{});
  expect(readTasks(files.get(path(day))!).map(t=>t.text)).toEqual(['事项0','事项1']);expect(parseQueue(files.get(QUEUE_PATH)!).tasks.map(t=>t.date)).toEqual(['2026-10-20']);
 });
 it('still respects an explicit request to leave overdue queued work unassigned',async()=>{
  const {files,service}=fixture();files.set(QUEUE_PATH,renderQueue({type:'research-planner-future',version:2,reviewed:[],tasks:[{id:crypto.randomUUID(),text:'等待反馈',date:'2026-10-09',deadline:null,start:null,end:null,priority:'normal'}]}));
  const s=await service.snapshot(day,latest);expect(service.draft(s,review(s),false,['等待反馈暂不安排。']).review.decisions[0].action).toBe('keep');
 });
 it('rejects an undated future bucket instead of guessing a replacement',async()=>{
  const {files,service}=fixture();files.set(path('2026-10-09'),'## Tasks\n- [ ] 未完成工作\n');const s=await service.snapshot(day,latest),r=review(s);Object.assign(r.decisions[0],{action:'future',date:null});
  expect(()=>service.draft(s,r,false)).toThrow('未来任务');
 });
});
