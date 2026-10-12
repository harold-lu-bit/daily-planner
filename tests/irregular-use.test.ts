import { describe, expect, it } from 'vitest';
import { PlannerService, PlanSchema, REVIEW_DIR, eligible, localPlan, validateInput, validatePlan, type PlanInput, type Store } from '../src/core';
import { freshReminder, markShown, reviewActivity, reviewDayAt, shouldRemind, skipReview, snoozeReview } from '../src/reminders';

class Memory implements Store {
  files=new Map<string,string>();
  async read(p:string){return this.files.get(p)??null;}
  async list(p:string){return [...this.files.keys()].filter(k=>k.startsWith(p+'/'));}
  async create(p:string,t:string){if(this.files.has(p))throw new Error('exists');this.files.set(p,t);}
  async compareWrite(p:string,b:string,a:string){if(this.files.get(p)!==b)throw new Error('conflict');this.files.set(p,a);}
  async compareRemove(p:string,b:string){if(this.files.get(p)!==b)throw new Error('conflict');this.files.set(p,'');}
}
const input:PlanInput={date:'2026-10-05',capacity:120,start:'09:00',end:'18:00',slots:false,fixed:'',review:''};
const instant=(s:string)=>new Date(`${s}+08:00`);
const evening=instant('2026-10-04T22:31:00');
const zone='Asia/Shanghai',target='22:30';
const state=()=>({...freshReminder(),since:'2026-10-04'});

describe('不按固定流程的一周',()=>{
  it('空白新 Vault 可以形成无任务本地草稿，未确认不写 Daily',async()=>{
    const store=new Memory(),svc=new PlannerService(store),tasks=await svc.tasks();
    const plan=localPlan(input,tasks)!;expect(PlanSchema.safeParse(plan).success).toBe(true);
    const d=await svc.draft(plan,input,tasks,await svc.config());
    expect(d.plan.items).toHaveLength(0);expect(store.files.size).toBe(0);
    await svc.apply(d,async()=>{});expect(await store.read(d.path)).toContain('本日没有待安排任务');
  });
  it('一周没有新增或复盘，未完成任务不会随回看窗口消失',async()=>{
    const svc=new PlannerService(new Memory()),r=await svc.capture('等待实验设备');
    for(const date of ['2026-10-05','2026-10-06','2026-10-07','2026-10-11','2026-11-04']){
      const tasks=eligible(await svc.tasks(),date);expect(tasks.map(x=>x.task.id)).toEqual([r.task.id]);
      expect(localPlan({...input,date},tasks)).toBeNull();
      const plan={date,outcomes:['继续实验'],items:[{id:r.task.id,action:'schedule' as const,minutes:60,start:null,reason:'已有任务仍待完成'}],uncertainties:[]};
      expect(()=>validatePlan(plan,{...input,date,review:''},tasks)).not.toThrow();
    }
    expect(await svc.hasReview('2026-10-04')).toBe(false);
  });
  it('休息日不要求合法工时段、不改变任务状态或日期，次日继续安排',async()=>{
    const svc=new PlannerService(new Memory()),r=await svc.capture('稍后读论文'),tasks=await svc.tasks();
    const rest={...input,capacity:0,slots:true,start:'',end:'',fixed:'暂时不想填写时间'};
    const plan=localPlan(rest,tasks)!;expect(PlanSchema.safeParse(plan).success).toBe(true);expect(()=>validatePlan(plan,rest,tasks)).not.toThrow();
    const d=await svc.draft(plan,rest,tasks,await svc.config());await svc.apply(d,async()=>{});
    const [after]=await svc.tasks();expect(after.raw).toBe(r.raw);expect(eligible([after],'2026-10-06')).toHaveLength(1);
  });
  it('全部已完成或延期到未来时，本地草稿不编造新任务',async()=>{
    const svc=new PlannerService(new Memory()),done=await svc.capture('已做完的实验'),later=await svc.capture('下月开会');
    await svc.update(done,{status:'done'});await svc.update(later,{deferUntil:'2026-11-01'});
    const tasks=eligible(await svc.tasks(),input.date);expect(localPlan(input,tasks)?.items).toEqual([]);
    expect(eligible(await svc.tasks(),'2026-11-01').map(r=>r.task.id)).toEqual([later.task.id]);
  });
  it('空复盘不伪造完成记录；完整复盘可被另一设备读取',async()=>{
    const store=new Memory(),svc=new PlannerService(store);
    expect(await svc.saveReview('2026-10-04','  \n')).toBeNull();expect(await svc.hasReview('2026-10-04')).toBe(false);
    await svc.saveReview('2026-10-04','今天休息');expect(await new PlannerService(store).hasReview('2026-10-04')).toBe(true);
  });
  it('断网后多次重新打开并重试同一复盘，不产生重复笔记',async()=>{
    const store=new Memory();let first:string|null=null;
    for(let i=0;i<3;i++){
      const svc=new PlannerService(store),p=await svc.saveReview('2026-10-04','今天完成基线。');
      first??=p;expect(p).toBe(first);
    }
    expect(await store.list(REVIEW_DIR)).toHaveLength(1);
  });
  it('日期相同但内容为空或属性损坏的文件不算已复盘',async()=>{
    const store=new Memory(),svc=new PlannerService(store);
    store.files.set(`${REVIEW_DIR}/2026-10-04-empty.md`,'---\ntype: research-planner-review\ndate: 2026-10-04\n---\n');
    store.files.set(`${REVIEW_DIR}/2026-10-04-broken.md`,'broken');expect(await svc.hasReview('2026-10-04')).toBe(false);
  });
  it.each([-1,NaN,Infinity,0.5,1441])('拒绝无效工作量 %s，但允许明确的 0',capacity=>{
    expect(()=>validateInput({...input,capacity})).toThrow();expect(()=>validateInput({...input,capacity:0})).not.toThrow();
  });
});

