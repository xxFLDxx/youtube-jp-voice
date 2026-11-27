// 画面の切り替え（#/ = URL入力、#/list = 変換一覧、#/watch/動画ID = 再生）
import { renderInput } from './views/input.js';
import { renderList } from './views/list.js';
import { renderWatch } from './views/watch.js';

const root = document.getElementById('view');
let cleanup = null;

function route() {
  cleanup?.();
  cleanup = null;
  root.replaceChildren();

  const hash = location.hash.replace(/^#\/?/, '');
  const [name, arg] = hash.split('/');
  let nav = 'input';
  if (name === 'list') { nav = 'list'; renderList(root); }
  else if (name === 'watch' && arg) { nav = 'list'; cleanup = renderWatch(root, decodeURIComponent(arg)); }
  else renderInput(root);

  document.querySelectorAll('[data-nav]').forEach(a =>
    a.toggleAttribute('aria-current', a.dataset.nav === nav));
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();
