/**
 * "Your client": one config block chosen from a list, instead of a block
 * per client on the page. The choices are the bare URL (the default, which
 * works with any client) and each client whose file shape ./client-config.ts
 * knows. The choice is kept in this browser's localStorage, so every page
 * with a picker opens on the client a person last chose there; without
 * script, or with storage blocked, the page shows the URL.
 *
 * The page supplies the copy buttons' script (./html.ts copyScript) and
 * includes pickerScript once, whatever number of pickers it has.
 */

import { CLIENTS, clientConfig, type ServerEntry } from './client-config';
import { escapeHtml as esc } from './escape';

/** Where the choice is remembered, for every page of the deployment. */
export const PICKER_STORAGE_KEY = 'c9e-client';

/** The default choice: the URL alone. */
export const JUST_THE_URL = 'url';

export interface PickerOptions {
  /**
   * What "Just the URL" shows, as HTML. Defaults to each entry's URL with a
   * copy button; a page that already lists its URLs with copy buttons says
   * so instead.
   */
  urlPanel?: string;
  /** A line under each client's block, as HTML (e.g. what else to add). */
  footnote?: string;
}

/**
 * The picker for `entries`: a select, then one panel per choice with the
 * block in that client's format and its copy button. Only the default
 * panel is shown until the script runs.
 */
export function configPicker(
  entries: readonly ServerEntry[],
  opts: PickerOptions = {}
): string {
  const options = [
    `<option value=${JUST_THE_URL}>Just the URL (works with any client)</option>`,
    ...CLIENTS.map(
      (c) => `<option value="${esc(c.kind)}">${esc(c.label)}</option>`
    )
  ].join('');
  const urls =
    opts.urlPanel ??
    `<ul class=urls>${entries
      .map(
        (e) =>
          `<li><code>${esc(e.url)}</code> <button class=copy data-copy-text="${esc(e.url)}">copy URL</button></li>`
      )
      .join('')}</ul>`;
  const panels = CLIENTS.map((c) => {
    const text = clientConfig(c.kind, entries);
    // Goose's merge line already names its file.
    const where = c.merge.includes(c.where) ? '' : `${c.where}. `;
    return (
      `<div data-pick="${esc(c.kind)}" hidden>` +
      `<p class=muted>${esc(where + c.merge)} ` +
      `<button class=copy data-copy-text="${esc(text)}">copy</button></p>` +
      `<pre>${esc(text)}</pre>${opts.footnote ?? ''}</div>`
    );
  }).join('');
  return (
    `<div class=picker><label>Your client <select data-picker aria-label="Your client">${options}</select></label> ` +
    `<span class=muted>Remembered in this browser.</span>` +
    `<div data-pick=${JUST_THE_URL}>${urls}</div>${panels}</div>`
  );
}

/**
 * Shows the chosen panel of every picker on the page and remembers the
 * choice. A stored choice the page does not offer is ignored.
 */
export const pickerScript = `<script>
(function(){
  var KEY=${JSON.stringify(PICKER_STORAGE_KEY)};
  function show(sel){
    var box=sel.closest('.picker');
    [].forEach.call(box.querySelectorAll('[data-pick]'),function(p){
      p.hidden=p.getAttribute('data-pick')!==sel.value;
    });
  }
  [].forEach.call(document.querySelectorAll('select[data-picker]'),function(sel){
    var saved=null;
    try{saved=localStorage.getItem(KEY);}catch(e){}
    for(var i=0;i<sel.options.length;i++){
      if(sel.options[i].value===saved){sel.value=saved;break;}
    }
    show(sel);
    sel.addEventListener('change',function(){
      show(sel);
      try{localStorage.setItem(KEY,sel.value);}catch(e){}
    });
  });
})();
</script>`;
