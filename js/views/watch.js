import { h, formatTime } from '../dom.js';
import { loadYouTubeApi } from '../youtube.js';
import { transcriptProvider, speechProvider } from '../config.js';
import { getItem } from '../store.js';
import { SyncEngine } from '../sync.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const YT_ERRORS = {
  2: '動画のURLが正しくないようです。',
  5: 'この動画はこのブラウザで再生できません。',
  100: '動画が見つかりません（削除または非公開）。',
  101: 'この動画は埋め込み再生が許可されていません。',
  150: 'この動画は埋め込み再生が許可されていません。',
};

// 戻り値: 画面を離れるときの後片付け関数
export function renderWatch(root, videoId) {
  let player = null, engine = null, disposed = false, ready = false;

  const title = h('h1', { class: 'watch-title' }, getItem(videoId)?.title || '読み込み中…');
  const playerHost = h('div', { id: 'player' });
  const current = h('p', { class: 'current-sub', 'aria-live': 'off' }, '');
  const status = h('p', { class: 'status', role: 'status' });
  const list = h('ol', { class: 'sub-list' });

  const playBtn = h('button', { type: 'button', class: 'primary', disabled: true }, '▶ 再生');
  const speedSel = h('select', { id: 'speed', disabled: true },
    SPEEDS.map(s => h('option', { value: s, selected: s === 1 }, `${s}倍`)));
  const voiceChk = h('input', { type: 'checkbox', id: 'voice', checked: true });

  const isPlaying = () => ready && player.getPlayerState() === window.YT.PlayerState.PLAYING;

  playBtn.addEventListener('click', () => {
    if (!ready) return;
    speechProvider.unlock();           // タップ直後に呼ぶことでスマホの読み上げ制限を解除
    if (isPlaying()) player.pauseVideo(); else player.playVideo();
  });
  speedSel.addEventListener('change', () => ready && player.setPlaybackRate(Number(speedSel.value)));
  voiceChk.addEventListener('change', () => {
    if (voiceChk.checked) speechProvider.unlock();
    engine?.setVoiceOn(voiceChk.checked);
  });

  root.append(h('section', { class: 'watch' },
    h('div', { class: 'watch-main' },
      h('div', { class: 'player-frame' }, playerHost),
      current,
      h('div', { class: 'controls' },
        playBtn,
        h('label', { for: 'speed' }, '速度 ', speedSel),
        h('label', { class: 'check', for: 'voice' }, voiceChk, ' 日本語で読み上げる'),
      ),
      status,
      title,
      h('p', { class: 'note' },
        '声が出ないときは、動画の中ではなく上の「再生」ボタンを押してください。'),
    ),
    h('aside', { class: 'watch-side' },
      h('h2', {}, '日本語字幕'),
      list,
    ),
  ));

  function showError(msg) {
    status.textContent = msg;
    status.className = 'status error';
  }

  function onActiveChange(idx) {
    list.querySelector('.active')?.classList.remove('active');
    const li = idx >= 0 ? list.children[idx] : null;
    current.textContent = li ? engine.segments[idx].text : '';
    if (li) {
      li.classList.add('active');
      // 字幕欄の中だけをスクロール（ページ全体は動かさない）
      list.scrollTo({ top: li.offsetTop - list.offsetTop - list.clientHeight / 3, behavior: 'smooth' });
    }
  }

  (async () => {
    let transcript, YT;
    try {
      [transcript, YT] = await Promise.all([
        transcriptProvider.getTranscript(videoId),
        loadYouTubeApi(),
      ]);
    } catch (err) {
      return showError(err.message || '読み込みに失敗しました。');
    }
    if (disposed) return;

    title.textContent = transcript.title;
    transcript.segments.forEach((seg) => {
      list.append(h('li', {},
        h('button', {
          type: 'button',
          onclick: () => {
            if (!ready) return;
            speechProvider.unlock();
            player.seekTo(seg.start, true);
            player.playVideo();
          },
        }, h('span', { class: 'time' }, formatTime(seg.start)), h('span', {}, seg.text))));
    });

    if (!speechProvider.available) {
      showError('このブラウザは読み上げ機能に対応していません。字幕のみ表示します。');
    }

    player = new YT.Player(playerHost, {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: { playsinline: 1, mute: 1, rel: 0, cc_load_policy: 0 },
      events: {
        onReady: () => {
          if (disposed) return;
          ready = true;
          player.mute();               // 元の音声は流さない
          engine = new SyncEngine({
            segments: transcript.segments,
            speech: speechProvider,
            getTime: () => player.getCurrentTime(),
            getRate: () => player.getPlaybackRate(),
            onActiveChange,
          });
          engine.setVoiceOn(voiceChk.checked);
          engine.start();
          playBtn.disabled = false;
          speedSel.disabled = false;
        },
        onStateChange: (e) => {
          const playing = e.data === YT.PlayerState.PLAYING;
          playBtn.textContent = playing ? '一時停止' : '▶ 再生';
          engine?.setPlaying(playing);
        },
        onPlaybackRateChange: (e) => {
          speedSel.value = String(e.data);
          engine?.rateChanged();
        },
        onError: (e) => showError(YT_ERRORS[e.data] || '動画を再生できませんでした。'),
      },
    });
  })();

  return () => {
    disposed = true;
    engine?.stop();
    speechProvider.stop();
    try { player?.destroy(); } catch { /* 破棄済み */ }
  };
}
