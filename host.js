import {
  db, STATE_DOC, VOTES_COL, PRESENCE_COL,
  doc, setDoc, deleteDoc, getDocs, onSnapshot, query, where, serverTimestamp,
} from "./firebase.js";
import { computeStandings, voteSpeedMs, difficultyText } from "./scoring.js";
import { PHONE_REVEAL_DELAY_MS } from "./settings.js";
import { questionsReady, onQuestionsChange, questionsSource } from "./questions-store.js";

const ONLINE_THRESHOLD_MS = 30000;
const COUNTDOWN_MS = 3000;
let advancing = false;

const QUESTIONS = window.QUESTIONS;
const appEl = document.getElementById("app");

// 問題作成画面で保存した問題を読み込んでから始める。あとで変わったら描き直す
await questionsReady;
onQuestionsChange(() => render());

function genSessionId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

let currentState = null;
let voteCountUnsub = null;

// ---------- 接続中人数の表示 ----------
let presenceDocs = [];
let onlineCount = 0;

function computeOnlineCount() {
  const now = Date.now();
  return presenceDocs.filter((d) => {
    const ms = d.lastSeen && d.lastSeen.toMillis ? d.lastSeen.toMillis() : 0;
    return ms > 0 && now - ms < ONLINE_THRESHOLD_MS;
  }).length;
}

function updatePresenceDisplay() {
  onlineCount = computeOnlineCount();
  const el = document.getElementById("presenceCount");
  if (el) el.textContent = `接続中: ${onlineCount}人`;
  updateUnanswered();
}

// ---------- 未回答者の一覧 ----------
let votedSeats = new Set();

function onlineSeats() {
  const now = Date.now();
  const seats = new Set();
  presenceDocs.forEach((d) => {
    const ms = d.lastSeen && d.lastSeen.toMillis ? d.lastSeen.toMillis() : 0;
    if (ms > 0 && now - ms < ONLINE_THRESHOLD_MS) seats.add(String(d.seat));
  });
  return seats;
}

function updateUnanswered() {
  const el = document.getElementById("unanswered");
  if (!el) return;
  const roster = window.ROSTER || [];
  if (!currentState || (currentState.phase !== "voting" && currentState.phase !== "results") || roster.length === 0) {
    el.innerHTML = "";
    return;
  }
  const online = onlineSeats();
  const pending = roster.filter((r) => !votedSeats.has(String(r.seat)));
  const pendingOnline = pending.filter((r) => online.has(String(r.seat)));
  const pendingOffline = pending.filter((r) => !online.has(String(r.seat)));
  if (pending.length === 0) {
    el.innerHTML = `<p class="all-answered">全員回答しました 🎉</p>`;
    return;
  }
  const chip = (r, cls) => `<span class="chip ${cls}">${r.seat} ${escapeHtml(r.name)}</span>`;
  el.innerHTML = `
    <p class="unanswered-title">未回答: ${pending.length}人</p>
    ${pendingOnline.length ? `<p class="muted">接続中なのに未回答(${pendingOnline.length}人)</p><div class="chips">${pendingOnline.map((r) => chip(r, "online")).join("")}</div>` : ""}
    ${pendingOffline.length ? `<p class="muted">未接続(${pendingOffline.length}人)</p><div class="chips">${pendingOffline.map((r) => chip(r, "offline")).join("")}</div>` : ""}`;
}

onSnapshot(PRESENCE_COL, (snap) => {
  presenceDocs = [];
  snap.forEach((d) => presenceDocs.push(d.data()));
  updatePresenceDisplay();
});
setInterval(updatePresenceDisplay, 5000);

async function startNewSession() {
  if (!confirm("新しいクイズセッションを開始します(進行状況がリセットされます)。よろしいですか?")) return;
  await setDoc(STATE_DOC, {
    sessionId: genSessionId(),
    currentQuestion: -1,
    phase: "lobby",
    questionStartAt: null,
  });
}

