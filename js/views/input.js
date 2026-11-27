import { h } from '../dom.js';
import { parseVideoId } from '../youtube.js';
import { sampleProvider, createTranslator, createTts } from '../config.js';
import { addItem } from '../store.js';
import { getSettings } from '../settings.js';
import { parseTranscript, summarize } from '../transcript-parse.js';
import { estimate, usdRange, usd, actualClaudeUsd, PRICES } from '../estimate.js';
import { runConversion } from '../convert.js';
import { describeClaudeError } from '../providers/translate-claude.js';
import { describeGoogleError } from '../providers/tts-google.js';
import * as db from '../db.js';

const PHASE_LABEL = { translate: '翻訳しています', tts: '音声を作っています' };

// 戻り値: 画面を離れるときの後片付け関数
export function renderInput(root, { resumeId } = {}) {
  let controller = null;   // 変換中の中断用
  let phase = 'translate';

  const status = h('p', { class: 'status', role: 'status' });
  const urlInput = h('input', {
    type: 'url', id: 'url', inputmode: 'url', autocomplete: 'off',
    placeholder: 'https://www.youtube.com/watch?v=...',
  });
  const titleInput = h('input', { type: 'text', id: 'title', autocomplete: 'off', placeholder: '（空欄でもかまいません）' });
  const textArea = h('textarea', {
    id: 'transcript', rows: 8, spellcheck: 'false',
    placeholder: '0:00\nhello everyone\n0:03\nwelcome back to the channel\n…',
  });
  const estimateBox = h('div', { class: 'estimate', hidden: true });
  const button = h('button', { type: 'submit', class: 'primary' }, '変換する');
  const samples = h('div', { class: 'samples' });

  const progressLabel = h('p', { class: 'progress-label' });
  const progressBar = h('progress', { max: 1, value: 0 });
  const cancelBtn = h('button', { type: 'button', onclick: () => controller?.abort() }, '中断する');
  const progressBox = h('div', { class: 'progress-box', hidden: true }, progressLabel, progressBar, cancelBtn);

  const say = (msg, error) => { status.textContent = msg; status.className = error ? 'status error' : 'status'; };

  function showEstimate() {
    const cues = parseTranscript(textArea.value);
    estimateBox.hidden = !textArea.value.trim();
    if (estimateBox.hidden) return;
    if (!cues.length) {
      estimateBox.replaceChildren(h('p', { class: 'error-text' },
        '時刻つきの行を読み取れませんでした。「0:00」のような時刻が入った文字起こしを貼り付けてください。'));
      return;
    }
    const sum = summarize(cues);
    const est = estimate(sum.chars);
    const { claudeKey, googleKey } = getSettings();
    estimateBox.replaceChildren(
      h('p', {}, h('strong', {}, '読み取り結果: '),
        `${sum.lines} 行・英語 ${sum.chars.toLocaleString()} 文字・動画の長さ 約 ${Math.max(1, Math.round(sum.durationSec / 60))} 分`),
      h('p', {}, h('strong', {}, '料金の目安: ')),
      h('ul', {},
        h('li', {}, `翻訳（Claude）: ${usdRange(est.claudeUsd)}`, claudeKey ? '' : '　※鍵が未設定'),
        h('li', {}, `音声（Google）: 日本語 約 ${est.jaChars[0].toLocaleString()}〜${est.jaChars[1].toLocaleString()} 文字。`,
          `月${(PRICES.ttsFreeCharsPerMonth / 10000).toLocaleString()}万文字の無料枠内なら0ドル、超えた分は${usdRange(est.ttsUsd)}`,
          googleKey ? '' : '　※鍵が未設定のため、ブラウザの読み上げを使います（0ドル）'),
      ),
      h('p', { class: 'note' }, '目安であり、実際の料金は前後します。正確な額は各サービスの請求画面で確認してください。'),
    );
  }
  // ブックマークレットでコピーした文章の先頭にある「URL:」「TITLE:」の行から、URLと名前を自動で入れる
  function adoptHeader() {
    const url = textArea.value.match(/^URL:\s*(\S+)/m);
    const title = textArea.value.match(/^TITLE:\s*(.+)$/m);
    if (url && parseVideoId(url[1]) && !urlInput.value.trim()) urlInput.value = url[1];
    if (title && !titleInput.value.trim()) titleInput.value = title[1].trim();
  }
  textArea.addEventListener('input', () => { adoptHeader(); showEstimate(); });

  // ブックマークレット（YouTubeの動画ページで押すと文字起こしをコピーするブックマーク）
  const bmLink = h('a', {
    class: 'button bookmarklet', href: '#', draggable: 'true',
    onclick: (e) => { e.preventDefault(); bmStatus.textContent = 'ここでは押さずに、ブックマークバーへドラッグしてください。'; },
  }, '文字起こしコピー');
  const bmStatus = h('span', { class: 'note', role: 'status' });
  const bmCopy = h('button', { type: 'button', disabled: true }, 'コードをコピー');
  fetch('bookmarklet/transcript-copy.js').then(r => r.ok ? r.text() : Promise.reject()).then(src => {
    const code = 'javascript:' + encodeURIComponent(src);
    bmLink.setAttribute('href', code);
    bmCopy.disabled = false;
    bmCopy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); bmStatus.textContent = 'コードをコピーしました。ブックマークのURL欄に貼り付けてください。'; }
      catch { bmStatus.textContent = 'コピーできませんでした。'; }
    });
  }).catch(() => { bmStatus.textContent = 'ブックマークレットを読み込めませんでした。'; });

  function setBusy(busy) {
    button.disabled = busy;
    urlInput.disabled = titleInput.disabled = textArea.disabled = busy;
    progressBox.hidden = !busy;
  }

  async function convertWithApis(videoId, { skipConfirm } = {}) {
    const rawText = textArea.value;
    const cues = parseTranscript(rawText);
    if (!cues.length) return say('時刻つきの行を読み取れませんでした。文字起こしを貼り付け直してください。', true);
    const translator = createTranslator();
    if (!translator) return say('翻訳にはClaudeの鍵が必要です。上の「設定」から鍵を保存してください。', true);
    const tts = createTts();

    if (!skipConfirm) {
      const est = estimate(summarize(cues).chars);
      const ok = confirm([
        '変換を始めます。料金の目安:',
        `・翻訳（Claude）: ${usdRange(est.claudeUsd)}`,
        tts ? `・音声（Google）: 無料枠内なら0ドル、超えた分は${usdRange(est.ttsUsd)}`
            : '・音声: Googleの鍵が未設定のため、ブラウザの読み上げを使います（0ドル）',
        '', 'よろしいですか？',
      ].join('\n'));
      if (!ok) return;
    }

    controller = new AbortController();
    setBusy(true);
    say('');
    try {
      const result = await runConversion({
        videoId,
        title: titleInput.value.trim() || `動画 ${videoId}`,
        rawText, cues,
        voice: getSettings().voice,
      }, {
        translator, tts, signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === 'done') return;
          phase = p.phase;
          progressBar.max = Math.max(1, p.total);
          progressBar.value = p.done;
          const unit = p.phase === 'tts' ? '文' : '行';
          progressLabel.textContent = `${PHASE_LABEL[p.phase]}… ${p.done} / ${p.total} ${unit}`;
        },
      });
      const cost = actualClaudeUsd(result.usage);
      sessionStorage.setItem('ytjp.flash',
        `変換が終わりました（${result.segments.length} 文）。今回の利用: 翻訳 ${usd(cost)}、音声 ${result.usage.ttsChars.toLocaleString()} 文字。`);
      location.hash = '#/list';
    } catch (err) {
      if (controller.signal.aborted) {
        say('中断しました。同じ文字起こしのままもう一度「変換する」を押すと、続きから再開します。');
      } else {
        const msg = phase === 'tts' ? describeGoogleError(err) : describeClaudeError(err);
        say(`${msg} できた分は保存してあります。同じ文字起こしのまま「変換する」を押すと、続きから再開します。`, true);
      }
    } finally {
      controller = null;
      setBusy(false);
    }
  }

  async function convertSample(videoId) {
    button.disabled = true;
    say('変換しています…');
    try {
      const tr = await sampleProvider.getTranscript(videoId);
      addItem({ videoId, title: tr.title, segmentCount: tr.segments.length, status: 'done', voice: 'sample' });
      location.hash = '#/list';
    } catch {
      say('文字起こしの欄が空です。YouTubeの文字起こしを貼り付けてください（空のままで変換できるのは、見本データのある動画だけです）。', true);
    } finally {
      button.disabled = false;
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    const videoId = parseVideoId(urlInput.value);
    if (!videoId) return say('YouTubeのURLとして読み取れませんでした。動画ページのURLを貼り付けてください。', true);
    if (textArea.value.trim()) convertWithApis(videoId);
    else convertSample(videoId);
  }

  root.append(
    h('section', { class: 'card' },
      h('h1', {}, '英語の動画を日本語音声で見る'),
      h('form', { onsubmit: onSubmit, novalidate: true, class: 'stack' },
        h('div', {},
          h('label', { for: 'url' }, '1. YouTubeのURL'),
          h('div', { class: 'row' }, urlInput),
        ),
        h('div', {},
          h('label', { for: 'title' }, '2. 一覧に出す名前（任意）'),
          h('div', { class: 'row' }, titleInput),
        ),
        h('div', {},
          h('label', { for: 'transcript' }, '3. 英語の文字起こし（時刻つき）'),
          textArea,
          h('details', { class: 'note', id: 'bookmarklet-help' },
            h('summary', {}, 'ワンクリックでコピーする（ブックマークレット・パソコン向け）'),
            h('p', {}, '最初に1回だけ登録: 下の青いボタンを、ブラウザのブックマークバーへドラッグします',
              '（バーが出ていないときは Ctrl+Shift+B、Mac は ⌘+Shift+B）。'),
            h('p', { class: 'row gap' }, bmLink, bmCopy),
            h('p', {}, bmStatus),
            h('p', {}, '使い方: YouTubeで動画のページを開く → 登録した「文字起こしコピー」を押す → 「コピーしました」と出たら、この欄に貼り付ける。',
              'URLと名前も自動で入ります。'),
          ),
          h('details', { class: 'note' },
            h('summary', {}, '手でコピーするしかた'),
            h('ol', {},
              h('li', {}, 'YouTubeで動画のページを開く'),
              h('li', {}, '動画の説明欄を開き、下のほうにある「文字起こしを表示」を押す'),
              h('li', {}, '右側（スマホは下）に出た文字起こしの、最初の行から最後の行までをドラッグして選び、コピーする'),
              h('li', {}, 'この欄に貼り付ける'),
            ),
          ),
        ),
        estimateBox,
        h('div', {}, button),
      ),
      progressBox,
      status,
      samples,
      h('p', { class: 'note' },
        'このアプリは動画や音声をダウンロードしません。文字起こしは、ご自身でコピーして貼り付けたものだけを使います。'),
    ),
  );

  sampleProvider.listAvailable?.().then(list => {
    if (!list.length) return;
    samples.append(
      h('p', {}, '鍵なしで試せる見本の動画（文字起こしの欄は空のまま「変換する」）:'),
      ...list.map(s => h('button', {
        type: 'button', class: 'link',
        onclick: () => { urlInput.value = `https://www.youtube.com/watch?v=${s.videoId}`; urlInput.focus(); },
      }, s.title)),
    );
  }).catch(() => {});

  // 変換一覧の「続きから再開」から来たとき
  if (resumeId) {
    db.getJob(resumeId).then(job => {
      if (!job) return say('再開できる変換が見つかりませんでした。', true);
      urlInput.value = `https://www.youtube.com/watch?v=${resumeId}`;
      titleInput.value = job.title || '';
      textArea.value = job.rawText;
      showEstimate();
      convertWithApis(resumeId, { skipConfirm: true });
    });
  }

  return () => controller?.abort();
}
