import {describe,expect,it} from 'vitest';
import {addDay,type Store} from '../src/core';
import {DailyService,QUEUE_PATH,parseQueue,pendingTasks,readTasks,renderQueue,reviewPayload,type BatchJournal,type Decision,type Layout,type Review,type Snapshot} from '../src/daily';

const day='2026-10-09';
const path=(d:string)=>`10 Daily/${d.slice(0,4)}/${d.slice(5,7)}/${d}.md`;
const template='99 System/Templates/Daily.md';
const layout=(d:string):Layout=>({day:d,todayPath:path(d),tomorrowPath:path(addDay(d,1)),templatePath:template,heading:'Tasks',enabled:true});
class Memory implements Store {
  files=new Map<string,string>();reads:string[]=[];failPath='';
  async read(p:string){this.reads.push(p);return this.files.get(p)??null;}
  async list():Promise<string[]>{throw Error('No directory enumeration');}
  async create(p:string,s:string){if(this.files.has(p))throw Error('exists');this.files.set(p,s);}
  async compareWrite(p:string,b:string,s:string){
    if(this.failPath===p){this.failPath='';throw Error('disk failure');}
    if(this.files.get(p)!==b)throw Error('conflict');this.files.set(p,s);
  }
  async compareRemove(p:string,b:string){await this.compareWrite(p,b,'');}
}
function fixture(today='## Tasks\n- [ ] 今天的分析\n\n## Work Log\n人工内容\n') {
  const store=new Memory();store.files.set(path(day),today);store.files.set(template,'# {{date}}\n\n## Tasks\n- [ ] \n');
  store.files.set(QUEUE_PATH,renderQueue({type:'research-planner-future',version:1,reviewed:['2026-10-05'],tasks:[]}));
  return {store,service:new DailyService(store,async d=>layout(d))};
}
function decision(id:string,text:string,s:Snapshot,fields:Partial<Decision>={}):Decision {
  return {id,text,action:s.target,date:s.targetDay,deadline:null,start:null,end:null,priority:'normal',reason:'接续未完成工作',...fields};
}
function review(s:Snapshot):Review {
  return {summary:'接续遗漏任务，并安排接下来的工作。',questions:[],decisions:[
    ...pendingTasks(s).map(t=>decision(t.id,t.text,s)),
    ...s.completed.map(t=>decision(t.id,t.text,s,{action:'keep',date:null})),
    ...s.queue.tasks.map(t=>decision(t.id,t.text,s,{action:'keep',date:t.date})),
  ]};
}

