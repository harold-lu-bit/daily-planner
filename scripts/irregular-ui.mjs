import assert from 'node:assert/strict';
import path from 'node:path';

const idle=page=>page.waitForFunction(()=>!window.app.plugins.plugins['research-planner'].busy);
const close=page=>page.keyboard.press('Escape');
const openPlan=page=>page.getByRole('button',{name:'复盘 / 安排计划',exact:true}).click();
const generate=page=>page.getByRole('button',{name:'生成计划草稿',exact:true}).click();
const preview=page=>page.getByRole('button',{name:'确认写入 Daily',exact:true}).waitFor();
const reload=async page=>{
 await page.evaluate(async()=>{await window.app.plugins.disablePlugin('research-planner');await window.app.plugins.enablePlugin('research-planner');await window.app.plugins.plugins['research-planner'].openView();});
};

export async function emptyVaultUI(page,checks) {
 await openPlan(page);
 await page.getByLabel('计划日期',{exact:true}).fill('2026-10-12');
 await generate(page);await preview(page);
 assert.equal(await page.evaluate(()=>window.app.plugins.plugins['research-planner'].device.calls),0);
 assert.equal(await page.evaluate(()=>window.app.vault.getMarkdownFiles().length),0);
 await close(page);await close(page);
 await openPlan(page);assert.equal(await page.getByLabel('计划日期',{exact:true}).inputValue(),'2026-10-12');
 await page.getByRole('button',{name:'清空表单',exact:true}).click();await close(page);
 checks.push('Empty Vault: local preview with no API configuration or calls; closing writes no Daily');
 await page.getByRole('button',{name:'＋ 记录任务',exact:true}).click();
 await page.getByLabel('任务原话',{exact:true}).fill('未提交的临时想法');await close(page);
 assert.equal(await page.evaluate(async()=>(await window.app.plugins.plugins['research-planner'].service.tasks()).length),0);
 await reload(page);
 await page.getByRole('button',{name:'＋ 记录任务',exact:true}).click();
 assert.equal(await page.getByLabel('任务原话',{exact:true}).inputValue(),'未提交的临时想法');
 await page.getByRole('button',{name:'清空输入',exact:true}).click();await close(page);
 checks.push('Unsubmitted capture survives close and plugin reload without creating a task');
}

async function fakeNetwork(page) {
 await page.evaluate(()=>{
  const p=window.app.plugins.plugins['research-planner'];p.settings.baseUrl='https://synthetic.invalid/v1';p.settings.model='synthetic-test';
  window.app.secretStorage.setSecret('research-planner-api','synthetic-key');
  window.__rpCalls=window.__rpCalls??0;window.__rpFail=false;window.__rpDelay=false;
  p.transport=async(_url,body)=>{
   window.__rpCalls++;
   if(window.__rpFail)throw new Error('Synthetic offline');
   if(window.__rpDelay)await new Promise(resolve=>{window.__rpRelease=resolve;});
   const d=JSON.parse(JSON.parse(body).messages[1].content);
   return {status:200,json:{choices:[{message:{content:JSON.stringify({date:d.date,outcomes:['继续已有研究任务'],items:d.tasks.map(t=>({id:t.id,action:'schedule',minutes:60,start:d.slots?'09:00':null,reason:'延续未完成任务'})),uncertainties:[]})}}],usage:{prompt_tokens:10,completion_tokens:10}}};
  };
 });
}

