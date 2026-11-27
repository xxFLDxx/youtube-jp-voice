// ここが「差し替え口」です。
// 第2段階で翻訳AI・音声合成をつなぐときは、新しい部品を作って下の2行を入れ替えます。
// ほかのファイル（画面や同期の仕組み）は変更不要です。
import { createSampleTranscriptProvider } from './providers/transcript-sample.js';
import { createBrowserSpeechProvider } from './providers/speech-browser.js';

// 翻訳の部品: getTranscript(videoId) → { videoId, title, segments:[{start,end,text}] }
export const transcriptProvider = createSampleTranscriptProvider();

// 音声の部品: speak(segment, {rate, offset, onEnd}) / stop() / unlock()
export const speechProvider = createBrowserSpeechProvider();
