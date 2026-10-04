## Answer

**1912 (January 1912)** — the city is Nanjing.

---

### The chain, hop by hop, from the documents in `musique/`

**Hop 1 — the edict and the person it was addressed to.** The only paragraph in the 67-file corpus that describes an edict *addressed to* a person is `002-Sino-Tibetan-relations-during-the-Ming-dynasty.md` (read in full; the file is a single paragraph, so line 1 = title, line 3 = body):

```
# Sino-Tibetan relations during the Ming dynasty

The Information Office of the State Council of the PRC preserves an edict of the Zhengtong Emperor (r. 1435–1449) addressed to the Karmapa in 1445, written after the latter's agent had brought holy relics to the Ming court. Zhengtong had the following message delivered to the Great Treasure Prince of Dharma, the Karmapa:
```

The addressee is **the Karmapa**, whom the edict calls "the Great Treasure Prince of Dharma." The executor's `grep -rn "addressed to" .` run returned only two hits — this one and `035-Bloomingdale-Florida.md` ("the ZIP Codes serving the community are 33511 (which is addressed to Brandon)…"), which is irrelevant — confirming this is the only edict-with-a-person-addressee in the corpus. Decoys in the same topical family, each lacking a Yongle-greeted addressee, were read and excluded: `007` (Hongwu's edict granting the title "Initiation State Master" to Sagya Gyaincain), `014` ("his imperial edicts", Hongwu), and `023` (Tai Situpa's will referring to "his edicts").

The title "Great Treasure Prince of Dharma" is what welds hop 1 to hop 2: `016-Sino-Tibetan-relations-during-the-Ming-dynasty.md` states that the *Yongle* Emperor bestowed exactly that title ("Great Treasure Prince of Dharma") on Deshin Shekpa — the Karmapa — in Nanjing:

```
# Sino-Tibetan relations during the Ming dynasty

Throughout the following month, the Yongle Emperor and his court showered the Karmapa with presents. At Linggu Temple in Nanjing, he presided over the religious ceremonies for the Yongle Emperor's deceased parents, while twenty-two days of his stay were marked by religious miracles that were recorded in five languages on a gigantic scroll that bore the Emperor's seal. During his stay in Nanjing, Deshin Shekpa was bestowed the title "Great Treasure Prince of Dharma" by the Yongle Emperor. Elliot Sperling asserts that the Yongle Emperor, in bestowing Deshin Shekpa with the title of "King" and praising his mystical abilities and miracles, was trying to build an alliance with the Karmapa as the Mongols had with the Sakya lamas, but Deshin Shekpa rejected the Yongle Emperor's offer. In fact, this was the same title that Kublai Khan had offered the Sakya Phagpa lama, but Deshin Shekpa persuaded the Yongle Emperor to grant the title to religious leaders of other Tibetan Buddhist sects.
```

**Hop 2 — the city where the Yongle Emperor greeted that person.** `003-Sino-Tibetan-relations-during-the-Ming-dynasty.md` (read in full) is decisive; the executor's `grep -rn "greet"` run produced exactly one relevant hit, this sentence:

```
# Sino-Tibetan relations during the Ming dynasty

During his travels beginning in 1403, Deshin Shekpa was induced by further exhortations by the Ming court to visit Nanjing by April 10, 1407. Norbu writes that the Yongle Emperor, following the tradition of Mongol emperors and their reverence for the Sakya lamas, showed an enormous amount of deference towards Deshin Shekpa. The Yongle Emperor came out of the palace in Nanjing to greet the Karmapa and did not require him to kowtow like a tributary vassal. According to Karma Thinley, the emperor gave the Karmapa the place of honor at his left, and on a higher throne than his own. Rossabi and others describe a similar arrangement made by Kublai Khan and the Sakya Phagpa lama, writing that Kublai would "sit on a lower platform than the Tibetan cleric" when receiving religious instructions from him.
```

City = **Nanjing**. Corroborated by two further paragraphs in the same corpus. `021-Sino-Tibetan-relations-during-the-Ming-dynasty.md`:

```
# Sino-Tibetan relations during the Ming dynasty

In order to seek out the Karmapa, the Yongle Emperor dispatched his eunuch Hou Xian and the Buddhist monk Zhi Guang (d. 1435) to Tibet. Traveling to Lhasa either through Qinghai or via the Silk Road to Khotan, Hou Xian and Zhi Guang did not return to Nanjing until 1407.
```

and `009-Sino-Tibetan-relations-during-the-Ming-dynasty.md`, which identifies the greeted Karmapa as Deshin Shekpa, 5th Karmapa Lama (1384–1415), invited by Yongle on March 10, 1403:

```
# Sino-Tibetan relations during the Ming dynasty

In his usurpation of the throne from the Jianwen Emperor (r. 1398–1402), the Yongle Emperor was aided by the Buddhist monk Yao Guangxiao, and like his father, the Hongwu Emperor, the Yongle Emperor was "well-disposed towards Buddhism", claims Rossabi. On March 10, 1403, the Yongle Emperor invited Deshin Shekpa, 5th Karmapa Lama (1384–1415), to his court, even though the fourth Karmapa had rejected the invitation of the Hongwu Emperor. A Tibetan translation in the 16th century preserves the letter of the Yongle Emperor, which the Association for Asian Studies notes is polite and complimentary towards the Karmapa. The letter of invitation reads,
```

**Hop 3 — when Nanjing became the Chinese national capital.** `048-Nanjing.md` (read in full) is the only paragraph in the corpus that asserts a date for Nanjing as a *national/republican* capital:

```
# Nanjing

The Xinhai Revolution led to the founding of the Republic of China in January 1912 with Sun Yat-sen as the first provisional president and Nanking was selected as its new capital. However, the Qing Empire controlled large regions to the north, so revolutionaries asked Yuan Shikai to replace Sun as president in exchange for the abdication of Puyi, the Last Emperor. Yuan demanded the capital be Beijing (closer to his power base).
```

The executor's targeted grep `grep -rn "national capital\|new capital\|selected as\|became the capital\|capital of China" .` returned only three hits corpus-wide, and this is the only one that is both about Nanjing *and* dated:

```
./001-Nanjing.md:3:...Although as a city located in southern part of China becoming Chinese national capital as early as in Jin dynasty, the name Nanjing was designated to the city in Ming dynasty, about a thousand years later. ...
./019-Modern-history.md:3:...The Manchus then allied with former Ming general Wu Sangui and seized control of Beijing, which became the new capital of the Qing dynasty. ...
./048-Nanjing.md:3:The Xinhai Revolution led to the founding of the Republic of China in January 1912 with Sun Yat-sen as the first provisional president and Nanking was selected as its new capital. However, the Qing Empire controlled large regions to the north, so revolutionaries asked Yuan Shikai to replace Sun as president in exchange for the abdication of Puyi, the Last Emperor. Yuan demanded the capital be Beijing (closer to his power base).
```

Independent bracketing comes from `049-History-of-Beijing.md` (read in full), which marks 1912 as the start of the early Republic of China's capital period and the end of Qing rule:

```
# History of Beijing

The city of Beijing has a long and rich history that dates back over 3,000 years. Prior to the unification of China by the First Emperor in 221 BC, Beijing had been for centuries the capital of the ancient states of Ji and Yan. During the first millennia of imperial rule, Beijing was a provincial city in northern China. Its stature grew in the 10th to the 13th centuries when the nomadic Khitan and forest - dwelling Jurchen peoples from beyond the Great Wall expanded southward and made the city a capital of their dynasties, the Liao and Jin. When Kublai Khan made Dadu the capital of the Mongol - led Yuan dynasty (1279 -- 1368), all of China was ruled from Beijing for the first time. From 1279 onward, with the exception of two interludes from 1368 to 1420 and 1928 to 1949, Beijing would remain as China's capital, serving as the seat of power for the Ming dynasty (1421 -- 1644), the Manchu - led Qing dynasty (1644 -- 1912), the early Republic of China (1912 -- 1928) and now the People's Republic of China (1949 -- present).
```

**Documents-only reasoning, no outside knowledge:** the question asks for the city (Nanjing, hop 2) followed by the year its status as "the Chinese national capital" (the phrase used by `001-Nanjing.md`) began. `048-Nanjing.md` states that date directly — "the founding of the Republic of China in January 1912 … Nanking was selected as its new capital" — so the answer is 1912.

---

### Dates explicitly ruled out

`grep -rn "1912\|1368\|1420\|1421\|1644\|1928\|Xinhai" .` surfaced every candidate; each non-1912 candidate is about a different sense of "capital" or a different city:

- **1368** — `063-Nanjing.md` (read in full) is a *dynastic* capital for the Ming, not a national/republican one:
  ```
  # Nanjing

  The first emperor of the Ming dynasty, Zhu Yuanzhang (the Hongwu Emperor), who overthrew the Yuan dynasty, renamed the city Yingtian, rebuilt it, and made it the dynastic capital in 1368. He constructed a 48 km (30 mi) long city wall around Yingtian, as well as a new Ming Palace complex, and government halls. It took 200,000 laborers 21 years to finish the project. The present-day City Wall of Nanjing was mainly built during that time and today it remains in good condition and has been well preserved. It is among the longest surviving city walls in China. The Jianwen Emperor ruled from 1398 to 1402.
  ```
- **June 1644** — `051-Nanjing.md` (read in full) is a Ming claimant's enthronement, not the national capital:
  ```
  # Nanjing

  Over two centuries after the removal of the capital to Beijing, Nanjing was destined to become the capital of a Ming emperor one more time. After the fall of Beijing to Li Zicheng's rebel forces and then to the Manchu-led Qing dynasty in the spring of 1644, the Ming prince Zhu Yousong was enthroned in Nanjing in June 1644 as the Hongguang Emperor. His short reign was described by later historians as the first reign of the so-called Southern Ming dynasty.
  ```
- **1421 / 1928-interlude** — `049-History-of-Beijing.md` above refers to *Beijing's* Ming capital (1421–1644) and to a 1928–1949 interlude in Beijing's tenure; neither sentence asserts a Nanjing national-capital date. No file in the corpus contains any sentence stating Nanjing became the national capital in 1928 — that reading would be a pure inference from Beijing's interlude, so it is rejected in favour of the directly stated date.
- **12 February 1912** — `013-Qing-dynasty.md` concerns the Qing abdication edict, not a Nanjing-capital statement: "On 12 February 1912, after rounds of negotiations, Longyu issued an imperial edict bringing about the abdication of the child emperor Puyi."
- **"Chinese national capital" without a year** — `001-Nanjing.md` uses the exact question phrase but only supplies a dynasty ("becoming Chinese national capital as early as in Jin dynasty"), so it cannot answer "when."
- **Other "capital" hits** — `019-Modern-history.md` (Beijing as Qing capital), `050-Heian-period.md` and `052-Meiji-era.md` (Kyoto→Tokyo, Japan; Meiji-era's "1912" is Mutsuhito's reign), `005-Emperor-Yuan-of-Liang.md` (Jiangling), `065-Anzoategui.md` (Barcelona, Venezuela), `066-Kathmandu.md`, `067-History-of-Delhi.md`, `011-Religion-in-ancient-Rome.md` ("capital punishment"), all concern other cities/states. The executor's `grep -rn "capital" . | wc -l` returned 14 lines across 14 files, all of which were read or routed to files already read.
- **Remaining Nanjing files** (`027` Yangshan Quarry and the Yongle-ordered stele, `028` ethnic makeup, `033` census, `036` geography, `037` art groups, `043` sports teams, `053` 2013 GDP, `061` archaeology) were read in full in the complete 67-file dump and contain no capital date.

**Provenance note on the chain:** the Zhengtong edict (1445, `002`) post-dates Deshin Shekpa (d. 1415, per `009`/`012`), but "the Karmapa" is a lineage title and the corpus itself joins the two men through the shared title "Great Treasure Prince of Dharma" (`002` and `016`); the chain is therefore reported exactly as the documents support it. All 67 files of the worktree were dumped twice (once plain, once line-numbered with byte/line counts), every command exited 0, and no write to any repository was performed.

ANSWER: 1912