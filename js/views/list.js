import { h } from '../dom.js';
import { listItems, removeItem } from '../store.js';
import { thumbnailUrl } from '../youtube.js';
import { deleteVideo } from '../db.js';

const VOICE_LABEL = { google: '声: Google Chirp 3 HD', browser: '声: ブラウザ読み上げ', sample: '見本データ' };

export function renderList(root) {
  const items = listItems();
  const section = h('section', {}, h('h1', {}, '変換一覧'));

  // 変換直後のお知らせ（1回だけ表示）
  const flash = sessionStorage.getItem('ytjp.flash');
  if (flash) {
    sessionStorage.removeItem('ytjp.flash');
    section.append(h('p', { class: 'flash', role: 'status' }, flash));
  }

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
              `日本語 ${item.segmentCount} 文 ・ ${VOICE_LABEL[item.voice] || VOICE_LABEL.sample} ・ ${new Date(item.addedAt).toLocaleDateString('ja-JP')}`),
            item.status === 'partial' && h('span', { class: 'video-sub warn' }, '音声の作成が途中です（今はブラウザ読み上げで再生されます）'),
          ),
        ),
        h('span', { class: 'item-actions' },
          item.status === 'partial' && h('a', { class: 'button', href: `#/resume/${item.videoId}` }, '続きから再開'),
          h('button', {
            type: 'button', class: 'danger', 'aria-label': `${item.title} を削除`,
            onclick: async () => {
              if (!confirm(`「${item.title}」を一覧から削除しますか？\n保存した翻訳と音声も消えます。`)) return;
              removeItem(item.videoId);
              await deleteVideo(item.videoId).catch(() => {});
              root.replaceChildren();
              renderList(root);
            },
          }, '削除'),
        ),
      ))));
  }
  root.append(section);
}
