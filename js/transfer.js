// 変換結果（翻訳と音声）を1つのファイルに書き出す／読み込む。
// 別の端末（例: 自宅PC → スマホ）へ持っていくための機能です。鍵や利用料金の情報はファイルに入れません。
//
// ファイルの形（拡張子 .ytjp）:
//   [目印 "YTJP1\n" 6バイト][見出しの長さ 4バイト][見出し(JSON)][音声データを順に連結]
//   見出し: { format, videoId, title, voice, segments:[{start,end,text,audioDur?}], audio:[{i, size, type}] }
import * as db from './db.js';
import { addItem } from './store.js';

const MAGIC = 'YTJP1\n';
const MAX_HEADER = 20 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function formatSize(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 戻り値: { blob, filename, audioCount }
export async function exportVideo(videoId) {
  const rec = await db.getTranscript(videoId);
  if (!rec) throw new Error('この動画には、書き出せる変換結果がありません。');
  const blobs = [];
  const audio = [];
  for (let i = 0; i < rec.segments.length; i++) {
    const blob = await db.getAudio(videoId, i);
    if (!blob) continue;
    audio.push({ i, size: blob.size, type: blob.type || 'audio/mpeg' });
    blobs.push(blob);
  }
  const header = new TextEncoder().encode(JSON.stringify({
    format: 1, videoId, title: rec.title, voice: rec.voice || null, segments: rec.segments, audio,
  }));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, header.length, true);
  return {
    blob: new Blob([MAGIC, length, header, ...blobs], { type: 'application/octet-stream' }),
    // ファイル名は英数字だけにする（日本語の名前だと、環境によって名前が付かないことがあるため）。
    // 動画の名前はファイルの中に入っているので、読み込むと元の名前で一覧に出る
    filename: `ytjp-${videoId}.ytjp`,
    audioCount: audio.length,
  };
}

// ブラウザの「ダウンロード」としてファイルを保存する
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ファイルの見出しを読む（中身は外から来たものなので、形を確かめてから使う）
export async function readHeader(file) {
  const bad = () => new Error('このアプリで書き出したファイル（.ytjp）ではないようです。');
  if (file.size < MAGIC.length + 4) throw bad();
  const head = new Uint8Array(await file.slice(0, MAGIC.length + 4).arrayBuffer());
  if (new TextDecoder().decode(head.slice(0, MAGIC.length)) !== MAGIC) throw bad();
  const headerLen = new DataView(head.buffer).getUint32(MAGIC.length, true);
  const dataStart = MAGIC.length + 4 + headerLen;
  if (headerLen > MAX_HEADER || dataStart > file.size) throw bad();

  let h;
  try { h = JSON.parse(await file.slice(MAGIC.length + 4, dataStart).text()); } catch { throw bad(); }
  if (!h || h.format !== 1 || !ID_RE.test(h.videoId) || !Array.isArray(h.segments) || !Array.isArray(h.audio)) throw bad();

  const segments = h.segments.map((s) => {
    const seg = { start: Number(s.start), end: Number(s.end), text: String(s.text ?? '') };
    if (Number.isFinite(s.audioDur) && s.audioDur > 0) seg.audioDur = s.audioDur;
    return seg;
  });
  if (!segments.length || segments.some(s => !Number.isFinite(s.start) || !Number.isFinite(s.end) || !s.text)) throw bad();

  let offset = dataStart;
  const audio = [];
  for (const a of h.audio) {
    const ok = Number.isInteger(a.i) && a.i >= 0 && a.i < segments.length && Number.isInteger(a.size) && a.size > 0;
    if (!ok || offset + a.size > file.size) throw new Error('ファイルが途中で切れているか、壊れています。もう一度移し直してください。');
    audio.push({ i: a.i, offset, size: a.size, type: /^audio\/[\w.+-]+$/.test(a.type) ? a.type : 'audio/mpeg' });
    offset += a.size;
  }
  return {
    videoId: h.videoId,
    title: String(h.title || `動画 ${h.videoId}`).slice(0, 200),
    voice: typeof h.voice === 'string' ? h.voice : null,
    segments, audio,
  };
}

// 読み込んでこのブラウザに保存する。onProgress(済んだ数, 全体の数)
export async function importVideo(file, header, onProgress = () => {}) {
  navigator.storage?.persist?.().catch(() => {});   // 保存したデータを、ブラウザに勝手に消されにくくする
  const { videoId, title, voice, segments, audio } = header;
  await db.deleteVideo(videoId);
  for (let n = 0; n < audio.length; n++) {
    const a = audio[n];
    // いったんメモリに読み込んでから保存する（元のファイルが消えても再生できるように）
    const bytes = await file.slice(a.offset, a.offset + a.size).arrayBuffer();
    await db.putAudio(videoId, a.i, new Blob([bytes], { type: a.type }));
    onProgress(n + 1, audio.length);
  }
  await db.putTranscript({ videoId, title, segments, source: 'import', voice });
  addItem({
    videoId, title, segmentCount: segments.length, status: 'done',
    voice: audio.length ? 'google' : 'browser',
  });
}
