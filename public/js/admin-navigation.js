'use strict';
// Keep module controls in their owning panel; the rail delegates to those controls.
(() => {
  const main = document.getElementById('main');
  const mobile = matchMedia('(max-width:560px)');
  mobile.addEventListener('change', () => schedule());
  const selectors = { lampac: '.lc-tabs', voice: '.voice-tabs', settings: '.management-tabs', frp: '.frp-tabs' };
  let scheduled = false;
  function sync() {
    scheduled = false;
    for (const id of ['lampac', 'voice', 'settings', 'frp']) {
      const panel = document.getElementById(id);
      let nav = document.getElementById(id + '-subnav');
      if (!nav) {
        nav = document.createElement('nav'); nav.id = id + '-subnav';
        nav.className = 'support-nav module-subnav';
        nav.setAttribute('aria-label', 'Разделы: ' + document.querySelector(`.navbtn[data-view="${id}"]`).textContent.trim());
        document.querySelector(`.navbtn[data-view="${id}"]`).after(nav);
      }
      const active = !!S.token && panel.classList.contains('on') && !(id === 'settings' && document.body.classList.contains('support-active'));
      nav.hidden = !active;
      if (!active) continue;
      const source = panel.querySelector(selectors[id] || '.frp-wrap');
      if (!source) { nav.hidden = true; nav.replaceChildren(); delete nav.dataset.signature; continue; }
      if (!source.classList.contains('module-nav-source')) source.classList.add('module-nav-source');
      const entries = [...source.querySelectorAll('button')].map(button => [button.textContent, button]);
      const signature = entries.map(([label, node]) => label + ':' + node.classList.contains('on') + ':' + node.getAttribute('aria-pressed') + ':' + node.disabled).join('|');
      if (nav.dataset.signature === signature && nav._source === source) continue;
      nav.dataset.signature = signature; nav._source = source;
      nav.replaceChildren(...entries.map(([label, node]) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.disabled = !!node.disabled;
        const selected = node.classList.contains('on') || node.getAttribute('aria-pressed') === 'true';
        button.classList.toggle('on', selected); button.setAttribute('aria-current', selected ? 'page' : 'false');
        button.onclick = () => {
          node.click();
          schedule();
        };
        return button;
      }));
      nav.querySelector('.on')?.scrollIntoView({block: 'nearest', inline: 'nearest'});
    }
    for (const nav of document.querySelectorAll('.support-nav')) {
      const id = nav.id === 'support-nav' ? 'chat' : nav.id.replace('-subnav', '');
      const parent = mobile.matches ? document.body : document.querySelector('.rail');
      if (nav.parentElement !== parent) {
        if (mobile.matches) parent.append(nav);
        else document.querySelector(`.navbtn[data-view="${id}"]`).after(nav);
      }
    }
    document.body.classList.toggle('module-subnav-active', !!document.querySelector('.module-subnav:not([hidden]) button'));
    main.querySelectorAll('.panel details').forEach(details => {
      const summary = details.querySelector(':scope > summary');
      if (!summary || details.closest('#frp-mobile-devices') || details.matches('.lc-record,.lc-info,.lc-compose')) return;
      const fields = details.querySelectorAll('input:not([type=search]):not([type=hidden]),select,textarea');
      if (!fields.length) return;
      let count = summary.querySelector(':scope > .summary-count');
      if (!count) {
        count = summary.querySelector(':scope > small');
        if (count && !/^\d+$/.test(count.textContent.trim())) count = null;
        if (!count) { count = document.createElement('small'); summary.append(count); }
        count.classList.add('summary-count');
      }
      // Lampa rows contain separate inheritance and value controls for one setting.
      const rows = details.querySelectorAll('[data-key]');
      const value = String(rows.length || fields.length);
      if (count.textContent !== value) count.textContent = value;
      count.title = 'Параметров: ' + value;
      if (!summary.classList.contains('counted-summary')) summary.classList.add('counted-summary');
    });
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(sync); } }
  new MutationObserver(schedule).observe(main, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-pressed', 'disabled'] });
  new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  schedule();
})();
