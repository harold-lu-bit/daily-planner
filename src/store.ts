import { App, TFile, TFolder } from 'obsidian';
import { safePath, type Store } from './core';

export class ObsidianStore implements Store {
  constructor(private app:App) {}
  async read(path:string):Promise<string|null> {
    safePath(path); const f=this.app.vault.getAbstractFileByPath(path);
    if(f===null)return null; if(!(f instanceof TFile))throw new Error('目标不是普通文件');
    return this.app.vault.read(f);
  }
  async list(dir:string):Promise<string[]> {
    safePath(dir); const root=this.app.vault.getAbstractFileByPath(dir);
    if(!root)return []; if(!(root instanceof TFolder))throw new Error('任务/Planning 路径不是目录');
    const files:string[]=[];
    const visit=(folder:TFolder)=>{for(const f of folder.children){if(f instanceof TFolder)visit(f); else if(f instanceof TFile && f.extension==='md')files.push(safePath(f.path));}};
    visit(root); return files.sort();
  }
  async create(path:string,text:string):Promise<void> {
    safePath(path); const segments=path.split('/'); segments.pop(); let dir='';
    for(const part of segments) {dir=dir?dir+'/'+part:part; if(!this.app.vault.getAbstractFileByPath(dir)) {try {await this.app.vault.createFolder(dir);} catch(e) {if(!(this.app.vault.getAbstractFileByPath(dir) instanceof TFolder))throw e;}}}
    await this.app.vault.create(path,text);
  }
  async compareWrite(path:string,expected:string,next:string):Promise<void> {
    safePath(path); const f=this.app.vault.getAbstractFileByPath(path);
    if(!(f instanceof TFile))throw new Error('目标文件已移动或删除');
    await this.app.vault.process(f,current=>{if(current!==expected)throw new Error('文件已被修改，已停止写入；请刷新后重试'); return next;});
  }
  async compareRemove(path:string,expected:string):Promise<void> {
    safePath(path); const f=this.app.vault.getAbstractFileByPath(path);
    if(!(f instanceof TFile)||await this.app.vault.read(f)!==expected)throw new Error('文件已变化，不能撤销新建笔记');
    // Keep concurrent edits safe: clear the managed new file using process rather than delete it.
    await this.compareWrite(path,expected,'');
  }
}
