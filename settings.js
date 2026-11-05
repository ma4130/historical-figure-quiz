// 差し替えやすい設定をまとめたファイル

// 最終結果で1位の人に出すプレゼント画像。
// このフォルダに同じ名前の画像(prize.jpg)を置くだけで差し替わる。別の名前にしたいときはここを書き換える。
// 画像が無いときは 🎁 を大きく表示する。
export const PRIZE_IMAGE = "prize.jpg";
export const PRIZE_ALT = "優勝のプレゼント";

// 最終結果の流れ(ネタバレ防止)
// 1. 先生が「クイズを終了する」を押す → 投影画面でドラムロール(DRUMROLL_MS)→ 優勝発表
// 2. 終了から PHONE_REVEAL_DELAY_MS たつと、管理者画面がスマホにも結果を公開する
//    (管理者画面の「スマホに結果を公開する」ボタンで、すぐ公開することもできる)
export const DRUMROLL_MS = 3500;
export const PHONE_REVEAL_DELAY_MS = 8000;
