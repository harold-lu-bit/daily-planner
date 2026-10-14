// User-authorized local diagnostics. Never accept transport headers, keys or settings.
export interface ConversationRecord {
  version:1;id:string;startedAt:string;targetDate:string;feedback:string[];pluginVersion?:string;
  request?:unknown;response?:unknown;rawReview?:unknown;result?:unknown;error?:string;
  acceptedAt?:string;
  turns?:{role:'user'|'assistant'|'validator';content:string}[];planTarget?:'today'|'tomorrow';
  sourceDay?:string;
}
export interface ConversationAdapter {
  exists(path:string):Promise<boolean>;mkdir(path:string):Promise<void>;
  write(path:string,content:string):Promise<void>;read(path:string):Promise<string>;
  list(path:string):Promise<{files:string[]}>;
}
export class ConversationArchive {
  constructor(private adapter:ConversationAdapter,readonly folder:string){}
  async save(record:ConversationRecord):Promise<string>{
    if(!/^[\w-]+$/.test(record.id))throw Error('Invalid conversation id');
    if(!await this.adapter.exists(this.folder))await this.adapter.mkdir(this.folder);
    const path=`${this.folder}/${record.id}.json`;
    await this.adapter.write(path,JSON.stringify(record,null,2));return path;
  }
  async files():Promise<string[]>{
    if(!await this.adapter.exists(this.folder))return [];
    return (await this.adapter.list(this.folder)).files.filter(p=>p.startsWith(this.folder+'/')&&/\/[\w-]+\.json$/.test(p)).sort().reverse();
  }
  async read(path:string):Promise<string>{
    if(!path.startsWith(this.folder+'/')||!/^[-\w]+\.json$/.test(path.slice(this.folder.length+1)))throw Error('Invalid conversation path');
    return this.adapter.read(path);
  }
}
