// Firebase初期化(モジュール共通)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot,
  collection,
  query,
  where,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const app = initializeApp(window.FIREBASE_CONFIG);
export const db = getFirestore(app);

export {
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot,
  collection,
  query,
  where,
  serverTimestamp,
};

export const STATE_DOC = doc(db, "quiz", "state");
export const VOTES_COL = collection(db, "votes");
export const PRESENCE_COL = collection(db, "presence");