describe('漏复盘和不打扰的提醒策略',()=>{
  it('首次启用不追索之前的复盘；当晚才开始',()=>{
    expect(shouldRemind(state(),instant('2026-10-04T09:00:00'),zone,target,false,true)).toBe(false);
    expect(shouldRemind(state(),evening,zone,target,false,true)).toBe(true);
  });
  it('直接关闭不是完成，同日不循环弹窗，次晨仍可补提醒',()=>{
    const shown=markShown(state(),evening,zone);
    expect(shouldRemind(shown,instant('2026-10-04T23:30:00'),zone,target,false,true)).toBe(false);
    expect(shouldRemind(shown,instant('2026-10-05T09:00:00'),zone,target,false,true)).toBe(true);
    expect(shouldRemind(shown,instant('2026-10-05T09:00:00'),zone,target,true,true)).toBe(false);
  });
  it('明确跳过后次晨不追问，但未来日期可以正常提醒',()=>{
    const skipped=skipReview(markShown(state(),evening,zone),'2026-10-04');
    expect(shouldRemind(skipped,instant('2026-10-05T09:00:00'),zone,target,false,true)).toBe(false);
    expect(shouldRemind(skipped,instant('2026-10-05T22:31:00'),zone,target,false,true)).toBe(true);
  });
  it('用户主动延后才在同日再次提醒，到点只触发一次',()=>{
    const snoozed=snoozeReview(markShown(state(),evening,zone),'2026-10-04',evening);
    expect(shouldRemind(snoozed,instant('2026-10-04T23:00:00'),zone,target,false,true)).toBe(false);
    const later=instant('2026-10-04T23:31:00');expect(shouldRemind(snoozed,later,zone,target,false,true)).toBe(true);
    expect(shouldRemind(markShown(snoozed,later,zone),instant('2026-10-04T23:32:00'),zone,target,false,true)).toBe(false);
  });
  it('跨午夜延后能恢复；已完成会取消延后提醒',()=>{
    const late=instant('2026-10-04T23:50:00'),snoozed=snoozeReview(markShown(state(),late,zone),'2026-10-04',late);
    expect(shouldRemind(snoozed,instant('2026-10-05T00:49:00'),zone,target,false,true)).toBe(false);
    expect(shouldRemind(snoozed,instant('2026-10-05T00:50:00'),zone,target,false,true)).toBe(true);
    expect(shouldRemind(snoozed,instant('2026-10-05T00:50:00'),zone,target,true,true)).toBe(false);
  });
  it('连续缺席多天，仅提示最近一次应复盘日期，不回放旧提醒',()=>{
    const old=snoozeReview(markShown(state(),evening,zone),'2026-10-04',evening),back=instant('2026-10-11T09:00:00');
    expect(reviewDayAt(back,zone,target)).toBe('2026-10-10');expect(shouldRemind(old,back,zone,target,false,true)).toBe(true);
    expect(shouldRemind(markShown(old,back,zone),instant('2026-10-11T22:31:00'),zone,target,false,true)).toBe(false);
  });
  it('完全没有任务或活动时安静，不要求用户每日输入',()=>{
    expect(reviewActivity([],'2026-10-04',zone)).toBe(false);expect(shouldRemind(state(),evening,zone,target,false,false)).toBe(false);
  });
  it('未完成旧任务可触发复盘，当天完成也算活动；未来延期且无活动则安静',async()=>{
    const svc=new PlannerService(new Memory()),r=await svc.capture('旧任务');
    const old={...r,task:{...r.task,created:'2026-09-01T00:00:00Z',updated:'2026-09-01T00:00:00Z'}};
    expect(reviewActivity([old],'2026-10-04',zone)).toBe(true);
    expect(reviewActivity([{...old,task:{...old.task,deferUntil:'2026-11-01'}}],'2026-10-04',zone)).toBe(false);
    expect(reviewActivity([{...old,task:{...old.task,status:'done',updated:'2026-10-04T10:00:00Z'}}],'2026-10-04',zone)).toBe(true);
    expect(reviewActivity([{...old,task:{...old.task,status:'done'}}],'2026-10-04',zone)).toBe(false);
  });
  it('上海跨年和其他时区按本地日期判断',()=>{
    expect(reviewDayAt(instant('2027-01-01T08:00:00'),zone,target)).toBe('2026-12-31');
    expect(reviewDayAt(new Date('2026-10-05T03:00:00Z'),'America/New_York',target)).toBe('2026-10-04');
  });
});
