'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../tools/lampac/announcements.js'),'utf8');
function runtime(values){
 class Element{constructor(tag){this.tagName=tag;this.children=[];this.style={};}appendChild(el){el.parent=this;this.children.push(el);}remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}setAttribute(k,v){this[k]=v;}focus(){}contains(el){return this===el||this.children.some(x=>x.contains(el));}querySelector(selector){return this.children.find(x=>selector[0]==='.'?x.className===selector.slice(1):x.tagName===selector)||this.children.map(x=>x.querySelector(selector)).find(Boolean);}}
 const root=new Element('html'),head=new Element('head'),body=new Element('body');root.appendChild(head);root.appendChild(body);
 function byId(node,id){return node.id===id?node:node.children.map(x=>byId(x,id)).find(Boolean);}
 const document={head,body,documentElement:root,createElement:t=>new Element(t),getElementById:id=>byId(root,id)},acks=[];
 const context={document,addEventListener(){}};context.window=context;
 vm.runInNewContext(script,context);
 const popup=context.createWorkspaceAnnouncements({logo:'https://example.org/logo.png',store:{get:(k,f)=>values.get(k)||f,set:(k,v)=>values.set(k,JSON.parse(JSON.stringify(v)))},request:(action,data)=>acks.push({action,data})});
 return {popup,document,acks};
}
test('announcements persist occurrence receipts and do not repeat after reload',()=>{
 const values=new Map(),item={id:'announcement',occurrence:1,title:'Title',message:'<script>alert(1)</script>\nPlain text',button:'Close'};
 let r=runtime(values);r.popup.update(item,'token','device',true);
 assert.equal(r.document.getElementById('workspace-announcement').querySelector('.wa-notice-text').textContent,item.message);
 assert.equal(r.acks[0].action,'announcement-ack');
 r.document.getElementById('workspace-announcement').querySelector('button').onclick();
 r.popup.update(item,'token','device',true);assert.equal(r.document.getElementById('workspace-announcement'),undefined);
 r=runtime(values);r.popup.update(item,'token','device',true);assert.equal(r.document.getElementById('workspace-announcement'),undefined);assert.equal(r.acks.length,1);
 r.popup.update({...item,occurrence:2},'token','device',true);assert.ok(r.document.getElementById('workspace-announcement'));
 r.popup.update(null,'token','device',false);assert.equal(r.document.getElementById('workspace-announcement'),undefined);
});
