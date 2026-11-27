import { h } from '../dom.js';
import { parseVideoId } from '../youtube.js';
import { transcriptProvider } from '../config.js';
import { addItem } from '../store.js';

export function renderInput(root) {
  const status = h('p', { class: 'status', role: 'status' });
  const input = h('input', {
    type: 'url', id: 'url', inputmode: 'url', autocomplete: 'off',
    placeholder: 'https://www.youtube.com/watch?v=...',
  });
  const button = h('button', { type: 'submit', class: 'primary' }, '変換する');
  const samples = h('div', { class: 'samples' });

  async function convert(e) {
    e.preventDefault();
    status.className = 'status';
    const videoId = parseVideoId(input.value);
    if (!videoId) {
      status.textContent = 'YouTubeのURLとして読み取れませんでした。動画ページのURLを貼り付けてください。';
      status.classList.add('error');
      return;
    }
    button.disabled = true;
    status.textContent = '変換しています…';
    try {
      const tr = await transcriptProvider.getTranscript(videoId);
      addItem({ videoId, title: tr.title, segmentCount: tr.segments.length });
      location.hash = '#/list';
    } catch (err) {
      status.textContent = err.message || '変換に失敗しました。';
      status.classList.add('error');
    } finally {
      button.disabled = false;
    }
  }

  root.append(
    h('section', { class: 'card' },
      h('h1', {}, '英語の動画を日本語音声で見る'),
      h('form', { onsubmit: convert, novalidate: true },
        h('label', { for: 'url' }, 'YouTubeのURL'),
        h('div', { class: 'row' }, input, button),
      ),
      status,
      samples,
      h('p', { class: 'note' },
        'いまは第1段階（お試し版）です。見本データを用意した動画だけ変換できます。'),
    ),
  );

  transcriptProvider.listAvailable?.().then(list => {
    if (!list.length) return;
    samples.append(
      h('p', {}, '見本の動画:'),
      ...list.map(s => h('button', {
        type: 'button', class: 'link',
        onclick: () => { input.value = `https://www.youtube.com/watch?v=${s.videoId}`; input.focus(); },
      }, s.title)),
    );
  }).catch(() => {});
}
