'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ChatFiles}=require('../src/chat-files.cjs');

test('unread lookup skips ordinary documents and blank tabs while retaining bound chat highlights',()=>{
  const p={state:{documents:{'source.md':{id:'source'}}},cache:new Map([
    ['ordinary.md',{unread:[{}]}],['chat.md',{unread:[{}]}]
  ])};
  const chats=new ChatFiles(p);
  chats.metas.set('ordinary.md',null);
  chats.metas.set('chat.md',{documentId:'source',commentId:'aa'});
  assert.deepEqual(chats.unreadIds(undefined),[]);
  assert.deepEqual(chats.unreadIds('unknown.md'),[]);
  assert.deepEqual(chats.unreadIds('source.md'),['aa']);
});

test('owned links intercept the full mouse gesture, open once, and track updated targets',async()=>{
  const listeners=new Map(),opened=[];
  const win={
    addEventListener(type,handler,capture){assert.equal(capture,true);listeners.set(type,handler);},
    removeEventListener(type,handler,capture){assert.equal(capture,true);assert.equal(listeners.get(type),handler);listeners.delete(type);}
  };
  const chats=new ChatFiles({app:{workspace:{getLeavesOfType:()=>[]}},notice:e=>{throw e;}});
  chats.open=async(...args)=>{opened.push(args);};
  const link={ownerDocument:{defaultView:win},closest:()=>link};
  chats.bindLink(link,'old.md','old');
  chats.bindLink(link,'article.md','aa');
  assert.equal(listeners.size,5);
  let nativeExpands=0;
  const dispatch=(type,target=link,button=0)=>{
    const e={type,target,button,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};
    listeners.get(type)(e);
    if(!e.stopped) nativeExpands++;
    return e;
  };
  for(const type of ['pointerdown','mousedown','click']) {
    const e=dispatch(type);assert.equal(e.stopped,true);assert.equal(e.prevented,true);
  }
  await Promise.resolve();
  assert.equal(nativeExpands,0);assert.deepEqual(opened,[['article.md','aa']]);
  dispatch('dblclick');assert.equal(opened.length,1);
  assert.equal(dispatch('mousedown',link,2).stopped,undefined);
  const foreign={closest:()=>foreign};assert.equal(dispatch('click',foreign).stopped,undefined);
  // Enter on a focused anchor emits a primary click, which follows the same path.
  dispatch('click');assert.equal(opened.length,2);
  chats.destroy();assert.equal(listeners.size,0);
});

test('card single click acknowledges; double click opens exact chat; full answer stays single click',async()=>{
  const handlers=new Map(), calls=[];
  const win={addEventListener:(type,fn)=>handlers.set(type,fn),removeEventListener:()=>{}};
  const chats=new ChatFiles({notice:e=>{throw e;}});
  chats.open=async(...args)=>calls.push(['tab',...args]);
  chats.openSidebar=async(...args)=>calls.push(['sidebar',...args]);
  chats.markDiscussionRead=async(...args)=>calls.push(['read',...args]);
  const card={ownerDocument:{defaultView:win}};
  const link={ownerDocument:{defaultView:win}};
  const body={closest:s=>s==='.doc-comment-card'?card:null};
  link.closest=s=>s==='.ipc-full-chat-link'?link:s==='.doc-comment-card'?card:null;
  const editor={closest:s=>s==='.doc-comment-card'?card:s.startsWith('button,')?editor:null};
  chats.bindCard(card,'article.md','aa');chats.bindLink(link,'article.md','aa');
  function gesture(target){for(const type of ['pointerdown','mousedown','click']) {
    const e={target,type,button:0,preventDefault(){},stopImmediatePropagation(){this.stopped=true;}};
    handlers.get(type)(e);
    if(target!==editor) assert.equal(e.stopped,true);else assert.equal(e.stopped,undefined);
  }}
  gesture(body);gesture(link);gesture(editor);await Promise.resolve();
  assert.deepEqual(calls,[['read','article.md','aa'],['tab','article.md','aa']]);
  const event={target:body,type:'dblclick',button:0,preventDefault(){},stopImmediatePropagation(){}};
  handlers.get('dblclick')(event);
  await Promise.resolve();
  assert.deepEqual(calls.at(-1),['tab','article.md','aa']);
});

