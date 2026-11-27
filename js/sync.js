// 再生位置と読み上げを合わせる仕組み。
// プレーヤーにも音声の部品にも依存しないので、どちらを差し替えてもそのまま使えます。

const TICK_MS = 100;
const SEEK_THRESHOLD = 0.75;   // 予想位置からこれ以上（秒）ずれたらシークとみなす
const MIN_WINDOW = 0.8;        // 再開・シーク直後、残り時間がこれ未満（実時間・秒）なら次の文から読む
const MAX_BOOST = 1.6;         // 遅れを取り戻すための早口の上限（再生速度に対する倍率）
const MAX_RATE = 3.5;
const MAX_LAG_SEGMENTS = 2;    // 声がこの文数以上遅れたら、間の文を飛ばして今の文に追いつく

// 方針: 読み始めた文は途中で切らず、読み終えてから次の文へ進む。
// 声が遅れた分は、文と文のすき間と、上限つきの早口で取り戻す。
// 途中で止めるのは、一時停止・シーク・読み上げOFFのときだけ。

export class SyncEngine {
  constructor({ segments, speech, getTime, getRate, onActiveChange }) {
    this.segments = segments;
    this.speech = speech;
    this.getTime = getTime;
    this.getRate = getRate;
    this.onActiveChange = onActiveChange || (() => {});
    this.voiceOn = true;
    this.playing = false;
    this.activeIdx = -2;     // 字幕で強調中の文（動画の位置に従う）
    this.nextIdx = null;     // 次に読む文（null = 今の位置から決め直す）
    this.speaking = false;   // 読み上げ中か
    this.speakDeadline = 0;  // 読み終わりの通知が来ない場合の保険
    this.speakSeq = 0;
    this.lastT = null;
    this.lastNow = 0;
    this.charsPerSec = 4.5;  // 標準速度で1秒に読める文字数（実測で補正していく）
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

  // 再生速度が変わった: 読み上げ中の文はそのまま読み終え、次の文から新しい速度にする
  rateChanged() {}

  setVoiceOn(on) {
    this.voiceOn = on;
    this.resync();
  }

  // いったん黙り、次の tick で今の位置の文から読み直す
  resync() {
    this.speech.stop();
    this.speakSeq++;
    this.speaking = false;
    this.nextIdx = null;
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
      this.speakSeq++;
      this.speaking = false;
      this.nextIdx = null;
    }
    if (!this.voiceOn) return;

    // 読み上げ中は切らない（通知が来ないブラウザ不具合に備えて期限だけ見る）
    if (this.speaking) {
      if (now < this.speakDeadline) return;
      this.speaking = false;
    }

    const segs = this.segments;
    if (this.nextIdx === null) {
      // 再生開始・再開・シーク直後: 今の位置の文から。残りがわずかなら次の文から
      if (idx < 0) this.nextIdx = 0;
      else {
        const windowEnd = segs[idx + 1] ? segs[idx + 1].start : segs[idx].end;
        const tooLate = t >= segs[idx].end || (windowEnd - t) / rate < MIN_WINDOW;
        this.nextIdx = tooLate ? idx + 1 : idx;
      }
    }
    // 遅れすぎたら間の文を飛ばして追いつく
    if (idx - this.nextIdx >= MAX_LAG_SEGMENTS) this.nextIdx = idx;

    const i = this.nextIdx;
    if (i >= segs.length || t < segs[i].start) return;   // 次の文の開始待ち
    this.nextIdx = i + 1;
    this.speakSegment(i, t, rate);
  }

  speakSegment(idx, t, rate) {
    const seg = this.segments[idx];
    const next = this.segments[idx + 1];
    // 次の文が始まるまでを持ち時間とする（すき間も使える）。遅れているほど短くなる
    const windowEnd = next ? next.start : seg.end + 2;
    const windowReal = Math.max((windowEnd - t) / rate, 0.01);
    const chars = seg.text.length;
    const est = chars / this.charsPerSec;          // 標準速度での所要秒数の見積もり

    const offset = Math.max(0, t - seg.start);
    let speechRate = rate;
    if (!this.speech.supportsOffset) {
      // 持ち時間に収まらない／遅れているときは、上限つきで早口にする
      speechRate = Math.min(Math.max(rate, est / windowReal), rate * MAX_BOOST, MAX_RATE);
    }
    const seq = ++this.speakSeq;
    this.speaking = true;
    this.speakDeadline = performance.now() + (est / speechRate) * 3000 + 5000;
    this.speech.speak(seg, {
      rate: speechRate,
      offset,
      onEnd: (elapsed) => {
        if (seq !== this.speakSeq) return;
        this.speaking = false;
        // 実際にかかった時間から読み上げ速度の見積もりを補正
        if (!this.speech.supportsOffset && elapsed >= 0.3 && chars >= 5) {
          const measured = chars / (elapsed * speechRate);
          if (measured > 2 && measured < 20) {
            this.charsPerSec = this.charsPerSec * 0.5 + measured * 0.5;
          }
        }
        this.tick();     // 待っている次の文があればすぐ読む
      },
    });
  }
}
