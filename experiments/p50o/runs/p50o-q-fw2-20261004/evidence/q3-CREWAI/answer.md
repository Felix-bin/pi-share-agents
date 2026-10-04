## Answer

The city where the Yongle Emperor came out of the palace to greet the Karmapa is **Nanjing**, and the ethnic group forming its overwhelming majority is the **Han**.

Derivation, with evidence status attached to each link:

1. **The edict and its addressee.** A PRC State Council Information Office edict of the **Zhengtong Emperor (r. 1435–1449)**, dated **1445**, is "addressed to the Karmapa," and Zhengtong "had the following message delivered to the **Great Treasure Prince of Dharma, the Karmapa**" (`002-Sino-Tibetan-relations-during-the-Ming-dynasty.md:3`, quoted verbatim; the file ends at that colon — the edict body is not in the corpus). *Observed.* The addressee is never named as an individual here: a worktree-wide grep for `Deshin Shekpa` returns `003:3`, `009:3`, `012:3`, `016:3` — **never `002`**. *Observed.*

2. **The greeting and the city.** "The Yongle Emperor came out of the palace in **Nanjing** to greet the Karmapa and did not require him to kowtow like a tributary vassal"; the same line places Deshin Shekpa's visit to Nanjing by April 10, 1407 (`003-...md:3`, quoted verbatim). Greps for `came out of the palace` return only `003:3`, and for `greet` only `003:3` plus two unrelated hits (`025:3` Kadayawan Festival, `041:3` "Hello") — no competing greeting city exists in the corpus. The Lhasa reference in `021:3` is only the destination of envoys Hou Xian and Zhi Guang, who "did not return to Nanjing until 1407," i.e. Nanjing remains the court. *Observed; the city question is closed by absence of any contradicting document.*

3. **The title grant that bridges 002 to 016.** "During his stay in **Nanjing**, **Deshin Shekpa** was bestowed the title **'Great Treasure Prince of Dharma'** by the Yongle Emperor," at Linggu Temple (`016-...md:3`, quoted verbatim). *Observed.* Grep for `Great Treasure Prince of Dharma` returns exactly `002:3` and `016:3`.

4. **The identity of the addressee — inference, not statement.** No document asserts that the 1445 Zhengtong addressee *is* Deshin Shekpa. The linkage is the shared title "Great Treasure Prince of Dharma" (`002:3` ↔ `016:3`) plus the shared honorific "the Karmapa" — exactly the identity-match-on-shared-title that the plan's step 4 authorises. **This link is an inference from the texts, not a statement in them.** *Not established.*

5. **A reported, unreconciled contradiction.** The only named Karmapa in the corpus, Deshin Shekpa, is dated **1384–1415** in both `009:3` ("the Yongle Emperor invited Deshin Shekpa, 5th Karmapa Lama (1384–1415), to his court") and `012:3` ("Deshin Shekpa (1384–1415), the Karmapa of the Karma Kagyu school"), and he was invited by **Yongle (r. 1402–1424)**. The edict is dated **1445** under **Zhengtong**. A person who died in 1415 cannot be the individual addressed in 1445, and Yongle was dead by 1445. These are the documents' own dates; the arithmetic consequence is stated as inference here, not as a claim in the corpus. The corpus contains no document naming the 1445 addressee, so this tension cannot be resolved from the evidence: plan risk (a) is confirmed as a real conflict on the face of the sources, not an artefact of planning. *Observed (both dates); reported as a contradiction, not resolved.*

6. **The demographic fact for the city.** "As in most of eastern China the ethnic makeup of **Nanjing** is predominantly **Han nationality (98.56 percent)**, with 50 other minority nationalities" (`028-Nanjing.md:3`, quoted verbatim; following sentences give 77,394 minority residents in 1999, 64,832 Hui, Manchu 2,311, Zhuang 533, most minorities in Jianye District at 9.13 percent). Greps for `98.56`, `Han nationality` and `ethnic makeup` each return `028-Nanjing.md:3` and nothing else. The other Nanjing files carry no such breakdown (`001:3` total population 8,216,100 and "Southern Capital"; `033:3` 2010 census and sex ratio; `027:3` Yangshan Quarry stele). *Observed; unique in the corpus.*

**Scope control:** Rolpe Dorje, 4th Karmapa (1340–1383), and Je Tsongkhapa (1357–1419) both declined invitations and are greeted nowhere (`014:3`, `029:3`); the plan's finding that no document couples the edict to any other greeted person holds. No document places Yongle greeting the Karmapa anywhere but Nanjing, so plan risk (b) is not corroborated.

**Corpus-location default:** the task refers to "the `musique/` directory," but `list_worktree` reports `(no such dir: musique)` and the `NNN-Title.md` files sit flat at the worktree root (`001-...` through `067-...`). I read the root as the intended corpus, since that is the only structure the worktree supports.

In short: the edict (`002:3`) is addressed to "the Karmapa / Great Treasure Prince of Dharma"; the title is the sole bridge to Deshin Shekpa, whom Yongle greeted outside the palace in Nanjing (`003:3`, `016:3`); Nanjing is 98.56 percent Han (`028:3`) — with the identification of the 1445 addressee with the 1407 guest resting on a shared title and carrying an unreconciled 1415-vs-1445 date conflict.

ANSWER: Han

---

### Rests on
- `002-Sino-Tibetan-relations-during-the-Ming-dynasty.md:3` — Zhengtong (r. 1435–1449) edict of 1445 to "the Karmapa" / "Great Treasure Prince of Dharma".
- `003-Sino-Tibetan-relations-during-the-Ming-dynasty.md:3` — "came out of the palace in Nanjing to greet the Karmapa"; Deshin Shekpa in Nanjing by 1407.
- `016-Sino-Tibetan-relations-during-the-Ming-dynasty.md:3` — Nanjing stay; "Great Treasure Prince of Dharma" bestowed on Deshin Shekpa there.
- `028-Nanjing.md:3` — Nanjing ethnic makeup predominantly Han nationality (98.56 percent).
- `009:3`, `012:3` — Deshin Shekpa, 5th Karmapa Lama, 1384–1415, under Yongle (r. 1402–1424).
- Grep absence results: no `musique/` directory; `Deshin Shekpa` absent from `002`; `came out of the palace`, `98.56`, `Han nationality` each single-hit; no competing greeting city.

### Still open
- The identity of the 1445 Zhengtong addressee is not stated in any document — it rests on the shared title "Great Treasure Prince of Dharma" and honorific "the Karmapa". Flagged as inference.
- The 1415 death of the only named Karmapa versus the 1445 edict date, and Yongle's reign ending in 1424, is an unreconciled contradiction in the corpus; nothing in the evidence resolves it.
- The `musique/` directory named in the task does not exist; the root was read as the corpus under a stated default.