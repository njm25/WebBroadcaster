// One call that upgrades the page's native form controls to the shared,
// standardized versions — for every control present now and added later:
//   <select>                → custom dropdown (src/lib/select.ts)
//   <input type=checkbox>   → toggle switch (styled in styles/global.css; here it
//                             just gets role="switch" for screen readers)
//   title="…" tooltips      → custom tooltip (src/lib/tooltip.ts)

import { autoEnhanceSelects } from './select';
import { installTooltips } from './tooltip';

function markSwitch(el: Element) {
  if (el instanceof HTMLInputElement && el.type === 'checkbox' && !el.hasAttribute('role')) {
    el.setAttribute('role', 'switch');
  }
}

export function autoEnhanceControls(root: ParentNode = document.body) {
  installTooltips();
  autoEnhanceSelects(root);
  root.querySelectorAll('input[type=checkbox]').forEach(markSwitch);
  new MutationObserver((records) => {
    for (const rec of records) {
      rec.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        markSwitch(n);
        n.querySelectorAll('input[type=checkbox]').forEach(markSwitch);
      });
    }
  }).observe(root, { childList: true, subtree: true });
}
