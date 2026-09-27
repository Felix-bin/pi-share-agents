# SWE-QA on Windows: the same four arms, natively

A port of [`../../openeuler/sweqa/`](../../openeuler/sweqa/README.md) to Windows. The design and frozen rules are the same spec: [`docs/superpowers/specs/2026-09-26-sweqa-three-arm-design.md`](../../../docs/superpowers/specs/2026-09-26-sweqa-three-arm-design.md).

Everything that defines the experiment is shared with openEuler and imported from there:

- `matrix.mjs`: arms, packages, parent tools, model, prompts, sampling;
- `analyze.mjs`: metering;
- `score.mjs`: the judge;
- `report.mjs`: pairing and decision rules;
- `llm-proxy.mjs`: the recorder.

The sample must be byte-identical to the openEuler one, and `prepare.mjs` refuses any other. Only the platform layer lives here:

| | openEuler | Windows |
|---|---|---|
| Pi CLI | `../pi-web` checkout, 0.87.0 | `@earendil-works/pi-coding-agent@0.87.0`, installed by `prepare.mjs` into `experiments/data/sweqa-windows/pi/` |
| `pi` wrapper on PATH | `#!/bin/sh` script | `pi.cmd` for Windows callers and a `pi` script for Git Bash; both log to `pi-invocations.log` |
| PATH | `<bin>:/usr/local/bin:/usr/bin:/bin` | `<bin>;%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem`; Git Bash adds its own tools when Pi's bash tool starts it |
| rg / fd | `rg`, `fd` | `rg.exe`, `fd.exe` |
| Temporary state | `TMPDIR` per attempt | `TMPDIR`, `TMP`, `TEMP`, `APPDATA` and `LOCALAPPDATA` per attempt |
| Ending an attempt | `kill(-pgid)` | `taskkill /T /F` on the process tree |
| Snapshots | GNU tar | `%SystemRoot%\System32\tar.exe`; checkouts forced to LF (`core.autocrlf=false`), so byte counts match openEuler |
| Audit | POSIX paths | `C:\x`, `C:/x` and Git Bash `/c/x` folded into one form (`analyze.mjs`, `pathStyle: "win32"` from the manifest) |

**Windows data is its own run.** Tool behavior, path formats in system prompts, and the shell all differ. So a Windows run is never merged with openEuler data, and each is reported separately.

## Prepare

Needs:

- Windows 10/11 with Node 24;
- Git for Windows under `%ProgramFiles%\Git`: Pi's bash tool uses its `bin\bash.exe`;
- `rg.exe` and `fd.exe` in `%USERPROFILE%\.pi\agent\bin` (run Pi once online);
- network access to npm and GitHub;
- a few GB of disk.

No Pi model catalog is needed: the arms get the same `deepseek/deepseek-v4.1-flash` definition the openEuler arms were installed with.

```sh
node experiments/windows/sweqa/prepare.mjs
```

It does five things, in order:

1. Installs the pinned Pi CLI.
2. Installs each arm into its own agent directory under `experiments/data/sweqa-windows/agent/`.
3. Clones SWE-QA-Bench at its pinned commit into `experiments/data/swe-qa`.
4. Mirrors each repository and keeps its pinned tree as an LF tarball.
5. Writes `sample.jsonl` and checks its SHA-256 against the openEuler sample.

A repository whose tree cannot be checked out on NTFS (invalid file names) fails here, loudly.

## Run, measure, score, report

```sh
node experiments/windows/sweqa/run.mjs --id win-pilot-<date> --ids 'flask#…' --dry-run
COMMANDCODE_API_KEY=… node experiments/windows/sweqa/run.mjs --id win-pilot-<date> --ids 'flask#…'
node experiments/openeuler/sweqa/analyze.mjs experiments/data/sweqa-windows/runs/win-pilot-<date>
COMMANDCODE_API_KEY=… node experiments/openeuler/sweqa/score.mjs experiments/data/sweqa-windows/runs/win-pilot-<date>
node experiments/openeuler/sweqa/report.mjs  experiments/data/sweqa-windows/runs/win-pilot-<date>
```

The work root defaults to `%TEMP%\pi-sweqa\<id>`, outside this repository. Pass `--work-root C:\psq` when a deep repository runs into path-length limits. It is refused inside the repository.

As on openEuler, there is no filesystem sandbox. The leak audit is the guard, and paths outside the attempt are counted and reported.

## Tests

```sh
node --test experiments/windows/sweqa/test.mjs
```

They cover the Windows audit rules, plus a fake-Pi run of `run.mjs` → `analyze.mjs` → `report.mjs` that checks the platform layer: narrowed PATH, logged `pi` from both shells, per-attempt TEMP and APPDATA, and cleanup of read-only files. The shared logic is tested on openEuler by `experiments/openeuler/sweqa/test.mjs`.