describe('Resuming after missed reviews',()=>{
  it.each(['today','tomorrow'] as const)('collects several missed days and explicitly schedules %s',async target=>{
    const {store,service}=fixture();
    store.files.set(path('2026-10-06'),'## Tasks\n- [ ] 旧实验\n\n## Work Log\n保留旧日志\n');
    store.files.set(path('2026-10-08'),'## Tasks\n- [ ] 昨天的报告\n');
    store.files.set(path('2026-10-04'),'## Tasks\n- [ ] 不应回查\n');
    const before=new Map(store.files),s=await service.snapshot(day,{target,catchUp:true});
    expect(s.history.map(n=>n.day)).toEqual(['2026-10-06','2026-10-07','2026-10-08']);
    expect(store.reads).not.toContain(path('2026-10-04'));
    expect(pendingTasks(s)).toHaveLength(3);
    const payload=reviewPayload(s,[],null);
    expect(payload.tasks.find(t=>t.text==='昨天的报告')?.sourceDay).toBe('2026-10-08');
    expect(payload.targetDate).toBe(target==='today'?day:'2026-10-10');
    const draft=service.draft(s,review(s),false);expect(store.files).toEqual(before);
    await service.apply(draft,async()=>{});
    const result=store.files.get(path(s.targetDay))!;
    expect(readTasks(result).map(t=>t.text)).toEqual(expect.arrayContaining(['旧实验','昨天的报告','今天的分析']));
    expect(result).not.toMatch(/<!-- rp(?::|-reviewed:)/);
    expect(store.files.get(path('2026-10-06'))).toContain(`→ 已转至 [[${path(s.targetDay).replace(/\.md$/,'')}|${s.targetDay}]]`);
    expect(store.files.get(path('2026-10-06'))).toContain('## Work Log\n保留旧日志');
    expect(store.files.has(path('2026-10-07'))).toBe(false);
    if(target==='today')expect(store.files.has(path('2026-10-10'))).toBe(false);
  });

  it('does not reread old kept tasks after a confirmed catch-up on the same day',async()=>{
    const {store,service}=fixture();store.files.set(path('2026-10-08'),'## Tasks\n- [ ] 留在昨天\n');
    const s=await service.snapshot(day,{catchUp:true}),r=review(s);
    Object.assign(r.decisions.find(d=>d.text==='留在昨天')!,{action:'keep',date:null});
    await service.apply(service.draft(s,r,false,["留在昨天这项任务保留在原日记，不交接。"]),async()=>{});
    const again=await service.snapshot(day,{catchUp:true});
    expect(again.history).toHaveLength(0);expect(pendingTasks(again)).toHaveLength(0);
    const explicit=await service.snapshot(day,{catchUp:true,from:'2026-10-08'});
    expect(pendingTasks(explicit).map(t=>t.text)).toContain('留在昨天');
  });

  it('defaults to seven days without previous receipts and caps very long gaps visibly',async()=>{
    const {store,service}=fixture();store.files.delete(QUEUE_PATH);
    const first=await service.snapshot(day,{catchUp:true});expect(first.history).toHaveLength(7);expect(first.warnings.join()).toContain('7 天');
    store.files.set(QUEUE_PATH,renderQueue({type:'research-planner-future',version:1,reviewed:['2026-08-01'],tasks:[]}));
    const long=await service.snapshot(day,{catchUp:true});expect(long.history).toHaveLength(30);expect(long.warnings.join()).toContain('更早任务');
    await expect(service.snapshot(day,{catchUp:true,from:'2026-08-01'})).rejects.toThrow('最多');
    await expect(service.snapshot(day,{catchUp:true,from:'2026-10-10'})).rejects.toThrow('晚于');
  });

  it('reads only explicitly bounded days and rejects colliding date paths',async()=>{
    const {store,service}=fixture();
    const s=await service.snapshot(day,{catchUp:true,from:'2026-10-08'});expect(s.history).toHaveLength(1);
    const broken=new DailyService(store,async d=>({...layout(d),todayPath:path(day)}));
    await expect(broken.snapshot(day,{catchUp:true})).rejects.toThrow('重复路径');
  });

  it('checks later edits and newly created previously missing history before writing anything',async()=>{
    for(const previous of [null,'## Tasks\n- [ ] 旧任务\n']) {
      const {store,service}=fixture();if(previous!==null)store.files.set(path('2026-10-08'),previous);
      const s=await service.snapshot(day,{catchUp:true}),d=service.draft(s,review(s),false);
      store.files.set(path('2026-10-08'),'## Tasks\n- [ ] 后续编辑\n');const before=new Map(store.files);
      await expect(service.apply(d,async()=>{})).rejects.toThrow('变化');expect(store.files).toEqual(before);
    }
  });

  it('rolls back current and historical diary changes when a later historical write fails',async()=>{
    const {store,service}=fixture();
    for(const d of ['2026-10-06','2026-10-08'])store.files.set(path(d),`## Tasks\n- [ ] ${d} 的任务\n`);
    const before=new Map(store.files),s=await service.snapshot(day,{target:'today',catchUp:true});
    store.failPath=path('2026-10-08');let journal!:BatchJournal;
    await expect(service.apply(service.draft(s,review(s),false),async j=>{journal=j;})).rejects.toThrow('已恢复');
    expect(store.files).toEqual(before);expect(journal.state).toBe('reverted');
  });

  it('undo includes historical receipts and refuses post-acceptance historical edits',async()=>{
    const {store,service}=fixture();store.files.set(path('2026-10-08'),'## Tasks\n- [ ] 旧任务\n');
    const before=new Map(store.files),s=await service.snapshot(day,{target:'today',catchUp:true});let j!:BatchJournal;
    await service.apply(service.draft(s,review(s),false),async x=>{j=x;});
    const saved=store.files.get(path('2026-10-08'))!;store.files.set(path('2026-10-08'),saved+'人工后续');
    await expect(service.revert(j)).rejects.toThrow('拒绝');
    store.files.set(path('2026-10-08'),saved);await service.revert(j);expect(store.files).toEqual(before);
  });

  it('rejects a recovery journal that reaches outside the bounded date range',async()=>{
    const {service}=fixture();
    await expect(service.revert({version:2,day,state:'pending',sourceDays:['2025-01-01'],changes:[]})).rejects.toThrow('范围');
  });
});

