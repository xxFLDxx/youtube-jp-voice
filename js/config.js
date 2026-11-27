// ここが「差し替え口」です。翻訳・音声合成・再生時の声を、どの部品で行うかを決めます。
// 画面や同期の仕組み（sync.js）は、ここで選ばれた部品を使うだけです。
import { createSampleTranscriptProvider } from './providers/transcript-sample.js';
import { createBrowserSpeechProvider } from './providers/speech-browser.js';
import { createStoredAudioSpeechProvider } from './providers/speech-audio.js';
import { createClaudeTranslator } from './providers/translate-claude.js';
import { createGoogleTts } from './providers/tts-google.js';
import { getSettings } from './settings.js';
import * as db from './db.js';

// 見本データ（鍵が無くても動く）
export const sampleProvider = createSampleTranscriptProvider();

// ブラウザの読み上げ（Googleの鍵が無いとき・音声がまだ無い文に使う）
export const browserSpeech = createBrowserSpeechProvider();

// 翻訳の部品。Claudeの鍵が未設定なら null
export function createTranslator() {
  const { claudeKey } = getSettings();
  return claudeKey ? createClaudeTranslator(claudeKey) : null;
}

// 音声合成の部品。Googleの鍵が未設定なら null
export function createTts() {
  const { googleKey } = getSettings();
  return googleKey ? createGoogleTts(googleKey) : null;
}

// 再生に使う日本語文: 変換済みのものがあればそれ、無ければ見本データ
export async function getTranscript(videoId) {
  const saved = await db.getTranscript(videoId).catch(() => null);
  return saved || sampleProvider.getTranscript(videoId);
}

// 再生に使う声: 保存済みの音声があればそれ、無ければブラウザ読み上げ
export async function createSpeechFor(transcript) {
  const count = await db.countAudio(transcript.videoId).catch(() => 0);
  if (!count) return { speech: browserSpeech, label: 'ブラウザ読み上げ' };
  const speech = createStoredAudioSpeechProvider({
    videoId: transcript.videoId,
    segments: transcript.segments,
    fallback: browserSpeech,
  });
  const partial = count < transcript.segments.length;
  return { speech, label: partial ? 'Google Chirp 3 HD（一部はブラウザ読み上げ）' : 'Google Chirp 3 HD' };
}
