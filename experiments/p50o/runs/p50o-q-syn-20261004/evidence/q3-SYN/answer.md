## Answer

The question resolves as a three-link chain assembled from three separate files; each link's wording is unique in this corpus.

1. **The edict's addressee** — `002-Sino-Tibetan-relations-during-the-Ming-dynasty.md:3`: "The Information Office of the State Council of the PRC preserves an edict of the Zhengtong Emperor (r. 1435–1449) addressed to the Karmapa in 1445 … Zhengtong had the following message delivered to the Great Treasure Prince of Dharma, the Karmapa". So the person addressed = the Karmapa.
2. **The city where Yongle greeted that person** — `003-Sino-Tibetan-relations-during-the-Ming-dynasty.md:3`: "The Yongle Emperor came out of the palace in Nanjing to greet the Karmapa and did not require him to kowtow like a tributary vassal." City = **Nanjing**. Corroborated by `016-…-Ming-dynasty.md:3`, which ties the same title to the same person in the same city: "During his stay in Nanjing, Deshin Shekpa was bestowed the title 'Great Treasure Prince of Dharma' by the Yongle Emperor."
3. **The ethnic majority in that city** — this is the only file in the corpus that supplies it. `028-Nanjing.md:3`: "As in most of eastern China the ethnic makeup of Nanjing is predominantly Han nationality (98.56 percent), with 50 other minority nationalities." My own re-grep for `Han nationality|98.56` over the whole worktree returns exactly one file, `028-Nanjing.md`, confirming the executor's single-source finding.

**ANSWER: Han nationality**

### What it rests on
- `002-Sino-Tibetan-relations-during-the-Ming-dynasty.md:3` (edict → Karmapa / "Great Treasure Prince of Dharma")
- `003-Sino-Tibetan-relations-during-the-Ming-dynasty.md:3` (Yongle greets the Karmapa in Nanjing); corroborated by `016-Sino-Tibetan-relations-during-the-Ming-dynasty.md:3`
- `028-Nanjing.md:3` (Nanjing predominantly Han nationality, 98.56%) — verified by direct read and by an independent whole-corpus grep, which found no second source
- All four files re-read directly in this session; the truncation handles in the inherited evidence did not conceal anything load-bearing (002 and 003 are 3 lines each; 016 is a single paragraph with no ethnicity text).

### What remains open / caveats
- **No single file states the whole chain** — it is assembled across three documents; the corpus contains no sentence linking the edict, the greeting, Nanjing and Han ethnicity together.
- **Issuer mismatch is real but harmless here**: the edict is issued by the **Zhengtong** Emperor (1445), while the palace greeting is by **Yongle** (1407). The question asks about the *addressee* (the Karmapa, the same person in both events), so the chain is valid; a question about who *issued* the edict would not be answerable by the same route.
- **Format dependency**: the short form `Han nationality` is the exact string carried by `028:3`; the parenthetical figure (98.56 percent) is *not* part of the entity name and would break exact-match grading if included.
- **Not swept for paraphrase**: the sweep covered `*Nanjing*` files plus the Ming-relations chunks; a differently-worded ethnicity statement elsewhere in the 67 files (e.g. under an alias or a statistics heading) was not exhaustively ruled out, though the `Han nationality` / `98.56` greps returned only `028`.
- The shared-memory record for this chain landed **without a `sourcePath`** (per the executor), so it will not auto-retire if these files change; and no memory write was attempted from this role.