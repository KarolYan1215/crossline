# Where the model time goes, per Skill (docs/model-scheduling.md): reads the worker's `skill.run` lines from stdin-free /tmp/skill-runs.jsonl
# and prints, per Skill, how many runs, how long they waited before the gate (the assistant's line or a thread's earlier turn), at the
# gate, and ran, and how much of their input the provider served from its cache, per model a provider route served (the planning Skills
# run on their own model, docs/model-providers.md), and how many repaired runs were run again on the main model. Read-only; no content,
# only numbers, Skill and model names.
import json, statistics

rows = []
redone = {}
try:
    with open("/tmp/skill-runs.jsonl", encoding="utf-8") as handle:
        for line in handle:
            start = line.find("{")
            if start < 0:
                continue
            try:
                row = json.loads(line[start:])
            except ValueError:
                continue
            if row.get("type") == "skill.run":
                rows.append(row)
            elif row.get("type") == "skill.redo_on_main_model":
                skill = row.get("skill", "?").split(":")[-1]
                redone[skill] = redone.get(skill, 0) + 1
except OSError:
    pass

def median(values):
    return int(statistics.median(values)) if values else 0

def p90(values):
    if not values:
        return 0
    ordered = sorted(values)
    return int(ordered[min(len(ordered) - 1, int(len(ordered) * 0.9))])

by_skill = {}
for row in rows:
    via = row.get("model", "?").split("/")[-1] if row.get("provider") == "provider" else "codex"
    key = (row.get("skill", "?").split(":")[-1], via)
    by_skill.setdefault(key, []).append(row)

print(f"{len(rows)} runs")
print(f"{'skill':34} {'via':24} {'n':>4} {'fail':>4} {'lane p50/p90 s':>15} {'gate p50/p90 s':>15} {'run p50/p90 s':>15} {'cache %':>8}")
for (skill, via), items in sorted(by_skill.items(), key=lambda pair: -sum(item.get("serviceMs", 0) for item in pair[1])):
    lane = [item.get("laneMs", 0) / 1000 for item in items]
    gate = [item.get("gateMs", 0) / 1000 for item in items]
    run = [item.get("serviceMs", 0) / 1000 for item in items]
    total_in = sum(item.get("input", 0) for item in items)
    cached = sum(item.get("cached", 0) for item in items)
    fails = sum(1 for item in items if not item.get("ok"))
    cache = f"{100 * cached / total_in:.0f}" if total_in else "-"
    print(f"{skill:34} {via[:24]:24} {len(items):>4} {fails:>4} {median(lane):>7}/{p90(lane):<7} {median(gate):>7}/{p90(gate):<7} {median(run):>7}/{p90(run):<7} {cache:>8}")
print("redone on the main model after a repair: " + (", ".join(f"{skill} {count}" for skill, count in sorted(redone.items())) or "none"))
