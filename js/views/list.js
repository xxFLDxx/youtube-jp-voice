import { h } from '../dom.js';
import { listItems, removeItem } from '../store.js';
import { thumbnailUrl } from '../youtube.js';
import { deleteVideo } from '../db.js';
import { exportVideo, download, readHeader, importVideo, formatSize } from '../transfer.js';

const VOICE_LABEL = { google: '声: Google Chirp 3 HD', browser: '声: ブラウザ読み上げ', sample: '見本データ' };

export function renderList(root) {
  const items = listItems();
  const section = h('section', {}, h('h1', {}, '変換一覧'));
  const rerender = () => { root.replaceChildren(); renderList(root); };

  // ほかの端末で書き出したファイルの読み込み
  const transferStatus = h('p', { class: 'status', role: 'status' });
  const say = (msg, error) => { transferStatus.textContent = msg; transferStatus.className = error ? 'status error' : 'status'; };
  // accept を付けないのは、スマホのファイル選択画面で .ytjp が選べなくなるのを避けるため
  const fileInput = h('input', { type: 'file', id: 'import-file', class: 'visually-hidden' });
  const importBtn = h('button', { type: 'button', onclick: () => fileInput.click() }, 'ファイルを読み込む');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    importBtn.disabled = true;
    try {
      say('ファイルを確認しています…');
      const header = await readHeader(file);
      if (listItems().some(i => i.videoId === header.videoId)
          && !confirm(`「${header.title}」はすでに一覧にあります。読み込んだ内容で置き換えますか？`)) {
        return say('読み込みをやめました。');
      }
      await importVideo(file, header, (done, total) => say(`読み込んでいます… 音声 ${done} / ${total}`));
      sessionStorage.setItem('ytjp.flash',
        `「${header.title}」を読み込みました（${header.segments.length} 文、音声 ${header.audio.length} 件、${formatSize(file.size)}）。`);
      rerender();
    } catch (err) {
      say(err.message || '読み込みに失敗しました。', true);
    } finally {
      importBtn.disabled = false;
    }
  });
  section.append(h('div', { class: 'transfer-bar' },
    importBtn, fileInput,
    h('span', { class: 'note' }, '別の端末で「書き出す」したファイル（.ytjp）を読み込めます。'),
  ), transferStatus);

  async function exportItem(item, btn) {
    btn.disabled = true;
    try {
      say('書き出すファイルを作っています…');
      const { blob, filename, audioCount } = await exportVideo(item.videoId);
      download(blob, filename);
      say(`「${filename}」を書き出しました（${formatSize(blob.size)}、音声 ${audioCount} 件）。ダウンロードフォルダに保存されます。`);
    } catch (err) {
      say(err.message || '書き出しに失敗しました。', true);
    } finally {
      btn.disabled = false;
    }
  }

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
          item.voice !== 'sample' && h('button', {
            type: 'button', 'aria-label': `${item.title} を書き出す`,
            onclick: (e) => exportItem(item, e.currentTarget),
          }, '書き出す'),
          h('button', {
            type: 'button', class: 'danger', 'aria-label': `${item.title} を削除`,
            onclick: async () => {
              if (!confirm(`「${item.title}」を一覧から削除しますか？\n保存した翻訳と音声も消えます。`)) return;
              removeItem(item.videoId);
              await deleteVideo(item.videoId).catch(() => {});
              rerender();
            },
          }, '削除'),
        ),
      ))));
  }
  root.append(section);
}
