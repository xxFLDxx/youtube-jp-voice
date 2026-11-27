// 再生位置と読み上げを合わせる仕組み。
// プレーヤーにも音声の部品にも依存しないので、どちらを差し替えてもそのまま使えます。

const TICK_MS = 100;
const SEEK_BACK = 0.5;         // 再生位置がこれ以上（秒）戻ったらシークとみなす
const SEEK_FORWARD = 1.5;      // 進むはずの量よりこれ以上（秒）先へ飛んだらシークとみなす
const MIN_WINDOW = 0.8;        // 再開・シーク直後、残り時間がこれ未満（実時間・秒）なら次の文から読む
const MAX_BOOST = 1.6;         // 遅れを取り戻すための早口の上限（再生速度に対する倍率）
const MAX_RATE = 3.5;
const HOLD_AFTER = 1.0;        // 次の文の開始からこれ以上（動画の秒）声が遅れたら、動画を止めて待つ

// 方針: 読み始めた文は途中で切らず、読み終えてから次の文へ進む。
// 文は飛ばさない。声が遅れた分は、文と文のすき間と上限つきの早口で取り戻し、
// それでも遅れるときは、読み終わるまで動画のほうを一時的に止めて待つ。
// 途中で止めるのは、一時停止・シーク・読み上げOFFのときだけ。
// 読み込み待ち（バッファリング）や再生位置の通知の遅れでは止めない。

export class SyncEngine {
  constructor({ segments, speech, getTime, getRate, onActiveChange, onVoiceStop, holdVideo, releaseVideo, onHoldChange }) {
    this.segments = segments;
    this.speech = speech;
    this.getTime = getTime;
    this.getRate = getRate;
    this.onActiveChange = onActiveChange || (() => {});
    this.onVoiceStop = onVoiceStop || (() => {});   // 声を途中で止めたとき（理由つき・診断用）
    this.holdVideo = holdVideo || (() => {});         // 動画を一時的に止める
    this.releaseVideo = releaseVideo || (() => {});   // 止めた動画を再開する
    this.onHoldChange = onHoldChange || (() => {});
    this.holding = false;    // 声を待つために動画を止めている最中か
    this.holdEndedAt = 0;
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

  // プレーヤーが「再生中」になった／そうでなくなった。
  // ここでは声を止めない（読み込み待ちで一瞬止まっただけでも文を切らないため）。
  // 再生中でない間は、新しい文を読み始めないだけ。
  setPlaying(playing) {
    if (playing === this.playing) return;
    this.playing = playing;
    if (playing) this.tick();
  }

  // 利用者が一時停止した（または動画が終わった）: すぐ黙り、再開時は今の位置の文から
  pause() {
    this.playing = false;
    this.endHold(false);     // 利用者が止めたので、動画は再開しない
    this.resync('一時停止');
  }

  // 声待ちの停止を終える。resume = true なら動画を再開する
  endHold(resume) {
    if (!this.holding) return;
    this.holding = false;
    this.holdEndedAt = performance.now();
    this.onHoldChange(false);
    if (resume) this.releaseVideo();
  }

  // プレーヤーから「一時停止」の通知が来たとき、それが声待ちによるものか
  // （止めた直後・再開した直後に遅れて届く通知も含めて判定する）
  isHoldPause() {
    return this.holding || performance.now() - this.holdEndedAt < 500;
  }

  // 再生速度が変わった: 読み上げ中の文はそのまま読み終え、次の文から新しい速度にする
  rateChanged() {}

  setVoiceOn(on) {
    if (on === this.voiceOn) return;
    this.voiceOn = on;
    this.resync('読み上げOFF');
  }

  // いったん黙り、次の tick で今の位置の文から読み直す
  resync(reason) {
    if (this.speaking) this.onVoiceStop(reason);
    this.speech.stop();
    this.speakSeq++;
    this.speaking = false;
    this.nextIdx = null;
    this.endHold(this.playing);
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
    // シーク検知。再生位置の値が「変わった」ときだけ、前に変わった時点と比べる。
    // （位置の通知が少し止まってからまとめて進むことがあり、それをシークと誤認しないため）
    const rate = this.getRate() || 1;
    const now = performance.now();
    if (this.lastT === null) {
      this.lastT = t;
      this.lastNow = now;
    } else if (t !== this.lastT) {
      const jump = t - this.lastT;
      const allowed = ((now - this.lastNow) / 1000) * rate + SEEK_FORWARD;
      this.lastT = t;
      this.lastNow = now;
      if (jump < -SEEK_BACK || jump > allowed) this.resync('シーク');
    }
    if (!this.playing) return;
    if (!this.voiceOn) return;

    // 読み上げ中は切らない（通知が来ないブラウザ不具合に備えて期限だけ見る）
    if (this.speaking) {
      if (now < this.speakDeadline || this.speech.isSpeaking?.()) {
        // 次の文の時刻を過ぎても読み終わらないときは、動画を止めて声を待つ
        const n = this.nextIdx;
        if (!this.holding && n !== null && n < this.segments.length
            && t >= this.segments[n].start + HOLD_AFTER) {
          this.holding = true;
          this.onHoldChange(true);
          this.holdVideo();
        }
        return;
      }
      this.speaking = false;
    }
    this.endHold(true);

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
        this.endHold(true);   // 声が追いついたので動画を再開
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
