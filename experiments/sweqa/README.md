# SWE-QA: one Pi harness, four delegation arms

Design and frozen rules: [`docs/superpowers/specs/2026-09-26-sweqa-three-arm-design.md`](../../docs/superpowers/specs/2026-09-26-sweqa-three-arm-design.md).

The arms are:

- `share`: this repository, used freely;
- `share-pipeline`: the same package, driven by its own `/role-pipeline` template;
- `nico`: `pi-subagents@0.71.0`;
- `tintinweb`: `@tintinweb/pi-subagents@0.19.0`.

Each arm launches its installed package whole (extensions, skills, prompt templates); the parent holds only the delegation tool (`subagent`, or `Agent` for tintinweb), and the package does the rest. The prompt asks for delegation without naming a tool or a pattern. No Python environment is provided for the questioned repositories, and there is no filesystem sandbox: the leak audit is the guard, and scans outside the attempt are counted and reported. Everything else is fixed:

- `commandcode` `deepseek/deepseek-v4.1-flash` at `--thinking high`;
- the sibling `pi-web` Pi CLI, for the parent and every child;
- the repository snapshot;
- a 20-minute timeout and one attempt.

Each attempt is independent: a fresh session, a fresh `share` store, and a fresh worktree under `os.tmpdir()`, outside this repository.

The sample is 60 SWE-QA-Bench questions: 4 from each of the 15 repositories, drawn with a seed that depends only on the repository name. Reference answers stay in `sample.jsonl`. They reach the judge only, never the prompt or the worktree.

## Prepare

Needs:

- Node 24, git and tar;
- the `pi-web` checkout beside this one;
- `experiments/data/swe-qa`, from `experiments/bench/prepare-public-data.sh`;
- a Pi `commandcode` provider listing `deepseek/deepseek-v4.1-flash`, with `rg` and `fd` in `~/.pi/agent/bin`;
- a few GB of disk.

`run.mjs` and `score.mjs` read the key from `COMMANDCODE_API_KEY`, and only the local recorder ever holds it.

```sh
node experiments/sweqa/prepare.mjs
```

It installs each arm with the pinned CLI into its own agent directory, copying only the model definition, never credentials. It mirrors each repository blobless, resolves the pinned short sha, and keeps the pinned tree as `snapshots/<repo>-<sha>.tar` without `.git`. Finally, it writes `sample.jsonl`. An existing sample is never replaced.

## Run, measure, score, report

```sh
node experiments/sweqa/run.mjs --id pilot-20260926 --ids 'flask#…,requests#…,sphinx#…' --dry-run
COMMANDCODE_API_KEY=… node experiments/sweqa/run.mjs --id pilot-20260926 --ids 'flask#…,requests#…,sphinx#…'
node experiments/sweqa/analyze.mjs experiments/data/sweqa/runs/pilot-20260926
COMMANDCODE_API_KEY=… node experiments/sweqa/score.mjs experiments/data/sweqa/runs/pilot-20260926
node experiments/sweqa/report.mjs  experiments/data/sweqa/runs/pilot-20260926
```

`run.mjs` runs the four arms of a question concurrently. Each arm has its own localhost recorder, which holds the real key; Pi receives a dummy key. The recorder also lists requests still in flight, and a failed attempt records them in `inflightAtEnd`. Pi's PATH is a per-attempt bin directory plus `/usr/local/bin:/usr/bin:/bin`. Its `pi` is the pinned CLI, with every launch logged to `pi-invocations.log`, and its `rg` and `fd` are the arm's own copies, which Pi's grep and find tools need under `--offline`. `claude`, `codex` and `cursor-agent` are therefore missing on every arm. `TMPDIR` is also per attempt, because the pi-subagents lineage keeps run state and artifacts there. The agent directory is per attempt too: a copy of what loads the package (`settings.json`, `models.json`, `bin/`, `npm/`) under the work root, so `PI_CODING_AGENT_DIR` points away from this repository and nothing a package stores there carries over to the next question. Both are copied into the evidence directory afterwards. A repeated command with the same ID skips finished attempts and rejects changes to the manifest, including the hashes of the share arm's product source.

`analyze.mjs` measures every arm with the same code, from the recorder log alone:

- **Sessions.** A call extends the session whose previous request is a prefix of it. The parent is the session that holds the task prompt.
- **Dispatch.** Child sessions actually started, by agent type and depth.
- **Tokens.** Prompt (input + cacheRead + cacheWrite) and output, split into parent, children and agent type.
- **Communication.**
  - *Downlink*: a child's first-request messages, the variable part of its system prompt, and any user messages injected later.
  - *Uplink*: results of delegation calls that started a child, plus messages injected into the parent.
  - *Pulls*: memory, handle and supervisor tools.

  Catalog results, such as `list`, are reported as control and not counted as communication. Byte totals are exact. Token figures use this run's median bytes-per-token ratio.

An attempt is invalid if any of these hold:

- no child;
- an empty answer;
- missing usage;
- an unattributed call;
- a model other than `deepseek/deepseek-v4.1-flash`;
- a benchmark path in tool arguments.

Invalid attempts are unavailable, never zero.

The judge is SWE-QA's own prompt, read verbatim, with five votes per answer and the median of each dimension. It runs on `deepseek/deepseek-v4.1-flash`, the measured model itself, behind its own recorder, so its scores are a relative comparison between the arms only. `report.mjs` makes five pairings on questions where both arms are valid: each share arm against each upstream extension, and `share-pipeline` against `share`. It reports a bootstrap 95% CI and applies the frozen rules: "fewer" means the CI upper bound is below 0; quality is non-inferior when the lower bound is above −5.

The comparison is between whole extensions. It does not isolate `share`'s memory, state or envelope mechanisms.

## Tests

```sh
node --test experiments/sweqa/test.mjs
```