async function nextQuestion() {
  if (!currentState || !currentState.sessionId) {
    alert("先に「新しいクイズを開始」を押してください。");
    return;
  }
  const next = currentState.currentQuestion + 1;
  if (next >= QUESTIONS.length) {
    alert("すべての問題が終了しました。「クイズを終了する」を押してください。");
    return;
  }
  if (advancing) return;
  // 押し間違いで先へ進まないよう、もう一度確かめる
  if (!confirm(`第${next + 1}問を出題しますか?
(3秒のカウントダウンのあと、全員の画面に問題が出ます)`)) return;
  advancing = true;
  const sessionId = currentState.sessionId;
  try {
    // まず全画面でカウントダウンを表示し、3秒後に出題する。タイムは出題した瞬間から計る。
    await setDoc(STATE_DOC, { sessionId, currentQuestion: next, phase: "countdown", questionStartAt: null });
    await new Promise((r) => setTimeout(r, COUNTDOWN_MS));
    // 3秒の間にリセットや終了が押されていたら、出題で上書きしない
    const s = currentState;
    if (!s || s.sessionId !== sessionId || s.phase !== "countdown" || s.currentQuestion !== next) return;
    await startVoting(sessionId, next);
  } finally {
    advancing = false;
    render();
  }
}

async function startVoting(sessionId, qIndex) {
  await setDoc(STATE_DOC, { sessionId, currentQuestion: qIndex, phase: "voting", questionStartAt: serverTimestamp() });
}

async function showResults() {
  if (!currentState || currentState.currentQuestion < 0) return;
  const online = onlineSeats();
  const waiting = [...online].filter((seat) => !votedSeats.has(seat)).length;
  const msg = `第${currentState.currentQuestion + 1}問の結果を発表しますか?
`
    + `回答済み ${votedSeats.size}人${waiting ? ` ・ 接続中でまだ答えていない人 ${waiting}人` : ""}
`
    + "(発表すると回答の受付を締め切ります)";
  if (!confirm(msg)) return;
  await setDoc(STATE_DOC, { ...currentState, phase: "results" });
}

async function showStuckQuestion(s) {
  if (!confirm(`第${s.currentQuestion + 1}問を表示しますか?`)) return;
  await startVoting(s.sessionId, s.currentQuestion);
}

// 終了すると投影画面でドラムロール→優勝発表。スマホには少し遅れて公開する(ネタバレ防止)
let revealTimer = null;

async function finishQuiz() {
  if (!confirm("クイズを終了しますか?")) return;
  const sessionId = currentState.sessionId;
  await setDoc(STATE_DOC, { ...currentState, phase: "finished", finishedAt: serverTimestamp(), phonesRevealed: false });
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    revealTimer = null;
    revealToPhones(sessionId);
  }, PHONE_REVEAL_DELAY_MS);
  render();
}

async function revealToPhones(sessionId) {
  const s = currentState;
  if (!s || s.sessionId !== sessionId || s.phase !== "finished" || s.phonesRevealed !== false) return;
  clearTimeout(revealTimer);
  revealTimer = null;
  await setDoc(STATE_DOC, { ...s, phonesRevealed: true });
}

