// 音声の部品（第1段階）: ブラウザの読み上げ機能（Web Speech API）。
// 第2段階では、同じ3つの操作を持つ音声合成の部品に差し替えます。
//
//   unlock()                      利用者のタップ直後に呼ぶ（スマホの制限解除）
//   speak(segment, options)       文を話す（前の発話が残っていれば打ち切る。
//                                 通常は同期側が読み終わりを待ってから呼ぶ）
//       options.rate    話す速さ（1 = 標準）
//       options.offset  文の先頭から何秒目から話すか（ブラウザ読み上げは未対応で無視。
//                       音声ファイルを再生する部品なら途中から再生できる）
//       options.onEnd   話し終えたとき（失敗時も）必ず onEnd(かかった秒数) を呼ぶ
//   stop()                        すぐ黙る

export function createBrowserSpeechProvider() {
  const synth = window.speechSynthesis;
  let token = 0;      // 古い発話のコールバックを無視するための番号
  let timer = null;
  let voice = null;

  function pickVoice() {
    if (!synth) return;
    const ja = synth.getVoices().filter(v => (v.lang || '').replace('_', '-').toLowerCase().startsWith('ja'));
    voice = ja.find(v => v.localService) || ja[0] || null;
  }
  if (synth) {
    pickVoice();
    synth.addEventListener?.('voiceschanged', pickVoice);
  }

  return {
    name: 'ブラウザ読み上げ',
    available: !!synth,
    supportsOffset: false,
    hasJapaneseVoice: () => { pickVoice(); return !!voice; },

    unlock() {
      if (!synth) return;
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      synth.speak(u);
    },

    speak(segment, { rate = 1, onEnd } = {}) {
      if (!synth) return;
      const my = ++token;
      clearTimeout(timer);
      synth.cancel();
      // cancel 直後の speak を取りこぼすブラウザがあるため、わずかに待つ
      timer = setTimeout(() => {
        if (my !== token) return;
        const u = new SpeechSynthesisUtterance(segment.text);
        u.lang = 'ja-JP';
        if (voice) u.voice = voice;
        u.rate = rate;
        const t0 = performance.now();
        const done = () => { if (my === token) onEnd?.((performance.now() - t0) / 1000); };
        u.onend = done;
        u.onerror = done;
        synth.speak(u);
      }, 60);
    },

    stop() {
      ++token;
      clearTimeout(timer);
      synth?.cancel();
    },
  };
}
