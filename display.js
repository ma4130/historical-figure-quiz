// 投影用(観客)画面: 登録・投票機能は持たず、Firestoreの状態を表示するだけ。
// 効果音はこの画面だけで鳴らす(sound.js)。
import {
  STATE_DOC, VOTES_COL,
  onSnapshot, query, where,
} from "./firebase.js";
import { runCountdown, stopCountdown, isFirstReveal, animateReveal, celebrate, prizeImageHtml } from "./effects.js";
import { computeStandings, difficultyText, formatPoints } from "./scoring.js";
import { play, enableSound, isSoundEnabled, onSoundChange, mountSoundControls } from "./sound.js";
import { DRUMROLL_MS } from "./settings.js";
import { questionsReady, onQuestionsChange } from "./questions-store.js";

const QUESTIONS = window.QUESTIONS;
const appEl = document.getElementById("app");

function render(html) {
  appEl.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function questionBadge(q, qIndex, suffix = "") {
  return `<div class="badge">第${qIndex + 1}問 / ${QUESTIONS.length}問 ・ ${difficultyText(q)}${suffix}</div>`;
}

// ---------- 待機中(参加用QRと「音を有効にする」) ----------
function renderQr() {
  // index.htmlを省略した短いURLにすることで、QRコードのモジュール数を減らして読み取りやすくする
  const studentUrl = new URL(".", window.location.href).href;
  render(`
    <div class="lobby-grid">
      <div class="card qr-wrap">
        <div class="badge">参加はこちらから</div>
        <div id="joinQrCanvas"></div>
        <div class="qr-url">${studentUrl}</div>
        <p class="muted">クイズが始まるまでお待ちください…</p>
        <div id="soundPrompt"></div>
      </div>
      ${rulesCardHtml()}
    </div>`);
  drawSoundPrompt();
  if (typeof QRCode !== "undefined") {
    new QRCode(document.getElementById("joinQrCanvas"), {
      text: studentUrl,
      width: 520,
      height: 520,
      // 誤り訂正レベルを最低(L)にすることで、投影しても読み取りやすいシンプルな見た目にする
      correctLevel: QRCode.CorrectLevel.L,
    });
  }
}

// 待ち画面に出す「問題数」「早く答えるほど高得点」「優勝者にプレゼント」
function rulesCardHtml() {
  return `
    <div class="card rules-card">
      <div class="rules-count">全<b>${QUESTIONS.length}</b>問</div>
      <div class="rules-head">⏱ 早く答えるほど<br>点数が高くなります!</div>
      <div class="rules-prize">🎁 優勝者だけに<br>プレゼントがあります!</div>
    </div>`;
}

function drawSoundPrompt() {
  const el = document.getElementById("soundPrompt");
  if (!el) return;
  if (isSoundEnabled()) {
    el.innerHTML = `<p class="sound-ok">🔊 効果音オン</p>`;
    return;
  }
  el.innerHTML = `<button type="button" class="btn sound-big-btn">🔊 音を有効にする</button>`;
  el.querySelector("button").onclick = () => enableSound();
}
onSoundChange(drawSoundPrompt);
mountSoundControls();

// ---------- このセッションの回答 ----------
let currentState = null;
let sessionVotes = [];
let votesLoaded = false;
let votesSessionId = null;
let votesUnsub = null;

function watchSessionVotes(sessionId) {
  if (votesSessionId === sessionId) return;
  if (votesUnsub) { votesUnsub(); votesUnsub = null; }
  votesSessionId = sessionId;
  sessionVotes = [];
  votesLoaded = false;
  if (!sessionId) return;
  const qy = query(VOTES_COL, where("sessionId", "==", sessionId));
  votesUnsub = onSnapshot(qy, (snap) => {
    sessionVotes = snap.docs.map((d) => d.data());
    votesLoaded = true;
    onVotesChanged();
  }, () => {});
}

function onVotesChanged() {
  const s = currentState;
  if (!s) return;
  if (s.phase === "voting") updateVoteCount();
  else if (s.phase === "results") renderResultsView();
  else if (s.phase === "finished") renderFinishedView();
}

// ---------- 出題中(問題文と回答数だけ) ----------
let lastCount = { key: null, count: 0 };

function renderVotingDisplay() {
  const s = currentState;
  const qIndex = s.currentQuestion;
  const q = QUESTIONS[qIndex];
  if (!q) { render(`<div class="card center"><p>問題を準備しています…</p></div>`); return; }
  render(`
    <div class="card">
      ${questionBadge(q, qIndex)}
      <div class="question-text">${escapeHtml(q.text)}</div>
      <p class="muted center" id="voteCount">回答受付中…</p>
    </div>`);
  updateVoteCount();
}

function updateVoteCount() {
  const s = currentState;
  const el = document.getElementById("voteCount");
  if (!el || !votesLoaded) return;
  const key = `${s.sessionId}_${s.currentQuestion}`;
  const count = sessionVotes.filter((v) => v.questionIndex === s.currentQuestion).length;
  el.textContent = `${count}人が回答済み`;
  // 回答が届いたら小さな音(画面を開き直した直後の分は鳴らさない)
  if (lastCount.key === key && count > lastCount.count) play("vote");
  lastCount = { key, count };
}

// ---------- 結果発表 ----------
function renderResultsView() {
  const s = currentState;
  const qIndex = s.currentQuestion;
  const q = QUESTIONS[qIndex];
  if (!q || !votesLoaded) { render(`<div class="card center"><p>結果を集計しています…</p></div>`); return; }
  const votes = sessionVotes.filter((v) => v.questionIndex === qIndex);
  renderResultsBody(q, qIndex, votes);
  if (isFirstReveal(`${s.sessionId}_${qIndex}`)) {
    animateReveal(appEl);
    play("reveal");
    if (votes.some(v => v.correct)) celebrate("small");
  }
}

function renderResultsBody(q, qIndex, votes) {
  const header = `
    ${questionBadge(q, qIndex, " - 結果発表")}
    <div class="question-text">${escapeHtml(q.text)}</div>
  `;

  let bars = "";
  if (q.type === "single" || q.type === "multi") {
    const total = votes.length || 1;
    bars = q.options.map(o => {
      const count = votes.filter(v => (q.type === "single" ? v.answer === o.key : (v.answer || []).includes(o.key))).length;
      const pct = Math.round((count / total) * 100);
      const isCorrectOpt = q.correct.includes(o.key);
      return `
        <div class="bar-row">
          <div class="bar-label"><span>${escapeHtml(o.key)}. ${escapeHtml(o.text)} ${isCorrectOpt ? '<span class="correct-tag">正解</span>' : ""}</span><span>${count}人 (${pct}%)</span></div>
          <div class="bar-track"><div class="bar-fill ${isCorrectOpt ? "correct" : ""}" style="width:${pct}%"></div></div>
        </div>`;
    }).join("");
  } else if (q.type === "text") {
    const total = votes.length || 1;
    const counts = Object.create(null); // 「constructor」などの回答でも正しく数える
    const correctAnswers = new Set();
    votes.forEach(v => {
      const key = String(v.answer).trim();
      counts[key] = (counts[key] || 0) + 1;
      if (v.correct) correctAnswers.add(key);
    });
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    bars = `<p class="muted">正解: ${escapeHtml(q.correct[0])}</p>` + entries.map(([ans, count]) => {
      const pct = Math.round((count / total) * 100);
      const isCorrectAns = correctAnswers.has(ans);
      return `
        <div class="bar-row">
          <div class="bar-label"><span>${escapeHtml(ans)} ${isCorrectAns ? '<span class="correct-tag">正解</span>' : ""}</span><span>${count}人 (${pct}%)</span></div>
          <div class="bar-track"><div class="bar-fill ${isCorrectAns ? "correct" : ""}" style="width:${pct}%"></div></div>
        </div>`;
    }).join("");
  } else if (q.type === "order") {
    const total = votes.length || 1;
    const correctCount = votes.filter(v => v.correct).length;
    const pct = Math.round((correctCount / total) * 100);
    const correctOrderText = q.correct.join(" → ");
    bars = `
      <p class="muted">正解の順番: ${escapeHtml(correctOrderText)}</p>
      <div class="bar-row">
        <div class="bar-label"><span>完全一致で正解した人</span><span>${correctCount}人 (${pct}%)</span></div>
        <div class="bar-track"><div class="bar-fill correct" style="width:${pct}%"></div></div>
      </div>`;
  }

  const standings = computeStandings(sessionVotes, QUESTIONS, qIndex);
  const ranked = votes
    .filter(v => v.correct && v.answeredAt && v.answeredAt.toMillis)
    .sort((a, b) => a.answeredAt.toMillis() - b.answeredAt.toMillis())
    .slice(0, 5);
  let rankHtml = `<p class="muted">正解者はいませんでした。</p>`;
  if (ranked.length > 0) {
    rankHtml = `
      <table class="rank">
        <thead><tr><th>順位</th><th>番号</th><th>名前</th><th>タイム</th><th>得点</th></tr></thead>
        <tbody>
          ${ranked.map((v, i) => {
            const pq = standings.bySeat.get(String(v.seat))?.perQuestion[qIndex];
            const time = pq && pq.speedMs !== null ? (pq.speedMs / 1000).toFixed(3) + "秒" : "-";
            const pts = pq ? `${formatPoints(pq.points)}${pq.bonus > 0 ? ` 🔥${pq.streak}` : ""}` : "-";
            return `<tr><td>${i + 1}</td><td>${escapeHtml(v.seat)}</td><td>${escapeHtml(v.name)}</td><td>${time}</td><td>${pts}</td></tr>`;
          }).join("")}
        </tbody>
      </table>`;
  }

  render(`
    <div class="display-grid">
      <div class="card">${header}${bars}</div>
      <div class="card">
        <div class="badge">正解者スピードランキング</div>
        ${rankHtml}
      </div>
    </div>
  `);
}

// ---------- 最終結果(ドラムロール → 優勝発表) ----------
let finishStage = null;   // { key, revealAt, drumPlayed }
let finishTimer = null;
let sawFinishLive = false; // この画面を開いている間に「終了」に切り替わったか

function renderFinishedView() {
  const s = currentState;
  if (!s.sessionId) {
    render(`<div class="card center"><p>🎉 クイズは終了しました。お疲れ様でした!</p></div>`);
    return;
  }
  const key = `${s.sessionId}_final`;
  if (!finishStage || finishStage.key !== key) {
    // 終了した瞬間を見ていたときはドラムロールから始める。
    // あとから開き直したときは、終了時刻から数えた残りの分だけドラムロールする
    // (開き直した時刻から数えると、スマホへの公開より発表が遅れてしまう)
    const finishedMs = s.finishedAt && s.finishedAt.toMillis ? s.finishedAt.toMillis() : 0;
    let revealAt = 0;
    if (sawFinishLive) revealAt = Date.now() + DRUMROLL_MS;
    else if (finishedMs > 0 && finishedMs + DRUMROLL_MS > Date.now()) revealAt = finishedMs + DRUMROLL_MS;
    finishStage = { key, revealAt, drumPlayed: false };
  }

  const wait = finishStage.revealAt - Date.now();
  if (wait > 0) {
    render(`
      <div class="card center drumroll-card">
        <div class="badge">最終結果</div>
        <div class="drumroll-icon">🥁</div>
        <div class="drumroll-text">優勝は…</div>
      </div>`);
    if (!finishStage.drumPlayed) { finishStage.drumPlayed = true; play("drumroll"); }
    clearTimeout(finishTimer);
    finishTimer = setTimeout(() => {
      if (currentState && currentState.phase === "finished") renderFinishedView();
    }, wait + 20);
    return;
  }
  if (!votesLoaded) { render(`<div class="card center"><p>最終結果を集計しています…</p></div>`); return; }

  const { list } = computeStandings(sessionVotes, QUESTIONS, s.currentQuestion);
  const winners = list.filter((r) => r.rank === 1);

  const winnerCard = winners.length === 0
    ? `<div class="card center"><p>🎉 クイズは終了しました。お疲れ様でした!</p><p class="muted">回答データがありません。</p></div>`
    : `
      <div class="card winner-card">
        <div class="badge">🏆 優勝</div>
        ${winners.map((w) => `<div class="winner-name">${escapeHtml(String(w.seat))}番 ${escapeHtml(w.name ?? "")}さん</div>`).join("")}
        <div class="winner-points">${formatPoints(winners[0].total)}点</div>
      </div>`;

  const top = list.slice(0, 10);
  const table = list.length === 0 ? "" : `
    <div class="card">
      <div class="badge">総合ランキング(全${QUESTIONS.length}問)</div>
      <table class="rank">
        <thead><tr><th>順位</th><th>番号</th><th>名前</th><th>正解数</th><th>合計点</th></tr></thead>
        <tbody>
          ${top.map((r) => `
            <tr>
              <td>${r.rank}</td>
              <td>${escapeHtml(String(r.seat ?? ""))}</td>
              <td>${escapeHtml(r.name ?? "")}</td>
              <td>${r.correctCount} / ${QUESTIONS.length}</td>
              <td>${formatPoints(r.total)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      ${list.length > top.length ? `<p class="muted center">ほか ${list.length - top.length}人</p>` : ""}
    </div>`;

  // プレゼントの写真は最初は見せず、一番下のボタンを押したときだけ大きく出す
  const prizeButton = winners.length === 0 ? "" : `
    <div class="prize-reveal">
      <button type="button" class="btn" id="showPrizeBtn">🎁 プレゼントの写真を見る</button>
    </div>`;

  render(`<div class="display-grid final-grid">${winnerCard}${table}</div>${prizeButton}`);
  const showBtn = document.getElementById("showPrizeBtn");
  if (showBtn) showBtn.onclick = showPrize;

  if (isFirstReveal(key)) {
    animateReveal(appEl);
    appEl.querySelector(".winner-card")?.classList.add("pop-in");
    play("fanfare");
    celebrate("big");
  }
}

// プレゼントの写真を画面いっぱいに出す。画面を押すか「閉じる」で消える
function showPrize() {
  closePrize();
  const el = document.createElement("div");
  el.className = "prize-overlay";
  el.id = "prizeOverlay";
  el.innerHTML = `
    <div class="prize-title">🎁 優勝のプレゼント</div>
    ${prizeImageHtml()}
    <button type="button" class="btn secondary">閉じる</button>`;
  el.onclick = closePrize;
  document.body.appendChild(el);
  play("reveal");
  celebrate("small");
}
function closePrize() {
  document.getElementById("prizeOverlay")?.remove();
}

// ---------- 進行状態 ----------
// 問題作成画面で保存した問題を読み込んでから始める
await questionsReady;
// 問題作成画面で保存されたら、待ち画面の問題数を更新する
onQuestionsChange(() => {
  if (currentState && (!currentState.sessionId || currentState.phase === "lobby")) renderQr();
});
let goPlayedKey = null; // 「ポーン」を鳴らした問題
onSnapshot(STATE_DOC, (snap) => {
  const prevPhase = currentState ? currentState.phase : null;
  const state = snap.exists() ? snap.data() : { sessionId: null, currentQuestion: -1, phase: "lobby" };
  currentState = state;
  sawFinishLive = state.phase === "finished" && prevPhase !== null && prevPhase !== "finished";
  watchSessionVotes(state.sessionId || null);
  if (state.phase !== "countdown") stopCountdown();
  if (state.phase !== "finished") { clearTimeout(finishTimer); finishStage = null; closePrize(); }

  if (!state.sessionId || state.phase === "lobby") {
    renderQr();
  } else if (state.phase === "countdown") {
    const q = QUESTIONS[state.currentQuestion];
    const key = `${state.sessionId}_${state.currentQuestion}`;
    runCountdown(appEl, `第${state.currentQuestion + 1}問 / ${QUESTIONS.length}問${q ? " ・ " + difficultyText(q) : ""}`, null,
      (n) => {
        if (n > 0) { play("tick"); return; }
        if (goPlayedKey !== key) { goPlayedKey = key; play("go"); }
      });
  } else if (state.phase === "voting") {
    // 出題の切り替えが「スタート!」の表示と同時だと鳴らし損ねるので、ここで鳴らす
    const key = `${state.sessionId}_${state.currentQuestion}`;
    if (prevPhase === "countdown" && goPlayedKey !== key) { goPlayedKey = key; play("go"); }
    renderVotingDisplay();
  } else if (state.phase === "results") {
    renderResultsView();
  } else if (state.phase === "finished") {
    renderFinishedView();
  }
});
