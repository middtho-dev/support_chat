'use strict';
// Presence means a recently visible chat tab, never that a message was read.
function createCustomerPresence({onChange=()=>{},clock=Date.now,ttlMs=35000}={}) {
  const tickets=new Map();
  function online(id){const tabs=tickets.get(id);return !!tabs&&[...tabs.values()].some(until=>until>clock());}
  function sweep(){
    for(const [id,tabs] of tickets){
      for(const [tab,until] of tabs)if(until<=clock())tabs.delete(tab);
      if(!tabs.size){tickets.delete(id);onChange(id,false);}
    }
  }
  return {
    online,
    report(id,tab,visible){
      if(typeof id!=='string'||typeof tab!=='string'||!/^[A-Za-z0-9-]{8,64}$/.test(tab)||typeof visible!=='boolean')return false;
      sweep();const before=online(id);let tabs=tickets.get(id);
      if(visible){
        if(!tabs){if(tickets.size>=5000)return false;tickets.set(id,tabs=new Map());}
        if(!tabs.has(tab)&&tabs.size>=8)tabs.delete(tabs.keys().next().value);
        tabs.set(tab,clock()+ttlMs);
      }else if(tabs){tabs.delete(tab);if(!tabs.size)tickets.delete(id);}
      const after=online(id);if(before!==after)onChange(id,after);return true;
    },
    sweep
  };
}
module.exports={createCustomerPresence};