export async function irregularUI(page,checks,runtime) {
 await fakeNetwork(page);
 const initial=await page.evaluate(async()=>(await window.app.plugins.plugins['research-planner'].service.tasks()).map(r=>r.raw));
 await openPlan(page);await page.getByLabel('计划日期',{exact:true}).fill('2026-10-07');
 await page.getByLabel('复盘 / 调整说明',{exact:true}).fill('');
 await generate(page);await preview(page);await close(page);await close(page);
 assert.equal(await page.evaluate(()=>window.app.plugins.plugins['research-planner'].service.store.read('10 Daily/2026/10/2026-10-07.md')),null);
 assert.deepEqual(await page.evaluate(async()=>(await window.app.plugins.plugins['research-planner'].service.tasks()).map(r=>r.raw)),initial);
 checks.push('No new tasks and no review: old tasks can be planned; abandoning preview preserves all files');

 await openPlan(page);assert.equal(await page.getByLabel('计划日期',{exact:true}).inputValue(),'2026-10-07');
 await page.getByLabel('计划日期',{exact:true}).fill('2026-10-09');await page.getByLabel('可用工作量（分钟）',{exact:true}).fill('0');
 await page.getByLabel('工作开始',{exact:true}).fill('');await page.getByLabel('工作结束',{exact:true}).fill('');
 await page.getByLabel('固定安排（每行如 14:00-15:00 组会）',{exact:true}).fill('休息日无需填写');
 const beforeCalls=await page.evaluate(()=>window.__rpCalls);
 await page.evaluate(()=>{window.app.plugins.plugins['research-planner'].settings.model='';});
 await generate(page);await preview(page);
 await page.screenshot({path:path.join(runtime,'rest-day.png')});
 await page.getByRole('button',{name:'确认写入 Daily',exact:true}).click();await idle(page);await close(page);
 assert.equal(await page.evaluate(()=>window.__rpCalls),beforeCalls);
 assert.deepEqual(await page.evaluate(async()=>(await window.app.plugins.plugins['research-planner'].service.tasks()).map(r=>r.raw)),initial);
 checks.push('Zero-capacity rest day: local plan works without API/model or valid time fields; task state unchanged');

 await openPlan(page);await page.getByLabel('计划日期',{exact:true}).fill('');await page.getByLabel('复盘日期',{exact:true}).fill('2026-10-09');
 await page.getByLabel('可用工作量（分钟）',{exact:true}).fill('');
 await page.getByLabel('复盘 / 调整说明',{exact:true}).fill('今天休息；下次继续实验。');
 await page.getByRole('button',{name:'仅保存复盘',exact:true}).click();await idle(page);
 assert.equal(await page.evaluate(()=>window.app.plugins.plugins['research-planner'].service.hasReview('2026-10-09')),true);
 assert.equal(await page.evaluate(()=>window.__rpCalls),beforeCalls);
 checks.push('Review-only save is independent of plan date, working hours and API configuration');

 await fakeNetwork(page);
 await page.getByLabel('计划日期',{exact:true}).fill('2026-10-10');await page.getByLabel('可用工作量（分钟）',{exact:true}).fill('120');
 await page.getByLabel('工作开始',{exact:true}).fill('09:00');await page.getByLabel('工作结束',{exact:true}).fill('18:00');
 const reviewCount=await page.evaluate(async()=>(await window.app.plugins.plugins['research-planner'].service.store.list('50 Planning/Research Planner Reviews')).length);
 await page.evaluate(()=>{window.__rpFail=true;});await generate(page);await idle(page);
 assert.match(await page.locator('.modal .rp-status').innerText(),/网络失败或超时/);
 await close(page);await reload(page);await fakeNetwork(page);
 await openPlan(page);assert.equal(await page.getByLabel('复盘 / 调整说明',{exact:true}).inputValue(),'今天休息；下次继续实验。');
 assert.equal(await page.getByLabel('复盘日期',{exact:true}).inputValue(),'2026-10-09');
 await generate(page);await preview(page);await close(page);
 assert.equal(await page.evaluate(async()=>(await window.app.plugins.plugins['research-planner'].service.store.list('50 Planning/Research Planner Reviews')).length),reviewCount);
 assert.equal(await page.evaluate(()=>window.app.plugins.plugins['research-planner'].service.store.read('10 Daily/2026/10/2026-10-10.md')),null);
 checks.push('Injected offline failure, close/reload and successful retry retain inputs with one review note and no unconfirmed Daily');

 await page.evaluate(()=>{window.__rpDelay=true;});await generate(page);
 await page.waitForFunction(()=>typeof window.__rpRelease==='function');await close(page);
 await page.evaluate(()=>{window.__rpRelease();window.__rpRelease=null;});await idle(page);
 assert.equal(await page.locator('.rp-draft').count(),0);
 assert.equal(await page.evaluate(()=>window.app.plugins.plugins['research-planner'].service.store.read('10 Daily/2026/10/2026-10-10.md')),null);
 checks.push('Closing a form while the request is in flight suppresses late preview and writes no Daily');

 await page.evaluate(()=>{
  const p=window.app.plugins.plugins['research-planner'];p.device.reminders=true;p.settings.reminder='22:30';
  p.device.reminderState={since:'2026-10-01',shownDays:[],skippedDays:[],snooze:null};p.device.reviews=[];p.persistDevice();
  return p.checkReminder(new Date('2026-10-12T22:31:00+08:00'));
 });
 await page.getByRole('button',{name:'开始复盘',exact:true}).waitFor();await close(page);
 await page.evaluate(()=>window.app.plugins.plugins['research-planner'].checkReminder(new Date('2026-10-12T23:00:00+08:00')));
 assert.equal(await page.getByRole('button',{name:'开始复盘',exact:true}).count(),0);
 await page.evaluate(()=>window.app.plugins.plugins['research-planner'].checkReminder(new Date('2026-10-13T09:00:00+08:00')));
 await page.getByRole('button',{name:'跳过这次复盘',exact:true}).click();
 await page.evaluate(()=>window.app.plugins.plugins['research-planner'].checkReminder(new Date('2026-10-13T10:00:00+08:00')));
 assert.equal(await page.getByRole('button',{name:'开始复盘',exact:true}).count(),0);
 checks.push('Reminder dismissal is not completion: no same-day loop, next-morning catch-up, explicit skip stops chasing');

 await page.evaluate(()=>{const p=window.app.plugins.plugins['research-planner'];return Promise.all([p.checkReminder(new Date('2026-10-18T09:00:00+08:00')),p.checkReminder(new Date('2026-10-18T09:00:00+08:00'))]);});
 assert.equal(await page.getByRole('button',{name:'开始复盘',exact:true}).count(),1);
 assert.match(await page.locator('.modal-content').innerText(),/2026-10-17/);
 await page.screenshot({path:path.join(runtime,'catch-up.png')});
 await page.getByRole('button',{name:'1 小时后提醒',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.app.plugins.plugins['research-planner'].device.reminderState.snooze.day),'2026-10-17');
 checks.push('Several missed days produce one latest-day reminder; concurrent checks do not duplicate modal; snooze action persists');

 await page.evaluate(async()=>{
  const p=window.app.plugins.plugins['research-planner'];await p.service.saveReview('2026-10-20','在另一设备上已复盘');
  await p.checkReminder(new Date('2026-10-20T22:31:00+08:00'));
 });
 assert.equal(await page.getByRole('button',{name:'开始复盘',exact:true}).count(),0);
 await page.evaluate(async()=>{const p=window.app.plugins.plugins['research-planner'];for(const r of await p.service.tasks())await p.service.update(r,{status:'done'});await p.checkReminder(new Date('2026-10-22T22:31:00+08:00'));p.device.reminders=false;p.persistDevice();});
 assert.equal(await page.getByRole('button',{name:'开始复盘',exact:true}).count(),0);
 checks.push('An existing synced review suppresses reminder; no pending tasks or day activity stays quiet');

 await page.evaluate(()=>{window.app.plugins.plugins['research-planner'].settings.model='';});
 const finalCalls=await page.evaluate(()=>window.__rpCalls);
 await openPlan(page);await page.getByLabel('计划日期',{exact:true}).fill('2026-10-23');await page.getByLabel('复盘 / 调整说明',{exact:true}).fill('');
 await generate(page);await preview(page);
 assert.equal(await page.evaluate(()=>window.__rpCalls),finalCalls);
 await close(page);await close(page);
 checks.push('All tasks completed: empty local plan with no API calls or invented tasks');
}
