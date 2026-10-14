import {expect,it} from 'vitest';
import {ReplySchema,modelReplySchema,mergeReply,restoreDialogue,type Reply} from '../src/dialogue';
import type {Review} from '../src/daily';
const d=(id:string)=>({id,action:'tomorrow' as const,text:id,date:'2026-10-10',deadline:null,start:null,end:null,priority:'normal' as const,reason:'继续',timing:'asap' as const,timeSpecified:false,category:'task' as const});
const previous:Review={summary:'初稿',questions:[],decisions:[d('original'),d('new:1')]};
const patch:Reply={kind:'patch',message:'调整新增提醒',summary:'新稿',questions:[],upsert:[{...d('new:1'),text:'改名'}],remove:[]};
it.each(['today','tomorrow'] as const)('resolves literal target for %s in plans and patches without changing dates or input',target=>{
 const row={...d('original'),action:'target'};
 const raw={kind:'plan',message:'提案',review:{...previous,decisions:[row]}};
 const parsed=modelReplySchema(target).parse(raw);
 expect(parsed.kind==='plan'&&parsed.review.decisions[0]).toEqual({...row,action:target});
 expect(row.action).toBe('target');
 const changed=modelReplySchema(target).parse({...patch,upsert:[row]});
 expect(changed.kind==='patch'&&changed.upsert[0]).toEqual({...row,action:target});
 expect(modelReplySchema(target).safeParse({...raw,review:{...previous,decisions:[{...row,action:'invented'}]}}).success).toBe(false);
});
it('requires model timing classification and validates valid calendar dates',()=>{
 expect(ReplySchema.safeParse({kind:'plan',message:'说明',review:previous}).success).toBe(true);
 expect(ReplySchema.safeParse({kind:'plan',message:'说明',review:{...previous,decisions:[{...d('x'),timing:undefined}]}}).success).toBe(false);
 expect(ReplySchema.safeParse({kind:'plan',message:'说明',review:{...previous,decisions:[{...d('x'),date:'2026-02-30'}]}}).success).toBe(false);
});
it('answers without returning or mutating a plan',()=>{expect(mergeReply({kind:'answer',message:'原因说明'},previous)).toBeNull();expect(previous.decisions[1].text).toBe('new:1');});
it('merges a patch without losing unmentioned original or new tasks',()=>{const result=mergeReply(patch,previous)!;expect(result.decisions.map(t=>t.text)).toEqual(['original','改名']);expect(previous.decisions[1].text).toBe('new:1');});
it('treats an omitted patch remove list as no deletions, without accepting other invalid list values',()=>{
 const {remove,...raw}=patch;const parsed=ReplySchema.parse(raw);
 expect(parsed.kind==='patch'&&parsed.remove).toEqual([]);expect(mergeReply(parsed,previous)!.decisions).toHaveLength(2);
 expect(ReplySchema.safeParse({...raw,remove:'original'}).success).toBe(false);
});
it('only removes explicitly named uncommitted new items',()=>{expect(mergeReply({...patch,upsert:[],remove:['new:1']},previous)!.decisions).toHaveLength(1);expect(()=>mergeReply({...patch,remove:['original']},previous)).toThrow('不能删除');});
it('rejects duplicate patch operations and missing patch base',()=>{expect(()=>mergeReply({...patch,upsert:[d('x'),d('x')]},previous)).toThrow('重复');expect(()=>mergeReply(patch,null)).toThrow('完整 plan');});
it('restores ordered same-day discussion but never resurrects an accepted or older conversation',()=>{
 const record={sourceDay:'2026-10-10',planTarget:'today',feedback:['按刚才说的办'],turns:[{role:'user',content:'选哪天？'},{role:'assistant',content:'建议周末'},{role:'user',content:'按刚才说的办'}]};
 expect(restoreDialogue(record,'2026-10-10')?.turns).toEqual(record.turns);
 expect(restoreDialogue({...record,acceptedAt:'2026-10-10'},'2026-10-10')).toBeNull();expect(restoreDialogue(record,'2026-10-11')).toBeNull();
 expect(restoreDialogue({pluginVersion:'0.3.4'},'2026-10-10')).toBeNull();
});
