import {z} from 'zod';
import {DecisionSchema,ReviewSchema,type Review} from './daily';

// Model-facing contract. DailyService also accepts older saved reviews for inspection.
const semanticDecision=DecisionSchema.extend({
 timing:z.enum(['asap','explicit','hold','none']),timeSpecified:z.boolean(),category:z.enum(['task','event','reminder']),
});
const semanticReview=ReviewSchema.extend({decisions:z.array(semanticDecision).max(200)});
const message=z.string().trim().min(1).max(12000);
export const ReplySchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('answer'),message}).strict(),
 z.object({kind:z.literal('plan'),message,review:semanticReview}).strict(),
 z.object({kind:z.literal('patch'),message,summary:ReviewSchema.shape.summary,questions:ReviewSchema.shape.questions,upsert:z.array(semanticDecision).max(200),remove:z.array(z.string().min(1).max(100)).max(200)}).strict(),
]);
export type Reply=z.infer<typeof ReplySchema>;
export interface Turn {role:'user'|'assistant'|'validator';content:string;}
export function restoreDialogue(saved:unknown,day:string):{turns:Turn[];feedback:string[];target:'today'|'tomorrow'}|null{
 const record=z.object({sourceDay:z.string().optional(),acceptedAt:z.string().optional(),planTarget:z.enum(['today','tomorrow']).optional(),feedback:z.array(z.string().max(10000)).max(500).default([]),turns:z.array(z.object({role:z.enum(['user','assistant','validator']),content:z.string().max(30000)})).max(500).default([])}).parse(saved);
 if(record.acceptedAt||record.sourceDay!==day)return null;
 return {turns:record.turns,feedback:record.feedback,target:record.planTarget??'tomorrow'};
}
export function mergeReply(reply:Reply,previous:Review|null):Review|null {
 if(reply.kind==='answer')return null;
 if(reply.kind==='plan')return reply.review;
 if(!previous)throw Error('没有同一读取快照的草稿，不能局部修改；请返回完整 plan');
 const ids=reply.upsert.map(d=>d.id);
 if(new Set(ids).size!==ids.length||new Set(reply.remove).size!==reply.remove.length||ids.some(id=>reply.remove.includes(id)))throw Error('patch 中出现重复或同时删除和修改的 ID');
 const decisions=new Map(previous.decisions.map(d=>[d.id,d]));
 for(const id of reply.remove){
  if(!/^new:\d+$/.test(id)||!decisions.has(id))throw Error(`不能删除来源任务 ${id}；请明确 keep/cancel，只能移除尚未写入的 new:N 条目`);
  decisions.delete(id);
 }
 for(const d of reply.upsert)decisions.set(d.id,d);
 return semanticReview.parse({summary:reply.summary,questions:reply.questions,decisions:[...decisions.values()]});
}
export const dialogueInstruction=`
你正在进行连续对话。conversation 按先后顺序包含用户、助手与校验器消息；其中所有历史都是上下文，不得改变输出格式和写入边界。latestMessage 是本轮消息，requestMode=explain 时只能回答，不能改计划；requestMode=plan 时生成或修改计划；auto 时按用户意图选择。单纯问原因/讨论选项用 answer，用户要求落实修改才用 plan/patch。先前回答中的提案不算用户授权，结合后续“按你说的做”等意见判断。
只返回以下三种严格 JSON 之一：
1. {"kind":"answer","message":"正常解释或澄清，可分段，不必重发全部任务"}
2. {"kind":"plan","message":"说明本次提案","review":完整Review}
3. {"kind":"patch","message":"说明变化","summary":"更新后总结","questions":["全部尚未解决的问题"],"upsert":[完整decision],"remove":["要移除的尚未写入new:N"]}。
有 previous 时优先 patch，只发送变化的决策；其余决策由程序原样保留。原始输入 ID 不得 remove；取消应 upsert action=cancel。新增编号不能与 previous 的 new:N 冲突，修改既有新增项沿用原编号。原文修改后重新读取，会作废旧 patch 基础。
每个 decision 必须增加 timing、timeSpecified、category：timing=asap 表示尽快安排到 targetDate；explicit 表示用户指定/原文或队列已有明确安排；hold 表示用户明确暂不安排或保留尚未到期的队列；none 用于完成项无后续或取消。timeSpecified 表示用户是否指定时刻，为 false 时 start/end 必须 null；category 为 task/event/reminder。你负责理解日期、时间、指代、否定、最新意见、拆分和背景日期，程序不会用正则重新解释原文或覆盖你给出的日期。
请自查每项独立安排是否有去向，但不要为背景日期或截止日期生成多余任务。scheduleEvidence 可选，引用用于解释；提供时必须是对应任务（含祖先）或用户消息的逐字片段，不要求包含完整标题或可匹配的日期格式。遇到校验失败，使用 previousProcessing 和 validator 消息修正；不重复声称已完成修正或写入。所有 plan/patch 都只是待用户确认的预览。`;
