// ブックマークレット: YouTube の動画ページで押すと、表示中の文字起こしを時刻つきでクリップボードにコピーします。
// ・文字起こしパネルが閉じていれば、開いてから取得します。
// ・読むのは、ページに表示されている文字起こしパネルの文字だけです（手で選んでコピーするのと同じ内容）。
// ・YouTube 以外には何も送信しません。
(async function () {
  const TS = /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/;
  const BOX_ID = 'ytjp-transcript-copy';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 右上に出す小さな案内 ----
  document.getElementById(BOX_ID)?.remove();
  const box = document.createElement('div');
  box.id = BOX_ID;
  box.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;max-width:340px;padding:14px 16px;'
    + 'background:#fff;color:#111;border:2px solid #1f6feb;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);'
    + 'font:14px/1.6 system-ui,sans-serif;';
  const msg = document.createElement('div');
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;';
  box.append(msg, actions);
  document.body.append(box);

  function button(label, primary, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'font:inherit;padding:6px 14px;border-radius:8px;cursor:pointer;border:1px solid #1f6feb;'
      + (primary ? 'background:#1f6feb;color:#fff;font-weight:600;' : 'background:#fff;color:#1f6feb;');
    b.addEventListener('click', onClick);
    return b;
  }
  function show(text, ...buttons) {
    msg.textContent = text;
    actions.replaceChildren(...buttons, button('閉じる', false, () => box.remove()));
  }

  // ---- 動画ページかどうか ----
  const onYouTube = /(^|\.)youtube\.com$/.test(location.hostname);
  const videoId = new URLSearchParams(location.search).get('v')
    || (location.pathname.match(/^\/(?:live|shorts|embed)\/([\w-]{11})/) || [])[1];
  if (!onYouTube || !videoId) {
    show('YouTubeの動画ページを開いてから、もう一度このブックマークを押してください。');
    return;
  }

  // ---- 文字起こしの読み取り ----
  // 要素の中の文字を上から順にたどり、「時刻」とそれに続く文の組を集める。
  // 部品の名前（class など）に頼らないので、YouTubeの画面の作りが多少変わっても動きます。
  function textNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const tag = n.parentElement && n.parentElement.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || box.contains(n)) continue;
      if (n.nodeValue.trim()) out.push(n);
    }
    return out;
  }
  function cuesIn(root) {
    let nodes = textNodes(root);
    const stamps = nodes.filter((n) => TS.test(n.nodeValue.trim()));
    if (!stamps.length) return [];
    // 最初と最後の時刻を両方含む、いちばん内側の要素に絞る（パネルの見出しや言語メニューを除くため）
    let scope = stamps[0].parentElement;
    while (scope && !scope.contains(stamps[stamps.length - 1])) scope = scope.parentElement;
    if (scope && scope !== root) nodes = textNodes(scope);
    const cues = [];
    let cur = null;
    for (const n of nodes) {
      const t = n.nodeValue.replace(/\s+/g, ' ').trim();
      if (TS.test(t)) { cur = { time: t, parts: [] }; cues.push(cur); }
      else if (cur) cur.parts.push(t);
    }
    return cues.map((c) => ({ time: c.time, text: c.parts.join(' ') })).filter((c) => c.text);
  }
  function findCues() {
    // 文字起こし専用のパネル → 見つからなければ、ページ内のパネルのうち時刻つきの行がいちばん多いもの
    const specific = document.querySelectorAll(
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript" i], [target-id*="transcript" i], ytd-transcript-renderer');
    let best = [];
    for (const el of specific) { const c = cuesIn(el); if (c.length > best.length) best = c; }
    if (best.length) return best;
    for (const el of document.querySelectorAll('ytd-engagement-panel-section-list-renderer, #panels > *')) {
      const c = cuesIn(el);
      if (c.length >= 5 && c.length > best.length) best = c;
    }
    return best;
  }

  // ---- パネルが閉じていれば開く ----
  function transcriptButton() {
    const direct = document.querySelector(
      'ytd-video-description-transcript-section-renderer button, ytd-video-description-transcript-section-renderer [role="button"]');
    if (direct) return direct;
    return [...document.querySelectorAll('button, [role="button"]')].find((el) => {
      const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
      return /transcript|文字起こし/i.test(label) && !/close|閉じ|hide|非表示/i.test(label) && !box.contains(el);
    });
  }
  async function openPanel() {
    let btn = transcriptButton();
    if (!btn) {
      // 「文字起こしを表示」は説明欄の中にあるので、説明欄を開いてから探す
      const expand = document.querySelector(
        '#description-inline-expander #expand, ytd-text-inline-expander #expand, #description #expand');
      if (expand) { expand.click(); await sleep(700); btn = transcriptButton(); }
    }
    if (btn) { btn.click(); return true; }
    const panel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id*="transcript" i]');
    if (panel) { panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'); return true; }
    return false;
  }

  show('文字起こしを探しています…');
  let cues = findCues();
  if (!cues.length) {
    const opened = await openPanel();
    if (opened) {
      show('文字起こしを読み込んでいます…');
      // 行が出そろうまで待つ（最大15秒。行数が増えなくなったら完了とみなす）
      let last = -1;
      for (let i = 0; i < 50; i++) {
        await sleep(300);
        cues = findCues();
        if (cues.length && cues.length === last) break;
        last = cues.length;
      }
    }
  }
  if (!cues.length) {
    show('文字起こしを見つけられませんでした。この動画に文字起こしが無いか、YouTubeの画面の作りが変わった可能性があります。'
      + '説明欄の「文字起こしを表示」を手で押してから、もう一度このブックマークを押してみてください。');
    return;
  }

  // ---- コピーする文章を組み立てる（1〜2行目は、アプリがURLと題名を自動で入れるための行） ----
  const title = document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, '').trim();
  const lines = [`URL: https://www.youtube.com/watch?v=${videoId}`, `TITLE: ${title}`];
  for (const c of cues) lines.push(c.time, c.text);
  const output = lines.join('\n');

  const body = cues.map((c) => c.text).join('');
  const japanese = (body.match(/[぀-ヿ一-鿿]/g) || []).length;
  const notEnglish = japanese > body.length * 0.2
    ? ' ※英語ではないようです。文字起こしパネルの言語を英語に切り替えてから、もう一度押してください。' : '';

  async function copy() {
    try {
      await navigator.clipboard.writeText(output);
      return true;
    } catch (e) {
      // クリップボードAPIが使えないときの昔ながらの方法
      const ta = document.createElement('textarea');
      ta.value = output;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      return ok;
    }
  }
  const doneText = `文字起こし ${cues.length} 行をコピーしました。アプリの「英語の文字起こし」の欄に貼り付けてください。${notEnglish}`;
  const retry = button('クリップボードにコピー', true, async () => {
    if (await copy()) show(doneText);
    else show('コピーできませんでした。ブラウザの設定でクリップボードの利用が止められていないか確認してください。', retry);
  });
  if (await copy()) show(doneText);
  else show(`文字起こし ${cues.length} 行を読み取りました。下のボタンを押すとコピーします。${notEnglish}`, retry);
})();
