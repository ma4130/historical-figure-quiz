// 問題作成画面: 問題・正解・点数・順番を変えて Firestore(quiz/questions)に保存する。
// 保存した問題は、生徒・投影・管理者の全画面がすぐ使う(GitHub に送り直す必要はない)。
import { STATE_DOC, setDoc, onSnapshot, serverTimestamp } from "./firebase.js";
import { QUESTIONS_DOC, FILE_QUESTIONS, questionsReady, questionsSource, questionsSavedAt } from "./questions-store.js";
import { DIFFICULTY, formatPoints } from "./scoring.js";

const KEYS = "ABCDEF";
const MAX_OPTIONS = KEYS.length;
const TYPES = [
  ["single", "1つ選ぶ(4択など)"],
  ["multi", "当てはまるものを全部選ぶ"],
  ["text", "文字で答える"],
  ["order", "並べ替え"],
];

const appEl = document.getElementById("app");
const saveBarEl = document.getElementById("saveBar");

let qs = [];          // 編集中の問題
let dirty = false;    // 保存していない変更があるか
let editVersion = 0;  // 編集するたびに増える番号(保存中の編集を見分ける)
let quizState = null; // 進行状態(クイズ中の保存に注意を出すため)
let showErrors = false;
let lastMessage = "";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- 問題データ ⇔ 編集用のデータ ----------
function defaultPoints(difficulty) {
  return (DIFFICULTY[difficulty] || DIFFICULTY.normal).points;
}

function toModel(q) {
  const difficulty = DIFFICULTY[q.difficulty] ? q.difficulty : "normal";
  const correct = q.correct || [];
  const m = {
    type: q.type || "single",
    text: q.text || "",
    difficulty,
    points: Number.isFinite(q.points) ? q.points : defaultPoints(difficulty),
    options: [],
    answers: q.type === "text" ? [...correct] : [""],
    numeric: q.inputMode === "numeric",
  };
  if (m.type === "order") {
    m.options = (q.items || []).map((it) => ({ text: it.text, correct: false, pos: correct.indexOf(it.key) + 1 || "" }));
  } else if (m.type !== "text") {
    m.options = (q.options || []).map((o) => ({ text: o.text, correct: correct.includes(o.key), pos: "" }));
  }
  if (m.options.length === 0) m.options = blankOptions(4);
  return m;
}

function blankOptions(n) {
  return Array.from({ length: n }, (_, i) => ({ text: "", correct: false, pos: i + 1 }));
}

function newQuestion() {
  return { type: "single", text: "", difficulty: "normal", points: defaultPoints("normal"), options: blankOptions(4), answers: [""], numeric: false };
}

function toQuestion(m, i) {
  const q = { id: `q${i + 1}`, type: m.type, difficulty: m.difficulty, text: m.text.trim() };
  if (Number(m.points) !== defaultPoints(m.difficulty)) q.points = Number(m.points);
  if (m.type === "single" || m.type === "multi") {
    q.options = m.options.map((o, j) => ({ key: KEYS[j], text: o.text.trim() }));
    q.correct = m.options.map((o, j) => (o.correct ? KEYS[j] : null)).filter(Boolean);
  } else if (m.type === "text") {
    q.correct = m.answers.map((a) => a.trim()).filter(Boolean);
    if (m.numeric) q.inputMode = "numeric";
  } else if (m.type === "order") {
    q.items = m.options.map((o, j) => ({ key: KEYS[j], text: o.text.trim() }));
    q.correct = m.options
      .map((o, j) => ({ key: KEYS[j], pos: Number(o.pos) }))
      .sort((a, b) => a.pos - b.pos)
      .map((x) => x.key);
  }
  return q;
}

// 保存できない問題には理由を返す
function problems(m) {
  const out = [];
  if (!m.text.trim()) out.push("問題文が空です");
  const p = Number(m.points);
  if (!Number.isInteger(p) || p < 1 || p > 100000) out.push("満点は1〜100000の整数にしてください");
  if (m.type === "text") {
    if (!m.answers.some((a) => a.trim())) out.push("正解を1つ以上書いてください");
    return out;
  }
  if (m.options.length < 2) out.push("選択肢は2つ以上必要です");
  if (m.options.some((o) => !o.text.trim())) out.push("空の選択肢があります");
  if (m.type === "single" && m.options.filter((o) => o.correct).length !== 1) out.push("正解を1つ選んでください");
  if (m.type === "multi" && !m.options.some((o) => o.correct)) out.push("正解を1つ以上選んでください");
  if (m.type === "order") {
    const pos = m.options.map((o) => Number(o.pos));
    const ok = pos.every((x) => Number.isInteger(x) && x >= 1 && x <= pos.length) && new Set(pos).size === pos.length;
    if (!ok) out.push("正しい順番に重なりか抜けがあります");
  }
  return out;
}

