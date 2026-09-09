(function(){'use strict';
window.createWorkspacePlayback=function(options){
 var session=Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,14),busy=false,last=0;
 var data={session:session,state:'idle',title:'',source:'',hash:'',method:'unknown',position:null,duration:null,buffer:null,error:''};
 function number(n){return typeof n==='number'&&isFinite(n)&&n>=0&&n<=604800?Math.round(n*10)/10:null;}
 function video(){try{return Lampa.PlayerVideo&&Lampa.PlayerVideo.video();}catch(e){return null;}}
 function sample(){
  var v=video();if(!v||data.state==='idle'||data.state==='ended')return;
  data.position=number(v.currentTime);data.duration=number(v.duration);data.buffer=null;
  try{for(var i=0;v.buffered&&i<v.buffered.length;i++)if(v.buffered.start(i)<=v.currentTime&&v.buffered.end(i)>=v.currentTime){data.buffer=number(v.buffered.end(i)-v.currentTime);break;}}catch(e){}
  if(v.tagName==='VIDEO'&&data.method==='unknown')data.method='browser';
  else if(!v.tagName&&data.method==='unknown')data.method='native';
 }
 function send(){
  var token=options.token();if(!token||busy||Date.now()-last<2500)return;
  sample();busy=true;last=Date.now();
  try{options.request('heartbeat',{token:token,playback:data},function(status,result){busy=false;if(status===200&&result.enabled===false)options.access(false);});}catch(e){busy=false;}
 }
 function start(item){
  item=item||{};data.state='loading';data.error='';data.position=null;data.duration=null;data.buffer=null;
  var title=String(item.title||(item.card&&(item.card.title||item.card.name))||'');
  data.title=/https?:\/\/|[?&](token|password|key)=/i.test(title)?'':title.replace(/[\x00-\x1f]/g,' ').slice(0,200);
  data.hash=/^[a-f0-9]{40}$/i.test(item.torrent_hash||'')?item.torrent_hash.toLowerCase():'';
  data.source='';data.method='unknown';
  try{var link=document.createElement('a');link.href=item.url||'';if(/^https?:$/.test(link.protocol)&&item.url){data.source=link.hostname.slice(0,253);data.method=/\.m3u8(?:$|\?)/i.test(item.url)?'browser-hls':'unknown';}}catch(e){}
  send();
 }
 function state(value){data.state=value;send();}
 function bindVideo(){var v=video();if(!v||!v.addEventListener||v.workspacePlaybackBound)return;v.workspacePlaybackBound=true;
  ['waiting','playing'].forEach(function(event){v.addEventListener(event,function(){if(video()===v&&data.state!=='ended')state(event==='waiting'?'buffering':'playing');});});
 }

 if(Lampa.Player&&Lampa.Player.listener){Lampa.Player.listener.follow('start',start);Lampa.Player.listener.follow('ready',bindVideo);Lampa.Player.listener.follow('destroy',function(){state('ended');});}
 if(Lampa.PlayerVideo&&Lampa.PlayerVideo.listener){
  var events=Lampa.PlayerVideo.listener;
  events.follow('playing',function(){state('playing');});events.follow('play',function(){state('playing');});
  events.follow('pause',function(){state('paused');});events.follow('waiting',function(){state('buffering');});
  events.follow('ended',function(){state('ended');});
  events.follow('timeupdate',function(){var v=video();if(v&&!v.paused&&data.state!=='idle'&&data.state!=='ended')data.state='playing';send();});
  events.follow('error',function(){var v=video(),code=v&&v.error&&v.error.code;data.error=({1:'aborted',2:'network',3:'decode',4:'unsupported'})[code]||'player';state('error');});
 }
 document.addEventListener('visibilitychange',send);
 window.addEventListener('pageshow',send);
 window.addEventListener('online',send);
 // The timer is independent of settings discovery and continues in the player.
 setInterval(send,10000);
 try{if(Lampa.Player&&Lampa.Player.opened()&&Lampa.Player.playdata()){start(Lampa.Player.playdata());bindVideo();}}catch(e){}
 return {send:send};
};
})();
