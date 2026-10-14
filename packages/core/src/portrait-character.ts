/** The poses and expressions the portrait writer may choose for the figure; apart so `portrait.ts` and `portrait-type.ts` do not import each other. */
export const CHARACTER_POSES = ["standing confidently", "holding an object up to look at it", "mid-stride, walking forward", "sitting on a simple stool", "arms crossed, relaxed", "gesturing as if explaining"] as const;
export const CHARACTER_EXPRESSIONS = ["calm", "focused", "curious", "cheerful", "determined", "thoughtful"] as const;
