/**
 * Protected-topic matching that works in English AND Arabic (2026-10-01 (c), plan sections 10/44).
 *
 * Until now a protected topic was a literal, case-insensitive substring: "Family" caught "your family" but
 * not "عائلتك" or "اهلك", so replying in Arabic would have quietly bypassed the hard rule. Two changes:
 *   1. Arabic text is normalized before comparing (diacritics, tatweel, alef/ya/ta-marbuta spellings), so the
 *      same word written two common ways matches, and a topic a player types in Arabic works as written.
 *   2. A small built-in table of topic GROUPS: if a player's protected topic mentions any word of a group
 *      (in either language), every word of that group is forbidden in either language.
 * This is a best-effort keyword layer, NOT a translator: it cannot catch a rephrasing it has no word for.
 * That's why the model is also told, in every prompt, that protected topics apply in every language.
 */

/** Lowercase, drop Arabic diacritics/tatweel, fold alef/ya/ta-marbuta/hamza variants. Latin text only gets lowercased. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // harakat, superscript alef, tatweel
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627") // أ إ آ ٱ -> ا
    .replace(/\u0649/g, "\u064A") // ى -> ي
    .replace(/\u0629/g, "\u0647") // ة -> ه
    .replace(/\u0624/g, "\u0648") // ؤ -> و
    .replace(/\u0626/g, "\u064A"); // ئ -> ي
}

interface TopicGroup {
  en: string[];
  ar: string[];
}

// Arabic terms are written plainly; normalizeText is applied to them at load time.
const GROUPS: TopicGroup[] = [
  { en: ["family"], ar: ["عائل", "عايل", "اهلك", "اهله", "اسرت", "اسره", "والدك", "والدت", "ابوك", "امك", "اخوك", "اختك", "اخوه", "اهل "] },
  { en: ["health"], ar: ["صحت", "صحه", "مرض", "مريض", "المستشفي", "دكتور", "علاج", "مرضك"] },
  { en: ["relationship", "girlfriend", "boyfriend", "dating"], ar: ["علاق", "حبيب", "خطيب", "خطيبت", "صاحبتك", "صاحبك", "جوازك", "زوجت", "زوجه", "زوجك", "جواز"] },
  { en: ["university", "school", "college", "exam", "study"], ar: ["جامع", "كليت", "كليه", "امتحان", "مذاكر", "دراست", "محاضر", "مدرس", "ثانويه"] },
  { en: ["religion", "faith"], ar: ["دين", "ديني", "صلاه", "الصلاه", "صيام", "قران", "ربنا", "الله"] },
  { en: ["politic"], ar: ["سياس", "حكوم", "انتخاب", "رئيس"] },
  { en: ["money", "salary", "debt"], ar: ["فلوس", "مرتب", "راتب", "ديون", "دين عليك", "مصاري", "ماليه"] },
  { en: ["job", "work"], ar: ["شغلك", "وظيف", "عملك", "مديرك", "الشغل"] },
  { en: ["weight", "appearance", "looks"], ar: ["وزنك", "وزن", "شكلك", "تخين", "تخن", "سمين", "نحيف"] },
];

const NORMALIZED_GROUPS: TopicGroup[] = GROUPS.map((g) => ({ en: g.en.map(normalizeText), ar: g.ar.map(normalizeText) }));

/** True when `text` touches any of the protected topics, in English or Arabic. */
export function mentionsForbiddenTopic(text: string, forbiddenTopics: string[]): boolean {
  const haystack = normalizeText(text);
  for (const raw of forbiddenTopics) {
    const topic = normalizeText(raw).trim();
    if (!topic) continue;
    if (haystack.includes(topic)) return true;
    for (const group of NORMALIZED_GROUPS) {
      const triggered = [...group.en, ...group.ar].some((term) => term.trim() && topic.includes(term.trim()));
      if (triggered && [...group.en, ...group.ar].some((term) => term && haystack.includes(term))) return true;
    }
  }
  return false;
}
