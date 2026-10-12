import { z } from 'zod';
import { parse, stringify } from 'yaml';

export const START = '<!-- research-workflow:planner:start -->';
export const END = '<!-- research-workflow:planner:end -->';
export const TASK_DIR = '50 Planning/Research Planner Tasks';
export const REVIEW_DIR = '50 Planning/Research Planner Reviews';
export const CONFIG_PATH = '99 System/Automation/Research Workflow Config.md';
export const TEMPLATE_PATH = '99 System/Templates/Daily.md';

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, '日期无效');
const short = z.string().trim().min(1).max(500);
export const TaskSchema = z.object({
  type: z.literal('research-planner-task'), id: z.string().uuid(), title: short,
  status: z.enum(['open', 'done', 'cancelled']), priority: z.enum(['high', 'normal', 'low']),
  minutes: z.number().int().min(1).max(1440), project: z.string().max(200).nullable(),
  due: dateSchema.nullable(), deferUntil: dateSchema.nullable(),
  created: z.string().datetime(), updated: z.string().datetime(),
}).strict();
export type Task = z.infer<typeof TaskSchema>;
export interface TaskRecord { task: Task; raw: string; path: string; }
export const ExtractionSchema = z.object({
  title: short, priority: z.enum(['high', 'normal', 'low']),
  minutes: z.number().int().min(1).max(1440), project: z.string().max(200).nullable(),
  due: dateSchema.nullable(), uncertainties: z.array(short).max(10),
}).strict();
export type Extraction = z.infer<typeof ExtractionSchema>;
const clockSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const PlanSchema = z.object({
  date: dateSchema, outcomes: z.array(short).min(1).max(3),
  items: z.array(z.object({id: z.string().uuid(), action: z.enum(['schedule', 'defer']),
    minutes: z.number().int().min(0).max(1440), start: clockSchema.nullable(),
    reason: short}).strict()).max(150), uncertainties: z.array(short).max(20),
}).strict();
export type Plan = z.infer<typeof PlanSchema>;
export interface PlanInput {
  date: string; capacity: number; start: string; end: string; slots: boolean;
  fixed: string; review: string;
}
export interface WorkflowConfig {
  enabled: boolean; timezone: string; daily: string; planning: string; lookback: number;
  projects: {name: string; homepage: string}[];
}
export interface Store {
  read(path: string): Promise<string | null>;
  list(dir: string): Promise<string[]>;
  create(path: string, text: string): Promise<void>;
  compareWrite(path: string, expected: string, next: string): Promise<void>;
  compareRemove(path: string, expected: string): Promise<void>;
}
export interface Journal { path: string; before: string | null; after: string; date: string; }
export interface Draft { input: PlanInput; plan: Plan; tasks: TaskRecord[]; path: string; before: string | null; after: string; }

