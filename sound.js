// 効果音(投影画面 display.html だけで鳴らす。生徒のスマホからは鳴らさない)
//
// ・音はブラウザで合成して鳴らす(Web Audio API)ので、ファイルは要らない。
// ・sounds フォルダに下の名前の mp3 を置くと、合成音の代わりにそれを鳴らす。
//     tick.mp3      カウントダウンの 3・2・1(ピッ)
//     go.mp3        カウントダウンのスタート(ポーン)
//     vote.mp3      投票中に回答が届いたとき(小さな音)
//     reveal.mp3    結果発表で正解が出る瞬間
//     drumroll.mp3  最終結果のドラムロール
//     fanfare.mp3   優勝発表のファンファーレ
// ・ブラウザは画面を一度クリックするまで音を出せないので、「🔊 音を有効にする」を押すまでは鳴らさない。

const SOUND_NAMES = ["tick", "go", "vote", "reveal", "drumroll", "fanfare"];
const PREF_KEY = "quizSoundPrefs";

let ctx = null;
let master = null;
const buffers = {};
const listeners = new Set();
let prefs = loadPrefs();

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    return { volume: Number.isFinite(p.volume) ? p.volume : 0.7, muted: !!p.muted };
  } catch {
    return { volume: 0.7, muted: false };
  }
}
function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {}
}
function applyVolume() {
  if (master) master.gain.value = prefs.muted ? 0 : prefs.volume;
}
function notify() {
  listeners.forEach((fn) => { try { fn(); } catch {} });
}

export function isSoundEnabled() {
  return !!ctx && ctx.state === "running";
}

export function onSoundChange(fn) {
  listeners.add(fn);
}

// ボタンのクリックの中で呼ぶこと
export async function enableSound() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { alert("このブラウザは効果音に対応していません。"); return; }
  if (!ctx) {
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
    applyVolume();
    loadFiles();
  }
  if (ctx.state !== "running") await ctx.resume();
  notify();
  play("tick");
}

// sounds フォルダに置かれた mp3 があれば読み込む(無ければ合成音のまま)
function loadFiles() {
  SOUND_NAMES.forEach(async (name) => {
    try {
      const res = await fetch(`sounds/${name}.mp3`, { cache: "no-cache" });
      if (!res.ok) return;
      buffers[name] = await ctx.decodeAudioData(await res.arrayBuffer());
    } catch {}
  });
}

export function setVolume(v) {
  prefs.volume = Math.min(1, Math.max(0, v));
  if (prefs.volume > 0) prefs.muted = false;
  applyVolume(); savePrefs(); notify();
}
export function toggleMute() {
  prefs.muted = !prefs.muted;
  applyVolume(); savePrefs(); notify();
}

export function play(name) {
  if (!isSoundEnabled()) return;
  if (buffers[name]) {
    const src = ctx.createBufferSource();
    src.buffer = buffers[name];
    src.connect(master);
    src.start();
    return;
  }
  const fn = SYNTH[name];
  if (fn) fn(ctx.currentTime + 0.01);
}

// ---------- 合成音 ----------
function tone(t, freq, dur, { type = "sine", vol = 0.4, attack = 0.005, slideTo = null } = {}) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

let noiseBuf = null;
function noise(t, dur, { vol = 0.3, filter = 1800, q = 0.7 } = {}) {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = filter;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t);
  src.stop(t + dur + 0.05);
}

const SYNTH = {
  // ピッ
  tick: (t) => tone(t, 880, 0.15, { vol: 0.35 }),
  // ポーン
  go: (t) => {
    tone(t, 1318.5, 1.2, { vol: 0.4 });
    tone(t, 659.25, 1.2, { vol: 0.25, type: "triangle" });
  },
  // 回答が届いたときの小さな音
  vote: (t) => tone(t, 700, 0.08, { vol: 0.12, slideTo: 1100 }),
  // 正解発表(ジャン!と上がるアルペジオ)
  reveal: (t) => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(t + i * 0.08, f, 0.5, { type: "triangle", vol: 0.3 }));
    tone(t + 0.32, 1046.5, 1.0, { vol: 0.2 });
  },
  // ドラムロール(だんだん大きく、最後にシンバル)
  drumroll: (t) => {
    const dur = 3.2;
    for (let s = 0; s < dur; s += 0.045) {
      noise(t + s, 0.06, { vol: 0.08 + 0.25 * (s / dur), filter: 900, q: 0.9 });
    }
  },
  // 優勝のファンファーレ(タタタ・ターン)
  fanfare: (t) => {
    const notes = [
      [0.00, 523.25, 0.14], [0.16, 523.25, 0.14], [0.32, 523.25, 0.14],
      [0.48, 698.46, 0.9],
    ];
    notes.forEach(([d, f, len]) => {
      tone(t + d, f, len, { type: "sawtooth", vol: 0.16 });
      tone(t + d, f * 2, len, { type: "triangle", vol: 0.1 });
    });
    // 最後の和音
    [698.46, 880, 1046.5, 1396.9].forEach((f) => tone(t + 1.0, f, 1.8, { type: "triangle", vol: 0.16 }));
    noise(t + 1.0, 1.6, { vol: 0.18, filter: 6000, q: 0.5 });
  },
};

// ---------- 画面右下の音のボタン(音量・ミュート) ----------
export function mountSoundControls() {
  const box = document.createElement("div");
  box.className = "sound-ctrl";
  document.body.appendChild(box);
  const draw = () => {
    if (!isSoundEnabled()) {
      box.innerHTML = `<button type="button" class="sound-enable">🔊 音を有効にする</button>`;
      box.querySelector("button").onclick = () => enableSound();
      return;
    }
    const slider = box.querySelector("input");
    if (slider) {
      // 音量を動かしている最中に描き直すとドラッグが切れるので、アイコンだけ更新する
      box.querySelector(".sound-mute").textContent = prefs.muted || prefs.volume === 0 ? "🔇" : "🔊";
      if (document.activeElement !== slider) slider.value = Math.round((prefs.muted ? 0 : prefs.volume) * 100);
      return;
    }
    box.innerHTML = `
      <button type="button" class="sound-mute" title="ミュート切り替え">${prefs.muted || prefs.volume === 0 ? "🔇" : "🔊"}</button>
      <input type="range" min="0" max="100" step="5" value="${Math.round((prefs.muted ? 0 : prefs.volume) * 100)}" aria-label="音量">`;
    box.querySelector(".sound-mute").onclick = () => toggleMute();
    box.querySelector("input").oninput = (e) => setVolume(Number(e.target.value) / 100);
  };
  onSoundChange(draw);
  draw();
}
