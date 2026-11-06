import {
  db, STATE_DOC, VOTES_COL, PRESENCE_COL,
  doc, getDoc, setDoc, onSnapshot, query, where, serverTimestamp,
} from "./firebase.js";
import { runCountdown, stopCountdown, isFirstReveal, animateReveal, celebrate, prizeImageHtml } from "./effects.js";
import { computeStandings, rankChangeText, difficultyText, formatPoints } from "./scoring.js";
import { questionsReady } from "./questions-store.js";

const PRESENCE_INTERVAL_MS = 15000;
// 回答の送信がこの時間たっても終わらないときは「送信中…電波を確認してください」と出す
const SEND_SLOW_MS = 5000;

const QUESTIONS = window.QUESTIONS;
const appEl = document.getElementById("app");

// ---------- 端末ID・プロフィール ----------
function getVoterId() {
  let id = localStorage.getItem("quizVoterId");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    localStorage.setItem("quizVoterId", id);
  }
  return id;
}
const voterId = getVoterId();

function getProfile() {
  const raw = localStorage.getItem("quizProfile");
  return raw ? JSON.parse(raw) : null;
}
function saveProfile(p) {
  localStorage.setItem("quizProfile", JSON.stringify(p));
}

// ---------- 接続中の生存確認(ハートビート) ----------
function startPresenceHeartbeat(profile) {
  const send = () => {
    setDoc(doc(db, "presence", `s${profile.seat}`), {
      seat: profile.seat,
      name: profile.name,
      lastSeen: serverTimestamp(),
    }).catch(() => {});
  };
  send();
  setInterval(send, PRESENCE_INTERVAL_MS);
}

// ---------- 正誤判定 ----------
// スマホの日本語キーボードだと全角数字(２３７３)や「2,373」「2373億」になりやすいので揃えてから判定する
function normalizeText(s) {
  return String(s).normalize("NFKC").replace(/[\s,、]/g, "").replace(/(億円|億|円)$/, "");
}
function isCorrect(q, answer) {
  if (q.type === "single") return answer === q.correct[0];
  // 記述問題は correct に書いた答えのどれかと一致すれば正解(例: ["大谷翔平", "おおたにしょうへい"])
  if (q.type === "text") return q.correct.some((c) => normalizeText(answer) === normalizeText(c));
  if (q.type === "multi") {
    const a = [...answer].sort();
    const c = [...q.correct].sort();
    return JSON.stringify(a) === JSON.stringify(c);
  }
  if (q.type === "order") {
    return JSON.stringify(answer) === JSON.stringify(q.correct);
  }
  return false;
}

// ---------- 画面描画 ----------
function render(html) {
  appEl.innerHTML = html;
}

function questionBadge(q, qIndex, suffix = "") {
  return `<div class="badge">第${qIndex + 1}問 / ${QUESTIONS.length}問 ・ ${difficultyText(q)}${suffix}</div>`;
}

function renderRegistration() {
  const roster = window.ROSTER;
  if (Array.isArray(roster) && roster.length > 0) {
    render(`
      <div class="card">
        <div class="badge">参加登録</div>
        <p class="muted">出席番号を選んでください。名前は自動で表示されます。</p>
        <select id="seatSelect">
          <option value="">-- 出席番号を選択 --</option>
          ${roster.map(r => `<option value="${r.seat}">${r.seat}番</option>`).join("")}
        </select>
        <p id="nameDisplay" class="muted" style="min-height:1.5em;"></p>
        <button class="btn" id="joinBtn" disabled>参加する</button>
      </div>
    `);
    const seatSelect = document.getElementById("seatSelect");
    const nameDisplay = document.getElementById("nameDisplay");
    const joinBtn = document.getElementById("joinBtn");
    let selectedName = "";
    seatSelect.onchange = () => {
      const seat = seatSelect.value;
      const entry = roster.find(r => String(r.seat) === seat);
      selectedName = entry ? entry.name : "";
      nameDisplay.textContent = selectedName ? `名前: ${selectedName}` : "";
      joinBtn.disabled = !seat;
    };
    joinBtn.onclick = () => {
      const seat = seatSelect.value;
      if (!seat || !selectedName) {
        alert("出席番号を選んでください。");
        return;
      }
      saveProfile({ seat, name: selectedName });
      boot();
    };
    return;
  }

  // 名簿データがない場合は従来通り手入力
  render(`
    <div class="card">
      <div class="badge">参加登録</div>
      <p class="muted">出席番号と名前を入力して参加してください。</p>
      <input type="number" id="seatInput" placeholder="出席番号(例: 12)">
      <input type="text" id="nameInput" placeholder="名前(例: 山田太郎)">
      <button class="btn" id="joinBtn">参加する</button>
    </div>
  `);
  document.getElementById("joinBtn").onclick = () => {
    const seat = document.getElementById("seatInput").value.trim();
    const name = document.getElementById("nameInput").value.trim();
    if (!seat || !name) {
      alert("出席番号と名前を入力してください。");
      return;
    }
    saveProfile({ seat, name });
    boot();
  };
}