test('inline highlight captures clicks before the editor and resolves the owning document',async()=>{
  const handlers=new Map(),calls=[];
  const win={addEventListener:(type,fn)=>handlers.set(type,fn),removeEventListener:()=>{}};
  const anchor={dataset:{cid:'second-thread'}};
  const target={closest:s=>s==='.doc-comment-span[data-cid]'?anchor:s.includes('contenteditable')?target:null};
  const wrong={view:{file:{path:'wrong.md'},containerEl:{contains:()=>false}}};
  const owner={view:{file:{path:'source.md'},containerEl:{contains:el=>el===anchor}}};
  const chats=new ChatFiles({app:{workspace:{activeLeaf:wrong,getLeavesOfType:()=>[wrong,owner]}},notice:e=>{throw e;}});
  chats.markDiscussionRead=async(...args)=>calls.push(['read',...args]);
  chats.open=async(...args)=>calls.push(['open',...args]);
  chats.bindCardWindow(win);
  const send=(type,button=0)=>{
    const event={type,target,button,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};
    handlers.get(type)(event);return event;
  };
  assert.equal(send('pointerdown').stopped,undefined);
  assert.equal(send('click').stopped,true);
  assert.equal(send('dblclick').stopped,true);
  assert.equal(send('click',2).stopped,undefined);
  await Promise.resolve();
  assert.deepEqual(calls,[['read','source.md','second-thread'],['open','source.md','second-thread']]);
});

test('sidebar navigation activates the owning source leaf and uses the native reveal API',async()=>{
  const calls=[], leaf={view:{file:{path:'source.md'}}};
  const workspace={activeLeaf:{},getLeavesOfType:()=>[leaf],setActiveLeaf:(l,opts)=>calls.push(['activate',l,opts])};
  const native={revealComment:async id=>calls.push(['reveal',id])};
  const chats=new ChatFiles({state:{documents:{}},app:{workspace,plugins:{plugins:{'document-comments':native}}}});
  await chats.openSidebar('source.md','aa');
  assert.deepEqual(calls,[['activate',leaf,{focus:false}],['reveal','aa']]);
  await assert.rejects(chats.openSidebar('missing.md','aa'),/标签页已关闭/);
});

test('reading a discussion clears source and follow-up unread without affecting other threads',async()=>{
 const cache=new Map([
  ['source.md',{unread:[{threadId:'aa'},{threadId:'bb'}]}],
  ['chat-aa.md',{unread:[{threadId:'aa'}]}],['chat-bb.md',{unread:[{threadId:'bb'}]}]
 ]),calls=[];
 const p={state:{documents:{'source.md':{id:'source'}}},cache,markRead:async(name,id)=>{
  calls.push([name,id]);cache.get(name).unread=cache.get(name).unread.filter(x=>x.threadId!==id);
 }};
 const chats=new ChatFiles(p);
 chats.metas.set('ordinary.md',null);
 chats.metas.set('chat-aa.md',{documentId:'source',commentId:'aa'});
 chats.metas.set('chat-bb.md',{documentId:'source',commentId:'bb'});
 await chats.markDiscussionRead('source.md','aa');await chats.markDiscussionRead('source.md','aa');
 assert.deepEqual(calls,[['source.md','aa'],['chat-aa.md','aa']]);
 assert.deepEqual(chats.unreadIds('source.md'),['bb']);
});

test('hidden sidebar and offscreen cards do not acknowledge unread messages',()=>{
 const chats=new ChatFiles({});
 const bounds={top:40,bottom:800,left:700,right:1000};
 const view={containerEl:{checkVisibility:()=>true,getBoundingClientRect:()=>bounds}};
 const card={checkVisibility:()=>true,ownerDocument:{defaultView:{innerHeight:900,innerWidth:1100}},getBoundingClientRect:()=>({top:100,bottom:200,left:750,right:980})};
 assert.equal(chats.sidebarCardVisible(view,card),true);
 card.getBoundingClientRect=()=>({top:850,bottom:950,left:750,right:980});
 assert.equal(chats.sidebarCardVisible(view,card),false);
 view.containerEl.checkVisibility=()=>false;
 assert.equal(chats.sidebarCardVisible(view,card),false);
});

test('opening an existing complete answer explicitly activates its Markdown tab',async()=>{
 const source={path:'source.md'},chat={path:'chat.md'},calls=[];
 const leaf={view:{file:chat}};
 const workspace={getLeavesOfType:()=>[leaf],revealLeaf:async l=>calls.push(['reveal',l]),setActiveLeaf:(l,opts)=>calls.push(['activate',l,opts])};
 const p={app:{workspace,vault:{getAbstractFileByPath:()=>source}},markRead:async()=>{}};
 const chats=new ChatFiles(p);chats.isChat=()=>false;chats.ensure=async()=>chat;chats.decoratePanels=()=>{};
 assert.equal(await chats.open('source.md','aa'),leaf);
 assert.deepEqual(calls,[['reveal',leaf],['activate',leaf,{focus:true}]]);
});
