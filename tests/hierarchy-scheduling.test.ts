import {describe,it,expect} from 'vitest';
import {addDay,type Store} from '../src/core';
import {DailyService,QUEUE_PATH,parseQueue,pendingTasks,readTasks,reviewPayload,type Snapshot,type Review} from '../src/daily';


const day='2026-10-09',path=(d:string)=>`${d}.md`;
function fixture(raw:string,target='## Tasks\n') {
 const files=new Map([[path(day),raw],[path(addDay(day,1)),target],['template.md','## Tasks\n']]);
 const store:Store={read:async p=>files.get(p)??null,list:async()=>[],create:async(p,s)=>{files.set(p,s);},compareWrite:async(p,b,s)=>{if(files.get(p)!==b)throw Error('conflict');files.set(p,s);},compareRemove:async(p)=>{files.delete(p);}};
 const service=new DailyService(store,async d=>({day:d,todayPath:path(d),tomorrowPath:path(addDay(d,1)),templatePath:'template.md',heading:'Tasks',enabled:true}));
 return {files,service};
}
function review(s:Snapshot):Review{return {summary:'按所选日期整理任务。',questions:[],decisions:[...pendingTasks(s),...s.completed,...s.queue.tasks].map(t=>({id:t.id,text:t.text,action:'done' in t&&t.done?'keep':s.target,date:'done' in t&&t.done?null:s.targetDay,start:null,end:null,deadline:null,priority:'normal',reason:'继续'}))};}

describe('Task hierarchy survives scheduling',()=>{
 it('keeps three levels and original sibling order even if model reverses decisions, with stable identities',async()=>{
  const {files,service}=fixture('## Tasks\n- [ ] 实现功能\n\t- [ ] 编写模块\n\t\t- [ ] 验证结果\n\t- [ ] 更新文档\n');
  const s=await service.snapshot(day),r=review(s);r.decisions.reverse();
  expect(reviewPayload(s,[],null).tasks[2].ancestry).toEqual(['实现功能','编写模块']);
  await service.apply(service.draft(s,r,false),async()=>{});
  const raw=files.get(path('2026-10-10'))!;
  expect(raw).toContain('- [ ] 实现功能\n    - [ ] 编写模块\n        - [ ] 验证结果\n    - [ ] 更新文档');
  const next=await service.snapshot('2026-10-10');expect(next.tasks.map(t=>t.id)).toEqual(s.tasks.map(t=>t.id));
  expect(raw).not.toContain('<!-- rp:');
 });
 it('distinguishes identically named steps under different parents after reload',async()=>{
  const {service}=fixture('## Tasks\n- [ ] 项目甲\n  - [ ] 测试\n- [ ] 项目乙\n  - [ ] 测试\n');
  const s=await service.snapshot(day);await service.apply(service.draft(s,review(s),false),async()=>{});
  const next=await service.snapshot('2026-10-10');expect(next.tasks.map(t=>t.id)).toEqual(s.tasks.map(t=>t.id));
 });
 it('keeps plain list parents without duplicating them as continuation prose',async()=>{
  const {files,service}=fixture('## Tasks\n1. [ ] 主任务\n    - 操作步骤\n        - [ ] 子步骤\n          具体说明\n');
  const s=await service.snapshot(day);await service.apply(service.draft(s,review(s),false),async()=>{});
  const raw=files.get(path('2026-10-10'))!;expect(raw.match(/操作步骤/g)).toHaveLength(1);
  expect(readTasks(raw)[1].parents.map(t=>t.text)).toEqual(['主任务','操作步骤']);
  expect(readTasks(raw)[1].details).toBe('具体说明');
 });
 it('uses completed parents as context without resurrecting completed checkboxes',async()=>{
  const {files,service}=fixture('## Tasks\n- [x] 主任务\n  - [ ] 尚需处理\n  - [x] 已做步骤\n');
  const s=await service.snapshot(day);await service.apply(service.draft(s,review(s),false),async()=>{});
  const raw=files.get(path('2026-10-10'))!;expect(raw).toContain('- 主任务\n    - [ ] 尚需处理');expect(readTasks(raw)).toHaveLength(1);
  expect(files.get(path(day))).toContain('- [x] 主任务');
 });
 it('merges a moved child under an existing parent and preserves CRLF and unrelated prose',async()=>{
  const {files,service}=fixture('## Tasks\n- 主任务\n  - [ ] 新步骤\n','## Tasks\r\n- [ ] 主任务\r\n    - [ ] 已有步骤\r\n\r\n## Work Log\r\n人工正文\r\n');
  const s=await service.snapshot(day);await service.apply(service.draft(s,review(s),false),async()=>{});
  const raw=files.get(path('2026-10-10'))!;expect(raw.match(/主任务/g)).toHaveLength(1);
  expect(raw).toContain('    - [ ] 已有步骤\r\n    - [ ] 新步骤');expect(raw).toContain('## Work Log\r\n人工正文');
 });
 it('retains ancestry through the future queue and delivery on its explicit day',async()=>{
  const {files,service}=fixture('## Tasks\n- [ ] 项目\n  - [ ] 10月12日执行步骤\n');
  const s=await service.snapshot(day),r=review(s);Object.assign(r.decisions[1],{action:'future',date:'2026-10-12'});await service.apply(service.draft(s,r,false),async()=>{});
  const q=parseQueue(files.get(QUEUE_PATH)!);expect(q.tasks[0].ancestry).toEqual(['项目']);
  const later=await service.snapshot('2026-10-11');await service.apply(service.draft(later,review(later),false),async()=>{});
  expect(files.get(path('2026-10-12'))).toContain('- 项目\n    - [ ] 10月12日执行步骤');
 });
 it('preserves current-day nesting and IDs when parent text changes',async()=>{
  const {service}=fixture('## Tasks\n- [ ] 项目\n  - [ ] 步骤\n');const s=await service.snapshot(day,{target:'today'}),r=review(s);r.decisions[0].text='项目新名称';
  await service.apply(service.draft(s,r,false),async()=>{});const next=await service.snapshot(day,{target:'today'});
  expect(next.tasks.map(t=>t.id)).toEqual(s.tasks.map(t=>t.id));expect(next.tasks[1].parents[0].text).toBe('项目新名称');
 });
});

