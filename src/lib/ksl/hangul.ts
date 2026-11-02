/**
 * 한글 자모 처리 (외부 라이브러리 없음, 직접 구현).
 * - 음절 ↔ 초성·중성·종성 분해/결합
 * - 자모 단위 편집 거리: 음성 인식 오타("택씨"→"택시") 교정에 사용
 */

const BASE = 0xac00;
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];

export interface Syllable { cho: number; jung: number; jong: number }

export function isHangul(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= BASE && c <= 0xd7a3;
}

export function decompose(ch: string): Syllable | null {
  if (!isHangul(ch)) return null;
  const n = ch.charCodeAt(0) - BASE;
  return { cho: Math.floor(n / 588), jung: Math.floor((n % 588) / 28), jong: n % 28 };
}

export function compose(s: Syllable): string {
  return String.fromCharCode(BASE + s.cho * 588 + s.jung * 28 + s.jong);
}

export const jungOf = (ch: string) => JUNG[decompose(ch)?.jung ?? -1] ?? "";
export const jongOf = (ch: string) => JONG[decompose(ch)?.jong ?? 0] ?? "";

/** 마지막 음절에 받침을 붙인다(받침이 없을 때만). 예: 타+ㅆ → 탔 */
export function addJong(word: string, jong: string): string | null {
  const last = word.at(-1);
  const s = last ? decompose(last) : null;
  const j = JONG.indexOf(jong);
  if (!s || s.jong !== 0 || j <= 0) return null;
  return word.slice(0, -1) + compose({ ...s, jong: j });
}

/** 마지막 음절의 중성을 바꾼다. 예: 오 → 와 */
export function setJung(word: string, jung: string, jong = ""): string | null {
  const last = word.at(-1);
  const s = last ? decompose(last) : null;
  const v = JUNG.indexOf(jung);
  const j = JONG.indexOf(jong);
  if (!s || v < 0 || j < 0) return null;
  return word.slice(0, -1) + compose({ cho: s.cho, jung: v, jong: j });
}

/** 마지막 음절의 받침을 뗀다. 예: 알 → 아 */
export function dropJong(word: string): string | null {
  const last = word.at(-1);
  const s = last ? decompose(last) : null;
  if (!s || s.jong === 0) return null;
  return word.slice(0, -1) + compose({ ...s, jong: 0 });
}

/** 자모 문자열로 펼친다(편집 거리 계산용). */
export function toJamo(word: string): string {
  let out = "";
  for (const ch of word) {
    const s = decompose(ch);
    out += s ? CHO[s.cho] + JUNG[s.jung] + JONG[s.jong] : ch;
  }
  return out;
}

/** 자모 단위 레벤슈타인 거리 */
export function jamoDistance(a: string, b: string): number {
  const x = toJamo(a);
  const y = toJamo(b);
  const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[y.length];
}
