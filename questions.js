// クイズの問題データ(「偉人クイズ元.pdf」より)
//
// type: "single"=単一選択, "multi"=複数選択, "text"=記述(短答), "order"=並び替え
// difficulty: "easy"(かんたん・満点30点) / "normal"(ふつう・50点) / "hard"(むずかしい・100点)
//   ※満点を自由に決めたいときは points: 80 のように書くと、そちらが優先されます
// 記述問題の correct には、正解にしたい書き方を複数並べられます(例: ["大谷翔平", "おおたにしょうへい"])
//   全角・半角の違いと空白は自動でそろえて判定します。
window.QUESTIONS = [
  {
    id: "q1",
    type: "single",
    difficulty: "easy",
    text: "67歳のとき研究所が火事で全焼してしまいました。その時エジソンはなんて言ったでしょう?",
    options: [
      { key: "A", text: "無駄なものが全部なくなった。新しい研究が始められる" },
      { key: "B", text: "そんな～研究所が無くなちゃった" },
      { key: "C", text: "ま～いっか" },
      { key: "D", text: "どーしよー寝る場所がなくなった" },
    ],
    correct: ["A"],
  },
  {
    id: "q2",
    type: "single",
    difficulty: "normal",
    text: "ニコラ・テスラは何を愛した?",
    options: [
      { key: "A", text: "スズメ" },
      { key: "B", text: "鳩" },
      { key: "C", text: "カラス" },
      { key: "D", text: "鷹" },
    ],
    correct: ["B"],
  },
  {
    id: "q3",
    type: "single",
    difficulty: "normal",
    text: "ニコラ・テスラは何をした?",
    options: [
      { key: "A", text: "電球の開発" },
      { key: "B", text: "鳩の餌開発" },
      { key: "C", text: "無線操縦" },
      { key: "D", text: "車" },
    ],
    correct: ["C"],
  },
  {
    id: "q4",
    type: "single",
    difficulty: "hard",
    text: "松永安左エ門は官僚になんと公言した?",
    options: [
      { key: "A", text: "人間のクズ" },
      { key: "B", text: "無能なクズ" },
      { key: "C", text: "成れの果て" },
      { key: "D", text: "役立たず" },
    ],
    correct: ["A"],
  },
  {
    id: "q5",
    type: "single",
    difficulty: "normal",
    text: "松永安左エ門の異名は何?",
    options: [
      { key: "A", text: "電力の源" },
      { key: "B", text: "電力の塊" },
      { key: "C", text: "電力のパイオニア" },
      { key: "D", text: "電力の鬼" },
    ],
    correct: ["D"],
  },
  {
    id: "q6",
    type: "single",
    difficulty: "easy",
    text: "トーマス・エジソンは何を普及させようとした?",
    options: [
      { key: "A", text: "ガス灯" },
      { key: "B", text: "白熱電球" },
      { key: "C", text: "白熱蛍光灯" },
      { key: "D", text: "パソコン" },
    ],
    correct: ["B"],
  },
  {
    id: "q7",
    type: "single",
    difficulty: "hard",
    text: "エジソンは研究に没頭して何を忘れた?",
    options: [
      { key: "A", text: "電気の仕組み" },
      { key: "B", text: "言葉" },
      { key: "C", text: "妻の存在" },
      { key: "D", text: "研究の目的" },
    ],
    correct: ["C"],
  },
];
