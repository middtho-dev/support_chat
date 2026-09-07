'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
test('device plugin resumes old paused installations and exposes information without local controls',()=>{
  const script=fs.readFileSync(path.join(__dirname,'../tools/lampac/device-client.js'),'utf8');
  const values=new Map([['workspace_device_access',{token:'device-token',applied:0,paused:true}]]),buttons={},requests=[];
  const storage={get:(k,f)=>values.get(k)??f,set:(k,v)=>values.set(k,v),remove:k=>values.delete(k)};
  class XHR{open(method,url){this.url=url;}setRequestHeader(){}send(body){this.body=JSON.parse(body);requests.push(this);}}
  const context={document:{getElementById(){return null;}},XMLHttpRequest:XHR,Lampa:{Storage:storage,SettingsApi:{addComponent(){},addParam(p){buttons[p.param.name]=p.onChange;}},Noty:{show(){}}},setInterval(){},setTimeout(){},location:{reload(){}}};context.window=context;
  vm.runInNewContext(script.replace('DEVICE_CONFIG',JSON.stringify({url:'https://lc.example.org',fields:{internal_torrclient:['true','false']}})),context);
  assert.equal(requests[0].body.token,'device-token');
  requests[0].status=200;requests[0].responseText=JSON.stringify({paired:true,revision:1,values:{internal_torrclient:'true',account:'bad'},reload:false});requests[0].onload();
  assert.equal(values.get('internal_torrclient'),'true');assert.equal(values.has('account'),false);
  assert.equal(values.get('workspace_device_access').applied,1);
  assert.equal(values.get('workspace_device_access').paused,undefined);
  assert.equal('workspace_forget' in buttons,false);assert.equal('workspace_pair' in buttons,false);
  assert.equal(buttons.workspace_info,undefined);
});
test('new installations enroll automatically and retain their ID and credential',()=>{
  const script=fs.readFileSync(path.join(__dirname,'../tools/lampac/device-client.js'),'utf8');
  const values=new Map(),requests=[];const storage={get:(k,f)=>values.get(k)??f,set:(k,v)=>values.set(k,v)};
  class XHR{open(method,url){this.url=url;}setRequestHeader(){}send(body){this.body=JSON.parse(body);requests.push(this);}}
  const context={document:{cookie:'',getElementById(){return null;}},XMLHttpRequest:XHR,Lampa:{Storage:storage,SettingsApi:{addComponent(){},addParam(){}},Noty:{show(){}}},setInterval(){},setTimeout(){},location:{origin:'https://lc.example.org'}};context.window=context;
  vm.runInNewContext(script.replace('DEVICE_CONFIG',JSON.stringify({url:'https://lc.example.org',fields:{}})),context);
  assert.equal(requests[0].url,'https://lc.example.org/workspace-device/enroll');
  requests[0].status=200;requests[0].responseText=JSON.stringify({token:'scoped-token',id:'stable-id',paired:true});requests[0].onload();
  assert.equal(values.get('workspace_device_access').id,'stable-id');
  assert.equal(requests[1].body.token,'scoped-token');
  assert.match(context.document.cookie,/workspace_device=scoped-token;.*Secure/);
});