// ---------- 画面 ----------
function inProgress() {
  return quizState && quizState.sessionId && ["countdown", "voting", "results"].includes(quizState.phase);
}

function statusHtml() {
  const total = qs.reduce((a, m) => a + (Number(m.points) || 0), 0);
  const src = questionsSource() === "firestore"
    ? `いま全画面で使っているのは、この画面で保存した問題です${questionsSavedAt() ? `(${new Date(questionsSavedAt()).toLocaleString("ja-JP")} に保存)` : ""}。`
    : "いま全画面で使っているのは questions.js の問題です(まだ一度も保存していません)。";
  const warn = inProgress()
    ? `<p class="editor-warn">⚠ いまクイズの最中です(第${quizState.currentQuestion + 1}問)。ここで問題や順番を変えると、点数や結果がずれます。終わってから保存してください。</p>`
    : "";
  return `
    <div class="card">
      <div class="badge">全${qs.length}問 ・ 満点の合計 ${formatPoints(total)}点(連続正解ボーナスは別)</div>
      <p class="muted">${src}<br>保存すると、生徒・投影・管理者の全画面にすぐ反映されます。</p>
      ${warn}
      <div class="editor-tools">
        <button type="button" class="btn secondary" data-act="reload">保存してある問題を読み直す</button>
        <button type="button" class="btn secondary" data-act="resetfile">questions.js の問題に戻す</button>
        <button type="button" class="btn secondary" data-act="download">questions.js として書き出す</button>
      </div>
    </div>`;
}

function optionRows(m, qi) {
  const rows = m.options.map((o, oi) => {
    let mark = "";
    if (m.type === "single") {
      mark = `<label class="opt-mark" title="正解"><input type="radio" name="correct-${qi}" data-f="correct" data-q="${qi}" data-o="${oi}" ${o.correct ? "checked" : ""}> 正解</label>`;
    } else if (m.type === "multi") {
      mark = `<label class="opt-mark" title="正解"><input type="checkbox" data-f="correct" data-q="${qi}" data-o="${oi}" ${o.correct ? "checked" : ""}> 正解</label>`;
    } else if (m.type === "order") {
      mark = `<label class="opt-mark">正しい順番
        <select data-f="pos" data-q="${qi}" data-o="${oi}">
          <option value="">-</option>
          ${m.options.map((_, k) => `<option value="${k + 1}" ${Number(o.pos) === k + 1 ? "selected" : ""}>${k + 1}</option>`).join("")}
        </select></label>`;
    }
    return `
      <div class="opt-row ${o.correct && m.type !== "order" ? "is-correct" : ""}" data-key="${KEYS[oi]}">
        <span class="option-key">${KEYS[oi]}</span>
        <input type="text" value="${escapeHtml(o.text)}" placeholder="${m.type === "order" ? "項目" : "選択肢"} ${KEYS[oi]}" data-f="opt" data-q="${qi}" data-o="${oi}">
        ${mark}
        <button type="button" class="icon-btn" title="この${m.type === "order" ? "項目" : "選択肢"}を消す" data-act="delopt" data-q="${qi}" data-o="${oi}" ${m.options.length <= 2 ? "disabled" : ""}>✕</button>
      </div>`;
  }).join("");
  const add = m.options.length < MAX_OPTIONS
    ? `<button type="button" class="btn secondary small-btn" data-act="addopt" data-q="${qi}">＋ ${m.type === "order" ? "項目" : "選択肢"}を追加</button>` : "";
  const hint = m.type === "order" ? `<p class="muted">生徒には上から A, B, C… の順で表示されます。正しい順番をそれぞれ選んでください。</p>` : "";
  return hint + rows + add;
}

