import { h } from '../dom.js';
import { listItems, removeItem } from '../store.js';
import { thumbnailUrl } from '../youtube.js';

export function renderList(root) {
  const items = listItems();
  const section = h('section', {}, h('h1', {}, '変換一覧'));

  if (!items.length) {
    section.append(h('div', { class: 'card empty' },
      h('p', {}, 'まだ変換した動画がありません。'),
      h('a', { class: 'button primary', href: '#/' }, 'URLを入力する'),
    ));
  } else {
    section.append(h('ul', { class: 'video-list' }, items.map(item =>
      h('li', { class: 'video-item' },
        h('a', { class: 'video-link', href: `#/watch/${item.videoId}` },
          h('img', { src: thumbnailUrl(item.videoId), alt: '', loading: 'lazy', width: 160, height: 90 }),
          h('span', { class: 'video-meta' },
            h('span', { class: 'video-title' }, item.title),
            h('span', { class: 'video-sub' },
              `日本語 ${item.segmentCount} 文 ・ ${new Date(item.addedAt).toLocaleDateString('ja-JP')}`),
          ),
        ),
        h('button', {
          type: 'button', class: 'danger', 'aria-label': `${item.title} を削除`,
          onclick: () => {
            if (!confirm(`「${item.title}」を一覧から削除しますか？`)) return;
            removeItem(item.videoId);
            root.replaceChildren();
            renderList(root);
          },
        }, '削除'),
      ))));
  }
  root.append(section);
}
