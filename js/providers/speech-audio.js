// 音声の部品（第2段階）: 変換時に作ってブラウザ内に保存した音声を再生する。
// 操作は speech-browser.js と同じ形（speak / stop / unlock / isSpeaking）。
// 音声がまだ無い文は、fallback（ブラウザ読み上げ）で読みます。
import { getAudio } from '../db.js';

// 無音の短いWAV。スマホで「利用者のタップ直後に一度再生する」ための音
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

export function createStoredAudioSpeechProvider({ videoId, segments, fallback }) {
  const audio = new Audio();
  audio.preload = 'auto';
  const urls = new Map();     // 文番号 → 再生用URL（無ければ null）
  let token = 0;
  let state = 'idle';         // 'idle' | 'loading' | 'audio' | 'fallback'
  let unlocked = false;

  async function urlFor(i) {
    if (i < 0 || i >= segments.length) return null;
    if (!urls.has(i)) {
      const blob = await getAudio(videoId, i).catch(() => null);
      urls.set(i, blob ? URL.createObjectURL(blob) : null);
    }
    return urls.get(i);
  }

  return {
    name: '保存済みの音声',
    available: true,
    supportsOffset: true,     // 文の途中から再生できる
    maxBoost: 1.25,           // 自然な声なので、早回しは控えめにする
    durationOf: (seg) => seg.audioDur,   // 標準速度での長さ（秒）。不明なら undefined

    unlock() {
      fallback.unlock();
      if (unlocked || state !== 'idle') return;
      unlocked = true;
      audio.src = SILENT;
      audio.play().then(() => { if (state === 'idle') audio.pause(); }).catch(() => { unlocked = false; });
    },

    speak(segment, { rate = 1, offset = 0, onEnd } = {}) {
      const my = ++token;
      const i = segments.indexOf(segment);
      audio.pause();
      fallback.stop();
      state = 'loading';
      const t0 = performance.now();
      const done = () => {
        if (my !== token) return;
        state = 'idle';
        onEnd?.((performance.now() - t0) / 1000);
      };

      urlFor(i).then((url) => {
        if (my !== token) return;
        if (!url) {
          state = 'fallback';
          fallback.speak(segment, { rate, onEnd: done });
          return;
        }
        if (segment.audioDur && offset >= segment.audioDur - 0.15) return done();   // もう言い終えている位置
        state = 'audio';
        audio.onended = done;
        audio.onerror = done;
        audio.src = url;
        audio.defaultPlaybackRate = rate;
        audio.playbackRate = rate;
        if (offset > 0) audio.currentTime = offset;
        audio.play().catch((err) => { if (err.name !== 'AbortError') done(); });
        urlFor(i + 1);          // 次の文を先に読み込んでおく
      });
    },

    stop() {
      ++token;
      state = 'idle';
      audio.pause();
      fallback.stop();
    },

    isSpeaking() {
      if (state === 'loading') return true;
      if (state === 'audio') return !audio.paused && !audio.ended;
      if (state === 'fallback') return !!fallback.isSpeaking?.();
      return false;
    },

    dispose() {
      this.stop();
      for (const url of urls.values()) if (url) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}
