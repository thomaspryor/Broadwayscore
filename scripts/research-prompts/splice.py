# Rebuilds the generated prompt block of research-prompts.html: deep dives first
# (group "first"), then season prompts that have run in one tool (group "later"),
# then those that ran in both (group "older", shown as Done).
# Usage: python3 -I splice.py <html> <season-prompts.json> <deepdives.json> <ran-in.json>
import json, sys
html_path, season_path, deep_path, ran_path = sys.argv[1:5]
# Which tool ran each prompt: ran-in.json maps prompt id -> {"done": text, "ran": [tools]}.
RAN = {k: (v["done"], v["ran"]) for k, v in json.load(open(ran_path, encoding="utf-8")).items()}
season = json.load(open(season_path, encoding="utf-8"))
deep = json.load(open(deep_path, encoding="utf-8"))
first, later, older = [], [], []
# A question a deep dive asks is dropped from the season prompts, so each one is asked once.
covered = {}
for p in deep:
    for show in p["shows"]:
        covered.setdefault((show[0], show[2]), set()).update(show[3] or [])
def trim(p):
    if p.get("kind") != "commercial":
        return p
    shows = []
    for show in p["shows"]:
        need = [n for n in (show[3] or []) if n not in covered.get((show[0], show[2]), set())]
        if need:
            shows.append([show[0], show[1], show[2], need, *show[4:]])
    return {**p, "shows": shows}
season = [q for q in (trim(p) for p in season) if q["shows"]]
for p in deep:
    first.append({"id": p["id"], "group": "first", **{k: v for k, v in p.items() if k not in ("id", "group")}})
for p in season:
    done, ran = RAN.get(p["id"], (None, []))
    group = "older" if len(ran) == 2 else "later"
    body = {k: v for k, v in p.items() if k not in ("id", "group")}
    entry = {"id": p["id"], "group": group, **({"done": done, "ran": ran} if done else {}), **body}
    (older if group == "older" else later).append(entry)
lines = open(html_path, encoding="utf-8").read().split("\n")
idx = [i for i, l in enumerate(lines) if l.startswith('  {"id": "p')]
assert idx and idx == list(range(idx[0], idx[-1] + 1)), "generated block not contiguous"
new = ["  " + json.dumps(p, ensure_ascii=False) + "," for p in first + later + older]
lines[idx[0]:idx[-1] + 1] = new
open(html_path, "w", encoding="utf-8").write("\n".join(lines))
print("replaced", len(idx), "lines with", len(new), "| first", len(first), "later", len(later), "older", len(older))
