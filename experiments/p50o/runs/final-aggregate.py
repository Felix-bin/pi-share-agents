# p50o 最终口径聚合（2026-10-04 密封轮版）
#
# 原则：token 与质量一律从各臂口径 run 目录的原始记录重算，无硬编码数字——
#   token  = partial jsonl 的 totalIn + totalOut（父会话+四子代理合计，API usage 层）
#   质量   = 同一 run 目录 judge-results.jsonl 的五维总分（官方 SWE-QA 模板 × 5 票中位盲评）
# 两者的来源 run 完全相同（同源原则）；判分缺失的题按不可用计，不按 0 计。
#
# 用法：python experiments/p50o/runs/final-aggregate.py [--calibre sealed|legacy]
import json, io, sys, os

RUNS = os.path.dirname(os.path.abspath(__file__))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

def arg(name):
    return f"--{name}" in sys.argv

# ---- 口径映射：臂 → run 目录（token 与质量同源）--------------------------------
# sealed（2026-10-04 密封轮）：密封沙盒修复题库可达性泄漏后的最终口径。
# legacy（历史，仅复现已废弃的 10-04 晨数字：其 TXT/SYN 轮存在题库金标引用，见 runs/README）。
SEALED = {
	"r": {  # R 族 SWE-QA Flask 5 题
		"TXT":     "p50o-r17-txt-20261004",
		"SYN":     "p50o-r17-syn-20261004",
		"CREWAI":  "p50o-b-fw7-20261003",   # 框架臂本就 root 前缀密封，沿用
		"AUTOGEN": "p50o-b-fw2-20261003",
		"ABFH":    "p50o-r17-abfh-20261004",
		"ABNM":    "p50o-r17-abnm-20261004",
		"ABNC":    "p50o-r17-abnc-20261004",
	},
	"q": {  # Q 族 MuSiQue 5 题
		"TXT":     "p50o-q2-txt-20261004",
		"SYN":     "p50o-q2-syn-20261004",
		"CREWAI":  "p50o-q-fw2-20261004",
		"AUTOGEN": "p50o-q-ag-20261004",
	},
}
LEGACY = {
	"r": {"TXT": "p50o-r14-txt-20261004", "SYN": None, "CREWAI": "p50o-b-fw7-20261003", "AUTOGEN": "p50o-b-fw2-20261003"},
	"q": {"TXT": "p50o-q-txt2-20261004", "SYN": "p50o-q-syn-20261004", "CREWAI": "p50o-q-fw2-20261004", "AUTOGEN": "p50o-q-ag-20261004"},
}
CALIBRE = "legacy" if "legacy" in sys.argv[1:] else "sealed"
MAP = SEALED if CALIBRE == "sealed" else LEGACY

ARM_LABEL = {"TXT": "TXT", "SYN": "SYN", "CREWAI": "CREWAI", "AUTOGEN": "AUTOGEN", "ABFH": "AB-FH", "ABNM": "AB-NM", "ABNC": "AB-NC"}

def partial_file(run_dir):
	for name in ["p50o-partial.jsonl", "CREWAI7-partial.jsonl", "CREWAI-partial.jsonl", "AUTOGEN-partial.jsonl"]:
		p = os.path.join(RUNS, run_dir, name)
		if os.path.exists(p):
			return p
	return None

def load_tokens(run_dir):
	"""{(index, arm)}: totalIn+totalOut"""
	rows = {}
	pf = partial_file(run_dir)
	if not pf:
		return rows
	for l in open(pf, encoding="utf-8"):
		r = json.loads(l)
		if r.get("valid"):
			rows[(r["index"], r.get("arm") or r.get("config"))] = (r.get("totalIn") or 0) + (r.get("totalOut") or 0)
	return rows

def load_quality(run_dir):
	"""{key: total}（同 run 目录 judge-results；同一 key 多条取最后一条）"""
	out = {}
	qf = os.path.join(RUNS, run_dir, "judge-results.jsonl")
	if not os.path.exists(qf):
		return out
	for l in open(qf, encoding="utf-8"):
		r = json.loads(l)
		if r.get("total") is not None:
			out[r["key"]] = r["total"]
	return out

def family_report(name, arm_dirs):
	arms = [a for a, d in arm_dirs.items() if d]
	tokens = {a: load_tokens(d) for a, d in arm_dirs.items() if d}
	quality = {a: load_quality(d) for a, d in arm_dirs.items() if d}
	print(f"\n===== {name} =====")
	tok_cells = {a: {} for a in arms}
	for a in arms:
		for (idx, raw_arm), tot in tokens[a].items():
			norm = raw_arm if raw_arm in ARM_LABEL else ("CREWAI" if str(raw_arm).startswith("CREWAI") else ("AUTOGEN" if str(raw_arm).startswith("AUTOGEN") else raw_arm))
			if norm == a:
				tok_cells[a][idx + 1] = tot
	qs = sorted(set().union(*[set(v) for v in tok_cells.values()])) if tok_cells else []
	print(f"{'q':<4}", *[ARM_LABEL[a].rjust(10) for a in arms])
	colls = {a: [] for a in arms}
	for q in qs:
		row = []
		for a in arms:
			v = tok_cells[a].get(q)
			row.append(f"{v/1000:.0f}K" if v is not None else "-")
			if v is not None:
				colls[a].append(v)
		print(f"q{q:<3}", *[c.rjust(10) for c in row])
	mean_tok = {a: sum(v) / len(v) for a, v in colls.items() if v}
	print("token 均值:", {ARM_LABEL[a]: round(m) for a, m in mean_tok.items()})
	if "SYN" in mean_tok:
		for other in ["TXT", "CREWAI", "AUTOGEN", "ABFH", "ABNM", "ABNC"]:
			if other in mean_tok:
				print(f"  SYN vs {ARM_LABEL[other]} 省 {100*(1-mean_tok['SYN']/mean_tok[other]):.1f}%")
	qmean = {}
	for a in arms:
		vals = [v for k, v in quality[a].items()]
		if vals:
			qmean[a] = sum(vals) / len(vals)
	if qmean:
		print("质量(同源重算):", {ARM_LABEL[a]: round(qmean[a], 1) for a in qmean}, "| 每臂判分题数:", {ARM_LABEL[a]: len(quality[a]) for a in qmean})

family_report(f"R 族 SWE-QA Flask（主任务族，口径={CALIBRE}）", MAP["r"])
family_report(f"Q 族 MuSiQue（第二任务族，口径={CALIBRE}）", MAP["q"])

def fam_q(fam):
	out = {}
	for a, d in MAP[fam].items():
		if not d:
			continue
		vals = [v for k, v in load_quality(d).items()]
		if vals:
			out[a] = sum(vals) / len(vals)
	return out

rq, qq = fam_q("r"), fam_q("q")
both = [a for a in rq if a in qq]
if both:
	comb = {a: (rq[a] + qq[a]) / 2 for a in both}
	print("\n===== 两族综合质量 =====")
	for a in sorted(comb, key=lambda x: -comb[x]):
		print(f"{ARM_LABEL[a]}: {comb[a]:.2f}")
print("\n复核命令: python experiments/p50o/runs/final-aggregate.py [--calibre legacy]")
