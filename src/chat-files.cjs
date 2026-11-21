'use strict';
const fs = require('node:fs');
const path = require('node:path');
const D = require('./chat-document.cjs');
const C = require('./comments.cjs');

class ChatFiles {
  constructor(plugin) {
    this.p = plugin;
    this.panels = new Map();
    this.creating = new Map();
    this.sending = new Set();
    this.metas = new Map();
    this.linkTargets = new WeakMap();
    this.cardTargets = new WeakMap();
    this.linkWindows = new Map();
    this.stopped = false;
    this.work = Promise.resolve();
  }
  meta(file) {
    if (file?.extension !== 'md') return null;
    if (this.metas.has(file.path)) return this.metas.get(file.path);
    const absolute = path.join(this.p.root, file.path);
    const value = fs.existsSync(absolute) ? D.metadata(fs.readFileSync(absolute,'utf8')) : null;
    this.metas.set(file.path,value);
    return value;
  }
  isChat(file) { return !!this.meta(file); }
  invalidate(file) { this.metas.delete(file?.path); }
  source(meta) {
    const current = Object.entries(this.p.state.documents).find(([,doc])=>doc.id===meta.documentId)?.[0];
    const file = this.p.app.vault.getAbstractFileByPath(current || meta.source);
    if (!file) throw Error('聊天对应的原文不存在，请恢复原文后再发送。');
    return file;
  }
  owner(file) { return this.meta(file)?.documentId || this.p.state.documents[file?.path]?.id || file?.path; }
  unreadIds(sourcePath) {
    const id=this.p.state.documents[sourcePath]?.id, result=[];
    if(!id) return result;
    for(const [filePath,meta] of this.metas) if(meta && meta.documentId===id && this.p.cache.get(filePath)?.unread?.length) result.push(meta.commentId);
    return result;
  }
  busy(file) { return [...this.p.busyFiles].some(filePath=>this.owner(this.p.app.vault.getAbstractFileByPath(filePath))===this.owner(file)); }
  find(documentId,commentId) {
    const matches = this.p.app.vault.getMarkdownFiles().filter(file=>{const m=this.meta(file);return m?.documentId===documentId && m.commentId===commentId;});
    if(matches.length>1) throw Error('同一批注存在多个聊天文件，请保留一个绑定后再操作。');
    return matches[0];
  }
  async ensure(file,commentId) {
    if(this.isChat(file)) return file;
    const documentId=this.p.state.documents[file.path]?.id;
    const existing=documentId && this.find(documentId,commentId);
    if(existing && D.parse(await this.p.app.vault.read(existing)).messages.some(m=>m.author==='chat')) return existing;
    const key=file.path+'\0'+commentId;
    if(this.creating.has(key)) return this.creating.get(key);
    const task=this.create(file,commentId).finally(()=>this.creating.delete(key));
    this.creating.set(key,task); return task;
  }
  async create(file,commentId) {
    await this.p.flush(file);
    const raw=await this.p.readSource(file), comment=C.parse(raw).find(c=>c.id===commentId);
    if(!comment) throw Error('找不到这条批注。');
    if(!this.p.state.documents[file.path]) await this.p.refreshFile(file,'import',raw);
    const documentId=this.p.state.documents[file.path].id;
    const existing=this.find(documentId,commentId);
    if(existing) {
      // A file can be opened before the first response has finished.
      const first=comment.entries.find(C.isChat);
      if(first) await this.p.app.vault.process(existing, current=>{
        if(D.parse(current).messages.some(m=>m.author==='chat')) return current;
        return D.append(current,{id:first.timestamp || 'initial-reply',timestamp:first.timestamp,author:'chat',text:first.text});
      });
      return existing;
    }
    const stem=(file.basename || path.posix.basename(file.path,path.posix.extname(file.path))).slice(0,90);
    const directory=path.posix.join(path.posix.dirname(file.path),'chat');
    await this.ensureFolder(directory);
    let destination=path.posix.join(directory,`${stem} - chat - ${commentId.slice(-10)}.md`);
    if(this.p.app.vault.getAbstractFileByPath(destination)) destination=path.posix.join(directory,`${stem} - chat - ${commentId}.md`);
    if(this.p.app.vault.getAbstractFileByPath(destination)) throw Error('聊天文件名已被占用，未覆盖。');
    const meta={source:file.path,documentId,commentId,quote:comment.quote};
    const backup=path.join(this.p.storage,'backups','chat-files',C.hash(documentId+commentId)+'.json');
    if(!fs.existsSync(backup)) {fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,JSON.stringify({source:file.path,comment,at:new Date().toISOString()},null,2));}
    const created=await this.p.app.vault.create(destination,D.create(meta,comment.entries));
    this.metas.set(created.path,meta);
    await this.p.refreshFile(created,'import');
    this.p.trace({stage:'chat_file_created',status:'ok',documentId,source:'migration'});
    return created;
  }
  async ensureFolder(directory) {
    const vault=this.p.app.vault;
    const existing=vault.getAbstractFileByPath(directory);
    if(existing) {
      if(!Array.isArray(existing.children)) throw Error(`聊天目录被文件占用：${directory}`);
      return;
    }
    try { await vault.createFolder(directory); }
    catch(error) {
      // Two annotations may create their shared directory concurrently.
      if(!Array.isArray(vault.getAbstractFileByPath(directory)?.children)) throw error;
    }
  }
  async open(filePath,commentId) {
    const p=this.p, file=filePath ? p.app.vault.getAbstractFileByPath(filePath) : p.activeSourceFile();
    if(!file) throw Error('请先打开文档或选择批注。');
    if(!commentId && this.selected?.path===file.path) commentId=this.selected.commentId;
    if(!this.isChat(file) && !commentId) {
      const raw=await p.readSource(file), comments=C.parse(raw);
      const view=p.app.workspace.activeLeaf?.view;
      const active=[...(view ? this.cardsFor(view) : [])].filter(([el])=>el.classList.contains('is-active'));
      if(active.length===1) commentId=active[0][1];
      else if(comments.length===1) commentId=comments[0].id;
      else {
        const { SuggestModal } = require('obsidian');
        return new (class extends SuggestModal {
          getSuggestions(query){return comments.filter(c=>(c.quote+' '+c.entries.map(e=>e.text).join(' ')).includes(query));}
          renderSuggestion(c,el){el.setText((c.entries.find(e=>!C.isChat(e))?.text||c.quote||c.id).slice(0,120));}
          onChooseSuggestion(c){p.openCommentReader(file.path,c.id).catch(e=>p.notice(e));}
        })(p.app).open();
      }
    }
    const chat=await this.ensure(file,commentId);
    const workspace=p.app.workspace;
    let leaf=workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===chat.path);
    if(!leaf){leaf=workspace.getLeaf('tab');await leaf.openFile(chat,{active:true});}
    await workspace.revealLeaf(leaf);
    workspace.setActiveLeaf(leaf,{focus:true});
    this.decoratePanels();
    await p.markRead(file.path,commentId);
    if(chat.path!==file.path) await p.markRead(chat.path);
    return leaf;
  }
  async read(file) { return D.projection(await this.p.app.vault.read(file)); }
  async process(file,callback) { return this.p.app.vault.process(file,raw=>D.applyProjection(raw,callback(D.projection(raw)))); }
  draftKey(file){return 'chat-file:'+C.hash(this.meta(file).documentId+this.meta(file).commentId);}
  draft(file){return this.p.pdfDrafts?.[this.draftKey(file)] || '';}
  setDraft(file,value){this.p.pdfDrafts ||= {}; this.p.pdfDrafts[this.draftKey(file)]=value; clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>this.p.saveLocal().catch(e=>this.p.notice(e)),250);}
  async clearSubmittedDraft(file, submitted) {
    if(this.draft(file)===submitted) this.setDraft(file,'');
    for(const panel of this.panels.values()) {
      if(panel.file.path!==file.path || panel.input.value!==submitted) continue;
      panel.input.value='';
      panel.resize?.();
    }
    await this.p.saveLocal();
  }
  async submit(file,input) {
    if(!input.trim() || this.sending.has(file.path)) return false;
    if(this.busy(file)) throw Error('这篇原文正在回答，请稍后发送；草稿已保留。');
    if(this.p.state.documents[file.path]?.job) throw Error('上次请求尚待恢复，请使用“恢复原回答”；草稿已保留。');
    this.sending.add(file.path);
    try {
      await this.p.flush(file);
      if(!this.p.state.documents[file.path]) await this.p.refreshFile(file,'import');
      await this.p.app.vault.process(file,raw=>{
        const entry=D.submission(raw,input), last=D.parse(raw).messages.at(-1);
        if(last.author==='me' && last.submissionKey===entry.submissionKey) return raw;
        return D.append(raw,entry);
      });
      // The question is now durable in Markdown, even if connecting or answering
      // later fails. Clear only this submitted text, never a newer draft.
      await this.clearSubmittedDraft(file,input);
      await this.p.refreshFile(file,'observe');
      await this.p.send(file.path,[this.meta(file).commentId],'chat_composer');
      if(this.p.state.documents[file.path]?.job) return false;
      return true;
    } finally {this.sending.delete(file.path);this.decoratePanels();}
  }
  decoratePanels() {
    const live=new Set();
    for(const leaf of [...this.p.app.workspace.getLeavesOfType('markdown'),...this.p.app.workspace.getLeavesOfType('document-comments-sidebar')]) {
      const view=leaf.view, file=view.file;
      if(!this.isChat(file)) continue;
      live.add(view);
      const old=this.panels.get(view);
      if(old && old.file.path!==file.path){old.element.remove();this.panels.delete(view);}
      if(!this.panels.has(view)) {
        const element=view.containerEl.createDiv({cls:'ipc-chat-composer'});
        const input=element.createEl('textarea',{cls:'ipc-chat-input',attr:{placeholder:'无需 @chat，发送时会一并带上新增批注。','aria-label':'聊天消息'}});
        input.value=this.draft(file);
        const status=element.createDiv({cls:'ipc-chat-composer-status'});
        const resize=()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,220)+'px';};
        input.addEventListener('input',()=>{this.setDraft(file,input.value);resize();});
        let composing=false;
        input.addEventListener('compositionstart',()=>{composing=true;});
        input.addEventListener('compositionend',()=>{setTimeout(()=>{composing=false;},0);});
        input.addEventListener('keydown',async event=>{
          if(composing || !D.shouldSend(event)) return;
          event.preventDefault();event.stopPropagation();
          if(!input.value.trim() || this.sending.has(file.path)) return;
          const draft=input.value;
          try {status.setText('chat 正在工作…');await this.submit(file,draft);}
          catch(error){status.setText(error.message);this.p.notice(error);}
        });
        view.containerEl.addClass('ipc-chat-view');
        this.panels.set(view,{element,input,status,file,resize});
        resize();
      }
      const record=this.panels.get(view);
      if(this.busy(file) || this.sending.has(file.path)) record.status.setText('chat 正在工作…');
      else if(record.status.textContent==='chat 正在工作…') record.status.setText('Enter 发送 · Shift+Enter 换行');
      else if(!record.status.textContent) record.status.setText('Enter 发送 · Shift+Enter 换行');
    }
    for(const [view,record] of this.panels) if(!live.has(view)){record.element.remove();view.containerEl.removeClass('ipc-chat-view');this.panels.delete(view);}
  }
  schedule() {
    if(this.stopped || this.scheduled) return;
    this.scheduled=true;
    this.work=this.work.catch(()=>{}).then(async()=>{
      try{if(!this.stopped){this.decoratePanels();await this.decorateSources();}}
      catch(error){this.p.notice(error);}
      finally{this.scheduled=false;}
    });
  }
  async decorateSources() {
    const p=this.p;
    for(const leaf of [...p.app.workspace.getLeavesOfType('markdown'),...p.app.workspace.getLeavesOfType('document-comments-sidebar')]) {
      const file=leaf.view.file;
      if(!file || this.isChat(file)) continue;
      const comments=p.cache.get(file.path)?.comments || [];
      const cards=this.cardsFor(leaf.view);
      for(const [card,id] of cards) {
        const sidebar=leaf.view.getViewType?.()==='document-comments-sidebar';
        this.bindCard(card,file.path,id);
        if(sidebar && this.sidebarCardVisible(leaf.view,card)) await this.markDiscussionRead(file.path,id);
        const comment=comments.find(c=>c.id===id);
        if(!comment?.entries.some(C.isChat)) continue;
        const chat=await this.ensure(file,id);
        this.compactCard(card,comment,chat,file);
      }
    }
  }
  cardsFor(view) {
    // Read stable identities from the existing plugin's card objects; no
    // patched methods, position-based matching, or writes to that plugin.
    const cards=new Map();
    const reading=this.p.app.plugins?.plugins?.['document-comments']?.readingManager?.margins;
    const owners=[view,...(view.editor?.cm?.plugins || []).map(p=>p.value),...(reading instanceof Map ? reading.values() : [])];
    for(const owner of owners) if(owner?.cards instanceof Map) for(const card of owner.cards.values()) {
      if(card?.el?.matches?.('.doc-comment-card') && card.comment?.id && view.containerEl.contains(card.el)) cards.set(card.el,card.comment.id);
    }
    for(const card of view.containerEl?.querySelectorAll('.doc-comment-card') || []) {
      const id=card.dataset.cid || card.closest('[data-cid]')?.dataset.cid;
      if(id) cards.set(card,id);
    }
    return cards;
  }
  captureTarget(target) {
    this.selected=null;
    if(!target?.closest) return;
    const pdf=this.p.pdf?.fileForTarget(target,this.p.activeSourceFile());
    if(pdf) {
      const element=target.closest('[data-annotation-id], [data-hl-id]');
      const id=element?.dataset.annotationId || element?.dataset.hlId;
      if(!id) return;
      const matches=this.p.pdf.threads(this.p.pdf.contextFor(pdf)).filter(t=>t.annotationId===id);
      if(matches.length===1) this.selected={path:pdf.path,commentId:matches[0].id};
      return;
    }
    for(const leaf of [...this.p.app.workspace.getLeavesOfType('markdown'),...this.p.app.workspace.getLeavesOfType('document-comments-sidebar')]) {
      if(!leaf.view.file || !leaf.view.containerEl.contains(target)) continue;
      const span=target.closest('.doc-comment-span[data-cid]');
      const card=[...this.cardsFor(leaf.view)].find(([el])=>el.contains(target));
      const id=span?.dataset.cid || card?.[1];
      if(id) this.selected={path:leaf.view.file.path,commentId:id};
    }
  }
  closeLegacyViews() {
    const leaves=this.p.app.workspace.getLeavesOfType('inplace-chat-comment-reader');
    if(!leaves.length) return;
    const backup=path.join(this.p.storage,'backups','chat-files','legacy-tabs-'+Date.now()+'.json');
    fs.mkdirSync(path.dirname(backup),{recursive:true});
    fs.writeFileSync(backup,JSON.stringify(leaves.map(leaf=>leaf.getViewState()),null,2));
    for(const leaf of leaves) leaf.detach();
  }
  compactCard(card,comment,chat,file) {
    card.classList.add('ipc-chat-card');
    const index=comment.entries.findIndex(C.isChat);
    [...card.querySelectorAll('.dc-entry')].forEach((row,i)=>{row.classList.toggle('ipc-chat-hidden',i>index);});
    let link=card.querySelector('.ipc-full-chat-link');
    if(link && link.tagName!=='BUTTON'){link.remove();link=null;}
    if(!link) link=card.createEl('button',{cls:'ipc-full-chat-link ipc-full-chat-button',text:'完整回答',attr:{type:'button','aria-label':'在独立标签页打开完整回答'}});
    this.bindLink(link,file.path,comment.id);
    if(link.getAttribute('data-chat-path')!==chat.path) link.setAttribute('data-chat-path',chat.path);
  }
  bindLink(link,filePath,commentId) {
    this.linkTargets.set(link,{filePath,commentId});
    this.bindCardWindow(link.ownerDocument.defaultView);
  }
  bindCard(card,filePath,commentId) {
    this.cardTargets.set(card,{filePath,commentId});
    this.bindCardWindow(card.ownerDocument.defaultView);
  }
  async openSidebar(filePath,commentId) {
    const workspace=this.p.app.workspace;
    const native=this.p.app.plugins?.plugins?.['document-comments'];
    if(typeof native?.revealComment!=='function') throw Error('当前评论插件无法打开批注侧边栏。');
    const leaf=workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===filePath);
    if(!leaf) throw Error('原文标签页已关闭，请重新打开原文。');
    if(workspace.activeLeaf!==leaf) workspace.setActiveLeaf(leaf,{focus:false});
    await native.revealComment(commentId);
    await this.markDiscussionRead(filePath,commentId);
  }
  sidebarCardVisible(view,card) {
    if(!view.containerEl.checkVisibility?.() || !card.checkVisibility?.()) return false;
    const bounds=view.containerEl.getBoundingClientRect(), rect=card.getBoundingClientRect();
    const win=card.ownerDocument.defaultView;
    return rect.bottom>Math.max(bounds.top,0) && rect.top<Math.min(bounds.bottom,win.innerHeight) &&
      rect.right>Math.max(bounds.left,0) && rect.left<Math.min(bounds.right,win.innerWidth);
  }
  async markDiscussionRead(filePath,commentId) {
    const p=this.p,documentId=p.state.documents[filePath]?.id;
    if(!documentId) return;
    const hasUnread=(name,id)=>p.cache.get(name)?.unread?.some(item=>(item.threadId || item.id)===id);
    if(hasUnread(filePath,commentId)) await p.markRead(filePath,commentId);
    for(const [name,meta] of this.metas) if(meta?.documentId===documentId && meta.commentId===commentId && hasUnread(name,commentId)) {
      await p.markRead(name,commentId);
    }
  }
  bindCardWindow(win) {
    if(this.linkWindows.has(win)) return;
    // Capture before Document Comments stops propagation. Resolve highlights
    // against their owning leaf, never the currently active sidebar/tab.
    const handler=event=>{
      const link=event.target?.closest?.('.ipc-full-chat-link');
      const linkTarget=link && this.linkTargets.get(link);
      const card=event.target?.closest?.('.doc-comment-card');
      const anchor=event.target?.closest?.('.doc-comment-span[data-cid]');
      const leaf=anchor && this.p.app.workspace.getLeavesOfType('markdown').find(l=>l.view.file && l.view.containerEl.contains(anchor));
      const anchorTarget=leaf && {filePath:leaf.view.file.path,commentId:anchor.dataset.cid};
      const target=linkTarget || anchorTarget || (card && this.cardTargets.get(card));
      if(this.stopped || !target || (event.button != null && event.button!==0)) return;
      if(!linkTarget && !anchorTarget && event.target?.closest?.('button, textarea, input, select, [contenteditable="true"], .dc-foot-btn, .dc-reaction, .dc-pop')) return;
      if(anchorTarget && event.type!=='click' && event.type!=='dblclick') return;
      event.preventDefault();event.stopImmediatePropagation();
      if(event.type==='click' && (!linkTarget || !(event.detail>1))) {
        const action=linkTarget ? this.open(target.filePath,target.commentId) : this.markDiscussionRead(target.filePath,target.commentId);
        Promise.resolve(action).catch(e=>this.p.notice(e));
      }
      if(event.type==='dblclick' && !linkTarget) this.open(target.filePath,target.commentId).catch(e=>this.p.notice(e));
    };
    const types=['pointerdown','mousedown','click','dblclick'];
    for(const type of types) win.addEventListener(type,handler,true);
    const scroll=event=>{if(event.target?.closest?.('.workspace-leaf-content[data-type="document-comments-sidebar"]')) this.schedule();};
    win.addEventListener('scroll',scroll,true);
    this.linkWindows.set(win,()=>{for(const type of types) win.removeEventListener(type,handler,true);win.removeEventListener('scroll',scroll,true);});
  }
  destroy() {
    this.stopped=true;clearTimeout(this.saveTimer);
    for(const remove of this.linkWindows.values()) remove();
    this.linkWindows.clear();
    for(const [view,record] of this.panels){record.element.remove();view.containerEl.removeClass('ipc-chat-view');}
    this.panels.clear();
    for(const leaf of [...this.p.app.workspace.getLeavesOfType('markdown'),...this.p.app.workspace.getLeavesOfType('document-comments-sidebar')]) {
      leaf.view.containerEl.querySelectorAll('.ipc-full-chat-link').forEach(el=>el.remove());
      leaf.view.containerEl.querySelectorAll('.ipc-chat-hidden').forEach(el=>el.classList.remove('ipc-chat-hidden'));
      leaf.view.containerEl.querySelectorAll('.ipc-chat-card').forEach(el=>el.classList.remove('ipc-chat-card'));
    }
  }
}
module.exports={ChatFiles};
