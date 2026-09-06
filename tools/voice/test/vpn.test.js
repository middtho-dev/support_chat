'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {parseVless,xrayConfig}=require('../vless'),{Vpn}=require('../vpn'),{Store}=require('../store'),{validate}=require('../config');
const base='vless://11111111-1111-4111-8111-111111111111@example.com:443';
const link=base+'?security=tls&type=ws&host=cdn.example.com&path=%2Fvoice#Example';

test('VLESS preserves transport settings and rejects unsupported or insecure links',()=>{
 const v=parseVless(link);assert.equal(v.streamSettings.wsSettings.path,'/voice');assert.equal(v.streamSettings.wsSettings.headers.Host,'cdn.example.com');
 const reality=parseVless(base+'?security=reality&type=tcp&pbk='+'a'.repeat(43)+'&sid=abcd&flow=xtls-rprx-vision');assert.equal(reality.streamSettings.realitySettings.shortId,'abcd');
 assert.equal(parseVless(base+'?security=tls&type=grpc&serviceName=voice&mode=multi').streamSettings.grpcSettings.multiMode,true);
 assert.equal(parseVless(base+'?security=tls&type=xhttp&mode=stream-one').streamSettings.xhttpSettings.mode,'stream-one');
 for(const suffix of ['?security=none','?security=tls&type=kcp','?security=tls&extra=unknown','?security=tls&allowInsecure=1'])assert.throws(()=>parseVless(base+suffix));
 const c=xrayConfig(link,7501,'test');assert.equal(c.inbounds[0].listen,'127.0.0.1');assert.equal(c.inbounds[0].settings.accounts[0].pass,'test');assert.equal(c.outbounds[0].protocol,'blackhole');
});

test('VLESS credentials survive encrypted migration and remain absent from API status',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vpn-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir,'a'.repeat(64));store.data.config=validate({vlessUrl:link,vpnEnabled:true},store.data.config);store.save();
 assert.ok(!fs.readFileSync(store.file,'utf8').includes('example.com'));
 assert.equal(store.status().hasVlessUrl,true);assert.equal(store.status().config.vlessUrl,undefined);
 assert.equal(new Store(dir,'a'.repeat(64)).data.config.vlessUrl,link);
 assert.equal(validate({vlessUrl:''},store.data.config).vlessUrl,link);
});

test('VPN routes selected requests and never falls back to a direct request',async()=>{
 const calls=[];const vpn=new Vpn({fetcher:async(url,options)=>{calls.push({url,options});return new Response('',{status:401});}});
 vpn.ensure=async()=>{vpn.agent={test:true};};const config={vpnEnabled:true,vpnTelegram:false,vlessUrl:link};
 await vpn.fetch('https://api.openai.com/v1/models',{},config);assert.equal(calls[0].options.dispatcher,vpn.agent);
 await vpn.fetch('https://api.telegram.org/',{},config);assert.equal(calls[1].options.dispatcher,undefined);
 await vpn.fetch('https://api.telegram.org/',{},{...config,vpnTelegram:true});assert.equal(calls[2].options.dispatcher,vpn.agent);
 vpn.ensure=async()=>{throw Error('offline');};await assert.rejects(vpn.fetch('https://api.openai.com/',{},config));assert.equal(calls.length,3);
 await vpn.fetch('https://api.openai.com/',{},{...config,vpnEnabled:false});assert.equal(calls[3].options.dispatcher,undefined);
});

test('a missing Xray executable fails cleanly without hanging or leaving a proxy',async()=>{
 const vpn=new Vpn({port:0,binary:'nonexistent-xray-test-executable'});
 await assert.rejects(vpn.ensure({vpnEnabled:true,vlessUrl:link}));assert.equal(vpn.status().running,false);await vpn.stop();
});