export function safePath(path: string): string {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes(':') || path.includes('\0') || path.split('/').some(p => !p || p === '..' || p.startsWith('.'))) throw new Error('笔记路径必须是 Vault 内的普通相对路径');
  return path;
}
export function frontmatter(raw: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) throw new Error('缺少 YAML 属性');
  const obj = parse(match[1], {uniqueKeys: true});
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('YAML 属性格式无效');
  return obj;
}
export function taskText(task: Task, original: string): string {
  return `---\n${stringify(TaskSchema.parse(task))}---\n\n## 原始输入\n\n${original.trim()}\n`;
}
export function updateTaskText(raw: string, task: Task): string {
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  return `---\n${stringify(TaskSchema.parse(task))}---\n${body}`;
}
export function today(timezone = 'Asia/Shanghai', now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function addDay(day: string, n: number): string {
  dateSchema.parse(day);
  const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dailyPath(config: WorkflowConfig, day: string): string {
  dateSchema.parse(day); return safePath(`${config.daily}/${day.slice(0,4)}/${day.slice(5,7)}/${day}.md`);
}
export function minute(s: string): number { clockSchema.parse(s); const [h,m] = s.split(':').map(Number); return h*60+m; }
export function clock(n: number): string { return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; }
export function fixedIntervals(input: PlanInput): [number, number][] {
  return input.fixed.split('\n').filter(s => s.trim()).map(line => {
    const m = /^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})(?:\s|$)/.exec(line.trim());
    if (!m || minute(m[1]) >= minute(m[2])) throw new Error('固定安排请每行填写 HH:mm-HH:mm 说明');
    return [minute(m[1]), minute(m[2])];
  });
}
export function validateInput(input: PlanInput): void {
  dateSchema.parse(input.date);
  if (!Number.isInteger(input.capacity) || input.capacity < 0 || input.capacity > 1440) throw new Error('可用工作量须为 0–1440 分钟；0 表示休息日');
  if (input.capacity === 0) return;
  if (minute(input.start) >= minute(input.end)) throw new Error('工作结束时间必须晚于开始时间');
  fixedIntervals(input);
}
export function eligible(records: TaskRecord[], day: string): TaskRecord[] {
  return records.filter(r => r.task.status === 'open' && (!r.task.deferUntil || r.task.deferUntil <= day));
}
export function validatePlan(plan: Plan, input: PlanInput, records: TaskRecord[]): void {
  validateInput(input);
  if (plan.date !== input.date) throw new Error('模型返回了错误日期');
  const ids = new Set(records.map(r => r.task.id)); const seen = new Set<string>();
  const busy = input.capacity === 0 ? [] : fixedIntervals(input); let total = 0;
  for (const item of plan.items) {
    if (!ids.has(item.id) || seen.has(item.id)) throw new Error('模型返回了未知或重复任务');
    seen.add(item.id);
    if (item.action === 'defer') {
      if (item.minutes !== 0 || item.start !== null) throw new Error('延期任务不得占用时间段');
      continue;
    }
    if (item.minutes < 1) throw new Error('计划任务时长必须大于零');
    total += item.minutes;
    if (input.slots) {
      if (item.start === null) throw new Error('计划任务缺少时间段');
      const a = minute(item.start), b = a + item.minutes;
      if (a < minute(input.start) || b > minute(input.end) || busy.some(([x,y]) => a < y && b > x)) throw new Error('计划时间段越界或与其他安排冲突');
      busy.push([a,b]);
    } else if (item.start !== null) throw new Error('未启用时间段时模型不得分配开始时间');
  }
  if (seen.size !== ids.size) throw new Error('模型遗漏了未完成任务');
  if (total > input.capacity) throw new Error('计划超过可用工作量');
}
export function inline(s: string): string { return s.replace(/[\r\n]/g,' ').replace(/([\\`*_{}\[\]<>#])/g,'\\$1'); }
export function renderPlan(plan: Plan, records: TaskRecord[]): string {
  const tasks = new Map(records.map(r => [r.task.id,r]));
  const lines = [START, '## Research Planner', '', '### 预期结果', ...plan.outcomes.map(s => `- ${inline(s)}`), '', '### 任务'];
  for (const i of plan.items) {
    const r = tasks.get(i.id)!;
    const time = i.start ? `${i.start}–${clock(minute(i.start)+i.minutes)} · ` : '';
    lines.push(`- ${i.action === 'schedule' ? '[ ] ' : ''}${i.action === 'defer' ? '暂缓：' : ''}${inline(r.task.title)}${i.action === 'schedule' ? `（${time}${i.minutes} 分钟）` : ''}`,
      `  - ${inline(i.reason)} · [[${r.path.slice(0,-3)}|任务详情]]`);
  }
  if (plan.uncertainties.length) lines.push('', '### 待确认', ...plan.uncertainties.map(s => `- ${inline(s)}`));
  lines.push('', '> 完成状态以任务详情或插件任务列表为准；Daily 勾选仅作当天记录。', END);
  return lines.join('\n');
}
export function replaceBlock(before: string, block: string): string {
  if (before.split(START).length !== 2 || before.split(END).length !== 2 || before.indexOf(START) >= before.indexOf(END)) throw new Error('Daily 的 Planner 标记缺失、重复或顺序错误');
  return before.slice(0,before.indexOf(START)) + block + before.slice(before.indexOf(END)+END.length);
}
export function localPlan(input: PlanInput, records: TaskRecord[]): Plan | null {
  validateInput(input);
  if (input.capacity !== 0 && records.length !== 0) return null;
  return {
    date: input.date,
    outcomes: [input.capacity === 0 ? '休息与恢复，本日不安排工作任务' : '本日没有待安排任务'],
    items: records.map(r => ({id:r.task.id,action:'defer',minutes:0,start:null,reason:'本日可用工作量为 0；任务保留，之后可继续安排。'})),
    uncertainties: [],
  };
}

export class PlannerService {
  constructor(public store: Store) {}
  async config(): Promise<WorkflowConfig> {
    const raw = await this.store.read(CONFIG_PATH);
    if (!raw) return {enabled:true, timezone:'Asia/Shanghai', daily:'10 Daily', planning:'50 Planning', lookback:7, projects:[]};
    const schema = z.object({schema_version:z.literal(1), timezone:z.string(), paths:z.object({daily:z.string(), planning:z.string()}),
      planner:z.object({enabled:z.boolean(),lookback_days:z.number().int().min(1).max(30)}), active_projects:z.array(z.object({name:z.string(),homepage:z.string(),planner:z.boolean()}))});
    const c = schema.parse(frontmatter(raw)); new Intl.DateTimeFormat('en',{timeZone:c.timezone});
    return {enabled:c.planner.enabled,timezone:c.timezone,daily:safePath(c.paths.daily),planning:safePath(c.paths.planning),lookback:c.planner.lookback_days,projects:c.active_projects.filter(p=>p.planner).map(p=>({...p,homepage:safePath(p.homepage)}))};
  }
  async tasks(): Promise<TaskRecord[]> {
    const paths = await this.store.list(TASK_DIR); const out: TaskRecord[] = []; const ids = new Set<string>();
    for (const path of paths.filter(p=>p.endsWith('.md'))) {
      const raw = await this.store.read(path); if (raw === null) continue;
      try {
        const task = TaskSchema.parse(frontmatter(raw));
        if (ids.has(task.id)) throw new Error('duplicate');
        ids.add(task.id); out.push({task,raw,path});
      } catch { throw new Error(`任务属性无效或 ID 重复，请先检查：${path}`); }
    }
    return out.sort((a,b)=>a.task.created.localeCompare(b.task.created));
  }
  async capture(original: string): Promise<TaskRecord> {
    const text = original.trim(); if (!text || text.length > 10000) throw new Error('任务原话须为 1–10000 字符');
    const now = new Date().toISOString(); const task = TaskSchema.parse({type:'research-planner-task',id:crypto.randomUUID(),title:text.split('\n')[0].slice(0,200),status:'open',priority:'normal',minutes:30,project:null,due:null,deferUntil:null,created:now,updated:now});
    const path = `${TASK_DIR}/${task.id}.md`, raw = taskText(task,text);
    await this.store.create(path,raw); return {task,path,raw};
  }
  async update(record: TaskRecord, fields: Partial<Task>): Promise<void> {
    const task = TaskSchema.parse({...record.task,...fields,id:record.task.id,type:record.task.type,created:record.task.created,updated:new Date().toISOString()});
    await this.store.compareWrite(record.path,record.raw,updateTaskText(record.raw,task));
  }
  async saveReview(day: string, text: string): Promise<string | null> {
    dateSchema.parse(day); if (!text.trim()) return null;
    if (text.length > 10000) throw new Error('复盘请控制在 10000 字符内');
    // Retrying after a failed request or reopening a form must not duplicate the same review.
    for (const path of await this.reviewPaths(day)) {
      const raw = await this.store.read(path);
      if (raw && this.reviewBody(raw, day) === text.trim()) return path;
    }
    const path = `${REVIEW_DIR}/${day}-${crypto.randomUUID()}.md`;
    await this.store.create(path,`---\ntype: research-planner-review\ndate: ${day}\n---\n\n${text.trim()}\n`); return path;
  }
  private async reviewPaths(day: string): Promise<string[]> {
    dateSchema.parse(day);
    return (await this.store.list(REVIEW_DIR)).filter(p => p.startsWith(`${REVIEW_DIR}/${day}-`) && p.endsWith('.md'));
  }
  private reviewBody(raw: string, day: string): string | null {
    try {
      const meta = frontmatter(raw);
      if(meta.type !== 'research-planner-review' || meta.date !== day) return null;
      return raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
    } catch {return null;}
  }
  async hasReview(day: string): Promise<boolean> {
    for(const path of await this.reviewPaths(day)) {
      const raw = await this.store.read(path);
      if(raw && this.reviewBody(raw, day)) return true;
    }
    return false;
  }
  async context(c: WorkflowConfig, day: string): Promise<{path:string;content:string}[]> {
    const paths = c.projects.map(p=>p.homepage);
    for (let i=c.lookback;i>=0;i--) paths.push(dailyPath(c,addDay(day,-i)));
    const planning = await this.store.list(c.planning);
    for (const p of planning) {
      if (p.startsWith(TASK_DIR+'/') || p.startsWith(REVIEW_DIR+'/')) continue;
      const raw=await this.store.read(p); if(!raw) continue;
      try { const f=frontmatter(raw); if(f.type==='planning' && f.status==='active') paths.push(p); } catch { /* not a Planning note */ }
    }
    const result=[]; let size=0;
    for (const path of [...new Set(paths)]) {
      const content=await this.store.read(safePath(path)); if(content===null) continue;
      size+=content.length; if(size>60000) throw new Error('上下文超过 60000 字符，请减少回看天数或活跃 Planning/项目');
      result.push({path,content});
    }
    return result;
  }
  async draft(plan: Plan, input: PlanInput, tasks: TaskRecord[], c: WorkflowConfig): Promise<Draft> {
    validatePlan(plan,input,tasks); const path=dailyPath(c,input.date), before=await this.store.read(path);
    const template = before ?? await this.store.read(TEMPLATE_PATH) ?? `---\ntype: daily\ndate: {{date:YYYY-MM-DD}}\n---\n\n# {{date:YYYY-MM-DD}}\n\n${START}\n${END}\n\n## 明日继续\n\n`;
    const base=before===null?template.replaceAll('{{date:YYYY-MM-DD}}',input.date):template;
    if(before===null && /\{\{.*?\}\}/.test(base)) throw new Error('Daily 模板有尚不支持的占位符');
    return {input,plan,tasks,path,before,after:replaceBlock(base,renderPlan(plan,tasks))};
  }
  async apply(d: Draft, saveJournal: (j: Journal)=>Promise<void>): Promise<void> {
    const c=await this.config(); if(!c.enabled) throw new Error('集中配置中 planner.enabled 为 false；请确认启用后再写入计划');
    if(d.path!==dailyPath(c,d.input.date)) throw new Error('Daily 路径配置已变化，请重新生成');
    const current=eligible(await this.tasks(),d.input.date);
    if(current.length!==d.tasks.length || current.some(r=>!d.tasks.some(old=>old.path===r.path&&old.raw===r.raw))) throw new Error('任务在预览后发生变化，请重新生成计划');
    if(await this.store.read(d.path)!==d.before) throw new Error('Daily 在预览后发生变化，请重新生成计划');
    await saveJournal({path:d.path,before:d.before,after:d.after,date:new Date().toISOString()});
    if(d.before===null) await this.store.create(d.path,d.after); else await this.store.compareWrite(d.path,d.before,d.after);
  }
  async undo(j: Journal): Promise<void> {
    const c=await this.config(); const prefix=safePath(c.daily)+'/';
    if(!safePath(j.path).startsWith(prefix)||!j.path.endsWith('.md')) throw new Error('撤销记录路径不在 Daily 范围');
    if(j.before===null) await this.store.compareRemove(j.path,j.after); else await this.store.compareWrite(j.path,j.after,j.before);
  }
}
