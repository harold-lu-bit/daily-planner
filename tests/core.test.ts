import { describe, it, expect } from 'vitest';
import { PlannerService, START, END, TASK_DIR, CONFIG_PATH, TEMPLATE_PATH, addDay, dateSchema, today, safePath, frontmatter, eligible, validatePlan, replaceBlock, type Store, type PlanInput, type Plan, type Journal } from '../src/core';

class Memory implements Store {
  files=new Map<string,string>();
  async read(p:string){return this.files.get(p)??null;}
  async list(p:string){return [...this.files.keys()].filter(k=>k.startsWith(p+'/'));}
  async create(p:string,t:string){if(this.files.has(p))throw new Error('exists');this.files.set(p,t);}
  async compareWrite(p:string,b:string,a:string){if(this.files.get(p)!==b)throw new Error('conflict');this.files.set(p,a);}
  async compareRemove(p:string,b:string){if(this.files.get(p)!==b)throw new Error('conflict');this.files.set(p,'');}
}
const input:PlanInput={date:'2026-10-05',capacity:120,start:'09:00',end:'18:00',slots:false,fixed:'',review:'今天完成了基线实验'};
async function setup(){const store=new Memory(),svc=new PlannerService(store),r=await svc.capture('周五前完成消融实验');return {store,svc,r};}
const plan=(id:string):Plan=>({date:input.date,outcomes:['完成消融实验'],items:[{id,action:'schedule',minutes:60,start:null,reason:'当前研究重点'}],uncertainties:[]});

