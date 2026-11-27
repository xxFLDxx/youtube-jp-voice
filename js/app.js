// 画面の切り替え（#/ = URL入力、#/list = 変換一覧、#/watch/動画ID = 再生、
// #/settings = 設定、#/resume/動画ID = 変換の続き）
import { renderInput } from './views/input.js';
import { renderList } from './views/list.js';
import { renderWatch } from './views/watch.js';
import { renderSettings } from './views/settings.js';

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
  else if (name === 'settings') { nav = 'settings'; renderSettings(root); }
  else if (name === 'resume' && arg) cleanup = renderInput(root, { resumeId: decodeURIComponent(arg) });
  else cleanup = renderInput(root);

  document.querySelectorAll('[data-nav]').forEach(a =>
    a.toggleAttribute('aria-current', a.dataset.nav === nav));
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();
