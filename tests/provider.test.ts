import { expect, it } from 'vitest';
import { z } from 'zod';
import { callModel, endpoint, TruncatedOutputError, type ProviderConfig } from '../src/provider';
const config:ProviderConfig={baseUrl:'https://example.com/plan/v1',model:'test-model',format:'json_object',timeout:5,maxTokens:1000};
const schema=z.object({ok:z.literal(true)}).strict();
it('追加唯一接口路径',()=>{expect(endpoint(config.baseUrl)).toBe('https://example.com/plan/v1/chat/completions');expect(()=>endpoint(config.baseUrl+'/chat/completions')).toThrow();expect(()=>endpoint('https://user:key@example.com')).toThrow();});
it('严格结构化成功，记录 usage',async()=>{const r=await callModel(config,'test-secret',async(url,body,key)=>{expect(url).toBe(endpoint(config.baseUrl));expect(key).toBe('test-secret');expect(JSON.parse(body).response_format.type).toBe('json_object');return {status:200,json:{choices:[{message:{content:'{"ok":true}'}}],usage:{prompt_tokens:10,completion_tokens:5}}};},schema,'',{});expect(r).toEqual({value:{ok:true},usage:{input:10,output:5}});});
it('网络错误不会回显凭据或请求正文',async()=>{await expect(callModel(config,'test-secret',async()=>{throw new Error('test-secret sensitive-body');},schema,'',{})).rejects.toThrow('网络');});
it('HTTP 错误不回显上游 body',async()=>{await expect(callModel(config,'test-secret',async()=>({status:401,json:{secret:'test-secret'}}),schema,'',{})).rejects.toThrow('HTTP 401');});
it.each(['not json','{"ok":false}','{"ok":true,"extra":"untrusted"}'])('拒绝格式错误响应 %s',async content=>{await expect(callModel(config,'key',async()=>({status:200,json:{choices:[{message:{content}}]}}),schema,'',{})).rejects.toThrow('结构');});
it('截断响应不能变成草稿',async()=>{await expect(callModel(config,'key',async()=>({status:200,json:{choices:[{finish_reason:'length',message:{content:'{"ok":true}'}}]}}),schema,'',{})).rejects.toThrow('截断');});
it('截断诊断保留用量与推理计数，不泄露模型正文或密钥；不自动重试',async()=>{
 let calls=0;
 try {
  await callModel(config,'private-key',async()=>{calls++;return {status:200,json:{choices:[{finish_reason:'length',message:{content:'private-note',reasoning_content:'private-reasoning'}}],usage:{prompt_tokens:300,completion_tokens:1000,completion_tokens_details:{reasoning_tokens:900}}}};},schema,'',{});
  throw Error('Expected rejection');
 }catch(e){
  expect(e).toBeInstanceOf(TruncatedOutputError);
  expect((e as TruncatedOutputError).usage).toEqual({input:300,output:1000});
  expect((e as Error).message).toContain('推理 900');
  expect((e as Error).message).not.toMatch(/private-/);
 }
 expect(calls).toBe(1);
});
it('仅推理耗尽且 content 为 null 时也报告截断，而非响应格式错误',async()=>{
 await expect(callModel(config,'key',async()=>({status:200,json:{choices:[{finish_reason:'length',message:{content:null}}]}}),schema,'',{})).rejects.toThrow('服务端未提供 token 用量');
 await expect(callModel(config,'key',async()=>({status:200,json:{choices:[{finish_reason:'length',message:{content:null}}],usage:{completion_tokens:1000,completion_tokens_details:null}}}),schema,'',{})).rejects.toThrow('输入 未提供、输出 1000');
});