function renderWaiting(msg) {
  render(`
    <div class="card center">
      <span class="status-dot"></span>
      <p>${msg}</p>
    </div>
  `);
}

function renderStalled() {
  render(`
    <div class="card center">
      <p>問題を読み込んでいます…</p>
      <p class="muted">表示されない場合は、下のボタンを押してください。</p>
      <button class="btn" id="reloadBtn">再読み込み</button>
    </div>`);
  document.getElementById("reloadBtn").onclick = () => location.reload();
}

function renderError(e) {
  render(`
    <div class="card center">
      <p>画面の表示中にエラーが起きました。</p>
      <p class="muted">${escapeHtml(e && e.message ? e.message : String(e))}</p>
      <button class="btn" id="reloadBtn">再読み込み</button>
    </div>`);
  document.getElementById("reloadBtn").onclick = () => location.reload();
}

// 1問につき出席番号1つで1回だけ回答できる(端末を変えたりプライベートブラウザを開き直しても同じ)
let mySeat = null;

function voteDocId(sessionId, qIndex) {
  return `${sessionId}_${qIndex}_s${mySeat}`;
}

function renderWhoami(profile) {
  const el = document.getElementById("whoami");
  if (!el) return;
  el.innerHTML = `${escapeHtml(profile.seat)}番 ${escapeHtml(profile.name)} で参加中<span id="myRank"></span> ・ <button type="button" id="changeSeatBtn" class="link-btn">番号を選び直す</button>`;
  document.getElementById("changeSeatBtn").onclick = () => {
    if (!confirm("出席番号を選び直しますか?\nすでに回答した問題の回答は、元の番号のまま残ります。")) return;
    localStorage.removeItem("quizProfile");
    localStorage.removeItem("quizVoted");
    location.reload();
  };
  updateMyRank();
}

function renderTaken() {
  render(`
    <div class="card center">
      <p>この出席番号(${escapeHtml(mySeat)}番)では、この問題にすでに別の端末から回答されています。</p>
      <p class="muted">番号を間違えて選んだ場合は、下の「番号を選び直す」から正しい番号を選んでください。</p>
    </div>`);
}

// 回答済みかどうかを端末にも覚えておき、サーバーへの確認を待たずに画面を出せるようにする
function localVoted() {
  try { return new Set(JSON.parse(localStorage.getItem("quizVoted") || "[]")); } catch { return new Set(); }
}
function markLocalVoted(id) {
  const s = localVoted();
  s.add(id);
  try { localStorage.setItem("quizVoted", JSON.stringify([...s].slice(-200))); } catch {}
}

async function existingVote(sessionId, qIndex) {
  const snap = await getDoc(doc(db, "votes", voteDocId(sessionId, qIndex)));
  return snap.exists() ? snap.data() : null;
}

async function submitVote(state, qIndex, q, answer, profile) {
  const ref = doc(db, "votes", voteDocId(state.sessionId, qIndex));
  const correct = isCorrect(q, answer);
  await setDoc(ref, {
    sessionId: state.sessionId,
    questionIndex: qIndex,
    voterId,
    seat: profile.seat,
    name: profile.name,
    answer,
    correct,
    questionStartAt: state.questionStartAt ?? null,
    answeredAt: serverTimestamp(),
  });
  return correct;
}

