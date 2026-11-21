const test=require('node:test');
const assert=require('node:assert/strict');
const D=require('../src/chat-document.cjs');
const C=require('../src/comments.cjs');
const S=require('../src/state.cjs');
const meta={source:'课程/讲义.pdf',documentId:'pdf:abc',commentId:'p123',quote:'高亮原文'};
const initial=()=>D.create(meta,[{author:'me',timestamp:'old',text:'@chat 为什么？'},{author:'chat',timestamp:'reply',text:'**答案**\n\n$$x^2$$'}]);

test('a newly opened highlight with no messages can be scanned and receive its first question',()=>{
 const raw=D.create(meta,[]).replace(/\n/g,'\r\n');
 assert.deepEqual(D.parse(raw).messages,[]);
 const empty=S.reconcile(S.createDocument('empty-chat'),D.projection(raw),{mode:'import'});
 assert.equal(empty.pending.length,0);assert.equal(empty.unread.length,0);
 const asked=D.append(raw,D.submission(raw,'第一次提问'));
 const result=S.reconcile(empty.document,D.projection(asked),{mode:'observe'});
 assert.equal(result.pending.length,1);assert.equal(result.unread.length,0);
 assert.equal(D.parse(asked).messages[0].text,'第一次提问');
 assert.throws(()=>D.parse(D.create(meta,[])+'<!-- ipc-message:broken -->\n## me\n丢失分隔符'),/有效消息/);
});
test('readable Markdown history projects into existing reply pipeline and appends idempotently',()=>{
 const raw=initial();assert.deepEqual(D.metadata(raw),meta);
 assert.match(raw,/## chat\n\n\*\*答案\*\*/);
 assert.equal(D.parse(raw).messages.length,2);
 const entry=D.submission(raw,'追问无需提及');
 const next=D.append(raw,entry), virtual=D.projection(next), thread=C.parse(virtual)[0];
 assert.equal(thread.id,'p123'); assert.equal(thread.entries.at(-1).text,'@chat 追问无需提及');
 const result=C.appendReplies(virtual,[{commentId:'p123',text:'新的回答'}],'stamp');
 const applied=D.applyProjection(next,result);
 assert.equal(D.parse(applied).messages.at(-1).text,'新的回答');
 assert.equal(D.applyProjection(applied,result),applied);
 assert.equal(D.append(next,entry),next);
});
test('multiple inline references are attached once; edited references are included again without @chat',()=>{
 let raw=initial()+'\n<!--c:a1-->选中文字<!--/c:a1-->\n<!--co:a1\nme (t): 请展开\n-->\n<!--c:a2-->第二处<!--/c:a2-->\n<!--co:a2\nme (t2): 这里不明白\n-->\n';
 const first=D.submission(raw,'一起解释');
 assert.match(first.text,/选中文字/);assert.match(first.text,/这里不明白/);
 assert.equal(Object.keys(first.references).length,2);
 raw=D.append(raw,first);
 assert.equal(D.submission(raw,'继续').text,'继续');
 raw=raw.replace('me (t): 请展开','me (t): 请详细证明');
 const changed=D.submission(raw,'再看一下');
 assert.match(changed.text,/请详细证明/); assert.doesNotMatch(changed.text,/第二处/);
 assert.equal(C.parse(D.projection(raw)).length,1);
});
test('retry retains submission identity after the draft has been persisted',()=>{
 const raw=initial(), message=D.submission(raw,'同样的问题');
 assert.equal(D.submission(D.append(raw,message),'同样的问题').submissionKey,message.submissionKey);
});
test('Enter submits only outside composition, modifiers, and key repeat',()=>{
 assert.equal(D.shouldSend({key:'Enter'}),true);
 for(const patch of [{shiftKey:true},{ctrlKey:true},{altKey:true},{metaKey:true},{isComposing:true},{keyCode:229},{repeat:true},{key:'a'}]) assert.equal(D.shouldSend({key:'Enter',...patch}),false);
});
test('broken or duplicated message identity blocks updates',()=>{
 const raw=initial();const block=raw.slice(raw.indexOf('<!-- ipc-message:'));
 assert.throws(()=>D.parse(raw+block),/重复/);
 assert.throws(()=>D.parse(raw.replace('chat-binding:','broken:')),/来源/);
});

test('composer save normalizing an existing answer CR cannot create an unread reply',()=>{
 const raw=D.create(meta,[{author:'me',timestamp:'old',text:'@chat 为什么？'},{author:'chat',timestamp:'reply',text:'第一段\r第二段\r\n第三段'}]);
 // Existing installations can have observed the old, unnormalized projection.
 const legacy=D.projection(raw).replace('第一段\\n第二段\\n第三段','第一段\\r第二段\\r\\n第三段');
 let doc=S.reconcile(S.createDocument('chat-file'),legacy,{mode:'import'}).document;
 const next=D.append(raw,D.submission(raw,'继续解释')).replace(/\r\n?/g,'\n');
 const result=S.reconcile(doc,D.projection(next),{mode:'observe'});
 assert.equal(result.unread.length,0);
 assert.equal(result.pending.length,1);
 assert.equal(Object.values(result.document.observed.threads)[0].messages[1].revision,1);
 assert.equal(result.changes.some(change=>change.type==='message-updated'),false);
 const answered=D.applyProjection(next,C.appendReplies(D.projection(next),[{commentId:meta.commentId,text:'新的回答'}],'new-reply'));
 const reply=S.reconcile(result.document,D.projection(answered),{mode:'observe'});
 assert.equal(reply.unread.length,1);
 assert.equal(reply.unread[0].messages.length,1);
});
