import { describe, expect, it } from "vitest";
import { mentionsForbiddenTopic, normalizeText } from "../../src/modules/ai/topicMatch.js";

describe("normalizeText", () => {
  it("folds Arabic spelling variants and strips diacritics", () => {
    expect(normalizeText("أَهْلُكَ")).toBe(normalizeText("اهلك"));
    expect(normalizeText("مدرسة")).toBe(normalizeText("مدرسه"));
    expect(normalizeText("إمتحان")).toBe(normalizeText("امتحان"));
  });
  it("lowercases Latin text", () => expect(normalizeText("Family")).toBe("family"));
});

describe("mentionsForbiddenTopic (English behaviour unchanged)", () => {
  it("keeps the literal case-insensitive match", () => {
    expect(mentionsForbiddenTopic("How is your FAMILY?", ["family"])).toBe(true);
    expect(mentionsForbiddenTopic("nice clutch", ["family"])).toBe(false);
  });
  it("ignores empty topics", () => expect(mentionsForbiddenTopic("anything", ["", "  "])).toBe(false));
  it("does not widen English: 'mom' is not caught by 'family' (only a literal match is)", () => {
    expect(mentionsForbiddenTopic("say hi to your mom", ["family"])).toBe(false);
  });
});

describe("mentionsForbiddenTopic in Arabic", () => {
  it("an English protected topic now catches the Arabic words for it", () => {
    expect(mentionsForbiddenTopic("ازيك وازي عائلتك؟", ["Family"])).toBe(true);
    expect(mentionsForbiddenTopic("سلم على اهلك", ["family"])).toBe(true);
    expect(mentionsForbiddenTopic("الامتحان كان صعب؟", ["University"])).toBe(true);
    expect(mentionsForbiddenTopic("خطيبتك زعلانة؟", ["Relationships"])).toBe(true);
  });
  it("an Arabic protected topic works as typed, and also catches the English word", () => {
    expect(mentionsForbiddenTopic("كلمة عن الصحة", ["الصحة"])).toBe(true);
    expect(mentionsForbiddenTopic("how is your health", ["الصحة"])).toBe(true);
    expect(mentionsForbiddenTopic("عائلتك", ["family"])).toBe(true);
  });
  it("spelling variants still match (ة/ه, أ/ا)", () => {
    expect(mentionsForbiddenTopic("اسرتك", ["family"])).toBe(true);
    expect(mentionsForbiddenTopic("مدرسه", ["school"])).toBe(true);
  });
  it("unrelated Arabic text passes", () => {
    expect(mentionsForbiddenTopic("يلا نلعب ماتش النهاردة", ["family", "health", "relationships", "university"])).toBe(false);
  });
});
