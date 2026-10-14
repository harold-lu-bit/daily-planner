import { z } from 'zod';
import { stringify } from 'yaml';
import { addDay, dateSchema, frontmatter, safePath, type Store } from './core';


export const QUEUE_PATH = '99 System/Automation/Research Planner Future.md';
const REVIEW_START = '<!-- research-planner:review:start -->';
const REVIEW_END = '<!-- research-planner:review:end -->';
const single = z.string().trim().min(1).max(2000).refine(v => !/[\r\n]|<!--|-->/.test(v), '任务文字不得包含换行或内部标记');
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const itemFields = {
  text: single, date: dateSchema.nullable(), deadline: dateSchema.nullable(),
  start: clock.nullable(), end: clock.nullable(), priority: z.enum(['normal', 'high']),
};
export const DecisionSchema = z.object({
  id: z.string().min(1).max(100), action: z.enum(['today', 'tomorrow', 'future', 'keep', 'cancel']),
  ...itemFields, reason: single,
  scheduleEvidence:z.object({source:z.enum(['task','feedback']),quote:single}).strict().optional(),
  sourceTaskId:z.string().min(1).max(100).optional(),
  timing:z.enum(['asap','explicit','hold','none']).optional(),timeSpecified:z.boolean().optional(),category:z.enum(['task','event','reminder']).optional(),
}).strict();
export const ReviewSchema = z.object({
  summary: z.string().trim().min(1).max(4000).refine(v => !/<!--|-->|^#{1,6}\s/m.test(v), '总结请使用普通段落，不包含标题或内部标记'),
  decisions: z.array(DecisionSchema).max(200), questions: z.array(single).max(30),
}).strict();
export type Review = z.infer<typeof ReviewSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
const FutureSchema = z.object({id:z.string().uuid(), ...itemFields, date:dateSchema,ancestry:z.array(single).max(20).optional()}).strict();
export type FutureTask = z.infer<typeof FutureSchema>;
const ReceiptSchema = z.object({
  id:z.string().uuid(), text:z.string(), details:z.string(), reviewedDigest:z.string().regex(/^[0-9a-f]{64}$/).optional(),ancestry:z.array(z.string()).max(20).optional(),
}).strict();
type Receipt = z.infer<typeof ReceiptSchema>;
const DiaryStateSchema = z.object({day:dateSchema,path:z.string(),tasks:z.array(ReceiptSchema).max(500),wasChecklist:z.boolean().optional()}).strict();
const QueueSchema = z.object({
  type:z.literal('research-planner-future'), version:z.union([z.literal(1),z.literal(2)]),
  reviewed:z.array(dateSchema).max(90), tasks:z.array(FutureSchema).max(200),
  diaries:z.array(DiaryStateSchema).max(128).optional(),
}).strict();
export type Queue = z.infer<typeof QueueSchema>;
export interface TaskParent {text:string;line:number;indent:string;id?:string;}
export interface DailyTask { id:string; text:string; line:number; done:boolean; details:string; parents:TaskParent[]; indent:string; reviewedDigest?:string; sourceDay?:string; sourcePath?:string; }
export interface CompletedTask extends DailyTask { digest:string; }
export interface Layout { day:string; todayPath:string; tomorrowPath:string; templatePath:string; heading:string; enabled:boolean; }
export interface ReviewOptions { target?:'today'|'tomorrow'; catchUp?:boolean; from?:string; sourceMode?:'latest'|'range'; }
export interface DiarySnapshot { day:string; path:string; raw:string|null; tasks:DailyTask[]; layout:Layout; }
export interface Snapshot {
  layout:Layout; today:string|null; tomorrow:string|null; template:string|null; queueRaw:string|null;
  tasks:DailyTask[]; completed:CompletedTask[]; existing:DailyTask[]; queue:Queue;
  target:'today'|'tomorrow'; targetDay:string; history:DiarySnapshot[]; warnings:string[];
  sourceMode?:'latest'|'range'; probes?:DiarySnapshot[];
}
export interface Change {path:string; before:string|null; after:string;}
export interface BatchJournal {version:2; day:string; changes:Change[]; state:'pending'|'applied'|'reverted'; sourceDays?:string[];}
export interface OutlineRow {text:string;ancestry:string[];details?:string;}
export interface DailyDraft {snapshot:Snapshot; review:Review; changes:Change[]; warnings:string[];outline:OutlineRow[];}

function lines(raw:string):string[] {return raw.split('\n');}
function clean(line:string):string {return line.replace(/\r$/, '');}
function headings(raw:string):{line:number;level:number;name:string}[] {
  const out=[];let fence='';let yaml=raw.startsWith('---\n')||raw.startsWith('---\r\n');
  for(const [line,original] of lines(raw).entries()) {
    const s=clean(original);
    if(yaml){if(line>0 && s==='---')yaml=false;continue;}
    const f=/^\s{0,3}(`{3,}|~{3,})/.exec(s);
    if(f){if(!fence)fence=f[1];else if(f[1][0]===fence[0]&&f[1].length>=fence.length)fence='';continue;}
    if(fence)continue;
    const h=/^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(s);
    if(h)out.push({line,level:h[1].length,name:h[2]});
  }
  return out;
}
function section(raw:string,heading:string):{start:number;end:number}|null {
  const hs=headings(raw),matches=hs.filter(h=>h.level===2&&h.name===heading);
  if(matches.length>1)throw new Error(`发现多个 ## ${heading}，请先合并任务区域`);
  if(!matches.length)return null;
  const h=matches[0];return {start:h.line+1,end:hs.find(x=>x.line>h.line&&x.level<=2)?.line??lines(raw).length};
}
export function readTasks(raw:string,heading='Tasks',receipts:Receipt[]=[]):DailyTask[] {
  const range=section(raw,heading);if(!range)return [];
  const all=lines(raw),tasks:DailyTask[]=[],parents:TaskParent[]=[];let fence='';
  for(let i=range.start;i<range.end;i++) {
    const s=clean(all[i]);const f=/^\s*(`{3,}|~{3,})/.exec(s);
    if(f){if(!fence)fence=f[1];else if(f[1][0]===fence[0]&&f[1].length>=fence.length)fence='';continue;}
    if(fence)continue;
    const m=/^([ \t]*)(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.*)$/.exec(s);
    if(!m){if(/^#{1,6}\s/.test(s))parents.length=0;continue;}
    const width=(indent:string)=>indent.replace(/\t/g,'    ').length;
    while(parents.length&&width(parents.at(-1)!.indent)>=width(m[1]))parents.pop();
    const marker=/<!-- rp:([0-9a-f-]{36}) -->/.exec(m[3]);
    const reviewedDigest=/<!-- rp-reviewed:([0-9a-f]{64}) -->/.exec(m[3])?.[1];
    const text=m[3].replace(/<!-- rp:[0-9a-f-]{36} -->/g,'').replace(/<!-- rp-reviewed:[0-9a-f]{64} -->/g,'').trim();if(!text)continue;
    if(m[2]===undefined){parents.push({text,line:i,indent:m[1]});continue;}
    // Only indented continuation prose belongs to this checkbox, never another task or code block.
    const indent=/^\s*/.exec(s)![0].replace(/\t/g,'    ').length,details:string[]=[];
    for(let j=i+1;j<range.end;j++) {
      const next=clean(all[j]);
      if(!next.trim())break;
      const depth=/^\s*/.exec(next)![0].replace(/\t/g,'    ').length;
      const list=/^\s*(?:[-*+]|\d+[.)])\s+/.test(next);
      let hasChild=false;
      if(list)for(let k=j+1;k<range.end;k++){
        const line=all[k];if(!line.trim())continue;
        if(line.match(/^[ \t]*/)![0].replace(/\t/g,'    ').length<=depth)break;
        if(/^\s*(?:[-*+]|\d+[.)])\s+\[/.test(line)){hasChild=true;break;}
      }
      if(depth<=indent||hasChild||/^\s*(?:[-*+]|\d+[.)])\s+\[/.test(next)||/^\s*(?:`{3,}|~{3,}|#{1,6}\s|<!--)/.test(next))break;
      details.push(next.trim());
    }
    const detail=details.join('\n');
    const ancestry=parents.map(p=>p.text);
    const candidates=receipts.filter(t=>t.text===text&&t.details===detail&&!tasks.some(seen=>seen.id===t.id));
    const known=candidates.find(t=>!t.ancestry||JSON.stringify(t.ancestry)===JSON.stringify(ancestry))??(candidates.length===1?candidates[0]:undefined);
    const id=marker?.[1]??known?.id??crypto.randomUUID();
    tasks.push({id,text,line:i,done:m[2]!==' ',details:detail,parents:[...parents],indent:m[1],reviewedDigest:reviewedDigest??known?.reviewedDigest});
    parents.push({id,text,line:i,indent:m[1]});
  }
  if(new Set(tasks.map(t=>t.id)).size!==tasks.length)throw new Error('日记中有重复任务标识，请检查复制的任务');
  return tasks;
}
export function parseQueue(raw:string|null):Queue {
  if(raw===null||!raw.trim())return {type:'research-planner-future',version:1,reviewed:[],tasks:[]};
  const q=QueueSchema.parse(frontmatter(raw));
  if(new Set(q.tasks.map(t=>t.id)).size!==q.tasks.length)throw new Error('跨日清单存在重复任务标识');
  if(new Set((q.diaries??[]).map(n=>n.path)).size!==(q.diaries??[]).length)throw new Error('日记状态存在重复路径');
  for(const note of q.diaries??[]) {
    safePath(note.path);
    if(new Set(note.tasks.map(t=>t.id)).size!==note.tasks.length)throw new Error('日记状态存在重复任务标识');
  }
  return q;
}
function receipt(t:DailyTask):Receipt {
  return {id:t.id,text:t.text,details:t.details,...(t.parents.length?{ancestry:t.parents.map(p=>p.text)}:{}),...(t.reviewedDigest?{reviewedDigest:t.reviewedDigest}:{})};
}
export function pendingTasks(s:Snapshot):DailyTask[] {return [...s.history.flatMap(n=>n.tasks),...s.tasks].filter(t=>!t.done);}
// Strip only this plugin's task markers inside Tasks; preserve links, prose and fenced examples.
function withoutTaskMarkers(raw:string,heading:string):string {
  const range=section(raw,heading);if(!range)return raw;
  const all=lines(raw);let fence='';
  for(let i=range.start;i<range.end;i++) {
    const f=/^\s*(`{3,}|~{3,})/.exec(all[i]);
    if(f){if(!fence)fence=f[1];else if(f[1][0]===fence[0]&&f[1].length>=fence.length)fence='';continue;}
    if(!fence&&/^\s*(?:[-*+]|\d+[.)])\s/.test(all[i]))all[i]=all[i].replace(/[ \t]*<!-- rp:(?:[0-9a-f-]{36}) -->/g,'').replace(/[ \t]*<!-- rp-reviewed:[0-9a-f]{64} -->/g,'');
  }
  return all.join('\n');
}
function textOf(t:z.infer<typeof FutureSchema>|Decision):string {
  const time=t.start?(t.end?`${t.start} - ${t.end} `:`${t.start} `):'';
  return `${time}${t.text}${t.priority==='high'?'（优先）':''}${t.deadline?` 📅 ${t.deadline}`:''}`;
}
export function renderQueue(q:Queue):string {
  QueueSchema.parse(q);
  return `---\n${stringify(q)}---\n\n# 跨日任务\n\n由复盘面板维护，上方属性是任务数据；下面是阅读视图。请通过复盘意见修改或取消任务。\n\n${q.tasks.map(t=>`- ${t.date}：${textOf(t)}`).join('\n')||'暂无待安排任务。'}\n`;
}
export function renderTemplate(raw:string,day:string,title:string,format:(day:string,pattern:string)=>string):string {
  const out=raw.replace(/\{\{date(?::([^}]+))?\}\}/g,(_,pattern)=>format(day,pattern||'YYYY-MM-DD')).replaceAll('{{title}}',title);
  if(/\{\{|<%/.test(out))throw new Error('模板包含尚不支持的变量或 Templater 脚本；请先使用内置日期/标题模板');
  return out;
}
function appendTasks(raw:string,heading:string,entries:string[]):string {
  if(!entries.length)return raw;
  const newline=raw.includes('\r\n')?'\r\n':'\n';const range=section(raw,heading);
  if(!range)return raw+(raw.endsWith('\n')?'':'\n')+`${newline}## ${heading}${newline}${newline}${entries.join(newline)}${newline}`;
  const all=lines(raw);let at=range.end;
  while(at>range.start&&!clean(all[at-1]).trim())at--;
  // Remove only empty template checkboxes, never existing tasks or surrounding prose.
  for(let i=at-1;i>=range.start;i--)if(/^\s*[-*+] \[ \]\s*$/.test(clean(all[i]))){all.splice(i,1);at--;}
  all.splice(at,0,...entries.map(s=>s+(newline==='\r\n'?'\r':'')));
  return all.join('\n');
}
interface OutlineNode {text:string;row?:OutlineRow;children:Map<string,OutlineNode>;}
function outlineTree(rows:OutlineRow[]):Map<string,OutlineNode> {
  const roots=new Map<string,OutlineNode>();
  for(const row of rows) {
    let branch=roots;
    for(const text of [...row.ancestry,row.text]) {
      if(!branch.has(text))branch.set(text,{text,children:new Map()});
      const node=branch.get(text)!;branch=node.children;
    }
    let nodes=roots,node!:OutlineNode;
    for(const text of [...row.ancestry,row.text]){node=nodes.get(text)!;nodes=node.children;}
    if(node.row)throw new Error('同一父任务下出现同名任务，请核对重复安排');
    node.row=row;
  }
  return roots;
}
export function outlinePreview(rows:OutlineRow[]):{text:string;depth:number;task:boolean}[] {
  const out:{text:string;depth:number;task:boolean}[]=[];
  const walk=(nodes:Map<string,OutlineNode>,depth:number)=>{for(const n of nodes.values()){out.push({text:n.text,depth,task:!!n.row});walk(n.children,depth+1);}};
  walk(outlineTree(rows),0);return out;
}
function mergeOutline(raw:string,heading:string,rows:OutlineRow[]):string {
  if(!rows.length)return raw;
  const nodes=outlineTree(rows),existing=readTasks(raw,heading),all=lines(raw),range=section(raw,heading);
  const contexts=new Map<string,{line:number;indent:string}>(),ambiguous=new Set<string>();
  for(const t of existing) {
    const names:string[]=[];
    for(const n of [...t.parents,{text:t.text,line:t.line,indent:t.indent}]) {
      names.push(n.text);const key=JSON.stringify(names),prior=contexts.get(key);
      if(prior&&prior.line!==n.line)ambiguous.add(key);contexts.set(key,n);
    }
  }
  const render=(node:OutlineNode,indent:string):string[]=>[
    `${indent}- ${node.row?'[ ] ':''}${node.text}`,
    ...(node.row?.details?.split('\n').filter(Boolean).map(line=>indent+'    '+line)??[]),
    ...[...node.children.values()].flatMap(child=>render(child,indent+'    ')),
  ];
  const inserts=new Map<number,string[]>(),roots:string[]=[];
  const walk=(branch:Map<string,OutlineNode>,parents:string[],parent?:{line:number;indent:string})=>{
    for(const node of branch.values()) {
      const names=[...parents,node.text],key=JSON.stringify(names),found=contexts.get(key);
      if(ambiguous.has(key))throw new Error('目标日记中有多个同名父任务，请先区分');
      if(found&&!node.row){walk(node.children,names,found);continue;}
      if(found&&node.row)throw new Error('目标日记已有同名任务，请核对后重新读取，避免重复安排');
      const chunk=render(node,parent?parent.indent+'    ':'');
      if(!parent){roots.push(...chunk);continue;}
      let at=parent.line+1;
      while(at<(range?.end??all.length)) {
        const line=clean(all[at]);
        if(line.trim()&&line.match(/^[ \t]*/)![0].replace(/\t/g,'    ').length<=parent.indent.replace(/\t/g,'    ').length)break;
        at++;
      }
      while(at>parent.line+1&&!clean(all[at-1]).trim())at--;
      inserts.set(at,[...(inserts.get(at)??[]),...chunk]);
    }
  };
  walk(nodes,[]);
  for(const [at,chunk] of [...inserts].sort((a,b)=>b[0]-a[0]))all.splice(at,0,...chunk.map(s=>s+(raw.includes('\r\n')?'\r':'')));
  return appendTasks(all.join('\n'),heading,roots);
}
function withReview(raw:string,summary:string,title='晚间复盘'):string {
  const newline=raw.includes('\r\n')?'\r\n':'\n';
  const block=[REVIEW_START,`## ${title}`,'',...summary.split(/\r?\n/),REVIEW_END].join(newline);
  const a=raw.indexOf(REVIEW_START),b=raw.indexOf(REVIEW_END);
  if(a<0&&b<0)return raw+(raw.endsWith('\n')?'':'\n')+newline+block+newline;
  if(a<0||b<a||raw.split(REVIEW_START).length!==2||raw.split(REVIEW_END).length!==2)throw new Error('复盘区域标记异常，请先修复');
  return raw.slice(0,a)+block+raw.slice(b+REVIEW_END.length);
}
export function reviewPayload(snapshot:Snapshot,feedback:string[],previous:Review|null) {
  return {
    today:snapshot.layout.day,tomorrow:addDay(snapshot.layout.day,1),
    target:snapshot.target,targetDate:snapshot.targetDay,
    sourceMode:snapshot.sourceMode??'range',
    authoritativeTodoDay:snapshot.sourceMode==='latest'?(snapshot.history[0]?.day??snapshot.layout.day):null,
    daily:snapshot.today??'',
    sourceNotes:snapshot.history.map(n=>({day:n.day,text:n.raw??''})),
    tasks:pendingTasks(snapshot).map(({id,text,details,sourceDay,parents})=>({id,text,details,sourceDay,parentId:parents.at(-1)?.id??null,ancestry:parents.map(p=>p.text),source:sourceDay===snapshot.layout.day?'today':'missed'})),
    completed:snapshot.completed.map(({id,text,details,sourceDay,parents})=>({id,text,details,sourceDay,ancestry:parents.map(p=>p.text),source:'completed'})),
    future:snapshot.queue.tasks.map(t=>({...t,source:'future'})),
    tomorrowExisting:snapshot.existing.map(({id,text,done,parents})=>({id,text,done,ancestry:parents.map(p=>p.text)})),
    feedback,previous,
  };
}
export const reviewInstruction = `你是个人科研规划助手，负责理解任务语义、相对日期、简称、指代、多轮修改和任务拆分。
输入 today/currentTime/timezone 是本次时间，targetDate 是用户选择安排的日期。sourceDay 是原文日期，原文的相对日期以它为参照，用户本轮意见以 today 为参照。跨月跨年按自然语言上下文推理；真正有歧义再询问，不要因未匹配某种写法而要求改写。
用户偏好：没有明确安排日期表示尽快完成，安排到 targetDate；不能因为任务多、优先级或负荷而延期。区分安排、截止、活动、准备、提醒和历史背景日期。截止日不等于开始日。无指定时刻不编造时间块。未来分组无具体日期时澄清，不擅自塞进今天；明确的未来活动不能提前。过期队列默认接续到目标日，用户明确暂缓则保留。
sourceMode=latest 时 authoritativeTodoDay 的当前清单为准；已复盘或漏做多天都不表示完成。你只能规划 tasks、future、completed 中明确的后续，以及用户对话明确新增的任务。daily 和 sourceNotes 的其他章节仅作背景，不能自行扩张任务范围。已完成原条目不恢复成未完成；不存在明确后续时 keep/date=null。不能从历史记录复活用户删除的任务。
每个输入 tasks/completed/future ID 必须有且仅有一个处置。原层级和顺序由代码保留。多日活动或多个提醒可拆分：原 ID 保留一项，新增用 new:N 并关联 sourceTaskId；不要为所有日期机械建任务。新增一般只来自用户明确意见或来源任务的拆分。tomorrowExisting 保持原样；当前写入范围不支持更改它时向用户说明。
Review={summary:日记用简短总结,decisions:[decision],questions:[真正未解决的问题]}。
decision={id,action,text,date,deadline,start,end,priority,reason,timing,timeSpecified,category}；id 原样引用输入或 new:N；action 是 today/tomorrow/future/keep/cancel；text 普通单行任务标题，不嵌入 checkbox、HTML 注释或元数据；date/deadline 为有效 YYYY-MM-DD 或 null；start/end 为 HH:mm 或 null；priority=normal/high；reason 说明依据。可选 sourceTaskId 仅用于新增拆分；scheduleEvidence={source:task/feedback,quote:逐字来源片段} 是可选解释证据。
安排到 targetDate 时 action=target；future 日期必须晚于 targetDate；keep 对原日记 date=null，对队列 date 保持原值；cancel/date=null。保留、取消、改期均应符合用户意图。只提出预览，不声称已写入。不可虚构进展或声称读过未提供文件。
previous 是当前有效草稿，previousProcessing 是最近提议的校验结果；明确指出缺失上下文或校验错误，不自行宣称它们已解决。存在影响计划的歧义时用 questions 或对话澄清。用户最新明确意见优先于先前意见和原安排；历史模型建议只有被用户接受才成为要求。`;
export class DailyService {
  constructor(public store:Store,private layout:(day:string)=>Promise<Layout>,private format:(day:string,pattern:string)=>string=(day,pattern)=>pattern.replaceAll('YYYY',day.slice(0,4)).replaceAll('MM',day.slice(5,7)).replaceAll('DD',day.slice(8,10))) {}
  async snapshot(day:string,options:ReviewOptions={}):Promise<Snapshot> {
    dateSchema.parse(day);const layout=await this.layout(day);
    const target=options.target??'tomorrow',targetDay=target==='today'?day:addDay(day,1);
    for(const path of [layout.todayPath,layout.tomorrowPath,layout.templatePath])safePath(path);
    if(new Set([layout.todayPath,layout.tomorrowPath,layout.templatePath,QUEUE_PATH]).size!==4)throw new Error('日记、模板和跨日清单路径不能相同');
    const [today,tomorrow,queueRaw]=await Promise.all([this.store.read(layout.todayPath),this.store.read(layout.tomorrowPath),this.store.read(QUEUE_PATH)]);
    const needsTemplate=!today?.trim()||(target==='tomorrow'&&!tomorrow?.trim());
    const template=needsTemplate?await this.store.read(layout.templatePath):null;
    if(needsTemplate&&template===null)throw new Error('未找到日记模板，请在 Daily Notes 设置模板路径');
    if((queueRaw?.length??0)>5000000)throw new Error('跨日状态文件过大，请先检查');
    const queue=parseQueue(queueRaw),warnings:string[]=[];
    const read=(raw:string|null,p:string,d:string)=>{
      const ts=readTasks(raw??'',layout.heading,queue.diaries?.find(n=>n.path===p)?.tasks);
      if(new Set(ts.map(t=>JSON.stringify([t.parents.map(p=>p.text),t.text,t.details]))).size!==ts.length)throw new Error(`${d} 同一层级有同内容任务，请补充文字区分，避免无标记任务混淆`);
      return ts.map(t=>({...t,sourcePath:p,sourceDay:d}));
    };
    const tasks=read(today,layout.todayPath,day),existing=read(tomorrow,layout.tomorrowPath,addDay(day,1));
    const history:DiarySnapshot[]=[],probes:DiarySnapshot[]=[];
    const sourceMode=options.sourceMode??'range';
    const knownChecklist=(p:string)=>queue.diaries?.some(n=>n.path===p&&(n.wasChecklist||n.tasks.length>0));
    if(sourceMode==='latest'&&options.catchUp&&!tasks.length&&!knownChecklist(layout.todayPath)) {
      // The most recent checklist is authoritative even if that date was already reviewed.
      // Keep empty/missing newer notes as read guards, not task sources or write targets.
      const used=new Set([layout.todayPath,layout.tomorrowPath,layout.templatePath,QUEUE_PATH]);
      for(let offset=1;offset<=30;offset++) {
        const d=addDay(day,-offset),pastLayout=await this.layout(d),p=safePath(pastLayout.todayPath);
        if(used.has(p)||pastLayout.heading!==layout.heading)throw new Error('日记日期映射到重复路径或章节设置发生变化，请检查 Daily Notes 配置');
        used.add(p);const raw=await this.store.read(p);
        if((raw?.length??0)>90000)throw new Error('来源日记超过 90000 字符，请先整理');
        const note={day:d,path:p,raw,tasks:read(raw,p,d),layout:pastLayout};
        // A known checklist emptied by the user is also a stopping boundary. Never revive older lists.
        if(note.tasks.length||knownChecklist(p)) {history.push(note);break;}
        probes.push(note);
      }
      if(!history.length)warnings.push('最近 30 天未找到 TODO 清单；没有将缺失日记视作任务完成。请把更早的清单整理到今天，或选择按日期范围补读。');
      else if(!history[0].tasks.length)warnings.push(`${history[0].day} 的已登记 TODO 已被清空，未恢复更早的清单。`);
    } else if(sourceMode==='range'&&(options.catchUp||options.from)) {
      const last=queue.reviewed.filter(d=>d<=day).sort().at(-1),earliest=addDay(day,-30);
      let from=options.from??(last?(last===day?day:addDay(last,1)):addDay(day,-7));
      dateSchema.parse(from);
      if(from>day)throw new Error('补读起始日不能晚于今天');
      if(from<earliest) {
        if(options.from)throw new Error('每次最多补读最近 30 天，请缩小日期范围；更早遗漏可在意见中补充');
        from=earliest;warnings.push(`遗漏超过 30 天，本次只读取 ${earliest} 起的日记；更早任务请在意见中补充。`);
      }
      if(!last&&!options.from)warnings.push('没有此前复盘记录，默认补读最近 7 天；可以修改补读起始日（最多 30 天）。');
      const used=new Set([layout.todayPath,layout.tomorrowPath,layout.templatePath,QUEUE_PATH]);
      for(let d=from;d<day;d=addDay(d,1)) {
        const pastLayout=await this.layout(d),p=safePath(pastLayout.todayPath);
        if(used.has(p)||pastLayout.heading!==layout.heading)throw new Error('日记日期映射到重复路径或章节设置发生变化，请检查 Daily Notes 配置');
        used.add(p);const raw=await this.store.read(p);
        history.push({day:d,path:p,raw,tasks:read(raw,p,d),layout:pastLayout});
      }
    }
    if([today,tomorrow,template,...history.map(n=>n.raw),JSON.stringify(queue.tasks)].reduce<number>((n,s)=>n+(s?.length??0),0)>90000)throw new Error('本次日记与待安排任务超过 90000 字符，请缩小补读范围');
    const completed:CompletedTask[]=[];
    const sourceTasks=[...history.flatMap(n=>n.tasks),...tasks];
    for(const task of sourceTasks.filter(t=>t.done)) {
      const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([task.text,task.details])));
      const digest=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
      if(task.reviewedDigest!==digest)completed.push({...task,digest});
    }
    const all=[...sourceTasks.filter(t=>!t.done),...completed,...queue.tasks];
    if(all.length>150)throw new Error('本次待处理任务超过 150 项，请先整理');
    if(new Set([...sourceTasks,...queue.tasks].map(t=>t.id)).size!==sourceTasks.length+queue.tasks.length)throw new Error('日记与跨日清单有重复任务，请先检查同步或恢复未完成写入');
    return {layout,today,tomorrow,template,queueRaw,tasks,completed,existing,queue,target,targetDay,history,warnings,sourceMode,probes};
  }
  draft(snapshot:Snapshot,raw:Review,allowNew:boolean,feedback:string[]=[]):DailyDraft {
    const review=ReviewSchema.parse(raw),day=snapshot.layout.day,next=snapshot.targetDay;
    const inputs=[...pendingTasks(snapshot),...snapshot.completed,...snapshot.queue.tasks];
    const seen=new Set<string>(),assigned=new Map<string,string>();

    for(const d of review.decisions) {
      if(seen.has(d.id))throw new Error('模型重复处理了同一任务');seen.add(d.id);
      const input=inputs.find(t=>t.id===d.id);
      const completed=snapshot.completed.find(t=>t.id===d.id);
      const splitSource=d.sourceTaskId?inputs.find(t=>t.id===d.sourceTaskId):undefined;
      if(d.sourceTaskId&&(input||!splitSource))throw new Error('拆分任务的来源 ID 无效');
      if(!input&&!((allowNew||splitSource)&&/^new:\d+$/.test(d.id)))throw new Error('模型包含未知任务 ID');
      if(!input&&!['future','today','tomorrow'].includes(d.action))throw new Error('新增任务必须明确安排日期');
      if(completed&&(d.action==='cancel'||(d.action==='keep'&&d.date!==null)))throw new Error('已完成项应保留原状态；无新增后续请使用 keep 和空日期');
      if(['today','tomorrow'].includes(d.action)&&(d.action!==snapshot.target||d.date!==next))throw new Error('目标任务日期错误，请按选定的今天或明天安排');
      const future=snapshot.queue.tasks.find(t=>t.id===d.id);
      if(d.action==='keep'&&future&&d.date!==future.date)throw new Error('保留的跨日任务日期不能改变，请明确重新安排');
      if(d.end&&(!d.start||d.end<=d.start))throw new Error('结束时间必须晚于开始时间；跨午夜安排请拆开');
      // Semantic interpretation belongs to the model. Validate its structured
      // proposal without rewriting dates, times, reasons or task dispositions.
      const scheduled=['today','tomorrow','future'].includes(d.action);
      if(d.timing==='asap'&&(!scheduled||d.action!==snapshot.target||d.date!==next))throw new Error(`${d.id}: timing=asap 必须安排到 ${next}，不能因任务量延期`);
      if(d.timing&&scheduled&&!['asap','explicit'].includes(d.timing))throw new Error(`${d.id}: 已安排任务 timing 必须为 asap 或 explicit`);
      if(d.timing&&d.action==='keep'&&!['hold','none'].includes(d.timing))throw new Error(`${d.id}: keep 需要 hold 或 none 分类`);
      if(d.timing==='none'&&d.action==='keep'&&!completed)throw new Error(`${d.id}: 未完成任务暂不安排需要 timing=hold`);
      if(d.timing&&d.action==='cancel'&&d.timing!=='none')throw new Error(`${d.id}: cancel 需要 timing=none`);
      if(d.action==='keep'&&!future&&d.date!==null)throw new Error(`${d.id}: 留在原日记的任务 date 必须为 null`);
      if(d.action==='cancel'&&d.date!==null)throw new Error(`${d.id}: 取消任务 date 必须为 null`);
      if(d.timeSpecified===false&&(d.start||d.end))throw new Error(`${d.id}: 未指定时刻时 start/end 必须为 null`);
      if(d.action==='future'&&(!d.date||d.date<=next))throw new Error(`${d.id}: 未来任务必须安排在目标日期之后`);
      const sourceId=d.sourceTaskId??d.id;
      const task=[...pendingTasks(snapshot),...snapshot.completed].find(t=>t.id===sourceId);
      const queuedSource=snapshot.queue.tasks.find(t=>t.id===sourceId);
      const sourceText=task?[task.text,task.details,...task.parents.map(p=>p.text)].join('\n'):queuedSource?[queuedSource.text,...(queuedSource.ancestry??[])].join('\n'):'';
      if(d.scheduleEvidence){
        const {source,quote}=d.scheduleEvidence;
        if(!(source==='task'?sourceText.includes(quote):feedback.some(f=>f.includes(quote))))throw new Error(`${d.id}: 日期证据不是对应来源的逐字引用，请修正引用或省略可选证据并说明理由`);
      }
      assigned.set(d.id,input&&!completed?d.id:crypto.randomUUID());
    }
    if(inputs.some(t=>!seen.has(t.id)))throw new Error('模型遗漏了输入任务，没有生成可写入草稿');
    const order=new Map(inputs.map((t,i)=>[t.id,i]));
    review.decisions.sort((a,b)=>(order.get(a.id)??inputs.length)-(order.get(b.id)??inputs.length));
    const warnings:string[]=[...snapshot.warnings];
    let today=snapshot.today?.trim()?snapshot.today:renderTemplate(snapshot.template!,day,snapshot.layout.todayPath.split('/').pop()!.replace(/\.md$/,''),this.format);
    let tomorrow=snapshot.tomorrow??'';
    if(snapshot.target==='tomorrow'&&!tomorrow.trim())tomorrow=renderTemplate(snapshot.template!,next,snapshot.layout.tomorrowPath.split('/').pop()!.replace(/\.md$/,''),this.format);
    const sourceLines=new Map([[snapshot.layout.todayPath,lines(today)],...snapshot.history.map(n=>[n.path,lines(n.raw??'')] as [string,string[]])]);
    const sourceTasks=[...snapshot.tasks,...snapshot.history.flatMap(n=>n.tasks)];
    const records=new Map<string,Receipt[]>([[snapshot.layout.todayPath,snapshot.tasks.map(receipt)],[snapshot.layout.tomorrowPath,snapshot.existing.map(receipt)],...snapshot.history.map(n=>[n.path,n.tasks.map(receipt)] as [string,Receipt[]])]);
    const targetPath=snapshot.target==='today'?snapshot.layout.todayPath:snapshot.layout.tomorrowPath;
    const queue:Queue={...snapshot.queue,version:2,reviewed:[...new Set([...snapshot.queue.reviewed,day])].sort().slice(-90),tasks:[]};
    const additions:OutlineRow[]=[],outline:OutlineRow[]=[];
    const ancestryOf=(task:DailyTask|undefined,queued:FutureTask|undefined):string[]=>task?task.parents.map(p=>{
      const parent=review.decisions.find(d=>d.id===p.id);
      return parent&&['today','tomorrow','future'].includes(parent.action)?textOf(parent):p.text;
    }):queued?.ancestry??[];
    const targetExisting=snapshot.target==='tomorrow'?snapshot.existing:snapshot.tasks.filter(t=>t.done||review.decisions.find(d=>d.id===t.id)?.action==='keep');
    const existingKeys=new Set(targetExisting.map(t=>JSON.stringify([...t.parents.map(p=>p.text),t.text.trim()])));
    const intervals:{start:string;end:string;text:string}[]=targetExisting.filter(t=>!t.done).flatMap(t=>{
      const m=/^(\d{2}:\d{2})(?:\s*[-–—]\s*(\d{2}:\d{2}))?(?:\s|$)/.exec(t.text);return m?[{start:m[1],end:m[2]??m[1],text:t.text}]:[];
    });
    for(const d of review.decisions) {
      const id=assigned.get(d.id)!;
      const source=sourceTasks.find(t=>!t.done&&t.id===d.id);
      const completed=snapshot.completed.find(t=>t.id===d.id);
      const queued=snapshot.queue.tasks.find(t=>t.id===d.id);
      const splitTask=d.sourceTaskId?sourceTasks.find(t=>t.id===d.sourceTaskId):undefined;
      const ancestry=ancestryOf(source??completed??splitTask,queued??snapshot.queue.tasks.find(t=>t.id===d.sourceTaskId));
      if(d.action===snapshot.target) {
        const text=textOf(d);
        if(targetExisting.some(t=>t.id===id))throw new Error('该任务已经出现在目标日记，请先核对重复或未完成的写入');
        const key=JSON.stringify([...ancestry,text]);
        if(existingKeys.has(key))throw new Error('目标日记已有同名任务，请核对后重新读取，避免重复安排');
        existingKeys.add(key);
        const row={text,ancestry,details:source?.details??''};outline.push(row);
        if(d.start&&d.category!=='reminder') {
          if(intervals.some(x=>x.start===x.end?(d.start!<=x.start&&(d.end?d.end>x.start:d.start===x.start)):(d.start!<x.end&&(d.end?d.end>x.start:d.start!>=x.start))))warnings.push(`时间可能冲突：${text}`);
          intervals.push({start:d.start,end:d.end??d.start,text});
        }
        if(source?.sourcePath===targetPath) {
          const all=sourceLines.get(targetPath)!,line=all[source.line],cr=line.endsWith('\r')?'\r':'';
          const prefix=/^(\s*(?:[-*+]|\d+[.)])\s+\[ \]\s*)/.exec(line)![1];
          all[source.line]=`${prefix}${text}${cr}`;
          const record=records.get(targetPath)!.find(t=>t.id===id)!;record.text=text;record.ancestry=ancestry;
        } else {
          additions.push(row);
          records.get(targetPath)!.push({id,text,details:source?.details??'',ancestry});
        }
      }
      if(d.action==='future'||(d.action==='keep'&&snapshot.queue.tasks.some(t=>t.id===d.id))) {
        queue.tasks.push(FutureSchema.parse({id,text:d.text,date:d.date,deadline:d.deadline,start:d.start,end:d.end,priority:d.priority,...(ancestry.length?{ancestry}:{})}));
      }
      if(completed) {
        records.get(completed.sourcePath!)!.find(t=>t.id===completed.id)!.reviewedDigest=completed.digest;
      }
      if(source&&d.action!=='keep'&&!(source.sourcePath===targetPath&&d.action===snapshot.target)) {
        const all=sourceLines.get(source.sourcePath!)!;
        const indent=/^\s*/.exec(all[source.line])![0],cr=all[source.line].endsWith('\r')?'\r':'';
        const target=d.action===snapshot.target?`已转至 [[${targetPath.replace(/\.md$/,'')}|${next}]]`:d.action==='future'?`已登记跨日任务（${d.date}）`:'已取消';
        all[source.line]=`${indent}- ${source.text} → ${target}${cr}`;
        records.set(source.sourcePath!,records.get(source.sourcePath!)!.filter(t=>t.id!==source.id));
      }
    }
    const futureKeys=new Set<string>();
    for(const task of queue.tasks) {
      const key=JSON.stringify([task.date,task.ancestry??[],textOf(task).trim().replace(/\s+/g,' ')]);
      if(futureKeys.has(key))throw new Error('跨日清单出现同日期同名任务，请核对已登记的后续安排，避免重复');
      futureKeys.add(key);
    }
    today=withReview(sourceLines.get(snapshot.layout.todayPath)!.join('\n'),review.summary,snapshot.target==='today'?'日程安排':'晚间复盘');
    if(snapshot.target==='today')today=mergeOutline(today,snapshot.layout.heading,additions);
    else tomorrow=mergeOutline(tomorrow,snapshot.layout.heading,additions);
    if(snapshot.queue.reviewed.includes(day))warnings.push('今天已有确认过的复盘；本次会更新总结并合并新任务。');
    const candidates:Change[]=[
      ...(snapshot.target==='tomorrow'?[{path:snapshot.layout.tomorrowPath,before:snapshot.tomorrow,after:tomorrow}]:[]),
      {path:snapshot.layout.todayPath,before:snapshot.today,after:today},
      ...snapshot.history.filter(n=>n.raw!==null).map(n=>({path:n.path,before:n.raw,after:sourceLines.get(n.path)!.join('\n')})),
    ];
    const diaries=new Map((queue.diaries??[]).filter(n=>n.day>=addDay(day,-30)).map(n=>[n.path,n]));
    for(const c of candidates) {
      c.after=withoutTaskMarkers(c.after,snapshot.layout.heading);
      const d=c.path===snapshot.layout.todayPath?day:c.path===snapshot.layout.tomorrowPath?addDay(day,1):snapshot.history.find(n=>n.path===c.path)!.day;
      const receipts=readTasks(c.after,snapshot.layout.heading,records.get(c.path)).map(receipt);
      const previous=queue.diaries?.find(n=>n.path===c.path);
      const wasChecklist=!!(receipts.length||previous?.wasChecklist||previous?.tasks.length||sourceTasks.some(t=>t.sourcePath===c.path));
      diaries.set(c.path,{day:d,path:c.path,tasks:receipts,...(wasChecklist?{wasChecklist:true}:{})});
    }
    queue.diaries=[...diaries.values()];
    const changes:Change[]=[...candidates,{path:QUEUE_PATH,before:snapshot.queueRaw,after:renderQueue(queue)}].filter(c=>c.before!==c.after);
    return {snapshot,review,changes,warnings,outline};
  }
  async apply(draft:DailyDraft,save:(j:BatchJournal)=>Promise<void>):Promise<void> {
    if(draft.review.questions.length)throw new Error('请先回答面板中的待确认问题，再更新草稿');
    if(draft.warnings.some(w=>w.startsWith('时间可能冲突')))throw new Error('请先解决时间冲突，再更新草稿');
    const layout=await this.layout(draft.snapshot.layout.day);
    if(!layout.enabled)throw new Error('集中配置 planner.enabled 为 false：请在 99 System/Automation/Research Workflow Config.md 中启用，再点击“重新读取并复盘”');
    if(JSON.stringify(layout)!==JSON.stringify(draft.snapshot.layout))throw new Error('日记设置已变化，请点击“重新读取并复盘”生成新草稿；“更新草稿”不会重新读取设置');
    if(draft.snapshot.template!==null&&await this.store.read(layout.templatePath)!==draft.snapshot.template)throw new Error('模板已变化，请重新读取');
    // Validate every snapshot, including unchanged target files, before the first mutation.
    for(const [path,expected] of [[layout.todayPath,draft.snapshot.today],[layout.tomorrowPath,draft.snapshot.tomorrow],[QUEUE_PATH,draft.snapshot.queueRaw]]) {
      if(await this.store.read(path!)!==expected)throw new Error('日记或跨日清单已变化，请重新读取后生成草稿');
    }
    for(const note of [...draft.snapshot.history,...(draft.snapshot.probes??[])]) {
      if(JSON.stringify(await this.layout(note.day))!==JSON.stringify(note.layout))throw new Error('历史日记设置已变化，请重新读取');
      if(await this.store.read(note.path)!==note.raw)throw new Error('补读日记已变化，请重新读取后生成草稿');
    }
    const journal:BatchJournal={version:2,day:layout.day,changes:draft.changes,state:'pending',sourceDays:draft.snapshot.history.map(n=>n.day)};
    await save(journal);
    try {
      for(const c of journal.changes) {
        if(c.before===null)await this.store.create(c.path,c.after);else await this.store.compareWrite(c.path,c.before,c.after);
      }
      await save({...journal,state:'applied'});
    }catch {
      try {await this.revert(journal);await save({...journal,state:'reverted'});}
      catch {throw new Error('写入中断且检测到后续修改，未覆盖修改。请用“恢复 / 撤销”检查本机写入记录，处理前不要再次确认。');}
      throw new Error('写入失败，已恢复原内容；新建笔记会保留为空文件。请重新读取后重试。');
    }
  }
  async revert(journal:BatchJournal):Promise<void> {
    if(journal.version!==2||journal.state==='reverted')throw new Error('没有待恢复的写入记录');
    const layout=await this.layout(journal.day),allowed=new Set([layout.todayPath,layout.tomorrowPath,QUEUE_PATH]);
    if((journal.sourceDays?.length??0)>30)throw new Error('恢复记录的日期范围无效');
    for(const d of journal.sourceDays??[]) {
      dateSchema.parse(d);
      if(d>=journal.day||d<addDay(journal.day,-30))throw new Error('恢复记录的日期范围无效');
      allowed.add((await this.layout(d)).todayPath);
    }
    if(journal.changes.length>33||new Set(journal.changes.map(c=>c.path)).size!==journal.changes.length||journal.changes.some(c=>!allowed.has(c.path)))throw new Error('恢复记录与当前日记路径不匹配');
    for(const c of journal.changes) {
      const current=await this.store.read(c.path);
      if(current!==c.after&&current!==c.before&&!(c.before===null&&current===''))throw new Error('写入后文件已有其他修改；拒绝覆盖，请先人工核对');
    }
    for(const c of [...journal.changes].reverse()) {
      if(await this.store.read(c.path)!==c.after)continue;
      if(c.before===null)await this.store.compareRemove(c.path,c.after);else await this.store.compareWrite(c.path,c.after,c.before);
    }
  }
}
