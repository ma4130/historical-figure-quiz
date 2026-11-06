// 問題データの読み込み(全画面共通)
//
// 問題作成画面(editor.html)で保存した問題は Firestore の quiz/questions に入る。
// 全画面はそこから問題を読み、まだ保存されていなければ questions.js の問題を使う。
// window.QUESTIONS の配列をその場で入れ替えるので、各画面は今までどおり window.QUESTIONS を使えばよい。
import { db, doc, onSnapshot } from "./firebase.js";

export const QUESTIONS_DOC = doc(db, "quiz", "questions");

const list = window.QUESTIONS;
// questions.js に書いてある問題(問題作成画面の「questions.js の内容に戻す」で使う)
export const FILE_QUESTIONS = JSON.parse(JSON.stringify(list));

let source = "file";
let savedAt = null;
const listeners = new Set();

// "firestore"(問題作成画面で保存した問題)か "file"(questions.js)
export function questionsSource() { return source; }
export function questionsSavedAt() { return savedAt; }
export function onQuestionsChange(fn) { listeners.add(fn); }

// 最初の読み込みが終わるまで待つためのもの。つながらないときは4秒で questions.js のまま進む
export const questionsReady = new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  setTimeout(finish, 4000);
  onSnapshot(QUESTIONS_DOC, (snap) => {
    const data = snap.exists() ? snap.data() : null;
    const saved = data && Array.isArray(data.questions) && data.questions.length > 0 ? data.questions : null;
    source = saved ? "firestore" : "file";
    savedAt = saved && data.updatedAt && data.updatedAt.toMillis ? data.updatedAt.toMillis() : null;
    const next = JSON.parse(JSON.stringify(saved || FILE_QUESTIONS));
    list.splice(0, list.length, ...next);
    finish();
    listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  }, () => finish());
});
