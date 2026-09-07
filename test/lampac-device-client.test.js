'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
test('device plugin applies scoped preferences and ignores replies after local disconnect',()=>{
  const script=fs.readFileSync(path.join(__dirname,'../tools/lampac/device-client.js'),'utf8');
  const values=new Map([['workspace_device_access',{token:'device-token',applied:0}]]),buttons={},requests=[];
  const storage={get:(k,f)=>values.get(k)??f,set:(k,v)=>values.set(k,v),remove:k=>values.delete(k)};
  class XHR{open(method,url){this.url=url;}setRequestHeader(){}send(body){this.body=JSON.parse(body);requests.push(this);}}
  const context={XMLHttpRequest:XHR,Lampa:{Storage:storage,SettingsApi:{addComponent(){},addParam(p){buttons[p.param.name]=p.onChange;}},Noty:{show(){}}},setInterval(){},setTimeout(){},location:{reload(){}}};context.window=context;
  vm.runInNewContext(script.replace('DEVICE_CONFIG',JSON.stringify({url:'https://lc.example.org',fields:{internal_torrclient:['true','false']}})),context);
  assert.equal(requests[0].body.token,'device-token');
  requests[0].status=200;requests[0].responseText=JSON.stringify({paired:true,revision:1,values:{internal_torrclient:'true',account:'bad'},reload:false});requests[0].onload();
  assert.equal(values.get('internal_torrclient'),'true');assert.equal(values.has('account'),false);
  assert.equal(values.get('workspace_device_access').applied,1);
  buttons.workspace_forget();
  requests[0].responseText=JSON.stringify({paired:true,revision:2,values:{internal_torrclient:'false'},reload:false});requests[0].onload();
  assert.equal(values.has('workspace_device_access'),false);assert.equal(values.get('internal_torrclient'),'true');
});
