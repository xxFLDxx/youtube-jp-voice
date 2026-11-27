import { h, formatTime } from '../dom.js';
import { loadYouTubeApi } from '../youtube.js';
import { getTranscript, createSpeechFor, browserSpeech } from '../config.js';
import { getItem, updateItem } from '../store.js';
import { getTranscript as getSaved, putTranscript } from '../db.js';
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
  let speech = browserSpeech;   // 読み込み後、保存済みの音声があればそちらに替わる

  const title = h('h1', { class: 'watch-title' }, getItem(videoId)?.title || '読み込み中…');
  const playerHost = h('div', { id: 'player' });
  const current = h('p', { class: 'current-sub', 'aria-live': 'off' }, '');
  const status = h('p', { class: 'status', role: 'status' });
  const list = h('ol', { class: 'sub-list' });
  const diag = h('p', { class: 'note diag' });   // 声を途中で止めた理由（原因調査用）
  const voiceInfo = h('p', { class: 'note' });

  const playBtn = h('button', { type: 'button', class: 'primary', disabled: true }, '▶ 再生');
  const speedSel = h('select', { id: 'speed', disabled: true },
    SPEEDS.map(s => h('option', { value: s, selected: s === 1 }, `${s}倍`)));
  const voiceChk = h('input', { type: 'checkbox', id: 'voice', checked: true });

  const isPlaying = () => ready && player.getPlayerState() === window.YT.PlayerState.PLAYING;

  playBtn.addEventListener('click', () => {
    if (!ready) return;
    speech.unlock();           // タップ直後に呼ぶことでスマホの読み上げ制限を解除
    if (engine?.holding) {             // 声待ちで動画が止まっている最中に押された → 本当に一時停止
      engine.pause();
      playBtn.textContent = '▶ 再生';
      return;
    }
    if (isPlaying()) player.pauseVideo(); else player.playVideo();
  });
  speedSel.addEventListener('change', () => ready && player.setPlaybackRate(Number(speedSel.value)));
  voiceChk.addEventListener('change', () => {
    if (voiceChk.checked) speech.unlock();
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
      voiceInfo,
      diag,
    ),
    h('aside', { class: 'watch-side' },
      h('h2', {}, '日本語字幕'),
      list,
    ),
  ));

  // 名前を付けずに変換した動画は、YouTubeの題名を一覧の名前にする
  async function adoptVideoTitle() {
    const real = player.getVideoData?.()?.title;
    if (!real || title.textContent !== `動画 ${videoId}`) return;
    title.textContent = real;
    updateItem(videoId, { title: real });
    const saved = await getSaved(videoId).catch(() => null);
    if (saved) putTranscript({ ...saved, title: real }).catch(() => {});
  }

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
        getTranscript(videoId),
        loadYouTubeApi(),
      ]);
      const chosen = await createSpeechFor(transcript);
      if (disposed) return chosen.speech.dispose?.();
      speech = chosen.speech;
      voiceInfo.textContent = `声: ${chosen.label}`;
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
            speech.unlock();
            player.seekTo(seg.start, true);
            player.playVideo();
          },
        }, h('span', { class: 'time' }, formatTime(seg.start)), h('span', {}, seg.text))));
    });

    if (!speech.available) {
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
            speech,
            getTime: () => player.getCurrentTime(),
            getRate: () => player.getPlaybackRate(),
            onActiveChange,
            holdVideo: () => player.pauseVideo(),
            releaseVideo: () => player.playVideo(),
            onHoldChange: (holding) => {
              if (status.classList.contains('error')) return;
              status.textContent = holding ? '声が追いつくまで、動画を少し止めています…' : '';
            },
            onVoiceStop: (reason) => {
              diag.textContent = `最後に声を途中で止めた理由: ${reason}（動画の ${formatTime(player.getCurrentTime())} 付近）`;
            },
          });
          engine.setVoiceOn(voiceChk.checked);
          engine.start();
          playBtn.disabled = false;
          speedSel.disabled = false;
          adoptVideoTitle();
        },
        onStateChange: (e) => {
          const playing = e.data === YT.PlayerState.PLAYING;
          const buffering = e.data === YT.PlayerState.BUFFERING;
          // 声待ちでアプリ自身が動画を止めたときの通知は、一時停止として扱わない
          if (e.data === YT.PlayerState.PAUSED && engine?.isHoldPause()) return;
          // 読み込み待ちは「再生中の一時的な足踏み」として扱い、声は止めない
          if (!buffering) playBtn.textContent = playing ? '一時停止' : '▶ 再生';
          if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) engine?.pause();
          else engine?.setPlaying(playing);
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
    speech.stop();
    speech.dispose?.();
    try { player?.destroy(); } catch { /* 破棄済み */ }
  };
}