// 状態が切り替わるたびに増える番号。通信待ちの間に次の画面へ進んでいたら、古い画面で上書きしない
let viewToken = 0;

// 送信に時間がかかっているときのお知らせ。送信が終わると画面ごと描き直されて消える
function showSendingSlow() {
  if (document.getElementById("sendingSlow")) return;
  appEl.insertAdjacentHTML("afterbegin", `
    <div class="card center sending-slow" id="sendingSlow">
      <span class="spinner"></span>
      <p><b>送信中…</b><br>電波を確認してください</p>
      <p class="muted">つながると自動で送信されます。このまま待ってください。</p>
    </div>`);
}

async function sendVote(state, qIndex, q, answer, profile, token) {
  const slowTimer = setTimeout(() => { if (token === viewToken) showSendingSlow(); }, SEND_SLOW_MS);
  try {
    try {
      await submitVote(state, qIndex, q, answer, profile);
    } catch (e) {
      const saved = await existingVote(state.sessionId, qIndex).catch(() => null);
      if (!saved) {
        alert("回答を送信できませんでした。電波を確認して、もう一度選んでください。");
        if (token === viewToken) renderVoting(state, profile, token);
        return;
      }
      if (saved.voterId !== voterId) {
        if (token === viewToken) renderTaken();
        return;
      }
    }
    markLocalVoted(voteDocId(state.sessionId, qIndex));
    if (token === viewToken) renderWaiting("回答を送信しました。結果発表をお待ちください。");
  } finally {
    clearTimeout(slowTimer);
  }
}