describe('Planning the current day',()=>{
  it('updates existing current tasks in place with stable identity and no duplicate or self-link',async()=>{
    const {store,service}=fixture('## Tasks\r\n- [ ] 分析实验\r\n  保留细节\r\n\r\n## Work Log\r\n人工内容');
    const s=await service.snapshot(day,{target:'today'}),r=review(s);
    Object.assign(r.decisions[0],{start:'15:00',end:'16:00'});
    await service.apply(service.draft(s,r,false,["分析实验安排在15:00到16:00。"]),async()=>{});
    const raw=store.files.get(path(day))!,again=await service.snapshot(day,{target:'today'});
    expect(again.tasks).toHaveLength(1);expect(again.tasks[0].id).toBe(s.tasks[0].id);
    expect(raw).toContain('- [ ] 15:00 - 16:00 分析实验\r\n  保留细节');
    expect(raw).not.toContain('已转至');expect(raw).toContain('## 日程安排');
    expect(raw).not.toContain('rp:');expect(raw).toContain('## Work Log\r\n人工内容');
  });

  it('can move missed queued work into today and queue tomorrow as a future date',async()=>{
    const {store,service}=fixture();const id=crypto.randomUUID();
    store.files.set(QUEUE_PATH,renderQueue({type:'research-planner-future',version:1,reviewed:[],tasks:[{id,text:'过期工作',date:'2026-10-07',deadline:null,start:null,end:null,priority:'normal'}]}));
    const s=await service.snapshot(day,{target:'today'}),r=review(s);
    Object.assign(r.decisions[0],{action:'future',date:'2026-10-10'});Object.assign(r.decisions[1],{action:'today',date:day});
    await service.apply(service.draft(s,r,false,["今天的分析安排到2026-10-10。"]),async()=>{});
    const next=await service.snapshot(day,{target:'today'});
    expect(next.tasks[0].id).toBe(id);expect(next.queue.tasks[0].date).toBe('2026-10-10');
  });

  it('handles today with no template if the existing diary needs no creation',async()=>{
    const {store,service}=fixture();store.files.delete(template);
    const s=await service.snapshot(day,{target:'today'});await service.apply(service.draft(s,review(s),false),async()=>{});
    expect(store.files.has(path('2026-10-10'))).toBe(false);
  });

  it('creates today using today template variables when today is missing',async()=>{
    const {store,service}=fixture();store.files.delete(path(day));
    const s=await service.snapshot(day,{target:'today'}),r=review(s);r.decisions.push(decision('new:1','新增事项',s));
    await service.apply(service.draft(s,r,true),async()=>{});
    expect(store.files.get(path(day))).toContain('# 2026-10-09');expect(store.files.has(path('2026-10-10'))).toBe(false);
  });

  it('rejects target mismatch and detects overlaps between in-place and newly added tasks',async()=>{
    const {service}=fixture('## Tasks\n- [ ] 分析\n- [ ] 实验\n');
    const s=await service.snapshot(day,{target:'today'}),r=review(s);r.decisions[0].action='tomorrow';
    expect(()=>service.draft(s,r,false)).toThrow('日期');r.decisions[0].action='today';
    Object.assign(r.decisions[0],{start:'15:00',end:'16:00'});Object.assign(r.decisions[1],{start:'15:30',end:null});
    await expect(service.apply(service.draft(s,r,false,["分析安排在15:00到16:00。实验从15:30开始。"]),async()=>{})).rejects.toThrow('冲突');
  });

  it('allows cancelling or keeping old work but never silently omits it',async()=>{
    const {store,service}=fixture();store.files.set(path('2026-10-08'),'## Tasks\n- [ ] 可取消\n- [ ] 要保留\n');
    const s=await service.snapshot(day,{target:'today',catchUp:true}),r=review(s);
    const omitted={...r,decisions:r.decisions.slice(1)};expect(()=>service.draft(s,omitted,false)).toThrow('遗漏');
    Object.assign(r.decisions.find(d=>d.text==='可取消')!,{action:'cancel',date:null});
    Object.assign(r.decisions.find(d=>d.text==='要保留')!,{action:'keep',date:null});
    await service.apply(service.draft(s,r,false,["要保留这项留在原日记，不交接。"]),async()=>{});
    expect(store.files.get(path('2026-10-08'))).toContain('可取消 → 已取消');
    expect(store.files.get(path('2026-10-08'))).toContain('- [ ] 要保留');
  });
});

