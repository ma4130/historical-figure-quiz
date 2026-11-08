// 点数と順位の計算(生徒画面・投影画面・管理者画面で共通)
//
// ・正解した問題だけ点数が付く。早く答えるほど高い。
//     点数 = 満点 × (1 − 0.5 × タイム ÷ 20秒)  ※下限は満点の半分、整数に四捨五入
// ・満点は問題の難易度で決まる(questions.js の difficulty。points を書けばその値を優先)
// ・連続正解ボーナス: 2連続で満点の10%、3連続で20%…最大50%を上乗せ。
//   不正解・未回答で連続はリセット。
// ・総合順位: 合計点が多い順。同点なら、正解した問題のタイム合計が短い順。
//   それも同じなら同じ順位にする。

export const DIFFICULTY = {
  easy:   { label: "かんたん",   stars: "★",     points: 30 },
  normal: { label: "ふつう",     stars: "★★",   points: 50 },
  hard:   { label: "むずかしい", stars: "★★★", points: 100 },
};
export const SPEED_HALF_MS = 20000;   // この時間で満点の半分になる
export const MIN_RATE = 0.5;          // 遅くても満点の半分はもらえる
export const STREAK_STEP = 0.1;       // 1連続ごとに満点の10%
export const STREAK_MAX = 0.5;        // ボーナスは最大で満点の50%

export function difficultyOf(q) {
  return DIFFICULTY[q && q.difficulty] || DIFFICULTY.normal;
}

export function fullPoints(q) {
  if (q && Number.isFinite(q.points)) return q.points;
  return difficultyOf(q).points;
}

// 第○問のバッジに付ける「★★ ふつう・50点」
export function difficultyText(q) {
  const d = difficultyOf(q);
  return `${d.stars} ${d.label}・${formatPoints(fullPoints(q))}点`;
}

function toMs(t) {
  return t && t.toMillis ? t.toMillis() : 0;
}

// 出題から回答までの時間(ミリ秒)。分からないときは null
export function voteSpeedMs(v) {
  const a = toMs(v.answeredAt);
  const s = toMs(v.questionStartAt);
  return (a > 0 && s > 0) ? Math.max(0, a - s) : null;
}

export function speedPoints(q, speedMs) {
  const full = fullPoints(q);
  if (speedMs === null) return Math.round(full * MIN_RATE);
  const rate = Math.max(MIN_RATE, 1 - 0.5 * speedMs / SPEED_HALF_MS);
  return Math.round(full * rate);
}

export function streakBonus(q, streak) {
  if (streak < 2) return 0;
  const rate = Math.min(STREAK_MAX, STREAK_STEP * (streak - 1));
  return Math.round(fullPoints(q) * rate);
}

export function formatPoints(n) {
  return Number(n || 0).toLocaleString("ja-JP");
}

// 第0問〜第uptoIndex問までの回答から、全員の点数と順位を計算する。
// 返り値: { list: 順位順の配列, bySeat: 出席番号 → 成績 }
// 成績: { seat, name, total, correctCount, totalSpeedMs, streak, rank, perQuestion[] }
// perQuestion[i]: { answered, correct, speedMs, base, bonus, points, streak }
export function computeStandings(votes, questions, uptoIndex) {
  const bySeatVotes = new Map();
  votes.forEach((v) => {
    // 送信直後でサーバー時刻がまだ付いていない回答は数えない
    if (!v.answeredAt || v.questionIndex > uptoIndex) return;
    const key = String(v.seat);
    if (!bySeatVotes.has(key)) bySeatVotes.set(key, { seat: v.seat, name: v.name, votes: new Map() });
    const e = bySeatVotes.get(key);
    e.seat = v.seat;
    e.name = v.name;
    e.votes.set(v.questionIndex, v);
  });

  const list = [];
  bySeatVotes.forEach((e) => {
    const r = { seat: e.seat, name: e.name, total: 0, correctCount: 0, totalSpeedMs: 0, streak: 0, rank: 0, perQuestion: [] };
    for (let i = 0; i <= uptoIndex; i++) {
      const v = e.votes.get(i);
      const q = questions[i];
      if (v && v.correct) {
        r.streak += 1;
        const speedMs = voteSpeedMs(v);
        const base = speedPoints(q, speedMs);
        const bonus = streakBonus(q, r.streak);
        r.total += base + bonus;
        r.correctCount += 1;
        if (speedMs !== null) r.totalSpeedMs += speedMs;
        r.perQuestion[i] = { answered: true, correct: true, speedMs, base, bonus, points: base + bonus, streak: r.streak };
      } else {
        r.streak = 0;
        r.perQuestion[i] = { answered: !!v, correct: false, speedMs: v ? voteSpeedMs(v) : null, base: 0, bonus: 0, points: 0, streak: 0 };
      }
    }
    list.push(r);
  });

  list.sort((a, b) =>
    (b.total - a.total)
    || (a.totalSpeedMs - b.totalSpeedMs)
    || String(a.seat).localeCompare(String(b.seat), "ja", { numeric: true }));
  list.forEach((r, i) => {
    const prev = list[i - 1];
    r.rank = (prev && prev.total === r.total && prev.totalSpeedMs === r.totalSpeedMs) ? prev.rank : i + 1;
  });

  const bySeat = new Map(list.map((r) => [String(r.seat), r]));
  return { list, bySeat };
}

// 前の問題のあとの順位と比べた上下を「↑3」「↓2」「→」で返す。比べられないときは ""
export function rankChangeText(votes, questions, uptoIndex, seat) {
  if (uptoIndex < 1) return "";
  const now = computeStandings(votes, questions, uptoIndex).bySeat.get(String(seat));
  const before = computeStandings(votes, questions, uptoIndex - 1).bySeat.get(String(seat));
  if (!now || !before) return "";
  const diff = before.rank - now.rank;
  if (diff > 0) return `↑${diff}`;
  if (diff < 0) return `↓${-diff}`;
  return "→";
}
