// 生徒画面・投影画面で共通の演出(カウントダウン、グラフのアニメーション、紙吹雪、プレゼント画像)
import { PRIZE_IMAGE, PRIZE_ALT } from "./settings.js";

const COUNTDOWN_SECONDS = 3;

// 1位の人に出すプレゼント画像。画像ファイルが無いときは 🎁 を大きく出す
export function prizeImageHtml() {
  const fallback = "this.outerHTML='<div class=&quot;prize-fallback&quot;>🎁</div>'";
  return `<img class="prize-img" src="${PRIZE_IMAGE}" alt="${PRIZE_ALT}" onerror="${fallback}">`;
}
let countdownTimer = null;

export function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

// 管理者が「次の問題へ」を押すと phase が countdown になり、各画面で 3→2→1 を表示する。
// 実際の出題(voting)は3秒後に管理者画面が書き込む。
// onTick(n) は数字が変わるたびに呼ばれる(3,2,1 と スタートの 0)。投影画面が効果音に使う。
export function runCountdown(container, label, onDone, onTick) {
  stopCountdown();
  let n = COUNTDOWN_SECONDS;
  const draw = () => {
    container.innerHTML = `
      <div class="card center countdown-card">
        <div class="badge">${label}</div>
        <div class="countdown-num">${n > 0 ? n : "スタート!"}</div>
      </div>`;
    if (onTick) onTick(n);
  };
  draw();
  countdownTimer = setInterval(() => {
    n -= 1;
    if (n < 0) { stopCountdown(); if (onDone) onDone(); return; }
    draw();
  }, 1000);
}

// 同じ問題の結果が再描画されるたびにアニメーションが繰り返されないよう、初回だけ演出する
const revealed = new Set();
export function isFirstReveal(key) {
  if (revealed.has(key)) return false;
  revealed.add(key);
  return true;
}

export function animateReveal(root) {
  root.querySelectorAll(".bar-fill").forEach((el) => {
    const target = el.style.width;
    el.style.width = "0";
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.width = target; }));
  });
  root.querySelectorAll("table.rank").forEach((t) => t.classList.add("rank-reveal"));
  root.querySelectorAll(".my-result").forEach((c) => c.classList.add("pop-in"));
}

export function celebrate(size = "small") {
  if (typeof window.confetti !== "function") return;
  if (size === "big") {
    const end = Date.now() + 1500;
    (function frame() {
      window.confetti({ particleCount: 6, angle: 60, spread: 70, origin: { x: 0, y: 0.7 } });
      window.confetti({ particleCount: 6, angle: 120, spread: 70, origin: { x: 1, y: 0.7 } });
      if (Date.now() < end) requestAnimationFrame(frame);
    })();
  } else {
    window.confetti({ particleCount: 80, spread: 70, origin: { y: 0.4 } });
  }
}