describe('Task identities without diary comments',()=>{
  it('does not reuse a cancelled task identity when another task is renamed to its text',async()=>{
    const {service}=fixture('## Tasks\n- [ ] 旧名字\n- [ ] 新工作\n');
    const s=await service.snapshot(day,{target:'today'}),r=review(s);
    Object.assign(r.decisions[0],{action:'cancel',date:null});r.decisions[1].text='旧名字';
    await service.apply(service.draft(s,r,false),async()=>{});
    const next=await service.snapshot(day,{target:'today'});
    expect(next.tasks[0].id).toBe(s.tasks[1].id);expect(next.tasks).toHaveLength(1);
  });
  it('migrates legacy markers, keeps links and fenced examples, and imports already-reviewed receipts',async()=>{
    const id=crypto.randomUUID(),{store,service}=fixture('## Tasks\n- [x] 已完成\n');
    const initial=await service.snapshot(day),digest=initial.completed[0].digest;
    const raw=`## Tasks\n- [x] 已完成 <!-- rp:${id} --> <!-- rp-reviewed:${digest} -->\n- 已转至 [[另一篇日记]] <!-- rp:${crypto.randomUUID()} -->\n\n\`\`\`md\n- [ ] 示例 <!-- rp:${id} -->\n\`\`\`\n\n## Work Log\n人工尾部\n`;
    store.files.set(path(day),raw);
    const s=await service.snapshot(day,{target:'today'});expect(s.completed).toHaveLength(0);
    await service.apply(service.draft(s,review(s),false),async()=>{});
    const after=store.files.get(path(day))!;
    expect(after).toContain('- [x] 已完成\n- 已转至 [[另一篇日记]]\n');
    expect(after).toContain(`- [ ] 示例 <!-- rp:${id} -->`);
    const again=await service.snapshot(day,{target:'today'});expect(again.completed).toHaveLength(0);expect(again.tasks[0].id).toBe(id);
  });

  it('retains completed follow-up suppression across service/device reload and task line moves',async()=>{
    const {store,service}=fixture('## Tasks\n- [x] 报告已交，明天补实验\n');
    const s=await service.snapshot(day,{target:'today'}),r=review(s);
    Object.assign(r.decisions[0],{action:'future',date:'2026-10-10',text:'补实验'});
    await service.apply(service.draft(s,r,false),async()=>{});
    store.files.set(path(day),store.files.get(path(day))!.replace('## Tasks','## Tasks\n\n普通说明'));
    const other=new DailyService(store,async d=>layout(d)),again=await other.snapshot(day,{target:'today'});
    expect(again.completed).toHaveLength(0);expect(again.queue.tasks).toHaveLength(1);
    expect(store.files.get(path(day))).not.toContain('rp-reviewed');
    store.files.set(path(day),store.files.get(path(day))!.replace('明天补实验','后天补另一实验'));
    expect((await other.snapshot(day,{target:'today'})).completed).toHaveLength(1);
  });

  it('does not resurrect deleted tasks from the receipt registry',async()=>{
    const {store,service}=fixture();const s=await service.snapshot(day,{target:'today'});
    await service.apply(service.draft(s,review(s),false),async()=>{});
    store.files.set(path(day),'## Tasks\n');
    expect(pendingTasks(await service.snapshot(day,{target:'today',catchUp:true}))).toHaveLength(0);
  });

  it('fails safely on ambiguous identical diary tasks without inline identifiers',async()=>{
    const {service}=fixture('## Tasks\n- [ ] 相同任务\n- [x] 相同任务\n');
    await expect(service.snapshot(day,{target:'today'})).rejects.toThrow('同内容任务');
  });

  it('keeps historical relative dates in completed inputs and registers their follow-up independently',async()=>{
    const {store,service}=fixture('## Tasks\n');store.files.set(path('2026-10-08'),'## Tasks\n- [x] 今天初调结束，明天验证\n');
    const s=await service.snapshot(day,{target:'today',catchUp:true});expect(reviewPayload(s,[],null).completed[0].sourceDay).toBe('2026-10-08');
    const r=review(s);Object.assign(r.decisions[0],{text:'验证',action:'today',date:day});
    await service.apply(service.draft(s,r,false),async()=>{});
    const again=await service.snapshot(day,{target:'today',catchUp:true,from:'2026-10-08'});
    expect(again.completed).toHaveLength(0);expect(again.tasks[0].id).not.toBe(s.completed[0].id);
    expect(parseQueue(store.files.get(QUEUE_PATH)!)).toHaveProperty('version',2);
  });
});
