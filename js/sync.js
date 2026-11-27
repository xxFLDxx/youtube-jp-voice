// 再生位置と読み上げを合わせる仕組み。
// プレーヤーにも音声の部品にも依存しないので、どちらを差し替えてもそのまま使えます。

const TICK_MS = 100;
const SEEK_THRESHOLD = 0.75;   // 予想位置からこれ以上（秒）ずれたらシークとみなす
const MIN_WINDOW = 0.8;        // 残り時間がこれ未満（実時間・秒）なら読まずに次の文を待つ
const MAX_BOOST = 1.6;         // 持ち時間に収めるための早口の上限（再生速度に対する倍率）
const MAX_RATE = 3.5;

export class SyncEngine {
  constructor({ segments, speech, getTime, getRate, onActiveChange }) {
    this.segments = segments;
    this.speech = speech;
    this.getTime = getTime;
    this.getRate = getRate;
    this.onActiveChange = onActiveChange || (() => {});
    this.voiceOn = true;
    this.playing = false;
    this.activeIdx = -2;     // 字幕で強調中の文
    this.spokenIdx = -1;     // 読み上げを始めた文
    this.lastT = null;
    this.lastNow = 0;
    this.charsPerSec = 6;    // 標準速度で1秒に読める文字数（実測で補正していく）
    this.timer = null;
  }

  start() { this.timer = setInterval(() => this.tick(), TICK_MS); }

  stop() {
    clearInterval(this.timer);
    this.speech.stop();
  }

  // プレーヤーが「再生中」になった／そうでなくなった（一時停止・読み込み待ち・終了）
  setPlaying(playing) {
    if (playing === this.playing) return;
    this.playing = playing;
    this.resync();
    if (playing) this.tick();
  }

  // 再生速度が変わった
  rateChanged() { this.resync(); }

  setVoiceOn(on) {
    this.voiceOn = on;
    this.resync();
  }

  // いったん黙り、次の tick で今の位置の文から読み直す
  resync() {
    this.speech.stop();
    this.spokenIdx = -1;
    this.lastT = null;
  }

  // 時刻 t までに始まっている最後の文（なければ -1）
  indexAt(t) {
    let lo = 0, hi = this.segments.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.segments[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  tick() {
    const t = this.getTime();
    if (typeof t !== 'number' || Number.isNaN(t)) return;
    const idx = this.indexAt(t);
    if (idx !== this.activeIdx) {
      this.activeIdx = idx;
      this.onActiveChange(idx);
    }
    if (!this.playing) return;

    const rate = this.getRate() || 1;
    const now = performance.now();
    let seeked = false;
    if (this.lastT !== null) {
      const expected = this.lastT + ((now - this.lastNow) / 1000) * rate;
      seeked = Math.abs(t - expected) > SEEK_THRESHOLD;
    }
    this.lastT = t;
    this.lastNow = now;

    if (seeked) {
      this.speech.stop();
      this.spokenIdx = -1;
    }
    if (!this.voiceOn || idx < 0 || idx === this.spokenIdx) return;

    const seg = this.segments[idx];
    if (t >= seg.end) return;            // 文と文のすき間。前の発話は最後まで言わせる
    this.spokenIdx = idx;
    this.speakSegment(idx, t, rate);
  }

  speakSegment(idx, t, rate) {
    const seg = this.segments[idx];
    const next = this.segments[idx + 1];
    // 次の文が始まるまでを持ち時間とする（すき間も使える）
    const windowEnd = next ? next.start : seg.end + 2;
    const windowReal = (windowEnd - t) / rate;
    if (windowReal < MIN_WINDOW) return;

    const offset = Math.max(0, t - seg.start);
    let speechRate = rate;
    if (!this.speech.supportsOffset) {
      // 途中から話せない部品は文頭から読むので、持ち時間に収まるよう必要なら早口にする
      const needed = (seg.text.length / this.charsPerSec) / windowReal;
      speechRate = Math.min(Math.max(rate, needed), rate * MAX_BOOST, MAX_RATE);
    }
    const chars = seg.text.length;
    this.speech.speak(seg, {
      rate: speechRate,
      offset,
      onEnd: (elapsed) => {
        // 実際にかかった時間から読み上げ速度の見積もりを補正
        if (this.speech.supportsOffset || elapsed < 0.3 || chars < 5) return;
        const measured = chars / (elapsed * speechRate);
        if (measured > 2 && measured < 20) {
          this.charsPerSec = this.charsPerSec * 0.7 + measured * 0.3;
        }
      },
    });
  }
}
