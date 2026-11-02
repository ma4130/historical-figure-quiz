// クイズの問題データ
// ※いまは動作確認用の「仮の問題」です。本番の問題が決まったら、ここを書き換えてください。
//
// type: "single"=単一選択, "multi"=複数選択, "text"=記述(短答), "order"=並び替え
// difficulty: "easy"(かんたん・満点500点) / "normal"(ふつう・1000点) / "hard"(むずかしい・1500点)
//   ※満点を自由に決めたいときは points: 1200 のように書くと、そちらが優先されます
// 記述問題の correct には、正解にしたい書き方を複数並べられます(例: ["大谷翔平", "おおたにしょうへい"])
//   全角・半角の違いと空白は自動でそろえて判定します。
window.QUESTIONS = [
  {
    id: "q1",
    type: "single",
    difficulty: "easy",
    text: "【仮の問題1】これは動作確認用の問題です。「B」を選んでください。",
    options: [
      { key: "A", text: "選択肢A" },
      { key: "B", text: "選択肢B(正解)" },
      { key: "C", text: "選択肢C" },
      { key: "D", text: "選択肢D" },
    ],
    correct: ["B"],
  },
  {
    id: "q2",
    type: "single",
    difficulty: "normal",
    text: "【仮の問題2】これは動作確認用の問題です。「C」を選んでください。",
    options: [
      { key: "A", text: "選択肢A" },
      { key: "B", text: "選択肢B" },
      { key: "C", text: "選択肢C(正解)" },
      { key: "D", text: "選択肢D" },
    ],
    correct: ["C"],
  },
  {
    id: "q3",
    type: "multi",
    difficulty: "normal",
    text: "【仮の問題3】これは動作確認用の問題です。「A」と「D」を選んでください。(複数選択)",
    options: [
      { key: "A", text: "選択肢A(正解)" },
      { key: "B", text: "選択肢B" },
      { key: "C", text: "選択肢C" },
      { key: "D", text: "選択肢D(正解)" },
    ],
    correct: ["A", "D"],
  },
  {
    id: "q4",
    type: "text",
    difficulty: "hard",
    text: "【仮の問題4】これは動作確認用の問題です。「てすと」と入力してください。",
    correct: ["てすと", "テスト"],
  },
  {
    id: "q5",
    type: "order",
    difficulty: "hard",
    text: "【仮の問題5】これは動作確認用の問題です。A→B→C→Dの順に並べてください。",
    items: [
      { key: "A", text: "項目A" },
      { key: "B", text: "項目B" },
      { key: "C", text: "項目C" },
      { key: "D", text: "項目D" },
    ],
    correct: ["A", "B", "C", "D"],
  },
];
