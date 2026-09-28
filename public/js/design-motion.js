/* Decorative tracking for dynamically replaced module tabs. */
(() => {
 let frame = 0;
 function update() {
  frame = 0;
  document.querySelectorAll('.support-nav').forEach(nav => {
   const active = nav.querySelector('button.on');
   if (nav.hidden || !active || !nav.getClientRects().length) { nav.removeAttribute('data-tracking'); return; }
   const parent=nav.getBoundingClientRect(), rect=active.getBoundingClientRect();
   const values={left:rect.left-parent.left+nav.scrollLeft,top:rect.top-parent.top+nav.scrollTop,width:rect.width,height:rect.height};
   Object.entries(values).forEach(([key,value])=>nav.style.setProperty('--nav-'+key,value+'px'));
   nav.dataset.tracking='';
  });
 }
 function schedule(){if(!frame)frame=requestAnimationFrame(update);}
 new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden']});
 new ResizeObserver(schedule).observe(document.body);
 window.addEventListener('resize',schedule,{passive:true});
 schedule();
})();