describe('Model semantics with deterministic write validation',()=>{
 it.each(['下个月最后一个工作日前一天提醒','收到邀请后下周再处理','23号分享，21号准备，20号提醒','月底再说，不是今天'])('preserves a model-resolved date without matching grammar: %s',async text=>{
  const {service}=fixture(`## Tasks\n- [ ] ${text}\n`),s=await service.snapshot(day),r=review(s);
  Object.assign(r.decisions[0],{timing:'explicit',action:'future',date:'2026-11-27',timeSpecified:true,start:'13:30',end:null});
  const d=service.draft(s,r,false);expect(d.review.decisions[0]).toEqual(r.decisions[0]);expect(d.review.questions).toEqual([]);expect(d.warnings).toEqual([]);
 });
 it('rejects contradictory ASAP metadata instead of changing the proposed date',async()=>{
  const {service,files}=fixture('## Tasks\n- [ ] 分析数据\n'),s=await service.snapshot(day),r=review(s),before=new Map(files);
  Object.assign(r.decisions[0],{timing:'asap',action:'future',date:'2026-10-20'});
  expect(()=>service.draft(s,r,false)).toThrow('timing=asap');expect(r.decisions[0].date).toBe('2026-10-20');expect(files).toEqual(before);
 });
 it('rejects invented-time metadata and retains explicitly classified times',async()=>{
  const {service}=fixture('## Tasks\n- [ ] 午饭后半小时讨论\n'),s=await service.snapshot(day),r=review(s);
  Object.assign(r.decisions[0],{timeSpecified:false,start:'13:30'});expect(()=>service.draft(s,r,false)).toThrow('未指定时刻');
  r.decisions[0].timeSpecified=true;expect(service.draft(s,r,false).review.decisions[0].start).toBe('13:30');
 });
 it('allows pronoun evidence and does not turn background dates into mandatory tasks',async()=>{
  const {service}=fixture('## Tasks\n- [ ] 23号分享；21号是参考背景\n'),s=await service.snapshot(day),r=review(s);
  Object.assign(r.decisions[0],{action:'future',date:'2026-10-22',scheduleEvidence:{source:'feedback',quote:'这个提前一天就行'}});
  const d=service.draft(s,r,false,['这个提前一天就行']);expect(d.review.questions).toEqual([]);expect(d.review.decisions[0].date).toBe('2026-10-22');
 });
 it('validates optional quote existence but does not require an exact title',async()=>{
  const {service}=fixture('## Tasks\n- [ ] 复杂任务完整标题\n'),s=await service.snapshot(day),r=review(s);
  r.decisions[0].scheduleEvidence={source:'feedback',quote:'它顺延到月底'};
  expect(()=>service.draft(s,r,false,[])).toThrow('逐字引用');expect(()=>service.draft(s,r,false,['它顺延到月底'])).not.toThrow();
 });
 it('supports source-linked splitting without mandatory quotations and preserves ancestry',async()=>{
  const {service}=fixture('## Tasks\n- 活动\n  - [ ] 连续三天参会\n'),s=await service.snapshot(day),r=review(s);
  Object.assign(r.decisions[0],{action:'future',date:'2026-10-17',text:'第一天'});
  r.decisions.push({...r.decisions[0],id:'new:1',sourceTaskId:s.tasks[0].id,text:'第二天',date:'2026-10-18'});
  const d=service.draft(s,r,false),q=parseQueue(d.changes.find(c=>c.path===QUEUE_PATH)!.after);
  expect(q.tasks.every(t=>t.ancestry?.[0]==='活动')).toBe(true);
  r.decisions[1].sourceTaskId='missing';expect(()=>service.draft(s,r,false)).toThrow('来源 ID');
 });
 it('keeps explicit uncertainty blocking acceptance',async()=>{
  const {service,files}=fixture('## Tasks\n- [ ] 活动前一天提醒\n'),s=await service.snapshot(day),r=review(s),before=new Map(files);
  r.questions=['指准备开始前一天还是活动前一天？'];await expect(service.apply(service.draft(s,r,false),async()=>{})).rejects.toThrow('待确认');expect(files).toEqual(before);
 });
 it('does not classify a timed reminder overlapping an appointment as two competing appointments',async()=>{
  const {service}=fixture('## Tasks\n- [ ] 提醒看消息\n','## Tasks\n- [ ] 13:00 - 14:00 开会\n'),s=await service.snapshot(day),r=review(s);
  Object.assign(r.decisions[0],{start:'13:30',timeSpecified:true,category:'reminder'});
  expect(service.draft(s,r,false).warnings).toEqual([]);r.decisions[0].category='event';
  expect(service.draft(s,r,false).warnings.join()).toContain('时间可能冲突');
 });
});