function questionCard(m, qi) {
  const errs = showErrors ? problems(m) : [];
  const body = m.type === "text"
    ? `
      <label class="field-label">正解(1行に1つ。どれかと一致すれば正解)</label>
      <textarea rows="3" data-f="answers" data-q="${qi}" placeholder="例: エジソン">${escapeHtml(m.answers.join("\n"))}</textarea>
      <label class="check"><input type="checkbox" data-f="numeric" data-q="${qi}" ${m.numeric ? "checked" : ""}> 数字で答える問題(スマホに数字のキーボードを出す)</label>`
    : optionRows(m, qi);
  return `
    <div class="card q-card ${errs.length ? "has-error" : ""}" id="q-${qi}">
      <div class="q-head">
        <div class="badge">第${qi + 1}問</div>
        <div class="q-actions">
          <button type="button" class="icon-btn" title="ひとつ前へ" data-act="up" data-q="${qi}" ${qi === 0 ? "disabled" : ""}>↑</button>
          <button type="button" class="icon-btn" title="ひとつ後ろへ" data-act="down" data-q="${qi}" ${qi === qs.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" class="icon-btn" title="複製" data-act="dup" data-q="${qi}">⧉</button>
          <button type="button" class="icon-btn danger-text" title="この問題を消す" data-act="del" data-q="${qi}" ${qs.length <= 1 ? "disabled" : ""}>🗑</button>
        </div>
      </div>
      ${errs.length ? `<ul class="q-errors">${errs.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : ""}
      <div class="q-grid">
        <label class="field-label">種類
          <select data-f="type" data-q="${qi}">
            ${TYPES.map(([v, l]) => `<option value="${v}" ${m.type === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </label>
        <label class="field-label">難易度
          <select data-f="difficulty" data-q="${qi}">
            ${Object.entries(DIFFICULTY).map(([k, d]) => `<option value="${k}" ${m.difficulty === k ? "selected" : ""}>${d.stars} ${d.label}(${d.points}点)</option>`).join("")}
          </select>
        </label>
        <label class="field-label">満点
          <input type="number" min="1" step="1" value="${escapeHtml(m.points)}" data-f="points" data-q="${qi}">
        </label>
      </div>
      <label class="field-label">問題文</label>
      <textarea rows="2" data-f="text" data-q="${qi}" placeholder="問題文を入力">${escapeHtml(m.text)}</textarea>
      ${body}
    </div>`;
}

function render() {
  const y = window.scrollY;
  appEl.innerHTML = `
    ${statusHtml()}
    ${qs.map(questionCard).join("")}
    <button type="button" class="btn" data-act="add">＋ 問題を追加</button>`;
  window.scrollTo(0, y);
  renderSaveBar();
}

function renderSaveBar() {
  const errCount = qs.filter((m) => problems(m).length).length;
  saveBarEl.innerHTML = `
    <div class="save-bar-inner">
      <span class="save-msg ${dirty ? "dirty" : ""}">${dirty ? "● 保存していない変更があります" : (lastMessage || "保存済み")}${errCount && showErrors ? ` ・ 直すところ ${errCount}問` : ""}</span>
      <button type="button" class="btn save-btn" data-act="save" ${dirty ? "" : "disabled"}>保存する</button>
    </div>`;
}

function setDirty() {
  dirty = true;
  editVersion++;
  lastMessage = "";
  renderSaveBar();
}

// ---------- 操作 ----------
function convertType(m, type) {
  if (m.type === type) return;
  if (type === "text") {
    const picked = m.options.filter((o) => o.correct && o.text.trim()).map((o) => o.text);
    if (picked.length && !m.answers.some((a) => a.trim())) m.answers = picked;
  }
  if (type === "order") m.options.forEach((o, i) => { o.pos = i + 1; o.correct = false; });
  if (type === "single") {
    let seen = false;
    m.options.forEach((o) => { if (o.correct && !seen) seen = true; else o.correct = false; });
  }
  if (m.type === "order" && (type === "single" || type === "multi")) m.options.forEach((o) => { o.correct = false; });
  m.type = type;
}

function onInput(e) {
  const t = e.target;
  const qi = Number(t.dataset.q);
  const m = qs[qi];
  if (!m) return;
  const f = t.dataset.f;
  if (f === "text") m.text = t.value;
  else if (f === "opt") m.options[Number(t.dataset.o)].text = t.value;
  else if (f === "answers") m.answers = t.value.split("\n");
  else if (f === "points") {
    m.points = t.value === "" ? "" : Number(t.value);
    appEl.querySelector(".badge").textContent =
      `全${qs.length}問 ・ 満点の合計 ${formatPoints(qs.reduce((a, x) => a + (Number(x.points) || 0), 0))}点(連続正解ボーナスは別)`;
  } else return;
  setDirty();
}

function onChange(e) {
  const t = e.target;
  const qi = Number(t.dataset.q);
  const m = qs[qi];
  if (!m) return;
  const f = t.dataset.f;
  if (f === "type") convertType(m, t.value);
  else if (f === "difficulty") { m.difficulty = t.value; m.points = defaultPoints(t.value); }
  else if (f === "correct") {
    const oi = Number(t.dataset.o);
    if (m.type === "single") m.options.forEach((o, i) => { o.correct = i === oi; });
    else m.options[oi].correct = t.checked;
  } else if (f === "pos") m.options[Number(t.dataset.o)].pos = t.value;
  else if (f === "numeric") m.numeric = t.checked;
  else return; // 文字の入力は onInput で受け取る
  setDirty();
  render();
}

async function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn || btn.disabled) return;
  const act = btn.dataset.act;
  const qi = Number(btn.dataset.q);
  if (act === "save") { await save(); return; }
  if (act === "add") {
    qs.push(newQuestion());
    setDirty(); render();
    document.getElementById(`q-${qs.length - 1}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (act === "up" || act === "down") {
    const to = act === "up" ? qi - 1 : qi + 1;
    [qs[qi], qs[to]] = [qs[to], qs[qi]];
    setDirty(); render();
    return;
  }
  if (act === "dup") {
    qs.splice(qi + 1, 0, JSON.parse(JSON.stringify(qs[qi])));
    setDirty(); render();
    return;
  }
  if (act === "del") {
    if (!confirm(`第${qi + 1}問を消しますか?\n(保存するまでは、全画面の問題は変わりません)`)) return;
    qs.splice(qi, 1);
    setDirty(); render();
    return;
  }
  if (act === "addopt") {
    const m = qs[qi];
    m.options.push({ text: "", correct: false, pos: m.options.length + 1 });
    setDirty(); render();
    return;
  }
  if (act === "delopt") {
    const m = qs[qi];
    const oi = Number(btn.dataset.o);
    const removed = m.options.splice(oi, 1)[0];
    if (m.type === "order" && removed) {
      const gone = Number(removed.pos);
      m.options.forEach((o) => { if (Number(o.pos) > gone) o.pos = Number(o.pos) - 1; });
    }
    setDirty(); render();
    return;
  }
  if (act === "reload") {
    if (dirty && !confirm("保存していない変更を捨てて、保存してある問題を読み直しますか?")) return;
    loadFrom(window.QUESTIONS);
    return;
  }
  if (act === "resetfile") {
    if (!confirm("questions.js に書いてある問題に戻しますか?\n(「保存する」を押すまでは、全画面の問題は変わりません)")) return;
    qs = FILE_QUESTIONS.map(toModel);
    showErrors = false;
    setDirty(); render();
    return;
  }
  if (act === "download") { download(); return; }
}

function loadFrom(list) {
  qs = list.map(toModel);
  dirty = false;
  showErrors = false;
  lastMessage = "";
  render();
}

function buildQuestions() {
  return qs.map(toQuestion);
}

async function save() {
  const bad = qs.map((m, i) => ({ i, errs: problems(m) })).filter((x) => x.errs.length);
  if (bad.length) {
    showErrors = true;
    render();
    alert(`まだ保存できません。直すところがあります:\n\n${bad.slice(0, 5).map((x) => `第${x.i + 1}問: ${x.errs.join("、")}`).join("\n")}`);
    document.getElementById(`q-${bad[0].i}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (inProgress() && !confirm(`いまクイズの最中です(第${quizState.currentQuestion + 1}問)。\n保存すると、点数や結果がずれることがあります。それでも保存しますか?`)) return;
  const btn = saveBarEl.querySelector(".save-btn");
  if (btn) { btn.disabled = true; btn.textContent = "保存中…"; }
  const savingVersion = editVersion;
  try {
    await setDoc(QUESTIONS_DOC, { questions: buildQuestions(), updatedAt: serverTimestamp() });
    if (editVersion !== savingVersion) {
      // 保存中にさらに編集した分は、まだ保存されていない
      renderSaveBar();
      return;
    }
    dirty = false;
    showErrors = false;
    lastMessage = `✓ 保存しました(${new Date().toLocaleTimeString("ja-JP")})。全画面に反映されます。`;
    render();
  } catch (e) {
    alert("保存できませんでした。電波を確認して、もう一度押してください。\n" + (e && e.message ? e.message : e));
    renderSaveBar();
  }
}

// いまの問題を questions.js の形でダウンロードする(バックアップや、GitHub の questions.js を更新したいとき用)
function download() {
  const header = `// クイズの問題データ(問題作成画面から書き出し: ${new Date().toLocaleString("ja-JP")})\n` +
    `// type: "single"=1つ選ぶ, "multi"=全部選ぶ, "text"=文字で答える, "order"=並べ替え\n` +
    `// difficulty: "easy"(30点) / "normal"(50点) / "hard"(100点)。points を書くとその点数が満点になる\n`;
  const body = `window.QUESTIONS = ${JSON.stringify(buildQuestions(), null, 2)};\n`;
  const blob = new Blob([header + body], { type: "text/javascript;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "questions.js";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

appEl.addEventListener("input", onInput);
appEl.addEventListener("change", onChange);
appEl.addEventListener("click", onClick);
saveBarEl.addEventListener("click", onClick);
window.addEventListener("beforeunload", (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

onSnapshot(STATE_DOC, (snap) => {
  quizState = snap.exists() ? snap.data() : null;
  if (qs.length) {
    // 文字を打っている最中に描き直さないよう、注意書きのカードだけ入れ替える
    const first = appEl.querySelector(".card");
    if (first) first.outerHTML = statusHtml();
  }
});

await questionsReady;
loadFrom(window.QUESTIONS);
