import {afterEach,describe,expect,it,vi} from 'vitest';
import {addDay,type Store} from '../src/core';
import {DailyService,QUEUE_PATH,renderQueue,type Layout,type Review} from '../src/daily';
import type {Transport} from '../src/provider';

vi.mock('obsidian',()=>({
  Plugin:class {},ItemView:class {},Modal:class {},Notice:class {},PluginSettingTab:class {},
  Setting:class {},SecretComponent:class {},moment:vi.fn(),requestUrl:vi.fn(),
}));
import ResearchPlanner from '../src/main';

afterEach(()=>vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-09T02:00:00Z'));
  const files=new Map<string,string>([
    ['daily/2026-10-08.md','## Tasks\n- [ ] 昨天未完\n'],
    ['daily/2026-10-09.md','## Tasks\n- [ ] 今日未完\n'],
    ['template.md','# {{date}}\n\n## Tasks\n'],
    [QUEUE_PATH,renderQueue({type:'research-planner-future',version:1,reviewed:['2026-10-07'],tasks:[]})],
  ]);
  const store:Store={read:async p=>files.get(p)??null,list:async()=>{throw Error('No scan');},
    create:async(p,s)=>{if(files.has(p))throw Error('exists');files.set(p,s);},
    compareWrite:async(p,b,s)=>{if(files.get(p)!==b)throw Error('changed');files.set(p,s);},
    compareRemove:async(p,b)=>{if(files.get(p)!==b)throw Error('changed');files.set(p,'');},
  };
  const service=new DailyService(store,async(day):Promise<Layout>=>({day,todayPath:`daily/${day}.md`,tomorrowPath:`daily/${addDay(day,1)}.md`,templatePath:'template.md',heading:'Tasks',enabled:true}));
  const plugin=new ResearchPlanner(null!,null!);
  Object.assign(plugin,{app:{workspace:{getLeavesOfType:()=>[]},saveLocalStorage:vi.fn(),secretStorage:{getSecret:()=> 'synthetic-key'}}});
  Object.assign(plugin,{saveData:vi.fn(async()=>{})});
  plugin.service=service;plugin.settings.baseUrl='https://synthetic.invalid';plugin.settings.model='synthetic';plugin.device.writes=true;
  const calls:Record<string,unknown>[]=[];
  const transport:Transport=async(_url,body)=>{
    const data=JSON.parse(JSON.parse(body).messages[1].content);calls.push(data);
    const result:Review={summary:'安排剩余工作。',questions:[],decisions:data.tasks.map((t:{id:string;text:string})=>({id:t.id,text:t.text,action:data.target,date:data.targetDate,deadline:null,start:null,end:null,priority:'normal',reason:'接续'}))};
    return {status:200,json:{choices:[{message:{content:JSON.stringify(result)}}]}};
  };
  (plugin as unknown as {transport:Transport}).transport=transport;
  return {plugin,files,calls};
}
describe('Planning controls and confirmation',()=>{
  it('returns raw proposals and local corrections to the next iteration and archives both',async()=>{
    const {plugin,calls,files}=fixture();
    const control=plugin as unknown as {transport:Transport},normal=control.transport;
    control.transport=async(url,body,key)=>{
      const response=await normal(url,body,key),json=response.json as {choices:{message:{content:string}}[]};
      const r=JSON.parse(json.choices[0].message.content);r.decisions[0].action='future';r.decisions[0].date='2026-10-20';
      json.choices[0].message.content=JSON.stringify(r);return response;
    };
    const before=new Map(files);await plugin.begin();
    expect(plugin.diagnostics!.rawReview!.decisions[0].date).toBe('2026-10-20');
    expect(plugin.draft!.review.decisions[0].date).toBe('2026-10-10');
    expect(plugin.lastRecord!.request).toBeDefined();expect(plugin.lastRecord!.response).toBeDefined();expect(plugin.lastRecord!.result).toBeDefined();
    plugin.device.notes='为什么日期不对？';await plugin.iterate();
    expect(JSON.stringify(calls.at(-1)!.previousProcessing)).toContain('本地规则改写');expect(files).toEqual(before);
  });
  it('saves validation failures and sends the failed output and error on retry',async()=>{
    const {plugin,calls}=fixture(),control=plugin as unknown as {transport:Transport},normal=control.transport;
    control.transport=async()=>({status:200,json:{choices:[{message:{content:'{"broken":"synthetic"}'}}]}});
    plugin.device.notes='活动按18号安排';await expect(plugin.begin()).rejects.toThrow('结构校验');
    expect(plugin.lastRecord!.feedback).toEqual(['活动按18号安排']);expect(plugin.lastRecord!.error).toContain('结构校验');
    control.transport=normal;await plugin.retry();expect(JSON.stringify(calls.at(-1)!.previousProcessing)).toContain('broken');
  });
  it('保留重读失败前的预览，但禁止接受；成功重试后才恢复写入',async()=>{
    const {plugin,files}=fixture();await plugin.begin();const old=plugin.draft;
    const control=plugin as unknown as {transport:Transport},success=control.transport;
    control.transport=async()=>({status:200,json:{choices:[{finish_reason:'length',message:{content:'partial'}}],usage:{prompt_tokens:500,completion_tokens:16384}}});
    files.set('daily/2026-10-09.md','## Tasks\n- [ ] 人工追加的新任务\n');const before=new Map(files);
    await expect(plugin.begin()).rejects.toThrow('截断');
    expect(plugin.draft).toBe(old);expect(plugin.draftStale).toBe(true);expect(plugin.device.output).toBe(16384);
    await expect(plugin.accept()).rejects.toThrow('旧稿');expect(files).toEqual(before);
    control.transport=success;await plugin.retry();
    expect(plugin.draftStale).toBe(false);expect(plugin.draft!.review.decisions[0].text).toBe('人工追加的新任务');
    expect(files).toEqual(before);
  });
  it('首次截断后可无调整意见重试，扩大预算只在明确调用时发生',async()=>{
    const {plugin,files}=fixture();plugin.settings.maxTokens=8192;
    const control=plugin as unknown as {transport:Transport},success=control.transport;
    const limits:number[]=[];
    control.transport=async(url,body,key)=>{
      limits.push(JSON.parse(body).max_tokens);
      if(limits.length===1)return {status:200,json:{choices:[{finish_reason:'length',message:{content:null}}]}};
      return success(url,body,key);
    };
    const before=new Map(files);await expect(plugin.begin()).rejects.toThrow('截断');
    expect(limits).toEqual([8192]);expect(plugin.draft).toBeNull();expect(plugin.settings.maxTokens).toBe(8192);
    await plugin.retryWithMoreTokens();expect(limits).toEqual([8192,16384]);
    expect(plugin.draft).not.toBeNull();expect(plugin.lastTruncation).toBeNull();expect(files).toEqual(before);
  });
  it('调整失败保留意见和旧预览，不能接受旧稿；重试不会丢失意见',async()=>{
    const {plugin,files,calls}=fixture();await plugin.begin();const old=plugin.draft;
    const control=plugin as unknown as {transport:Transport},success=control.transport;
    control.transport=async()=>{throw Error('network')};plugin.device.notes='今天优先做这个';const before=new Map(files);
    await expect(plugin.iterate()).rejects.toThrow('网络');expect(plugin.draft).toBe(old);
    expect(plugin.device.notes).toBe('今天优先做这个');await expect(plugin.accept()).rejects.toThrow('旧稿');
    control.transport=success;await plugin.retry();expect(calls.at(-1)!.feedback).toEqual(['今天优先做这个']);
    expect(plugin.device.notes).toBe('');expect(plugin.draftStale).toBe(false);expect(files).toEqual(before);
  });
  it('输出预算不超过 32768；没有截断时不能扩大预算重试',async()=>{
    const {plugin}=fixture();await expect(plugin.retryWithMoreTokens()).rejects.toThrow('检查');
    plugin.settings.maxTokens=32768;
    (plugin as unknown as {transport:Transport}).transport=async()=>({status:200,json:{choices:[{finish_reason:'length',message:{content:''}}]}});
    await expect(plugin.begin()).rejects.toThrow('截断');await expect(plugin.retryWithMoreTokens()).rejects.toThrow('检查');
    expect(plugin.settings.maxTokens).toBe(32768);
  });
  it('sends today target, local time and missed-day sources, writes only after explicit acceptance',async()=>{
    const {plugin,files,calls}=fixture();plugin.planTarget='today';files.set('daily/2026-10-09.md','## Tasks\n');const before=new Map(files);
    await plugin.begin();expect(files).toEqual(before);expect(calls[0].target).toBe('today');expect(calls[0].currentTime).toBe('10:00');
    expect(plugin.snapshot!.history.map(n=>n.day)).toEqual(['2026-10-08']);
    expect(plugin.draft!.review.decisions).toHaveLength(1);expect(calls[0].sourceMode).toBe('latest');
    await plugin.accept();expect(files.get('daily/2026-10-09.md')).toContain('- [ ] 昨天未完');
    expect(files.has('daily/2026-10-10.md')).toBe(false);expect(plugin.draft).toBeNull();
  });
  it('honors the selected lookback range and prevents acceptance with unsubmitted feedback',async()=>{
    const {plugin,files}=fixture();plugin.sourceMode='range';plugin.catchUpFrom='2026-10-09';await plugin.begin();
    expect(plugin.snapshot!.history).toHaveLength(0);plugin.device.notes='先调整一下';const before=new Map(files);
    await expect(plugin.accept()).rejects.toThrow('未提交');expect(files).toEqual(before);
  });
  it('rejects a today draft after midnight instead of writing a stale date',async()=>{
    const {plugin,files}=fixture();plugin.planTarget='today';await plugin.begin();const before=new Map(files);
    vi.setSystemTime(new Date('2026-10-09T16:01:00Z'));
    await expect(plugin.accept()).rejects.toThrow('日期已经变化');expect(files).toEqual(before);
  });
});
