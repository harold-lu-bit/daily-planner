import {describe,it,expect} from 'vitest';
import {addDay,type Store} from '../src/core';
import {DailyService,QUEUE_PATH,parseQueue,pendingTasks,readTasks,reviewPayload,type Snapshot,type Review} from '../src/daily';
import {scheduleDates} from '../src/scheduling';

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
  const s=await service.snapshot(day);await service.apply(service.draft(s,review(s),false),async()=>{});
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
describe('Dates and times require user evidence',()=>{
 it.each(['today','tomorrow'] as const)('never postpones undated work for capacity when targeting %s',async target=>{
  const {files,service}=fixture('## Tasks\n- [ ] 分析数据\n- [ ] 编写报告\n');const s=await service.snapshot(day,{target}),r=review(s);
  Object.assign(r.decisions[0],{action:'future',date:'2026-10-20',reason:'任务太多，延后'});Object.assign(r.decisions[1],{action:'keep',date:null});
  const d=service.draft(s,r,false);expect(d.review.decisions.every(t=>t.date===s.targetDay&&t.action===target)).toBe(true);
  await service.apply(d,async()=>{});expect(parseQueue(files.get(QUEUE_PATH)!).tasks).toHaveLength(0);
 });
 it('treats a deadline as ASAP, while respecting explicit appointments and inherited dates',async()=>{
  const {service}=fixture('## Tasks\n- [ ] 报告 📅 2026-10-20\n- [ ] 10月12日组会\n  - [ ] 展示实验\n');const s=await service.snapshot(day),d=service.draft(s,review(s),false);
  expect(d.review.decisions.map(t=>t.date)).toEqual(['2026-10-10','2026-10-12','2026-10-12']);
 });
 it('accepts task-specific rescheduling without letting another task borrow that date',async()=>{
  const {service}=fixture('## Tasks\n- [ ] 分析数据\n- [ ] 编写报告\n');const s=await service.snapshot(day),r=review(s);
  for(const t of r.decisions)Object.assign(t,{action:'future',date:'2026-10-15'});
  const d=service.draft(s,r,false,['分析数据安排在2026-10-15，编写报告尽快完成。']);
  expect(d.review.decisions.map(t=>t.date)).toEqual(['2026-10-15','2026-10-10']);
 });
 it('does not accept fabricated evidence or negative postponement instructions',async()=>{
  const {service}=fixture('## Tasks\n- [ ] 分析数据\n');const s=await service.snapshot(day),r=review(s);
  Object.assign(r.decisions[0],{action:'future',date:'2026-10-15',scheduleEvidence:{source:'feedback',quote:'分析数据安排在2026-10-15'}});
  expect(service.draft(s,r,false,['分析数据不要安排到2026-10-15。']).review.decisions[0].date).toBe(s.targetDay);
 });
 it('removes invented clock times and accepts explicitly named times',async()=>{
  const {service}=fixture('## Tasks\n- [ ] 分析数据\n');const s=await service.snapshot(day),r=review(s);Object.assign(r.decisions[0],{start:'15:00',end:'16:00'});
  expect(service.draft(s,r,false).review.decisions[0]).toMatchObject({start:null,end:null});
  expect(service.draft(s,r,false,['分析数据15点到16点。']).review.decisions[0]).toMatchObject({start:'15:00',end:'16:00'});
 });
 it('continues blocking unresolved questions after local scheduling correction',async()=>{
  const {service,files}=fixture('## Tasks\n- [ ] 分析数据\n'),before=new Map(files),s=await service.snapshot(day),r=review(s);r.questions=['实验范围待确认'];
  await expect(service.apply(service.draft(s,r,false),async()=>{})).rejects.toThrow('待确认');expect(files).toEqual(before);
 });
 it('anchors relative dates in the original diary and excludes deadline-only language',()=>{
  expect(scheduleDates('明天继续',day)).toEqual(['2026-10-10']);expect(scheduleDates('下周一组会',day)).toEqual(['2026-10-12']);
  expect(scheduleDates('截止10月20日提交；10月18日前完成初稿',day)).toEqual([]);
 });
});
