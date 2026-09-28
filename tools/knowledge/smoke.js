'use strict';
// Exercise installed native bindings and GramJS exports without network or secrets.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {Store}=require('./store'),{Account,inputPeer}=require('./telegram');
const {TelegramClient}=require('telegram'),{StringSession}=require('telegram/sessions');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'knowledge-smoke-'));
let s;
try {
 s=new Store(dir,'a'.repeat(64));const a=new Account(s),events=[];
 a.client={addEventHandler:(handler,event)=>events.push(event)};a.attach();assert.equal(events.length,3);
 const client=new TelegramClient(new StringSession(''),12345,'a'.repeat(32),{connectionRetries:0});
 for(const method of ['sendCode','signInWithPassword','getMessages','iterDialogs','checkAuthorization'])assert.equal(typeof client[method],'function',method);
 assert.equal(inputPeer('{"kind":"channel","id":"123","hash":"456"}').className,'InputPeerChannel');
 console.log('SQLite, Telegram auth methods and event handlers OK');
} finally {s?.db.close();fs.rmSync(dir,{recursive:true,force:true});}