describe('任务生命周期与输入保护',()=>{
  it('先保存原话、多个任务获得独立 UUID',async()=>{const {svc,r}=await setup();const b=await svc.capture('第二项\n保留原文');expect(r.task.id).not.toBe(b.task.id);expect(b.raw).toContain('第二项\n保留原文');expect(await svc.tasks()).toHaveLength(2);});
  it('完成和延期跨日保留，完成任务不进入计划',async()=>{const {svc,r}=await setup();await svc.update(r,{status:'done'});const tasks=await svc.tasks();expect(eligible(tasks,'2027-01-01')).toHaveLength(0);expect(tasks[0].task.id).toBe(r.task.id);expect(tasks[0].raw).toContain('周五前完成消融实验');});
  it('延期日期到达后重新出现',async()=>{const {svc,r}=await setup();await svc.update(r,{deferUntil:'2026-10-07'});const tasks=await svc.tasks();expect(eligible(tasks,'2026-10-06')).toHaveLength(0);expect(eligible(tasks,'2026-10-07')).toHaveLength(1);});
  it('拒绝用过期界面覆盖人工编辑',async()=>{const {svc,r}=await setup();await svc.update(r,{title:'新标题'});await expect(svc.update(r,{status:'done'})).rejects.toThrow('conflict');});
  it('拒绝损坏或重复任务 ID',async()=>{const {store,svc,r}=await setup();store.files.set(TASK_DIR+'/duplicate.md',r.raw);await expect(svc.tasks()).rejects.toThrow('ID');});
  it('取消后可重新打开，不删除原始记录',async()=>{const {svc,r}=await setup();await svc.update(r,{status:'cancelled'});const [next]=await svc.tasks();await svc.update(next,{status:'open'});expect((await svc.tasks())[0].task.id).toBe(r.task.id);});
  it('复盘重试去重，但新内容或不同日期分别保存',async()=>{const {svc}=await setup();const a=await svc.saveReview('2026-10-04','被实验问题阻塞');const b=await svc.saveReview('2026-10-04','被实验问题阻塞');expect(a).toBe(b);expect(await svc.saveReview('2026-10-05','被实验问题阻塞')).not.toBe(a);expect(await svc.saveReview('2026-10-04','问题已解决')).not.toBe(a);});
});
describe('受限计划校验',()=>{
  it('每项任务有且仅有一个处置',async()=>{const {r}=await setup();expect(()=>validatePlan(plan(r.task.id),input,[r])).not.toThrow();expect(()=>validatePlan({...plan(r.task.id),items:[]},input,[r])).toThrow('遗漏');expect(()=>validatePlan({...plan(r.task.id),items:[...plan(r.task.id).items,...plan(r.task.id).items]},input,[r])).toThrow('重复');});
  it('拒绝虚构 UUID 和错误日期',async()=>{const {r}=await setup();expect(()=>validatePlan(plan(crypto.randomUUID()),input,[r])).toThrow('未知');expect(()=>validatePlan({...plan(r.task.id),date:'2026-10-06'},input,[r])).toThrow('日期');});
  it('不能超过可用工时',async()=>{const {r}=await setup();expect(()=>validatePlan(plan(r.task.id),{...input,capacity:30},[r])).toThrow('工作量');});
  it('时间段避开会议，不能越出工作时间',async()=>{const {r}=await setup();const p=plan(r.task.id);p.items[0].start='09:30';expect(()=>validatePlan(p,{...input,slots:true,fixed:'10:00-11:00 组会'},[r])).toThrow('冲突');p.items[0].start='17:30';expect(()=>validatePlan(p,{...input,slots:true},[r])).toThrow('越界');p.items[0].start='11:00';expect(()=>validatePlan(p,{...input,slots:true,fixed:'10:00-11:00 组会'},[r])).not.toThrow();});
  it('拒绝任务间重叠',async()=>{const {svc,r}=await setup();const b=await svc.capture('另一实验'),p=plan(r.task.id);p.items[0].start='09:00';p.items.push({id:b.task.id,action:'schedule',start:'09:30',minutes:30,reason:'同样重要'});expect(()=>validatePlan(p,{...input,slots:true},[r,b])).toThrow('冲突');});
  it('暂缓必须不占用时间且有明确处置',async()=>{const {r}=await setup();const p=plan(r.task.id);p.items[0]={id:r.task.id,action:'defer',minutes:0,start:null,reason:'等待实验设备'};expect(()=>validatePlan(p,input,[r])).not.toThrow();p.items[0].minutes=30;expect(()=>validatePlan(p,input,[r])).toThrow('延期');});
});
describe('预览、写入与撤销',()=>{
  it('保留人工区域字节，撤销恢复已有文件',async()=>{const {svc,store,r}=await setup(),c=await svc.config();const path='10 Daily/2026/10/2026-10-05.md',before=`人工内容\r\n${START}\r\n旧计划\r\n${END}\r\n## Captures\r\n私有记录`;
    store.files.set(path,before);const d=await svc.draft(plan(r.task.id),input,[r],c);expect(await store.read(path)).toBe(before);let j!:Journal;await svc.apply(d,async x=>{j=x;});expect(await store.read(path)).toBe(d.after);expect(d.after.startsWith('人工内容\r\n')).toBe(true);expect(d.after.endsWith('## Captures\r\n私有记录')).toBe(true);await svc.undo(j);expect(await store.read(path)).toBe(before);
  });
  it('预览后任务变化则拒绝写入',async()=>{const {svc,r}=await setup();const d=await svc.draft(plan(r.task.id),input,[r],await svc.config());await svc.update(r,{status:'done'});await expect(svc.apply(d,async()=>{})).rejects.toThrow('任务');});
  it('预览后新增任务则拒绝写入',async()=>{const {svc,r}=await setup();const d=await svc.draft(plan(r.task.id),input,[r],await svc.config());await svc.capture('临时任务');await expect(svc.apply(d,async()=>{})).rejects.toThrow('任务');});
  it('预览后 Daily 创建或修改则拒绝覆盖',async()=>{const {svc,store,r}=await setup();const d=await svc.draft(plan(r.task.id),input,[r],await svc.config());store.files.set(d.path,'人工笔记');await expect(svc.apply(d,async()=>{})).rejects.toThrow('Daily');expect(await store.read(d.path)).toBe('人工笔记');});
  it('本机撤销记录保存失败时不写 Vault',async()=>{const {svc,store,r}=await setup();const d=await svc.draft(plan(r.task.id),input,[r],await svc.config());await expect(svc.apply(d,async()=>{throw new Error('quota');})).rejects.toThrow('quota');expect(await store.read(d.path)).toBeNull();});
  it('撤销保护后续编辑，新建文件撤销留空而不删除',async()=>{const {svc,store,r}=await setup();const d=await svc.draft(plan(r.task.id),input,[r],await svc.config());let j!:Journal;await svc.apply(d,async x=>{j=x;});store.files.set(d.path,d.after+'人工补充');await expect(svc.undo(j)).rejects.toThrow();store.files.set(d.path,d.after);await svc.undo(j);expect(await store.read(d.path)).toBe('');});
  it('模板异常不能形成草稿',async()=>{const {svc,store,r}=await setup();store.files.set(TEMPLATE_PATH,'{{unsupported}}');await expect(svc.draft(plan(r.task.id),input,[r],await svc.config())).rejects.toThrow('占位符');});
});
describe('配置边界与日期',()=>{
  it.each(['../a','/etc/passwd','.obsidian/data.json','x/../y','C:\\foo','x//y'])('拒绝越界或隐藏路径 %s',p=>expect(()=>safePath(p)).toThrow());
  it('拒绝重复配置键',()=>expect(()=>frontmatter('---\na: 1\na: 2\n---\n')).toThrow());
  it('集中配置停用时拒绝计划写入',async()=>{const {svc,store,r}=await setup();store.files.set(CONFIG_PATH,'---\nschema_version: 1\ntimezone: Asia/Shanghai\npaths: {daily: 10 Daily, planning: 50 Planning}\nplanner: {enabled: false, lookback_days: 3}\nactive_projects: []\n---\n');const d=await svc.draft(plan(r.task.id),input,[r],await svc.config());await expect(svc.apply(d,async()=>{})).rejects.toThrow('false');});
  it('上下文只读配置范围，排除任务和其他项目',async()=>{const {svc,store}=await setup();store.files.set('40 Projects/Private/secret.md','private');store.files.set('50 Planning/Weekly.md','---\ntype: planning\nstatus: active\n---\n每周目标');store.files.set('10 Daily/2026/10/2026-10-04.md','昨天');const ctx=await svc.context(await svc.config(),input.date);expect(ctx.map(x=>x.path)).toEqual(expect.arrayContaining(['50 Planning/Weekly.md','10 Daily/2026/10/2026-10-04.md']));expect(ctx.some(x=>x.path.includes('Private')||x.path.startsWith(TASK_DIR))).toBe(false);});
  it('真实日历日期、跨年、上海时区',()=>{expect(()=>dateSchema.parse('2026-02-30')).toThrow();expect(addDay('2026-12-31',1)).toBe('2027-01-01');expect(today('Asia/Shanghai',new Date('2026-10-04T17:00:00Z'))).toBe('2026-10-05');});
  it.each([START,`${START}${START}${END}`,`${END}${START}`])('拒绝不完整或重复标记',raw=>expect(()=>replaceBlock(raw,'new')).toThrow());
});
