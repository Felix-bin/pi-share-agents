# SWE-bench: one Pi harness, three delegation extensions

This experiment fixes the model (`deepseek/deepseek-flash`, DeepSeek-V4.1-Flash), Pi CLI, task prompt, repository commit, tool set, timeout, and official SWE-bench Lite test split. The only arm is the Pi extension: this repository (`share`), `pi-subagents@0.71.0` (`nico`), or `@tintinweb/pi-subagents@0.19.0` (`tintinweb`). Each question begins with one completed foreground child investigation before the parent uses repository tools. The extension chooses how to perform and return it. The current model alias is documented by [DeepSeek](https://api-docs.deepseek.com/updates/).

## Prepare

The runner needs Node 24, Pi, git, Python, a DeepSeek API key, and enough disk for the SWE-bench repositories. Run from this repository root:

```sh
npm ci
node experiments/swebench/prepare.mjs
python3 -m pip install datasets swebench
python3 experiments/swebench/download.py
```

`prepare.mjs` uses `pi install` in separate agent directories. The local arm installs this checkout; the upstream arms use the README npm sources at pinned versions. It writes `installed.json` with the local commit or npm lock digest. It copies only the DeepSeek model definition from your Pi catalog, never credentials. At run time, the runner reads `DEEPSEEK_API_KEY` or the existing Pi DeepSeek provider key. It replaces the model endpoint with a localhost recorder that holds the real key; Pi and all children receive a dummy key.

`download.py` writes only `instance_id`, `repo`, `base_commit`, and `problem_statement`, excluding gold patches and hidden tests. It refuses to overwrite an existing dataset. The runner records its SHA-256.

## Run

```sh
node experiments/swebench/run.mjs --dataset experiments/data/swebench/lite-test.jsonl --id pilot-20260926 --limit 3 --dry-run
DEEPSEEK_API_KEY=... node experiments/swebench/run.mjs --dataset experiments/data/swebench/lite-test.jsonl --id pilot-20260926 --limit 3
DEEPSEEK_API_KEY=... node experiments/swebench/run.mjs --dataset experiments/data/swebench/lite-test.jsonl --id lite-main-20260926
```

Run the full experiment under a fresh ID after checking the pilot. `--pi <cli.js>` chooses another CLI; the default is the sibling `pi-web` checkout's CLI when present, otherwise `pi` on `PATH`. `--ids id1,id2` selects an explicit subset; `--timeout-ms` defaults to 45 minutes per instance and arm. A repeated command with the same ID skips completed arm records and rejects matrix changes. There is one attempt per arm and instance; failures remain in `result.json`.

Each instance gets three clean worktrees at the same `base_commit`, a fresh Pi session, and an instance-specific `share` memory store. The upstream packages use their own default settings. Model calls are recorded at the common proxy; aggregate usage is taken from provider responses. `observedHandoffBytes` includes only the parent RPC's delegation tool arguments and result content. It is an observed lower bound, not a complete internal transport total.

## Grade and report

```sh
node experiments/swebench/export.mjs experiments/data/swebench/runs/lite-main-20260926
python -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite --predictions_path experiments/data/swebench/runs/lite-main-20260926/predictions/share.jsonl --run_id lite-main-20260926-share --max_workers 1
python -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite --predictions_path experiments/data/swebench/runs/lite-main-20260926/predictions/nico.jsonl --run_id lite-main-20260926-nico --max_workers 1
python -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite --predictions_path experiments/data/swebench/runs/lite-main-20260926/predictions/tintinweb.jsonl --run_id lite-main-20260926-tintinweb --max_workers 1
node experiments/swebench/report.mjs experiments/data/swebench/runs/lite-main-20260926 logs/evaluation
```

Official evaluation needs Docker. Use a new `run_id` if any prediction changes: the official harness caches by run ID and instance. The report keeps evaluation coverage separate from resolved counts. Absent scores stay unavailable. Primary outcome is resolved / 300 with paired `share` versus each upstream extension. Secondary outcomes are provider-reported token totals, elapsed time, completed delegations, and observed handoff bytes. A record with no delegation, an empty patch, incomplete usage, or an exception is never silently made valid.

The experiment compares whole delegation extensions. It does not isolate the effect of `share` memory, state, or envelope machinery; those need separate within-extension ablations. Existing CrewAI and AutoGen runs used different harnesses and are historical evidence only.
