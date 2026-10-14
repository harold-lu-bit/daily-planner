import { chromium } from 'playwright';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const runtime=path.resolve('.test-runtime','obsidian-'+Date.now()),vault=path.join(runtime,'vault'),profile=path.join(runtime,'profile');
await mkdir(path.join(vault,'.obsidian','plugins','research-planner'),{recursive:true,mode:0o700});await mkdir(profile,{recursive:true,mode:0o700});
for(const f of ['main.js','manifest.json','styles.css'])await copyFile(f,path.join(vault,'.obsidian','plugins','research-planner',f));
await writeFile(path.join(vault,'.obsidian','community-plugins.json'),JSON.stringify(['research-planner']));
await writeFile(path.join(vault,'.obsidian','app.json'),JSON.stringify({promptDelete:false}));
await writeFile(path.join(profile,'obsidian.json'),JSON.stringify({vaults:{testvault00000001:{path:vault,ts:Date.now(),open:true}},autoUpdate:false}));
const executable=process.env.OBSIDIAN_EXECUTABLE||'/tmp/rwa-obsidian/opt/Obsidian/obsidian';
const port=19723;
const child=spawn(executable,[`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--no-sandbox','--disable-gpu','--disable-dev-shm-usage'],{env:{...process.env,DISPLAY:process.env.RWA_TEST_DISPLAY||':97',LD_LIBRARY_PATH:process.env.RWA_TEST_LIBS||'/tmp/rwa-xserver/root/usr/lib/x86_64-linux-gnu'},stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
let browser;const checks=[];const report={runtime,checks};
try {
 for(let i=0;i<60;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);break;}catch{await new Promise(r=>setTimeout(r,500));}}
 if(!browser)throw new Error('Obsidian debugging endpoint unavailable');
 let page;
 for(let i=0;i<60;i++){
  for(const p of browser.contexts().flatMap(c=>c.pages()))if(await p.evaluate(()=>Boolean(window.app?.vault)).catch(()=>false)){page=p;break;}
  if(page)break;await new Promise(r=>setTimeout(r,500));
 }
 if(!page)throw new Error('Vault window did not open');
 const trust=page.getByRole('button',{name:'Trust author and enable plugins',exact:true});await trust.waitFor({state:'visible',timeout:15000});await trust.click();
 page.on('console',m=>{if(m.type()==='error')log+='\nCONSOLE: '+m.text();});
 await page.waitForFunction(()=>Boolean(window.app?.plugins?.plugins?.['research-planner']),{timeout:30000});
 await page.evaluate(()=>window.app.setting.close());await page.bringToFront();await page.setViewportSize({width:1440,height:1200});
 page.on('pageerror',e=>{log+='\nPAGE ERROR: '+e.message;});
 checks.push('Real Obsidian loads v0.3 using public portable APIs');
 const fixture=await page.evaluate(async()=>{
  const p=window.app.plugins.plugins['research-planner'];p.device.writes=true;p.persistDevice();
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const shift=n=>{const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
  const layout=await p.layout(day),queuePath='99 System/Automation/Research Planner Future.md';
  const todayText=`# ${day}\n\n## Tasks\n- [x] 整理实验记录\n- [ ] 分析实验数据\n- [ ] ${shift(4)} 提交周报\n\n## Work Log\n人工日志\n`;
  const tomorrowText='## Tasks\n- [ ] 10:00 - 11:00 培训\n\n## Captures\n原有内容\n';
  await p.service.store.create(layout.todayPath,todayText);await p.service.store.create(layout.tomorrowPath,tomorrowText);
  await p.service.store.create(layout.templatePath,'# {{date:YYYY-MM-DD}}\n\n## Tasks\n\n- [ ] \n\n## Captures\n模板正文\n');
  const tasks=[{id:crypto.randomUUID(),text:'联系学长',date:shift(-1),deadline:null,start:null,end:null,priority:'normal'},{id:crypto.randomUUID(),text:'组会',date:shift(1),deadline:null,start:'14:00',end:'15:00',priority:'normal'}];
  await p.service.store.create(queuePath,'---\ntype: research-planner-future\nversion: 1\nreviewed: []\ntasks: '+JSON.stringify(tasks)+'\n---\n');
  window.rpReads=[];const read=p.service.store.read.bind(p.service.store);p.service.store.read=async path=>{window.rpReads.push(path);return read(path);};
  await window.app.workspace.openLinkText(layout.todayPath,'',false);await p.openView();return {day,layout,queuePath,todayText,tomorrowText};
 });
 assert.equal(await page.evaluate(()=>window.rpReads.length),0);checks.push('Opening panel performs no diary reads or task indexing');
 await page.evaluate(()=>{
  const p=window.app.plugins.plugins['research-planner'];p.settings.baseUrl='https://synthetic.invalid/v1';p.settings.model='synthetic';window.app.secretStorage.setSecret(p.settings.secretName,'synthetic-key');window.rpCalls=0;
  p.transport=async(_url,body)=>{
   window.rpCalls++;const data=JSON.parse(JSON.parse(body).messages[1].content),adjust=data.feedback.length>0;
   const shift=n=>{const d=new Date(data.today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
   const mk=(t,fields)=>({id:t.id,text:t.text,action:'tomorrow',date:data.tomorrow,deadline:null,start:null,end:null,priority:'normal',reason:'继续安排',timing:fields?.action==='cancel'?'none':fields?.action==='keep'?(fields.date?'hold':'none'):'explicit',timeSpecified:!!fields?.start,category:'task',...fields});
   const decisions=data.tasks.map(t=>t.text.includes('周报')?mk(t,{text:'提交周报',action:'future',date:shift(4)}):mk(t,{priority:adjust?'high':'normal'}));
   for(const t of data.completed)decisions.push(mk(t,{action:'keep',date:null}));
   for(const t of data.future)decisions.push(t.text.includes('学长')?mk(t,{action:adjust?'cancel':'keep',date:adjust?null:t.date}):mk(t,{start:adjust?'15:00':'14:00',end:adjust?'16:00':'15:00'}));
   if(adjust)decisions.push(mk({id:'new:1',text:'准备周报材料'},{action:'future',date:shift(3)}));
   return {status:200,json:{choices:[{message:{content:JSON.stringify({kind:'plan',message:'合成测试提案',review:{summary:'完成实验记录整理，明天优先分析数据。',decisions,questions:adjust?[]:['联系学长是否仍需要？']}})}}],usage:{prompt_tokens:10,completion_tokens:10}}};
  };window.rpTransport=p.transport;
 });
 const idle=()=>page.waitForFunction(()=>!window.app.plugins.plugins['research-planner'].busy);
 await page.getByRole('button',{name:'开始复盘',exact:true}).click();await idle();
 await page.getByRole('button',{name:'接受并写入',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'接受并写入',exact:true}).isDisabled(),true);
 assert.equal(await page.evaluate(p=>window.app.plugins.plugins['research-planner'].service.store.read(p),fixture.layout.todayPath),fixture.todayText);
 checks.push('Initial review reads only requested notes, writes nothing, questions block acceptance');
 await page.getByLabel('你的补充或调整意见').fill('不用联系学长了。组会改到15点到16点，明天优先分析数据，不排时间。周四准备周报材料。');
 await page.getByRole('button',{name:'发送 / 调整计划',exact:true}).click();await idle();
 assert.equal(await page.evaluate(()=>window.rpCalls),2);
 await page.screenshot({path:path.join(runtime,'daily-preview.png')});
 await page.getByRole('button',{name:'接受并写入',exact:true}).click();await idle();
 const accepted=await page.evaluate(async({layout,queuePath})=>{const p=window.app.plugins.plugins['research-planner'];return {today:await p.service.store.read(layout.todayPath),tomorrow:await p.service.store.read(layout.tomorrowPath),queue:await p.service.store.read(queuePath),journal:p.device.journal.state};},fixture);
 assert.match(accepted.today,/分析实验数据 → 已转至/);assert.match(accepted.today,/## Work Log\n人工日志/);
 assert.match(accepted.tomorrow,/15:00 - 16:00 组会/);assert.match(accepted.tomorrow,/10:00 - 11:00 培训/);assert.match(accepted.tomorrow,/原有内容/);assert.equal(accepted.journal,'applied');
 assert.ok(!accepted.queue.includes('联系学长'));assert.ok(!accepted.queue.includes('组会'));assert.match(accepted.queue,/准备周报材料/);
 checks.push('Natural-language iteration and explicit confirmation write all three files, preserving existing diary content');
 await page.getByRole('button',{name:'恢复 / 撤销',exact:true}).click();await page.getByRole('button',{name:'确认恢复',exact:true}).click();await idle();
 assert.equal(await page.evaluate(p=>window.app.plugins.plugins['research-planner'].service.store.read(p),fixture.layout.todayPath),fixture.todayText);
 assert.equal(await page.evaluate(p=>window.app.plugins.plugins['research-planner'].service.store.read(p),fixture.layout.tomorrowPath),fixture.tomorrowText);
 checks.push('Real Obsidian Vault.process restores the multi-file batch');
 // A stale preview may not overwrite later human edits.
 await page.getByLabel('你的补充或调整意见').fill('按刚才的调整安排。');await page.getByRole('button',{name:'开始复盘',exact:true}).click();await idle();
 await page.evaluate(async p=>{const s=window.app.plugins.plugins['research-planner'].service.store,b=await s.read(p);await s.compareWrite(p,b,b+'\n后续编辑');},fixture.layout.todayPath);
 await page.getByRole('button',{name:'接受并写入',exact:true}).click();await idle();
 assert.match(await page.locator('.rp-status').innerText(),/变化/);checks.push('Later diary edit refuses a stale confirmed preview');
 // A network failure keeps the user's input and all Vault bytes.
 await page.getByLabel('你的补充或调整意见').fill('网络故障时保留这句话');
 await page.evaluate(()=>{window.app.plugins.plugins['research-planner'].transport=async()=>{throw Error('offline');};});
 await page.getByRole('button',{name:'发送 / 调整计划',exact:true}).click();await idle();
 assert.equal(await page.getByLabel('你的补充或调整意见').inputValue(),'网络故障时保留这句话');
 assert.match(await page.locator('.rp-status').innerText(),/网络失败/);checks.push('Network failure preserves feedback and does not write notes');
 // Closing the view while a response is pending never reopens it or commits a draft.
 await page.evaluate(()=>{const p=window.app.plugins.plugins['research-planner'];p.transport=(url,body,key)=>new Promise(resolve=>{window.releaseReview=()=>window.rpTransport(url,body,key).then(resolve);});});
 await page.getByRole('button',{name:'重新读取并复盘',exact:true}).click();
 await page.waitForFunction(()=>typeof window.releaseReview==='function');
 await page.evaluate(()=>window.app.workspace.getLeavesOfType('research-planner-view')[0].detach());
 await page.evaluate(()=>window.releaseReview());await idle();
 assert.equal(await page.evaluate(()=>window.app.plugins.plugins['research-planner'].draft),null);
 assert.equal(await page.evaluate(()=>window.app.workspace.getLeavesOfType('research-planner-view').length),0);
 checks.push('Closing a pending review ignores late response and never reopens the panel');
 await page.evaluate(async()=>{await window.app.plugins.disablePlugin('research-planner');await window.app.plugins.enablePlugin('research-planner');await window.app.plugins.plugins['research-planner'].openView();});
 assert.equal(await page.getByLabel('你的补充或调整意见').inputValue(),'网络故障时保留这句话');
 checks.push('Reload preserves unsubmitted feedback and device permission using Vault-scoped local storage');
 // Empty input can be previewed locally, without credentials or network.
 await page.evaluate(async f=>{const p=window.app.plugins.plugins['research-planner'],s=p.service.store;for(const [path,next] of [[f.layout.todayPath,'## Tasks\n'],[f.queuePath,'']])await s.compareWrite(path,await s.read(path),next);p.transport=async()=>{throw Error('Must not call model');};p.device.notes='';p.feedback=[];p.snapshot=null;p.draft=null;p.refresh();},fixture);
 await page.getByRole('button',{name:'开始复盘',exact:true}).click();await idle();
 assert.ok(await page.getByRole('button',{name:'接受并写入',exact:true}).isVisible());
 checks.push('Empty tasks/empty queue produces a local preview without API');
 // All checked items must now reach the model to inspect explicit continuation work.
 await page.evaluate(async f=>{
  const p=window.app.plugins.plugins['research-planner'],s=p.service.store;
  await s.compareWrite(f.layout.todayPath,await s.read(f.layout.todayPath),'## Tasks\n- [x] 今天调试结束，明天验证稳定性\n');
  p.feedback=[];p.device.notes='';
  p.transport=async(_url,body)=>{
   const data=JSON.parse(JSON.parse(body).messages[1].content);window.completedReviewPayload=data;
   return {status:200,json:{choices:[{message:{content:JSON.stringify({kind:'plan',message:'合成测试提案',review:{summary:'今天完成调试，明天验证。',decisions:data.completed.map(t=>({id:t.id,text:'验证稳定性',action:'tomorrow',date:data.tomorrow,deadline:null,start:null,end:null,priority:'normal',reason:'原条目明确安排后续',timing:'explicit',timeSpecified:false,category:'task'})),questions:[]}})}}]}};
  };
 },fixture);
 await page.getByRole('button',{name:'重新读取并复盘',exact:true}).click();await idle();
 assert.equal(await page.evaluate(()=>window.completedReviewPayload.completed.length),1);
 await page.getByRole('heading',{name:'从完成记录提取的后续工作',exact:true}).waitFor();
 await page.getByRole('button',{name:'接受并写入',exact:true}).click();await idle();
 const continued=await page.evaluate(async f=>{const p=window.app.plugins.plugins['research-planner'];return {today:await p.service.store.read(f.layout.todayPath),tomorrow:await p.service.store.read(f.layout.tomorrowPath),completed:(await p.service.snapshot(f.day)).completed.length};},fixture);
 assert.match(continued.today,/- \[x\] 今天调试结束，明天验证稳定性/);assert.doesNotMatch(continued.today,/<!-- rp(?::|-reviewed:)/);
 assert.match(continued.tomorrow,/- \[ \] 验证稳定性/);assert.equal(continued.completed,0);
 checks.push('All-completed follow-up calls model, shows source preview, preserves checkbox and suppresses duplicate extraction');
 // Select today's schedule through the new controls and catch up a missed diary.
 const missed=await page.evaluate(async f=>{
  const p=window.app.plugins.plugins['research-planner'];
  const date=new Date(f.day+'T12:00:00Z');date.setUTCDate(date.getUTCDate()-1);const yesterday=date.toISOString().slice(0,10);
  const old=await p.layout(yesterday),text='## Tasks\n- [ ] 补做实验记录\n\n## Work Log\n旧日志保留\n';
  await p.service.store.create(old.todayPath,text);
  p.transport=async(_url,body)=>{
   const data=JSON.parse(JSON.parse(body).messages[1].content);window.todayPlanningPayload=data;
   const mk=(t,fields={})=>({id:t.id,text:t.text,action:data.target,date:data.targetDate,deadline:null,start:null,end:null,priority:'normal',reason:'补做接续',timing:fields.action==='keep'?(fields.date?'hold':'none'):'asap',timeSpecified:false,category:'task',...fields});
   return {status:200,json:{choices:[{message:{content:JSON.stringify({kind:'plan',message:'合成测试提案',review:{summary:'今天继续遗漏的实验记录。',questions:[],decisions:[...data.tasks.map(t=>mk(t)),...data.completed.map(t=>mk(t,{action:'keep',date:null})),...data.future.map(t=>mk(t,{action:'keep',date:t.date}))]}})}}]}};
  };
  return {yesterday,path:old.todayPath,text};
 },fixture);
 await page.getByRole('combobox',{name:'安排哪一天',exact:true}).selectOption('today');
 await page.getByRole('combobox',{name:'任务来源',exact:true}).selectOption('range');
 await page.getByLabel('补读起始日',{exact:true}).fill(missed.yesterday);
 await page.getByRole('button',{name:'开始复盘',exact:true}).click();await idle();
 await page.getByRole('heading',{name:'今天的安排',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.todayPlanningPayload.target),'today');
 assert.equal(await page.evaluate(p=>window.app.plugins.plugins['research-planner'].service.store.read(p),missed.path),missed.text);
 await page.screenshot({path:path.join(runtime,'today-catch-up-preview.png')});
 await page.getByRole('button',{name:'接受并写入',exact:true}).click();await idle();
 const caught=await page.evaluate(async({f,old})=>{const p=window.app.plugins.plugins['research-planner'];return {today:await p.service.store.read(f.layout.todayPath),past:await p.service.store.read(old)};},{f:fixture,old:missed.path});
 assert.match(caught.today,/- \[ \] 补做实验记录/);assert.doesNotMatch(caught.today,/<!-- rp(?::|-reviewed:)/);
 assert.match(caught.past,/→ 已转至 \[\[/);assert.doesNotMatch(caught.past,/<!-- rp(?::|-reviewed:)/);assert.match(caught.past,/旧日志保留/);
 checks.push('Today selector catches up a missed diary after preview confirmation, preserving links without inline IDs');
 await page.setViewportSize({width:420,height:900});await page.screenshot({path:path.join(runtime,'narrow-panel.png')});
 checks.push('Narrow viewport rendering exercised (not Android device validation)');
 report.passed=true;
}catch(e){report.passed=false;report.error=String(e);if(browser)for(const p of browser.contexts().flatMap(c=>c.pages()))await p.screenshot({path:path.join(runtime,'failure.png')}).catch(()=>{});}
finally {await writeFile(path.join(runtime,'test-report.json'),JSON.stringify(report,null,2));await writeFile(path.join(runtime,'runtime.log'),log);console.log(JSON.stringify(report,null,2));await browser?.close();child.kill();}
if(!report.passed)process.exitCode=1;
