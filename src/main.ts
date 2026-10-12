import { App, ItemView, Modal, Notice, Plugin, PluginSettingTab, SecretComponent, Setting, WorkspaceLeaf, moment, requestUrl } from 'obsidian';
import { addDay, CONFIG_PATH, frontmatter, minute, safePath, today } from './core';
import { DailyService, QUEUE_PATH, ReviewSchema, reviewInstruction, reviewPayload, outlinePreview, type BatchJournal, type DailyDraft, type Layout, type Review, type Snapshot } from './daily';
import { callModel, TruncatedOutputError, type ProviderConfig, type Usage } from './provider';
import { ObsidianStore } from './store';
import { z } from 'zod';
import type Moment from 'moment';
const dateMoment=moment as unknown as typeof Moment;
const VIEW='research-planner-view';
interface Settings extends ProviderConfig {secretName:string; reminder:string; dailyCallLimit:number; timezone:string; heading:string;}
const DEFAULTS:Settings={baseUrl:'',model:'',format:'json_object',timeout:120,maxTokens:16384,secretName:'research-planner-api',reminder:'22:30',dailyCallLimit:30,timezone:'Asia/Shanghai',heading:'Tasks'};
interface Device {writes:boolean; reminders:boolean; reminded:string; quotaDay:string; calls:number; input:number; output:number; journal:BatchJournal|null; notes:string;}
const fresh=():Device=>({writes:false,reminders:false,reminded:'',quotaDay:'',calls:0,input:0,output:0,journal:null,notes:''});
const errorText=(e:unknown)=>e instanceof Error?e.message:'操作失败，请检查设置';
function button(el:HTMLElement,text:string,action:()=>void,primary=false):HTMLButtonElement {
 const b=el.createEl('button',{text,cls:primary?'mod-cta':''});b.addEventListener('click',action);return b;
}
export default class ResearchPlanner extends Plugin {
 settings:Settings={...DEFAULTS};device:Device=fresh();service!:DailyService;busy=false;
 snapshot:Snapshot|null=null;draft:DailyDraft|null=null;feedback:string[]=[];status='';
 draftStale=false;lastTruncation:TruncatedOutputError|null=null;
 planTarget:'today'|'tomorrow'='tomorrow';catchUp=true;catchUpFrom='';sourceMode:'latest'|'range'='latest';
 private deviceKey='';private generation=0;private checkingReminder=false;
 async onload():Promise<void> {
  this.settings={...DEFAULTS,...await this.loadData()};
  this.deviceKey='research-planner-daily-device-v2';
  try{this.device={...fresh(),...this.app.loadLocalStorage(this.deviceKey)};}catch{this.device=fresh();}
  this.service=new DailyService(new ObsidianStore(this.app),day=>this.layout(day),(day,pattern)=>dateMoment(day,'YYYY-MM-DD',true).format(pattern));
  this.registerView(VIEW,leaf=>new ReviewView(leaf,this));
  this.addRibbonIcon('calendar-check','日记复盘',()=>void this.openView());
  this.addCommand({id:'open',name:'打开日记复盘',callback:()=>void this.openView()});
  this.addCommand({id:'plan',name:'打开日记复盘',callback:()=>void this.openView()});
  this.addCommand({id:'undo',name:'恢复 / 撤销最近一次写入',callback:()=>this.confirmUndo()});
  this.addSettingTab(new PlannerSettings(this.app,this));
  // Reminder never reads tasks or calls a model. Review starts only from the button.
  this.registerInterval(window.setInterval(()=>void this.checkReminder(),60_000));
 }
 onunload():void {this.generation++;}
 persistDevice():void {this.app.saveLocalStorage(this.deviceKey,this.device);}
 async saveSettings():Promise<void>{await this.saveData(this.settings);}
 async layout(day:string):Promise<Layout> {
  const configPath=`${this.app.vault.configDir}/daily-notes.json`;
  let options:{folder?:string;format?:string;template?:string}={};
  if(await this.app.vault.adapter.exists(configPath))options=JSON.parse(await this.app.vault.adapter.read(configPath));
  const folder=options.folder===undefined?'10 Daily':options.folder,format=options.format||'YYYY/MM/YYYY-MM-DD';
  const path=(date:string)=>safePath((folder?`${folder}/`:'')+dateMoment(date,'YYYY-MM-DD',true).format(format)+'.md');
  let template=options.template||'99 System/Templates/Daily';if(!template.endsWith('.md'))template+='.md';
  const raw=await this.service.store.read(CONFIG_PATH);
  const enabled=raw?((frontmatter(raw).planner as {enabled?:boolean}|undefined)?.enabled!==false):true;
  if(!this.settings.heading.trim()||/[\r\n#]/.test(this.settings.heading))throw new Error('任务章节名称无效');
  return {day,todayPath:path(day),tomorrowPath:path(addDay(day,1)),templatePath:safePath(template),heading:this.settings.heading,enabled};
 }
 async openView():Promise<void>{
  let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];
  if(!leaf){leaf=this.app.workspace.getRightLeaf(false)??this.app.workspace.getLeaf(true);await leaf.setViewState({type:VIEW,active:true});}
  await this.app.workspace.revealLeaf(leaf);
 }
 refresh():void {for(const leaf of this.app.workspace.getLeavesOfType(VIEW))if(leaf.view instanceof ReviewView)leaf.view.render();}
 abandonResponse():void {this.generation++;}
 async action(run:()=>Promise<void>):Promise<void>{
  if(this.busy){new Notice('上一项操作尚未结束');return;}
  this.busy=true;this.status='处理中…';this.refresh();
  try{await run();}catch(e){this.status=errorText(e);new Notice(this.status,9000);}
  finally{this.busy=false;this.refresh();}
 }
 private reserve():string {
  const key=this.app.secretStorage?.getSecret(this.settings.secretName);
  if(!key)throw new Error('请在设置中配置本机 API 密钥');
  if(!this.settings.baseUrl||!this.settings.model)throw new Error('请配置 API 基础地址和模型');
  const day=today(this.settings.timezone);
  if(day!==this.device.quotaDay){this.device.quotaDay=day;this.device.calls=0;this.device.input=0;this.device.output=0;}
  if(!Number.isInteger(this.settings.dailyCallLimit)||this.settings.dailyCallLimit<1||this.settings.dailyCallLimit>1000)throw new Error('每日调用上限应为 1–1000');
  if(this.device.calls>=this.settings.dailyCallLimit)throw new Error('已达到本设备每日调用上限');
  this.device.calls++;this.persistDevice();return key;
 }
 private transport=async(url:string,body:string,key:string)=>{
  const response=await requestUrl({url,method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body,throw:false});
  let json:unknown=null;try{json=response.json;}catch{/* Keep server error bodies out of the UI. */}
  return {status:response.status,json};
 };
 private usage(u:Usage):void {this.device.input+=u.input;this.device.output+=u.output;this.persistDevice();}
 async connectionTest():Promise<void>{
  const r=await callModel(this.settings,this.reserve(),this.transport,z.object({ok:z.literal(true)}).strict(),'返回 {"ok":true}。',{message:'synthetic connection test'});
  this.usage(r.usage);this.status='连接成功，仅发送了合成内容。';
 }
 async begin():Promise<void>{
  if(this.device.journal?.state==='pending')throw new Error('存在未完成写入，请先使用“恢复 / 撤销”处理');
  this.draftStale=true;this.lastTruncation=null;
  const next=await this.service.snapshot(today(this.settings.timezone),{target:this.planTarget,catchUp:this.catchUp,sourceMode:this.sourceMode,from:this.catchUp&&this.sourceMode==='range'?this.catchUpFrom||undefined:undefined});
  if(this.snapshot?.layout.day!==next.layout.day)this.feedback=[];
  this.snapshot=next;
  await this.generate();
 }
 async iterate():Promise<void>{
  if(!this.snapshot)throw new Error('请先开始复盘');
  if(!this.device.notes.trim())throw new Error('请先填写你的调整意见');
  await this.generate();
 }
 async retry():Promise<void>{await this.generate();}
 async retryWithMoreTokens():Promise<void>{
  if(!this.lastTruncation||this.lastTruncation.limit!==this.settings.maxTokens||this.settings.maxTokens>=32768)throw new Error('请检查当前输出上限，再重试生成');
  this.settings.maxTokens=Math.min(32768,this.settings.maxTokens*2);await this.saveSettings();
  await this.generate();
 }
 private async generate():Promise<void>{
  this.draftStale=true;this.lastTruncation=null;
  const snapshot=this.snapshot;if(!snapshot)throw new Error('请重新开始复盘');
  if(snapshot.layout.day!==today(this.settings.timezone))throw new Error('日期已经变化，请重新读取今天的日记');
  const token=++this.generation,notes=this.device.notes.trim();
  if(notes.length>10000)throw new Error('调整意见请控制在 10000 字符内');
  const feedback=notes?[...this.feedback,notes]:this.feedback,previous=this.draft?.snapshot===snapshot?this.draft.review:null;
  const payload={...reviewPayload(snapshot,feedback,previous),currentTime:new Intl.DateTimeFormat('en-GB',{timeZone:this.settings.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date())};
  if(JSON.stringify(payload).length>100000)throw new Error('讨论上下文过长，请重新读取后简要说明');
  let review:Review;
  if(!payload.tasks.length&&!payload.completed.length&&!payload.future.length&&!feedback.length)review={summary:'本次没有需要接续的未完成任务；已有安排保持原样。',decisions:[],questions:[]};
  else {
   try {
    const r=await callModel(this.settings,this.reserve(),this.transport,ReviewSchema,reviewInstruction,payload);this.usage(r.usage);review=r.value;
   }catch(e){
    if(e instanceof TruncatedOutputError){if(e.usage)this.usage({input:e.usage.input??0,output:e.usage.output??0});if(token===this.generation)this.lastTruncation=e;}
    throw e;
   }
  }
  if(token!==this.generation){this.status='面板已关闭，本次响应未应用；笔记没有变化。';return;}
  this.draft=this.service.draft(snapshot,review,feedback.length>0,feedback);this.feedback=feedback;this.draftStale=false;
  if(this.device.notes.trim()===notes)this.device.notes='';this.persistDevice();
  this.status=`草稿已更新，尚未写入。请检查 ${snapshot.targetDay} 的安排、遗漏任务的去向和跨日清单。`;
 }
 async accept():Promise<void>{
  if(this.draftStale)throw new Error('当前预览是旧稿；请成功重新生成后再接受');
  if(!this.device.writes)throw new Error('请先在设置中开启“允许本设备写入”');
  if(this.device.journal?.state==='pending')throw new Error('存在未完成写入，请先恢复');
  if(!this.draft)throw new Error('请先生成草稿');
  if(this.device.notes.trim())throw new Error('还有未提交的调整意见，请先更新草稿或清空输入');
  if(this.draft.snapshot.layout.day!==today(this.settings.timezone))throw new Error('日期已经变化，请重新读取');
  await this.service.apply(this.draft,async j=>{this.device.journal=j;this.persistDevice();});
  this.device.reminded=this.draft.snapshot.layout.day;this.persistDevice();
  this.draft=null;this.snapshot=null;this.feedback=[];
  this.status='已保存日程与任务去向。可继续直接在日记中勾选、修改或删除任务。';
 }
 confirmUndo():void {
  const j=this.device.journal;if(!j||j.state==='reverted'){new Notice('本设备没有可恢复的写入记录');return;}
  const m=new Modal(this.app);m.titleEl.setText('恢复 / 撤销最近一次写入');
  m.contentEl.createEl('p',{text:'同时恢复本次涉及的日记（包括补读后交接的旧日记）和跨日清单。有后续编辑时拒绝覆盖；新建文件保留为空文件。'});
  for(const c of j.changes)m.contentEl.createEl('p',{text:c.path});
  button(m.contentEl,'确认恢复',()=>{m.close();void this.action(async()=>{
   if(!this.device.writes)throw new Error('请先允许本设备写入');
   await this.service.revert(j);this.device.journal={...j,state:'reverted'};this.persistDevice();
   this.draft=null;this.snapshot=null;this.status='已恢复写入前内容，请重新读取。';
  });});m.open();
 }
 async checkReminder(now=new Date()):Promise<void>{
  if(!this.device.reminders||this.busy||this.checkingReminder)return;this.checkingReminder=true;
  try {
   const day=today(this.settings.timezone,now),clock=new Intl.DateTimeFormat('en-GB',{timeZone:this.settings.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
   if(this.device.reminded===day||minute(clock)<minute(this.settings.reminder))return;
   this.device.reminded=day;this.persistDevice();new Notice('可以整理今天的任务，然后在“日记复盘”面板点击开始。',12000);
  }catch{/* Do not interrupt writing when reminder configuration is invalid. */}
  finally{this.checkingReminder=false;}
 }
}
class ReviewView extends ItemView {
 constructor(leaf:WorkspaceLeaf,private plugin:ResearchPlanner){super(leaf);}
 getViewType(){return VIEW;}getDisplayText(){return '日记复盘';}getIcon(){return 'calendar-check';}
 async onOpen(){this.render();}async onClose(){this.plugin.abandonResponse();}
 render():void {
  const p=this.plugin,el=this.contentEl;el.empty();el.addClass('rp-panel');
  el.createEl('div',{text:'RESEARCH PLANNER · DAILY',cls:'rp-eyebrow'});el.createEl('h2',{text:'接续任务，安排日程'});
  el.createEl('p',{text:'先在最近那篇 TODO 中勾选完成项、删改旧任务并追加新任务，再选择安排今天或明天。中断几天也会按这份清单继续。',cls:'rp-muted'});
  const reset=()=>{p.snapshot=null;p.draft=null;p.feedback=[];p.status='安排日期或补读范围已改变，请重新生成草稿。';p.refresh();};
  new Setting(el).setName('安排哪一天').addDropdown(c=>{c.selectEl.setAttribute('aria-label','安排哪一天');c.addOption('today','今天').addOption('tomorrow','明天').setValue(p.planTarget).setDisabled(p.busy).onChange(v=>{p.planTarget=v as 'today'|'tomorrow';reset();});});
  new Setting(el).setName('接续旧日记 TODO').setDesc('先整理最近那篇 TODO：勾选完成、删除不需要的任务并追加新任务。中断几天不表示任务已完成。').addToggle(c=>c.setValue(p.catchUp).setDisabled(p.busy).onChange(v=>{p.catchUp=v;reset();}));
  if(p.catchUp)new Setting(el).setName('任务来源').addDropdown(c=>{c.selectEl.setAttribute('aria-label','任务来源');c.addOption('latest','最近一份 TODO（默认）').addOption('range','按日期范围合并（高级）').setValue(p.sourceMode).setDisabled(p.busy).onChange(v=>{p.sourceMode=v as 'latest'|'range';reset();});});
  if(p.catchUp&&p.sourceMode==='latest')el.createEl('p',{text:'优先使用今天的 TODO；今天没有清单时向前查找最近 30 天，只接续最近一份，不混入更早的清单。已勾选项保持完成，无日期的未完成项安排到所选今天／明天。',cls:'rp-muted'});
  if(p.catchUp&&p.sourceMode==='range'){
   const range=el.createEl('label',{cls:'rp-field'});range.createEl('span',{text:'补读起始日（留空自动判断）'});
   const date=range.createEl('input',{attr:{type:'date','aria-label':'补读起始日',max:today(p.settings.timezone),min:addDay(today(p.settings.timezone),-30)}});
   date.value=p.catchUpFrom;date.disabled=p.busy;date.addEventListener('change',()=>{p.catchUpFrom=date.value;reset();});
  }
  if(p.device.journal?.state==='pending')el.createEl('p',{text:'上次写入中断，请先恢复，避免重复任务。',cls:'rp-hint'});
  const actions=el.createDiv({cls:'rp-actions'});
  button(actions,p.snapshot?'重新读取并复盘':'开始复盘',()=>void p.action(()=>p.begin()),true).disabled=p.busy;
  button(actions,'恢复 / 撤销',()=>p.confirmUndo()).disabled=p.busy;
  if(!p.device.writes)el.createEl('p',{text:'当前只预览。确认写入前，请在设置中开启本设备写入。',cls:'rp-hint'});
  el.createEl('p',{text:'0.1 版独立任务不会自动导入；需要继续的任务请手动放入今天的 Tasks。',cls:'rp-muted'});
  if(p.snapshot) {
   const history=p.snapshot.history;
   const pending=[...p.snapshot.tasks,...history.flatMap(n=>n.tasks)].filter(t=>!t.done).length;
   el.createEl('p',{text:`本次需处理 ${pending+p.snapshot.completed.length+p.snapshot.queue.tasks.length} 项：未完成 ${pending}、完成记录待检查 ${p.snapshot.completed.length}、跨日任务 ${p.snapshot.queue.tasks.length}。输出上限 ${p.settings.maxTokens} token。`,cls:'rp-muted'});
   el.createEl('p',{text:p.snapshot.sourceMode==='latest'?`目标：${p.snapshot.targetDay}。TODO 来源：${history[0]?.day??p.snapshot.layout.day}；以这份清单的当前内容为准，并核对跨日待办与明日已有安排。`:`目标：${p.snapshot.targetDay}。读取今天、明日已有安排和跨日清单${history.length?`，补读 ${history[0].day} 至 ${history.at(-1)!.day}`:'；未补读旧日记'}。`,cls:'rp-muted'});
   for(const warning of p.snapshot.warnings)el.createEl('p',{text:warning,cls:'rp-hint'});
   if(history.length){
    const missed=el.createEl('details');missed.open=true;missed.createEl('summary',{text:`${p.snapshot.sourceMode==='latest'?'来源 TODO':'补读日记'}共有 ${history.flatMap(n=>n.tasks.filter(t=>!t.done)).length} 项未完成任务`});
    for(const note of history)for(const t of note.tasks.filter(t=>!t.done))missed.createEl('p',{text:`${note.day} · ${t.text}`});
    if(history.every(n=>!n.tasks.some(t=>!t.done)))missed.createEl('p',{text:'所选日期内没有未完成任务。'});
   }
   const e=el.createEl('details');e.open=true;e.createEl('summary',{text:`明日日记已有 ${p.snapshot.existing.length} 项（保持原样）`});
   for(const t of p.snapshot.existing)e.createEl('p',{text:`${t.done?'☑':'☐'} ${t.text}`});
  }
  if(p.draft) {
   if(p.draftStale)el.createEl('p',{text:`以下是上一次成功生成的 ${p.draft.snapshot.targetDay} 预览，尚未包含本次重新读取或调整；当前不可写入，请重试生成。`,cls:'rp-hint'});
   const d=p.draft;el.createEl('h3',{text:d.snapshot.target==='today'?'安排说明':'今日总结'});el.createEl('p',{text:d.review.summary,cls:'rp-summary'});
   el.createEl('h3',{text:d.snapshot.target==='today'?'今天的安排':'明日新增任务'});
   const next=d.review.decisions.filter(t=>t.action===d.snapshot.target);
   if(!next.length)el.createEl('p',{text:'没有新增任务，已有安排保持原样。',cls:'rp-muted'});
   for(const row of outlinePreview(d.outline)){const line=el.createEl('p',{text:`${row.task?'☐ ':'· '}${row.text}`,cls:'rp-outline-item'});line.style.marginInlineStart=`${row.depth*18}px`;}
   el.createEl('h3',{text:'明确另定日期的任务与其他处理'});
   for(const t of d.review.decisions.filter(t=>t.action!==d.snapshot.target)) {
    const label=t.action==='cancel'?'取消':t.action==='future'?'安排到 '+t.date:d.snapshot.completed.some(q=>q.id===t.id)?'原条目保持完成，无新增后续':d.snapshot.queue.tasks.some(q=>q.id===t.id)?'继续保留到 '+t.date:'留在来源日记，本次不安排';
    const task=[...d.snapshot.tasks,...d.snapshot.history.flatMap(n=>n.tasks),...d.snapshot.completed].find(q=>q.id===t.id);
    const parents=task?.parents.map(q=>q.text)??d.snapshot.queue.tasks.find(q=>q.id===t.id)?.ancestry??[];
    el.createEl('p',{text:`${parents.length?parents.join(' › ')+' › ':''}${t.text} — ${label}。${t.reason}`});
   }
   const followups=d.review.decisions.filter(t=>['today','tomorrow','future'].includes(t.action)&&d.snapshot.completed.some(q=>q.id===t.id));
   if(followups.length){el.createEl('h3',{text:'从完成记录提取的后续工作'});for(const t of followups){const source=d.snapshot.completed.find(q=>q.id===t.id)!;el.createEl('p',{text:`${source.text} → ${t.date}：${t.text}（原条目保持已完成）`});}}
   for(const q of d.review.questions)el.createEl('p',{text:'待确认：'+q,cls:'rp-hint'});
   for(const w of d.warnings)el.createEl('p',{text:w,cls:'rp-hint'});
   const changes=el.createEl('details');changes.createEl('summary',{text:'查看即将写入的完整内容'});
   for(const c of d.changes){changes.createEl('h4',{text:c.path});changes.createEl('pre',{text:c.after});}
  }
  if(p.snapshot&&!p.draft)el.createEl('p',{text:p.busy?'正在生成日程预览…':'尚未生成有效预览。来源任务已读取；请查看下方错误说明并重试。',cls:'rp-hint'});
  const label=el.createEl('label',{cls:'rp-field'});label.createEl('span',{text:'你的补充或调整意见'});
  const input=label.createEl('textarea',{attr:{'aria-label':'你的补充或调整意见',rows:'4',placeholder:'例如：实验顺延到周五，明天优先分析数据，不安排具体时间。'}});
  input.value=p.device.notes;input.disabled=p.busy;
  input.addEventListener('input',()=>{p.device.notes=input.value;try{p.persistDevice();}catch{new Notice('本机输入保存失败，请先复制文字。');}});
  const footer=el.createDiv({cls:'rp-actions'});
  if(p.snapshot)button(footer,!p.draft||p.draftStale?'重试生成':'更新草稿',()=>void p.action(()=>!p.draft||p.draftStale?p.retry():p.iterate())).disabled=p.busy;
  if(p.snapshot&&p.lastTruncation&&p.lastTruncation.limit===p.settings.maxTokens&&p.settings.maxTokens<32768){
   button(footer,`提高上限至 ${Math.min(32768,p.settings.maxTokens*2)} 并重试`,()=>void p.action(()=>p.retryWithMoreTokens())).disabled=p.busy;
   el.createEl('p',{text:'提高上限会保存到插件设置，并发起一次新请求，可能增加用量；不会自动重试或写入笔记。',cls:'rp-muted'});
  }
  if(p.draft)button(footer,'接受并写入',()=>void p.action(()=>p.accept()),true).disabled=p.busy||p.draftStale||p.draft.review.questions.length>0||p.draft.warnings.some(w=>w.startsWith('时间可能冲突'));
  if(p.draft)el.createEl('p',{text:'尚未接受的未来任务也未登记。关闭面板不会写入；重载插件后需重新复盘。',cls:'rp-muted'});
  el.createEl('p',{text:p.status,cls:'rp-status',attr:{role:'status'}});
 }
}
class PlannerSettings extends PluginSettingTab {
 constructor(app:App,private plugin:ResearchPlanner){super(app,plugin);}
 display():void {
  const el=this.containerEl,p=this.plugin;el.empty();el.createEl('h2',{text:'日记复盘'});
  el.createEl('p',{text:'日记路径、命名格式和模板读取内置 Daily Notes 设置。任务入口是日记，不再创建独立任务文件。'});
  const text=(name:string,desc:string,key:keyof Settings)=>new Setting(el).setName(name).setDesc(desc).addText(c=>c.setValue(String(p.settings[key])).onChange(async v=>{(p.settings as unknown as Record<string,unknown>)[key]=v;await p.saveSettings();}));
  text('API 基础地址','例如 https://服务商/plan/v1，不包含 /chat/completions','baseUrl');text('模型 ID','填写服务商提供的准确名称','model');
  new Setting(el).setName('API 密钥').setDesc('使用 Obsidian SecretStorage。每台设备单独配置；密钥不保存在插件 data.json。').addComponent(c=>new SecretComponent(this.app,c).setValue(p.settings.secretName).onChange(async v=>{p.settings.secretName=v;await p.saveSettings();}));
  new Setting(el).setName('JSON 响应模式').addDropdown(c=>c.addOption('json_object','json_object').addOption('none','仅提示词约束').setValue(p.settings.format).onChange(async v=>{p.settings.format=v as Settings['format'];await p.saveSettings();}));
  for(const [key,name] of [['timeout','超时秒数（5–300）'],['maxTokens','输出 token 上限（256–32768）'],['dailyCallLimit','本设备每日调用上限（1–1000）']] as const)new Setting(el).setName(name).addText(c=>c.setValue(String(p.settings[key])).onChange(async v=>{p.settings[key]=Number(v);await p.saveSettings();}));
  text('任务章节名称','二级标题，不含 ##；默认 Tasks','heading');text('时区','默认 Asia/Shanghai；两台设备建议保持一致','timezone');
  new Setting(el).setName('允许本设备写入').setDesc('仅点击“接受并写入”时修改日记与跨日清单。已有集中配置的 planner.enabled 也必须为 true。').addToggle(c=>c.setValue(p.device.writes).onChange(v=>{p.device.writes=v;p.persistDevice();p.refresh();}));
  new Setting(el).setName('集中配置').setDesc(`${CONFIG_PATH}；修改 planner.enabled 后，请重新读取并复盘。`).addButton(c=>c.setButtonText('打开配置').onClick(()=>void this.app.workspace.openLinkText(CONFIG_PATH,'',false)));
  text('复盘提醒时间','HH:mm，仅提醒，不读取笔记或调用模型','reminder');
  new Setting(el).setName('本设备晚间提醒').setDesc('应用运行时，每天到点后最多提醒一次。双设备可只开启一台；关闭应用时不运行。').addToggle(c=>c.setValue(p.device.reminders).onChange(v=>{p.device.reminders=v;p.persistDevice();}));
  new Setting(el).setName('测试连接').setDesc('只发送合成内容，不读取 Vault 正文。').addButton(c=>c.setButtonText('测试连接').onClick(()=>void p.action(()=>p.connectionTest())));
  el.createEl('p',{text:`跨日任务文件：${QUEUE_PATH}。内容由复盘面板维护，可由 LiveSync 同步。`,cls:'rp-muted'});
 }
}
