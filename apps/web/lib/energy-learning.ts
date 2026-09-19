export type EnergyLevel = "low" | "medium" | "high";
export type TransitionOutcome = { before: EnergyLevel; taskEnergy: EnergyLevel;
  predicted: EnergyLevel; baseline: EnergyLevel; actual: EnergyLevel };

export function readTransitionOutcomes(events: Array<{ payload: unknown }>): TransitionOutcome[] {
  return events.flatMap((event) => {
    const value = event.payload as Partial<TransitionOutcome> | null;
    return value && [value.before, value.taskEnergy, value.predicted, value.baseline, value.actual]
      .every((level) => level === "low" || level === "medium" || level === "high")
      ? [value as TransitionOutcome] : [];
  });
}

const levels: EnergyLevel[] = ["low", "medium", "high"];
const rank = (level: EnergyLevel) => levels.indexOf(level);

/** A task above today's energy can lower the next self-report by one level; never claim physiology. */
export function predictEnergyTransition(before: EnergyLevel, taskEnergy: EnergyLevel,
  outcomes: TransitionOutcome[]): { predicted: EnergyLevel; baseline: EnergyLevel;
    basis: "rule" | "personal_unvalidated" } {
  const rule = levels[Math.max(0, rank(before) - (rank(taskEnergy) > rank(before) ? 1 : 0))]!;
  const comparable = outcomes.filter((item) => item.before === before && item.taskEnergy === taskEnergy);
  if (comparable.length < 5) return { predicted: rule, baseline: before, basis: "rule" };
  const observed = [...comparable].map((item) => rank(item.actual)).sort((a, b) => a - b);
  const middle = observed[Math.floor(observed.length / 2)]!;
  const soft = rank(rule) + Math.sign(middle - rank(rule));
  return { predicted: levels[soft]!, baseline: before, basis: "personal_unvalidated" };
}

export function energyCalibration(outcomes: TransitionOutcome[]): {
  status: "rule_only" | "personal_unvalidated" | "personal_calibrated";
  count: number; predictedCorrect: number; baselineCorrect: number
} {
  const count = outcomes.length;
  const predictedCorrect = outcomes.filter((item) => item.predicted === item.actual).length;
  const baselineCorrect = outcomes.filter((item) => item.baseline === item.actual).length;
  return { status: count >= 20 && predictedCorrect > baselineCorrect ? "personal_calibrated"
    : count >= 5 ? "personal_unvalidated" : "rule_only",
    count, predictedCorrect, baselineCorrect };
}
