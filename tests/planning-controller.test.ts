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