async function renderVoting(state, profile, token) {
  const qIndex = state.currentQuestion;
  const q = QUESTIONS[qIndex];
  if (!q) { renderWaiting("問題を準備しています…"); return; }

  if (localVoted().has(voteDocId(state.sessionId, qIndex))) {
    renderWaiting("回答を送信しました。結果発表をお待ちください。");
    return;
  }
  // 問題はすぐ表示し、別の端末やタブで回答済みでないかは裏で確認する
  existingVote(state.sessionId, qIndex).then((v) => {
    if (!v || token !== viewToken) return;
    if (v.voterId === voterId) {
      markLocalVoted(voteDocId(state.sessionId, qIndex));
      renderWaiting("回答を送信しました。結果発表をお待ちください。");
    } else {
      renderTaken();
    }
  }).catch(() => {});

  const header = `
    ${questionBadge(q, qIndex)}
    <div class="question-text">${escapeHtml(q.text)}</div>
  `;

  if (q.type === "single") {
    render(`<div class="card">${header}
      ${q.options.map(o => `<button class="option-btn" data-key="${o.key}"><span class="option-key">${o.key}</span>${escapeHtml(o.text)}</button>`).join("")}
    </div>`);
    document.querySelectorAll(".option-btn").forEach(btn => {
      btn.onclick = async () => {
        document.querySelectorAll(".option-btn").forEach(b => b.disabled = true);
        btn.classList.add("selected");
        await sendVote(state, qIndex, q, btn.dataset.key, profile, token);
      };
    });
  } else if (q.type === "multi") {
    render(`<div class="card">${header}
      ${q.options.map(o => `<button class="option-btn" data-key="${o.key}"><span class="option-key">${o.key}</span>${escapeHtml(o.text)}</button>`).join("")}
      <button class="btn" id="submitBtn" disabled>この内容で回答する</button>
    </div>`);
    const selected = new Set();
    document.querySelectorAll(".option-btn").forEach(btn => {
      btn.onclick = () => {
        const k = btn.dataset.key;
        if (selected.has(k)) { selected.delete(k); btn.classList.remove("selected"); }
        else { selected.add(k); btn.classList.add("selected"); }
        document.getElementById("submitBtn").disabled = selected.size === 0;
      };
    });
    document.getElementById("submitBtn").onclick = async () => {
      document.querySelectorAll(".option-btn, .btn").forEach(b => b.disabled = true);
      await sendVote(state, qIndex, q, [...selected], profile, token);
    };
  } else if (q.type === "text") {
    render(`<div class="card">${header}
      <input type="text" id="textInput" placeholder="回答を入力" ${q.inputMode ? `inputmode="${q.inputMode}"` : ""}>
      <button class="btn" id="submitBtn">回答する</button>
    </div>`);
    document.getElementById("submitBtn").onclick = async () => {
      const val = normalizeText(document.getElementById("textInput").value);
      if (!val) { alert("回答を入力してください。"); return; }
      document.getElementById("submitBtn").disabled = true;
      document.getElementById("textInput").disabled = true;
      await sendVote(state, qIndex, q, val, profile, token);
    };
  } else if (q.type === "order") {
    render(`<div class="card">${header}
      <p class="muted">各項目に順番(1〜${q.items.length})を選んでください。</p>
      ${q.items.map(it => `
        <div class="order-row">
          <select data-key="${it.key}">
            <option value="">-</option>
            ${q.items.map((_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("")}
          </select>
          <div><span class="option-key">${it.key}</span>${escapeHtml(it.text)}</div>
        </div>
      `).join("")}
      <button class="btn" id="submitBtn">この順番で回答する</button>
    </div>`);
    document.getElementById("submitBtn").onclick = async () => {
      const selects = [...document.querySelectorAll(".order-row select")];
      const values = selects.map(s => s.value);
      if (values.some(v => !v) || new Set(values).size !== values.length) {
        alert("すべての項目に重複のない順番を設定してください。");
        return;
      }
      const ordered = selects
        .map(s => ({ key: s.dataset.key, pos: Number(s.value) }))
        .sort((a, b) => a.pos - b.pos)
        .map(x => x.key);
      document.getElementById("submitBtn").disabled = true;
      await sendVote(state, qIndex, q, ordered, profile, token);
    };
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- このセッションの回答(点数・順位の計算に使う) ----------
// 問題ごとではなくセッション全体を1本の購読で受け取り、結果発表・順位・最終結果で使い回す。
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
  updateMyRank();
  const s = currentState;
  if (!s) return;
  // 投票中は描き直すと選びかけの回答が消えるので、結果発表と最終結果のときだけ描き直す
  if (s.phase === "results") renderResultsView();
  else if (s.phase === "finished") renderFinishedView();
}

// スマホに最終結果を出してよいか(投影画面の優勝発表が終わるまでは false)
function phonesRevealed(s) {
  return s.phonesRevealed !== false;
}

// 順位を何問目までの成績で出すか。-1 なら出さない
function rankUpto(s) {
  if (!s || !s.sessionId) return -1;
  if (s.phase === "countdown" || s.phase === "voting") return s.currentQuestion - 1;
  if (s.phase === "results") {
    // 最後の問題の結果発表で順位を出すと最終順位のネタバレになるので出さない
    return s.currentQuestion === QUESTIONS.length - 1 ? -1 : s.currentQuestion;
  }
  if (s.phase === "finished") return phonesRevealed(s) ? s.currentQuestion : -1;
  return -1;
}

// 画面下の「27番 ○○ で参加中 ・現在7位」
function updateMyRank() {
  const el = document.getElementById("myRank");
  if (!el) return;
  const upto = rankUpto(currentState);
  if (upto < 0 || !votesLoaded) { el.textContent = ""; return; }
  const me = computeStandings(sessionVotes, QUESTIONS, upto).bySeat.get(mySeat);
  el.textContent = me ? ` ・ 現在${me.rank}位` : "";
}

// ---------- 結果発表 ----------
function renderResultsView() {
  const s = currentState;
  const qIndex = s.currentQuestion;
  const q = QUESTIONS[qIndex];
  if (!q || !votesLoaded) { renderWaiting("結果を集計しています…"); return; }
  const votes = sessionVotes.filter((v) => v.questionIndex === qIndex);
  renderResultsBody(q, qIndex, votes, s.sessionId);
}

function correctAnswerText(q) {
  if (q.type === "multi") return q.correct.join("・");
  if (q.type === "order") return q.correct.join(" → ");
  return q.correct[0];
}

function myResultCard(q, qIndex, votes) {
  const standings = computeStandings(sessionVotes, QUESTIONS, qIndex);
  const me = standings.bySeat.get(mySeat);
  let rankLine = "";
  if (me) {
    if (qIndex === QUESTIONS.length - 1) {
      rankLine = `合計 ${formatPoints(me.total)}点<br><span class="small">最終順位はこのあと発表!</span>`;
    } else {
      const change = rankChangeText(sessionVotes, QUESTIONS, qIndex, mySeat);
      rankLine = `現在 ${me.rank}位${change ? `(${change})` : ""}・${formatPoints(me.total)}点`;
    }
  }
  const rankHtml = rankLine ? `<div class="my-rank-line">${rankLine}</div>` : "";

  const mine = votes.find(v => String(v.seat) === String(mySeat));
  if (!mine) {
    return `<div class="card my-result none"><div class="my-result-mark">未回答</div><div class="my-result-sub">正解: ${escapeHtml(correctAnswerText(q))}</div>${rankHtml}</div>`;
  }
  if (!mine.correct) {
    return `<div class="card my-result wrong"><div class="my-result-mark">❌ 不正解</div><div class="my-result-sub">正解: ${escapeHtml(correctAnswerText(q))}</div>${rankHtml}</div>`;
  }
  const order = votes
    .filter(v => v.correct && v.answeredAt && v.answeredAt.toMillis)
    .sort((a, b) => a.answeredAt.toMillis() - b.answeredAt.toMillis());
  const speedRank = order.findIndex(v => String(v.seat) === String(mySeat)) + 1;
  const pq = me && me.perQuestion[qIndex];
  const time = pq && pq.speedMs !== null ? `${(pq.speedMs / 1000).toFixed(3)}秒` : "";
  const sub = [time && `タイム ${time}`, speedRank > 0 && `速さ ${speedRank}位`].filter(Boolean).join(" ・ ");
  const points = pq && pq.correct ? `<div class="my-points">+${formatPoints(pq.points)}点</div>` : "";
  const streak = pq && pq.bonus > 0 ? `<div class="streak">🔥${pq.streak}連続正解! +${formatPoints(pq.bonus)}</div>` : "";
  return `<div class="card my-result correct"><div class="my-result-mark">⭕ 正解!</div>${points}${streak}<div class="my-result-sub">${sub}</div>${rankHtml}</div>`;
}

function renderResultsBody(q, qIndex, votes, sessionId) {
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
          <div class="bar-label"><span>${o.key}. ${escapeHtml(o.text)} ${isCorrectOpt ? '<span class="correct-tag">正解</span>' : ""}</span><span>${count}人 (${pct}%)</span></div>
          <div class="bar-track"><div class="bar-fill ${isCorrectOpt ? "correct" : ""}" style="width:${pct}%"></div></div>
        </div>`;
    }).join("");
  } else if (q.type === "text") {
    const total = votes.length || 1;
    const counts = {};
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

  // スピードランキング(正解者のみ、早い順)と、その問題で取った点数
  const standings = computeStandings(sessionVotes, QUESTIONS, qIndex);
  const ranked = votes
    .filter(v => v.correct && v.answeredAt && v.answeredAt.toMillis)
    .sort((a, b) => a.answeredAt.toMillis() - b.answeredAt.toMillis())
    .slice(0, 10);
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
    ${myResultCard(q, qIndex, votes)}
    <div class="card">${header}${bars}</div>
    <div class="card">
      <div class="badge">正解者スピードランキング</div>
      ${rankHtml}
    </div>
  `);

  if (isFirstReveal(`${sessionId}_${qIndex}`)) {
    animateReveal(appEl);
    const mine = votes.find(v => String(v.seat) === String(mySeat));
    if (mine && mine.correct) celebrate("small");
  }
}

// ---------- 最終結果 ----------
function renderFinishedView() {
  const s = currentState;
  if (!s.sessionId) {
    render(`<div class="card center"><p>🎉 クイズは終了しました。お疲れ様でした!</p></div>`);
    return;
  }
  // 投影画面の優勝発表より先に順位が出ないよう、公開されるまでは待ってもらう
  if (!phonesRevealed(s)) {
    render(`
      <div class="card center finish-wait">
        <div class="finish-wait-icon">🥁</div>
        <p><b>最終結果を発表中!</b></p>
        <p class="muted">前のスクリーンを見てね</p>
      </div>`);
    return;
  }
  if (!votesLoaded) { renderWaiting("最終結果を集計しています…"); return; }

  const { list } = computeStandings(sessionVotes, QUESTIONS, s.currentQuestion);
  const me = list.find((r) => String(r.seat) === mySeat);
  const winner = me && me.rank === 1;

  const myCard = me ? `
    <div class="card my-result final ${winner ? "correct" : ""}">
      <div class="my-result-sub">あなたの最終順位</div>
      <div class="my-result-mark">${me.rank}位 <span class="small">/ ${list.length}人</span></div>
      <div class="my-points">${formatPoints(me.total)}点</div>
      <div class="my-result-sub">正解 ${me.correctCount} / ${QUESTIONS.length}問</div>
    </div>` : `<div class="card center"><p>🎉 クイズは終了しました。お疲れ様でした!</p></div>`;

  const prizeCard = winner ? `
    <div class="card prize-card">
      <div class="prize-title">🏆 優勝おめでとう!</div>
      ${prizeImageHtml()}
    </div>` : "";

  render(`
    ${prizeCard}
    ${myCard}
    <div class="card">
      <div class="badge">総合ランキング(全${QUESTIONS.length}問)</div>
      ${list.length === 0 ? `<p class="muted">まだ回答データがありません。</p>` : `
      <table class="rank">
        <thead><tr><th>順位</th><th>番号</th><th>名前</th><th>正解数</th><th>合計点</th></tr></thead>
        <tbody>
          ${list.map((r) => `
            <tr class="${String(r.seat) === mySeat ? "me" : ""}">
              <td>${r.rank}</td>
              <td>${escapeHtml(String(r.seat ?? ""))}</td>
              <td>${escapeHtml(r.name ?? "")}</td>
              <td>${r.correctCount} / ${QUESTIONS.length}</td>
              <td>${formatPoints(r.total)}</td>
            </tr>`).join("")}
        </tbody>
      </table>`}
    </div>
  `);

  if (isFirstReveal(`${s.sessionId}_final`)) {
    animateReveal(appEl);
    if (winner) celebrate("big");
  }
}

async function boot() {
  const profile = getProfile();
  if (!profile) { renderRegistration(); return; }
  mySeat = String(profile.seat);
  renderWhoami(profile);
  startPresenceHeartbeat(profile);

  onSnapshot(STATE_DOC, async (snap) => {
    if (!snap.exists()) { currentState = null; updateMyRank(); renderWaiting("クイズが始まるのをお待ちください…"); return; }
    const state = snap.data();
    currentState = state;
    watchSessionVotes(state.sessionId || null);
    updateMyRank();
    const token = ++viewToken;
    if (state.phase !== "countdown") stopCountdown();
    if (!state.sessionId || state.phase === "lobby") {
      renderWaiting("クイズが始まるのをお待ちください…");
    } else if (state.phase === "countdown") {
      const q = QUESTIONS[state.currentQuestion];
      runCountdown(appEl, `第${state.currentQuestion + 1}問 / ${QUESTIONS.length}問${q ? " ・ " + difficultyText(q) : ""}`, () => {
        // 「スタート!」のあと問題が届かないときに画面が固まったままにならないようにする
        setTimeout(() => { if (token === viewToken) renderStalled(); }, 4000);
      });
    } else if (state.phase === "voting") {
      renderVoting(state, profile, token).catch((e) => { if (token === viewToken) renderError(e); });
    } else if (state.phase === "results") {
      renderResultsView();
    } else if (state.phase === "finished") {
      renderFinishedView();
    }
  });
}

// 問題作成画面で保存した問題を読み込んでから始める
await questionsReady;
boot();
