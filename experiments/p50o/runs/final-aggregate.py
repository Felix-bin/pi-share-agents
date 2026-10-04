import json, io, sys, glob, os

RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def load_partial(path):
    rows = {}
    try:
        for l in open(path, encoding='utf-8'):
            r = json.loads(l)
            if r.get('valid'):
                rows[(r['index'], r.get('arm') or r.get('config'))] = r
    except FileNotFoundError:
        pass
    return rows

def arm_total(rows, q, arm):
    r = rows.get((q, arm))
    if not r: return None
    return (r.get('totalIn') or r.get('input') or 0) + (r.get('totalOut') or r.get('output') or 0)

# ---- R family ----
r_txt = load_partial(os.path.join(RUNS, "p50o-r14-txt-20261004/p50o-partial.jsonl"))
r_syn = {**load_partial(os.path.join(RUNS, "p50o-r12-syn-20261004/p50o-partial.jsonl"))}
for k, v in load_partial(os.path.join(RUNS, "p50o-r15-syn-20261004/p50o-partial.jsonl")).items():
    r_syn.setdefault(k, v)  # r12 优先，r15 补 q5
r_crew = load_partial(os.path.join(RUNS, "p50o-b-fw7-20261003/CREWAI7-partial.jsonl"))
r_auto = load_partial(os.path.join(RUNS, "p50o-b-fw2-20261003/AUTOGEN-partial.jsonl"))
for k in list(r_crew): r_crew[(k[0], 'CREWAI')] = r_crew.pop(k)
for k in list(r_auto): r_auto[(k[0], 'AUTOGEN')] = r_auto.pop(k)

def mean(xs): return sum(xs) / len(xs) if xs else 0

def family_report(name, arms_rows, quality):
    print(f"\n===== {name} =====")
    print(f"{'q':<4}", *[f"{a:>10}" for a in ['TXT','SYN','CREWAI','AUTOGEN']])
    totals = {a: [] for a in ['TXT','SYN','CREWAI','AUTOGEN']}
    for q in range(5):
        row = [arm_total(arms_rows.get(a, {}), q, a) for a in ['TXT','SYN','CREWAI','AUTOGEN']]
        cells=[f"{(v//1000):,}K".rjust(10) if v else "—".rjust(10) for v in row]
        print(f"q{q+1:<3}", *cells)
        for a, v in zip(['TXT','SYN','CREWAI','AUTOGEN'], row):
            if v: totals[a].append(v)
    m = {a: mean(v) for a, v in totals.items()}
    print("均值", *[f"{m[a]:>10,.0f}" for a in ['TXT','SYN','CREWAI','AUTOGEN']])
    if m['SYN']:
        print(f"SYN vs TXT 省 {100*(1-m['SYN']/m['TXT']):.1f}% | vs CrewAI 省 {100*(1-m['SYN']/m['CREWAI']):.1f}% | vs AutoGen 省 {100*(1-m['SYN']/m['AUTOGEN']):.1f}%")
    if quality:
        print("质量:", {a: quality.get(a) for a in ['TXT','SYN','CREWAI','AUTOGEN']})

family_report("R 族 SWE-QA Flask（主任务族）",
    {'TXT': r_txt, 'SYN': r_syn, 'CREWAI': r_crew, 'AUTOGEN': r_auto},
    {'TXT': 87.4, 'SYN': 79.3, 'CREWAI': 81.0, 'AUTOGEN': 80.8})

# ---- Q family ----
q_txt = load_partial(os.path.join(RUNS, "p50o-q-txt2-20261004/p50o-partial.jsonl"))
q_syn = load_partial(os.path.join(RUNS, "p50o-q-syn-20261004/p50o-partial.jsonl"))
q_crew = load_partial(os.path.join(RUNS, "p50o-q-fw2-20261004/CREWAI-partial.jsonl"))
q_auto = load_partial(os.path.join(RUNS, "p50o-q-fw2-20261004/AUTOGEN-partial.jsonl"))
family_report("Q 族 MuSiQue（第二任务族）",
    {'TXT': q_txt, 'SYN': q_syn, 'CREWAI': q_crew, 'AUTOGEN': q_auto},
    {'TXT': 77.8, 'SYN': 92.0, 'CREWAI': 89.8, 'AUTOGEN': 98.4})

# 综合质量
q_all = {'TXT': 87.4, 'SYN': 79.3, 'CREWAI': 81.0, 'AUTOGEN': 80.8}
m_all = {'TXT': 77.8, 'SYN': 92.0, 'CREWAI': 89.8, 'AUTOGEN': 98.4}
print("\n===== 两族综合质量 =====")
for a in ['SYN','AUTOGEN','CREWAI','TXT']:
    print(f"{a}: {(q_all[a]+m_all[a])/2:.2f}")
