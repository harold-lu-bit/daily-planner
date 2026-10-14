import {expect,it} from 'vitest';
import {ConversationArchive,type ConversationRecord,type ConversationAdapter} from '../src/conversation';
it('archives each request durably and can read it after recreation, rejects path traversal',async()=>{
 const files=new Map<string,string>();const dirs=new Set<string>();
 const adapter:ConversationAdapter={exists:async p=>dirs.has(p)||files.has(p),mkdir:async p=>{dirs.add(p);},write:async(p,s)=>{files.set(p,s);},read:async p=>files.get(p)!,list:async()=>({files:[...files.keys()]})};
 const archive=new ConversationArchive(adapter,'plugin/conversations-device');
 const record:ConversationRecord={version:1,id:'2026-10-14-request-1',startedAt:'2026-10-14',targetDate:'2026-10-14',feedback:['活动改期'],request:{tasks:['合成任务']}};
 const path=await archive.save(record);record.error='模型结构无效';await archive.save(record);
 const reopened=new ConversationArchive(adapter,archive.folder);expect(await reopened.files()).toEqual([path]);expect(JSON.parse(await reopened.read(path)).error).toBe('模型结构无效');
 await expect(reopened.read(archive.folder+'/../../secrets')).rejects.toThrow('path');
 await expect(reopened.save({...record,id:'../secrets'})).rejects.toThrow('id');
});
