// 変換前に見せる料金の目安。あくまで概算で、正確な額は各サービスの請求画面で確認します。
import { CHUNK_CHARS } from './providers/translate-claude.js';

// 単価（米ドル）。料金が改定されたらここを直します。
export const PRICES = {
  claudeInputPerMTok: 2,     // Claude Sonnet 5.5 入力 100万トークンあたり
  claudeOutputPerMTok: 10,   // 同 出力
  ttsPerMChars: 30,          // Google Chirp 3 HD 100万文字あたり
  ttsFreeCharsPerMonth: 1_000_000,
};

export function estimate(enChars) {
  const chunks = Math.max(1, Math.ceil(enChars / CHUNK_CHARS));
  const inputTok = Math.round(enChars / 4 * 1.2 + chunks * 900);
  // 日本語は英語の文字数のおよそ 0.3〜0.55 倍（短めに訳すため）
  const jaLow = Math.round(enChars * 0.3);
  const jaHigh = Math.round(enChars * 0.55);
  // 出力トークンは、日本語1文字あたり約2〜3.5（時刻などの付帯情報と、考える分を含む）
  const outLow = jaLow * 2;
  const outHigh = Math.round(jaHigh * 3.5);
  const claude = (out) => inputTok / 1e6 * PRICES.claudeInputPerMTok + out / 1e6 * PRICES.claudeOutputPerMTok;
  return {
    chunks,
    jaChars: [jaLow, jaHigh],
    claudeUsd: [claude(outLow), claude(outHigh)],
    ttsUsd: [jaLow / 1e6 * PRICES.ttsPerMChars, jaHigh / 1e6 * PRICES.ttsPerMChars],
  };
}

export function actualClaudeUsd(usage) {
  return usage.inputTokens / 1e6 * PRICES.claudeInputPerMTok
       + usage.outputTokens / 1e6 * PRICES.claudeOutputPerMTok;
}

export const usd = (n) => (n < 0.01 ? '0.01ドル未満' : `${n.toFixed(2)}ドル`);
export const usdRange = ([lo, hi]) => `約${lo.toFixed(2)}〜${hi.toFixed(2)}ドル`;
