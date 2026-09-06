'use strict';
const fs=require('fs/promises'),os=require('os'),path=require('path'),net=require('net'),crypto=require('crypto');
const {spawn}=require('child_process');
const {ProxyAgent}=require('undici');
const {xrayConfig}=require('./vless');
const delay=ms=>new Promise(r=>setTimeout(r,ms));

class Vpn {
  constructor({port=Number(process.env.VOICE_PROXY_PORT||7501),binary=process.env.XRAY_PATH||'xray',fetcher=fetch}={}) {
    this.port=port;this.binary=binary;this.fetcher=fetcher;this.child=null;this.agent=null;this.key='';this.error='';this.starting=null;this.generation=0;
  }
  status(){return {running:!!this.child&&!!this.agent,error:this.error};}
  async stop(){
    this.generation++;const child=this.child;this.child=null;this.key='';
    if(this.agent){await this.agent.destroy().catch(()=>{});this.agent=null;}
    if(child?.pid&&child.exitCode===null){
      await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),2000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill();});
    }
    if(this.dir){await fs.rm(this.dir,{recursive:true,force:true});this.dir=null;}
  }
  async ensure(config){
    if(!config.vpnEnabled)return;
    if(this.child&&this.agent&&this.key===config.vlessUrl)return;
    if(this.starting){await this.starting;return this.ensure(config);}
    this.starting=this.start(config).finally(()=>{this.starting=null;});return this.starting;
  }
  async start(config){
    await this.stop();const generation=this.generation;
    try{
      // Refuse an occupied listener before starting; authentication also isolates local users.
      await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',()=>reject(Error('Внутренний порт VPN занят')));s.listen(this.port,'127.0.0.1',()=>s.close(resolve));});
      const password=crypto.randomBytes(24).toString('hex');
      this.dir=await fs.mkdtemp(path.join(os.tmpdir(),'voice-vpn-'));
      const file=path.join(this.dir,'config.json');await fs.writeFile(file,JSON.stringify(xrayConfig(config.vlessUrl,this.port,password)),{mode:0o600});
      const child=spawn(this.binary,['run','-config',file],{stdio:'ignore',windowsHide:true});this.child=child;
      let failed=false;
      child.once('error',()=>{failed=true;this.error='Не удалось запустить Xray';});
      child.once('exit',()=>{failed=true;if(this.child===child){this.child=null;this.error='Клиент VPN остановился';}});
      let ready=false;
      for(let i=0;i<40&&!failed;i++){
        ready=await new Promise(resolve=>{const s=net.connect(this.port,'127.0.0.1');s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));s.setTimeout(100,()=>{s.destroy();resolve(false);});});
        if(ready)break;await delay(100);
      }
      if(!ready||failed||generation!==this.generation)throw Error('Xray не запустился: проверьте ссылку и свободный порт');
      this.agent=new ProxyAgent({uri:'http://127.0.0.1:'+this.port,token:'Basic '+Buffer.from('voice:'+password).toString('base64')});
      this.key=config.vlessUrl;this.error='';
    }catch(e){await this.stop();this.error=e.message;throw e;}
  }
  async fetch(url,options,config){
    const host=new URL(url).hostname;
    const routed=config.vpnEnabled&&(host==='api.openai.com'||(config.vpnTelegram&&host==='api.telegram.org'));
    if(!routed)return this.fetcher(url,options);
    await this.ensure(config);
    if(!this.agent)throw Error('VPN недоступен');
    try{return await this.fetcher(url,{...options,dispatcher:this.agent,redirect:'error'});}
    catch{throw Error('Нет соединения через VLESS. Проверьте ссылку и сервер VPN.');}
  }
  async check(config){
    if(!config.vpnEnabled)throw Error('Сохраните ссылку и включите VPN');
    const r=await this.fetch('https://api.openai.com/v1/models',{signal:AbortSignal.timeout(12000)},config);
    await r.body?.cancel();
    if(r.status!==401&&r.status!==200)throw Error('OpenAI через VPN вернул HTTP '+r.status);
    return {ok:true,message:'OpenAI доступен через VLESS; ключ API при проверке не отправлялся'};
  }
}
module.exports={Vpn};
