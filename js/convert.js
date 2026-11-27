// 変換の流れ: 文字起こし → 翻訳（Claude）→ 音声の事前作成（Google）→ ブラウザ内に保存。
// 途中の状態を毎回保存するので、失敗・中断しても続きから再開できます。
import * as db from './db.js';
import { CHUNK_CHARS, MODEL } from './providers/translate-claude.js';
import { audioDuration } from './providers/tts-google.js';
import { addItem } from './store.js';

const TTS_PARALLEL = 3;

// 翻訳結果を、再生に使える形に整える（時刻順・重なりなし・空文なし）
export function normalizeSegments(segments) {
  const list = segments
    .map(s => ({ start: Number(s.start), end: Number(s.end), text: String(s.text || '').trim() }))
    .filter(s => s.text && Number.isFinite(s.start))
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < list.length; i++) {
    const next = list[i + 1];
    if (next && next.start <= list[i].start) next.start = list[i].start + 0.5;
    if (!(list[i].end > list[i].start)) list[i].end = list[i].start + 3;
    if (next && list[i].end > next.start) list[i].end = next.start;
  }
  return list;
}

// from 番目の行から、文字数の目安に収まる分だけ取り出す
function takeChunk(cues, from) {
  let chars = 0, to = from;
  while (to < cues.length && (to === from || chars + cues[to].text.length <= CHUNK_CHARS)) {
    chars += cues[to].text.length;
    to++;
  }
  return to;
}

function sameSource(job, rawText) {
  return job && job.rawText === rawText;
}

// 変換を実行する。translator は必須、tts は null でもよい（その場合は翻訳だけ）。
// onProgress({ phase: 'translate' | 'tts' | 'done', done, total, waitSec })
//   waitSec: Googleの1分あたりの上限に当たって待っている場合の残り秒数（待っていなければ 0）
export async function runConversion({ videoId, title, rawText, cues, voice }, { translator, tts, onProgress = () => {}, signal }) {
  navigator.storage?.persist?.().catch(() => {});   // 保存したデータを、ブラウザに勝手に消されにくくする
  let job = await db.getJob(videoId);
  if (!sameSource(job, rawText)) {
    // 新しい文字起こしでの変換: 前の結果は消してやり直す
    await db.deleteVideo(videoId);
    job = {
      videoId, title, rawText, cues,
      nextCue: 0, rawSegments: [], translateDone: false,
      segments: null, voice,
      usage: { inputTokens: 0, outputTokens: 0, ttsChars: 0 },
    };
    await db.putJob(job);
  }
  job.title = title || job.title;
  const saveItem = (status, voiceKind) => addItem({
    videoId, title: job.title, segmentCount: job.segments?.length ?? 0, status, voice: voiceKind,
  });

  // --- 1. 翻訳 ---
  while (!job.translateDone) {
    signal?.throwIfAborted();
    onProgress({ phase: 'translate', done: job.nextCue, total: job.cues.length });
    const from = job.nextCue;
    const to = takeChunk(job.cues, from);
    const isLast = to >= job.cues.length;
    const lastCue = job.cues[job.cues.length - 1];
    const chunkEnd = isLast ? lastCue.t + Math.max(3, Math.ceil(lastCue.text.length / 15)) : job.cues[to].t;

    const result = await translator.translateChunk({
      cues: job.cues.slice(from, to),
      chunkEnd,
      isLast,
      previousLines: job.rawSegments.slice(-3).map(s => s.text),
    }, { signal });

    // 途中で切れた文は次の回に回す（ただし必ず前へ進むようにする）
    let next = to;
    let accepted = result.segments;
    if (!isLast && result.incompleteFrom !== null) {
      const carry = job.cues.findIndex((c, i) => i > from && i < to && c.t >= result.incompleteFrom);
      if (carry > from) {
        next = carry;
        accepted = accepted.filter(s => s.start < job.cues[carry].t);
      }
    }
    job.rawSegments.push(...accepted);
    job.nextCue = next;
    job.translateDone = isLast;
    job.usage.inputTokens += result.usage.inputTokens;
    job.usage.outputTokens += result.usage.outputTokens;
    await db.putJob(job);
  }
  onProgress({ phase: 'translate', done: job.cues.length, total: job.cues.length });

  if (!job.segments) {
    job.segments = normalizeSegments(job.rawSegments);
    if (!job.segments.length) throw new Error('翻訳結果が空でした。文字起こしの内容を確認してください。');
    await db.putJob(job);
  }
  const record = () => ({
    videoId, title: job.title, segments: job.segments,
    source: 'claude', model: MODEL, voice: tts ? job.voice : null, usage: job.usage,
  });
  // 翻訳が済んだ時点で再生できるようにしておく（声はブラウザ読み上げ）
  await db.putTranscript(record());
  saveItem(tts ? 'partial' : 'done', 'browser');

  // --- 2. 音声の事前作成 ---
  if (tts) {
    const total = job.segments.length;
    let done = 0;
    let cursor = 0;
    // 並行して動かす処理のどれかが失敗・中断したら、残りもすぐ止める
    // （裏で動き続けると、「続きから再開」したときに同じ文を二重に作ってしまうため）
    const stopAll = new AbortController();
    const onOuterAbort = () => stopAll.abort(signal.reason);
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    if (signal?.aborted) onOuterAbort();
    let firstError = null;

    const worker = async () => {
      while (cursor < total) {
        const i = cursor++;
        stopAll.signal.throwIfAborted();
        const seg = job.segments[i];
        if (!(await db.getAudio(videoId, i))) {
          const blob = await tts.synthesize(seg.text, job.voice, {
            signal: stopAll.signal,
            onWait: (waitSec) => onProgress({ phase: 'tts', done, total, waitSec }),
          });
          const dur = await audioDuration(blob);
          if (dur) seg.audioDur = dur;
          await db.putAudio(videoId, i, blob);
          job.usage.ttsChars += seg.text.length;
        }
        done++;
        onProgress({ phase: 'tts', done, total });
      }
    };
    const guarded = () => worker().catch((err) => {
      if (!firstError) firstError = err;
      stopAll.abort(err);
    });
    onProgress({ phase: 'tts', done: 0, total });
    try {
      // 全員が止まるのを待ってから、できた分を保存する
      await Promise.all(Array.from({ length: Math.min(TTS_PARALLEL, total) }, guarded));
    } finally {
      signal?.removeEventListener('abort', onOuterAbort);
      // 中断・失敗しても、できた分（音声の長さ・使用量）は残す
      await db.putJob(job);
      await db.putTranscript(record());
    }
    if (firstError) throw firstError;
    saveItem('done', 'google');
  }

  await db.deleteJob(videoId);
  onProgress({ phase: 'done', done: 1, total: 1 });
  return { segments: job.segments, usage: job.usage, voice: tts ? 'google' : 'browser' };
}