// ---------- CSVエクスポート ----------
function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
}
function downloadCsv(filename, rows) {
  const csv = "﻿" + toCsv(rows); // Excelでの文字化け防止のためBOM付き
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function formatAnswer(q, answer) {
  if (!q) return JSON.stringify(answer);
  if (q.type === "single" || q.type === "text") return answer;
  if (q.type === "multi") return (answer || []).join(",");
  if (q.type === "order") return (answer || []).join("→");
  return JSON.stringify(answer);
}
async function exportCsv() {
  if (!currentState || !currentState.sessionId) {
    alert("エクスポートするデータがありません。");
    return;
  }
  const qy = query(VOTES_COL, where("sessionId", "==", currentState.sessionId));
  const snap = await getDocs(qy);
  const votes = [];
  snap.forEach((d) => votes.push(d.data()));
  if (votes.length === 0) {
    alert("回答データがありません。");
    return;
  }

  // 点数は scoring.js でまとめて計算する(画面に出る点数・順位と同じ)
  const lastIndex = Math.max(currentState.currentQuestion, ...votes.map((v) => v.questionIndex));
  const standings = computeStandings(votes, QUESTIONS, lastIndex);

  const detailHeader = ["出席番号", "名前", "問題番号", "問題文", "難易度", "回答", "正誤", "回答時刻", "所要時間(秒)", "速さの点", "連続正解", "連続ボーナス", "得点"];
  const detailRows = votes
    .slice()
    .sort((a, b) => (a.questionIndex - b.questionIndex) || String(a.seat).localeCompare(String(b.seat), "ja", { numeric: true }))
    .map((v) => {
      const q = QUESTIONS[v.questionIndex];
      const answeredMs = v.answeredAt && v.answeredAt.toMillis ? v.answeredAt.toMillis() : null;
      const speedMs = voteSpeedMs(v);
      const pq = standings.bySeat.get(String(v.seat))?.perQuestion[v.questionIndex];
      return [
        v.seat, v.name, v.questionIndex + 1, q ? q.text : "", q ? difficultyText(q) : "",
        formatAnswer(q, v.answer), v.correct ? "正解" : "不正解",
        answeredMs ? new Date(answeredMs).toLocaleString("ja-JP") : "",
        speedMs !== null ? (speedMs / 1000).toFixed(3) : "",
        pq ? pq.base : 0, pq && pq.correct ? pq.streak : 0, pq ? pq.bonus : 0, pq ? pq.points : 0,
      ];
    });
  downloadCsv("著名人クイズ_回答詳細.csv", [detailHeader, ...detailRows]);

  const rankHeader = ["順位", "出席番号", "名前", "合計点", "正解数", "合計時間(秒)"];
  const rankRows = standings.list.map((r) => [r.rank, r.seat, r.name, r.total, `${r.correctCount} / ${QUESTIONS.length}`, (r.totalSpeedMs / 1000).toFixed(3)]);
  downloadCsv("著名人クイズ_総合ランキング.csv", [rankHeader, ...rankRows]);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function questionPreview(qIndex) {
  const q = QUESTIONS[qIndex];
  if (!q) return "";
  let correctText = "";
  if (q.type === "single") correctText = q.correct[0];
  else if (q.type === "multi") correctText = q.correct.join(", ");
  else if (q.type === "text") correctText = q.correct[0];
  else if (q.type === "order") correctText = q.correct.join(" → ");
  return `
    <div class="card">
      <div class="badge">第${qIndex + 1}問(${q.type})・${difficultyText(q)}</div>
      <div class="question-text">${escapeHtml(q.text)}</div>
      <p class="muted">正解: ${escapeHtml(correctText)}</p>
    </div>`;
}

function render() {
  if (!currentState) {
    appEl.innerHTML = `<div class="card center"><p>読み込み中…</p></div>`;
    return;
  }
  const s = currentState;
  const phaseLabel = { lobby: "待機中", countdown: "カウントダウン中", voting: "投票中", results: "結果発表中", finished: "終了" }[s.phase] || "未開始";
  // カウントダウン中に管理者画面を再読み込みすると出題されないまま止まるので、その場合は手動で出題できるようにする
  const stuckCountdown = s.phase === "countdown" && !advancing;
  const advanceLabel = s.phase === "countdown" ? (stuckCountdown ? "問題を表示する" : "カウントダウン中…")
    : s.phase === "voting" ? "結果を見る" : "次の問題へ";

  appEl.innerHTML = `
    <div class="card host-links">
      <a class="btn secondary" href="display.html" target="_blank" rel="noopener">🖥 投影画面を開く</a>
      <a class="btn secondary" href="editor.html" target="_blank" rel="noopener">📝 問題を作成・編集する</a>
    </div>
    <div class="card">
      <div class="badge">状態</div>
      <p>フェーズ: <b>${phaseLabel}</b> / 問題: <b>${s.currentQuestion >= 0 ? (s.currentQuestion + 1) + " / " + QUESTIONS.length : "-"}</b></p>
      <p class="muted">使う問題: 全${QUESTIONS.length}問(${questionsSource() === "firestore" ? "問題作成画面で保存した問題" : "questions.js の問題"})</p>
      <p id="presenceCount" class="muted">接続中: ${onlineCount}人</p>
      <p id="voteCount" class="muted">回答数を集計中…</p>
      ${s.phase === "finished" ? `<p>スマホへの最終結果の公開: <b>${s.phonesRevealed === false ? (revealTimer ? "まもなく自動で公開" : "まだ") : "公開済み"}</b></p>` : ""}
      <div id="unanswered"></div>
    </div>
    <div class="card">
      <button class="btn secondary" id="startBtn">新しいクイズを開始(リセット)</button>
      <button class="btn" id="advanceBtn" ${s.phase === "countdown" && !stuckCountdown ? "disabled" : ""}>${advanceLabel}</button>
      ${s.phase === "finished" && s.phonesRevealed === false ? `<button class="btn" id="revealBtn">スマホに結果を公開する(今すぐ)</button>` : ""}
      <button class="btn danger" id="finishBtn">クイズを終了する</button>
      <button class="btn secondary" id="csvBtn">CSVエクスポート(回答詳細・総合ランキング)</button>
    </div>
    ${s.currentQuestion >= 0 ? questionPreview(s.currentQuestion) : ""}
  `;

  document.getElementById("startBtn").onclick = startNewSession;
  document.getElementById("advanceBtn").onclick =
    stuckCountdown ? () => showStuckQuestion(s)
    : s.phase === "voting" ? showResults : nextQuestion;
  document.getElementById("finishBtn").onclick = finishQuiz;
  const revealBtn = document.getElementById("revealBtn");
  if (revealBtn) revealBtn.onclick = () => revealToPhones(s.sessionId);
  document.getElementById("csvBtn").onclick = exportCsv;

  if (voteCountUnsub) { voteCountUnsub(); voteCountUnsub = null; }
  votedSeats = new Set();
  updateUnanswered();
  if (s.sessionId && s.currentQuestion >= 0) {
    const qy = query(VOTES_COL, where("sessionId", "==", s.sessionId), where("questionIndex", "==", s.currentQuestion));
    voteCountUnsub = onSnapshot(qy, (snap) => {
      votedSeats = new Set();
      snap.forEach((d) => votedSeats.add(String(d.data().seat)));
      updateUnanswered();
      const el = document.getElementById("voteCount");
      if (el) el.textContent = `回答数: ${snap.size}人`;
    });
  }
}

onSnapshot(STATE_DOC, (snap) => {
  currentState = snap.exists() ? snap.data() : { sessionId: null, currentQuestion: -1, phase: "lobby" };
  render();
});

// ---------- 生徒データ管理(名前を選んで回答履歴を削除) ----------
const studentAdminEl = document.getElementById("studentAdmin");

function groupVotesByStudent(snap) {
  const byVoter = new Map();
  snap.forEach((d) => {
    const data = d.data();
    const key = String(data.seat ?? d.id);
    if (!byVoter.has(key)) {
      byVoter.set(key, { voterId: key, seat: data.seat, name: data.name, docIds: [] });
    }
    const entry = byVoter.get(key);
    entry.seat = data.seat;
    entry.name = data.name;
    entry.docIds.push(d.id);
  });
  return [...byVoter.values()].sort((a, b) => String(a.seat).localeCompare(String(b.seat), "ja", { numeric: true }));
}

async function deleteStudent(entry) {
  if (!confirm(`出席番号 ${entry.seat}(${entry.name})の回答データ(${entry.docIds.length}件)を削除します。よろしいですか?`)) return;
  await Promise.all(entry.docIds.map((id) => deleteDoc(doc(db, "votes", id))));
}

function renderStudentAdmin(students) {
  if (students.length === 0) {
    studentAdminEl.innerHTML = `
      <div class="card">
        <div class="badge">生徒データ管理</div>
        <p class="muted">まだ回答データがありません。</p>
      </div>`;
    return;
  }
  studentAdminEl.innerHTML = `
    <div class="card">
      <div class="badge">生徒データ管理</div>
      <p class="muted">生徒を選んで回答履歴(全セッション分)を削除できます。</p>
      <table class="rank">
        <thead><tr><th>出席番号</th><th>名前</th><th>回答数</th><th></th></tr></thead>
        <tbody>
          ${students.map((s, i) => `
            <tr>
              <td>${escapeHtml(String(s.seat ?? ""))}</td>
              <td>${escapeHtml(s.name ?? "")}</td>
              <td>${s.docIds.length}</td>
              <td><button class="btn danger" style="width:auto;padding:6px 12px;margin:0;" data-idx="${i}">削除</button></td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  students.forEach((s, i) => {
    const btn = studentAdminEl.querySelector(`button[data-idx="${i}"]`);
    if (btn) btn.onclick = () => deleteStudent(s);
  });
}

onSnapshot(VOTES_COL, (snap) => {
  renderStudentAdmin(groupVotesByStudent(snap));
});
