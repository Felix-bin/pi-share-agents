The city's name means **"Southern Capital"**.

The chain that gets there: the edict in the corpus is "an edict of the Zhengtong Emperor (r. 1435–1449) addressed to the Karmapa in 1445 … delivered to the Great Treasure Prince of Dharma, the Karmapa" (`002-Sino-Tibetan-relations…md` line 3). The person Yongle greets is that same title: "The Yongle Emperor came out of the palace in Nanjing to greet the Karmapa" (`003-Sino-Tibetan-relations…md` line 3). The greeting city is Nanjing, and `001-Nanjing.md` line 3 glosses it twice — "Nanjing (… 南京, "Southern Capital")" and "The city whose name means 'Southern Capital' has a prominent place in Chinese history and culture".

Grounding, part by part:
- Addressee = "the Karmapa" — `002…md` line 3 (verified by read). A corpus-wide grep for `addressed` returns only this edict (the other hits, `020` and `035`, are not edicts).
- Yongle greets "the Karmapa" — `003…md` line 3 (verified by read); grep for `greet` returns no other Yongle-greeting paragraph.
- City = Nanjing; name-meaning = "Southern Capital" — `001-Nanjing.md` line 3 (verified by read; `whose name means` occurs only there).
- Supporting link for the identification: `016…md` line 3 says that in Nanjing "Deshin Shekpa was bestowed the title 'Great Treasure Prince of Dharma' by the Yongle Emperor" — the same epithet the edict of `002` uses for its addressee.

What remains open:
- **The identity join is by title, not by name.** No single corpus sentence names the 1445 addressee as the individual Yongle greeted; the retriever and executor both flag this. The edict is Zhengtong's (1445) while the greeted Karmapa, Deshin Shekpa, died in 1415 (`009…md`), so "the Karmapa" is a title held successively; the corpus never names the 1445 addressee. If the task instead intends the Yongle letter of invitation to Deshin Shekpa (`009…md` line 3), the addressee, city and city-name meaning are unchanged — the answer is the same either way.
- **Minor source contradiction:** the retriever stated the gloss also appears on `027-Nanjing.md` and `051-Nanjing.md`; two independent greps for `Southern Capital` return only `001-Nanjing.md`, and `027-Nanjing.md` is a Yangshan Quarry paragraph. The executor's narrower finding stands; the retriever's broader one does not. It does not affect the answer, since `001` carries the gloss twice.
- The task refers to a `musique/` directory; the source paragraphs in this worktree sit at the worktree root (68 files, `001`–`067` plus sequence), not in a `musique/` subdirectory. All documents read are inside the working directory.

ANSWER: Southern Capital