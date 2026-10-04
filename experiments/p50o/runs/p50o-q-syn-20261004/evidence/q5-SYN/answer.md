## Answer

The corpus supports the full chain, and I re-read each hop directly (not from the inherited excerpt):

1. **The edict** — `002-Sino-Tibetan-relations-during-the-Ming-dynasty.md:3` (whole file is that one paragraph): *"…preserves an edict of the Zhengtong Emperor (r. 1435–1449) addressed to the Karmapa in 1445… Zhengtong had the following message delivered to the Great Treasure Prince of Dharma, the Karmapa:"* → addressee is **the Karmapa** (titled, not personally named here).
2. **Only edict with a Karmapa/Tibet addressee** — my own `grep -i edict` over the 67 files returns hits in `002, 007, 008, 011, 013, 014, 015, 018, 020, 023, 024, 026, 032`; none of the others addresses a Karmapa or Tibet (they concern Decius, Hongwu, Taika, Longyu, Guangxu, Julian, Milan, Thessalonica, etc.).
3. **The person greeted** — `003-…:3`: *"During his travels beginning in 1403, Deshin Shekpa was induced … to visit Nanjing by April 10, 1407… The Yongle Emperor came out of the palace in Nanjing to greet the Karmapa and did not require him to kowtow like a tributary vassal."* → city = **Nanjing**; note this line links Yongle to "the Karmapa" by the same title used in `002`.
4. **Title → person** — `016-…:3`: *"During his stay in Nanjing, Deshin Shekpa was bestowed the title 'Great Treasure Prince of Dharma' by the Yongle Emperor."* Plus `009-…:3`: *"…invited Deshin Shekpa, 5th Karmapa Lama (1384–1415)…"* → the title in `002` resolves to **Deshin Shekpa**.
5. **The square miles** — `036-Nanjing.md:3`: *"Nanjing, with a total land area of 6,598 square kilometres (2,548 sq mi)…"* → **2,548 sq mi**. My `grep` for `2,548|6,598` hits only `036`; `grep -i "\barea\b"` shows no other Nanjing file carries an area figure (`033` has only population density context, `061` only a place-name use); `grep sq mi|square kilometres|km²` returns only `036-Nanjing` and the distractor `066-Kathmandu.md` (19.09 sq mi), which has no Yongle/Karmapa link.
6. **Greeting is unique to Nanjing** — `grep -i greet` hits only `003`, plus unrelated `025-Kadayawan-Festival.md` and `041-Hello.md`. No other file places Yongle's greeting elsewhere.

So the city is Nanjing and the square-mile figure is 2,548.

**What is answered vs. open**
- Answered: every hop of the question the corpus speaks to — edict addressee (a Karmapa, titled "Great Treasure Prince of Dharma"), the title-bearer (Deshin Shekpa), the greeting city (Nanjing), and the city's area (2,548 sq mi).
- Open / caveat: the `002` edict is a **Zhengtong** (1445) edict, while the greeting is by **Yongle** (Deshin Shekpa's visit, 1407); the corpus never states that the 1445 edict's addressee *is* Deshin Shekpa — the link is a shared title ("the Karmapa" / "Great Treasure Prince of Dharma"), i.e. an inference over titles, and the corpus does not name the 1445 recipient. The answer tolerates this because hop 3 fixes the city from the Yongle side alone. Also open: no second/competing

`ANSWER: 2,548`