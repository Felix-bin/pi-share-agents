# Answer: Area of the city where the Yongle Emperor greeted the edict's addressee

## The evidence chain

**Step 1 — The edict and its addressee.** The corpus contains multiple mentions of "edicts," but only one passage uses the construction "an edict … addressed to" a person. That passage is file `002-Sino-Tibetan-relations-during-the-Ming-dynasty.md`, reproduced here in full:

> # Sino-Tibetan relations during the Ming dynasty
>
> The Information Office of the State Council of the PRC preserves an edict of the Zhengtong Emperor (r. 1435–1449) addressed to the Karmapa in 1445, written after the latter's agent had brought holy relics to the Ming court. Zhengtong had the following message delivered to the Great Treasure Prince of Dharma, the Karmapa:

Thus the edict was addressed to **the Karmapa** (styled "Great Treasure Prince of Dharma").

For contrast, the other "edict" passages in the corpus are not addressed to a named person in this way, e.g. file `007-Sino-Tibetan-relations-during-the-Ming-dynasty.md`:

> … the Hongwu Emperor issued an edict granting the title "Initiation State Master" to Sagya Gyaincain …

and file `014-Sino-Tibetan-relations-during-the-Ming-dynasty.md`:

> As evident in his imperial edicts, the Hongwu Emperor was well aware of the Buddhist link between Tibet and China and wanted to foster it. …

Neither of these involves the Yongle Emperor (the Hongwu Emperor is meant), so neither can be the edict in question.

**Step 2 — The Yongle Emperor greets that person; the greeting city.** File `003-Sino-Tibetan-relations-during-the-Ming-dynasty.md` gives the greeting scene directly:

> # Sino-Tibetan relations during the Ming dynasty
>
> During his travels beginning in 1403, Deshin Shekpa was induced by further exhortations by the Ming court to visit Nanjing by April 10, 1407. Norbu writes that the Yongle Emperor, following the tradition of Mongol emperors and their reverence for the Sakya lamas, showed an enormous amount of deference towards Deshin Shekpa. The Yongle Emperor came out of the palace in Nanjing to greet the Karmapa and did not require him to kowtow like a tributary vassal. According to Karma Thinley, the emperor gave the Karmapa the place of honor at his left, and on a higher throne than his own. Rossabi and others describe a similar arrangement made by Kublai Khan and the Sakya Phagpa lama, writing that Kublai would "sit on a lower platform than the Tibetan cleric" when receiving religious instructions from him.

So the greeting city is **Nanjing**, and the greeted person is the same **Karmapa** named in the edict of Step 1.

Corroboration that the Karmapa in both passages is one and the same figure (Deshin Shekpa, 5th Karmapa Lama):

- `009-Sino-Tibetan-relations-during-the-Ming-dynasty.md`: "On March 10, 1403, the Yongle Emperor invited Deshin Shekpa, 5th Karmapa Lama (1384–1415), to his court …"
- `012-Sino-Tibetan-relations-during-the-Ming-dynasty.md`: "… the Yongle Emperor (r. 1402–1424) made a concerted effort to build a secular and religious alliance with Deshin Shekpa (1384–1415), the Karmapa of the Karma Kagyu school."
- `016-Sino-Tibetan-relations-during-the-Ming-dynasty.md`: "During his stay in Nanjing, Deshin Shekpa was bestowed the title 'Great Treasure Prince of Dharma' by the Yongle Emperor." — this ties the title used in the edict (`002`) to the person greeted in Nanjing.
- `021-Sino-Tibetan-relations-during-the-Ming-dynasty.md`: "In order to seek out the Karmapa, the Yongle Emperor dispatched his eunuch Hou Xian and the Buddhist monk Zhi Guang (d. 1435) to Tibet. … Hou Xian and Zhi Guang did not return to Nanjing until 1407."

**Step 3 — The area of Nanjing.** File `036-Nanjing.md` states it:

> # Nanjing
>
> Nanjing, with a total land area of 6,598 square kilometres (2,548 sq mi), is situated in the heartland of drainage area of lower reaches of Yangtze River, and in Yangtze River Delta, one of the largest economic zones of China. The Yangtze River flows past the west side and then north side of Nanjing City, while the Ningzheng Ridge surrounds the north, east and south side of the city. The city is 300 kilometres (190 mi) west-northwest of Shanghai, 1,200 kilometres (750 mi) south-southeast of Beijing, and 1,400 kilometres (870 mi) east-northeast of Chongqing. The downstream Yangtze River flows from Jiujiang, Jiangxi, through Anhui and Jiangsu to East Sea, north to drainage basin of downstream Yangtze is Huai River basin and south to it is Zhe River basin, and they are connected by the Grand Canal east to Nanjing. The area around Nanjing is called Hsiajiang (下江, Downstream River) region, with Jianghuai (江淮) stressing northern part and Jiangzhe (江浙) stressing southern part. The region is also known as Dongnan (東南, South East, the Southeast) and Jiangnan (江南, River South, south of Yangtze).

The document itself supplies the square-mile figure as a parenthetical: **6,598 square kilometres (2,548 sq mi)**.

**Step 4 — Unit and consistency check (as executed).** The document's km² value converts consistently to its own sq-mi value:

```
$ awk 'BEGIN{print 6598*0.3861021585}'
2547.5
$ awk 'BEGIN{print 6598/2.589988110336}'
2547.5
```

2,547.5 rounds to the document's stated 2,548 sq mi, so the source's figure is internally consistent; the question asks for square miles, so the 2,548 value — not 6,598 — is the one to report.

**Step 5 — Confirming no other Nanjing file states an area.** A loop over all twelve `*-Nanjing.md` files (executed run) returned:

```
001-Nanjing.md: no area
027-Nanjing.md: no area
028-Nanjing.md: no area
033-Nanjing.md: no area
036-Nanjing.md: HAS AREA LINE
037-Nanjing.md: no area
043-Nanjing.md: no area
048-Nanjing.md: no area
051-Nanjing.md: no area
053-Nanjing.md: no area
061-Nanjing.md: no area
063-Nanjing.md: no area
```

File `063-Nanjing.md`, for instance, gives only a wall length, not an area:

> The first emperor of the Ming dynasty, Zhu Yuanzhang (the Hongwu Emperor), who overthrew the Yuan dynasty, renamed the city Yingtian, rebuilt it, and made it the dynastic capital in 1368. He constructed a 48 km (30 mi) long city wall around Yingtian, as well as a new Ming Palace complex, and government halls. …

The only other square-mile area statement anywhere in the corpus is for a different city and is therefore irrelevant:

> `066-Kathmandu.md`: "According to the 2011 census, Kathmandu Metropolitan City has a population of 975,453 and measures 49.45 km2 (19.09 sq mi)."

## Conclusion

The edict is the Zhengtong Emperor's 1445 edict addressed to the Karmapa ("Great Treasure Prince of Dharma"); the Yongle Emperor greeted the Karmapa by coming out of the palace in **Nanjing**; and Nanjing's total land area, per the corpus, is 6,598 square kilometres — **2,548 sq mi**.

One note on corpus location: the task refers to a `musique/` directory, but no such subdirectory exists in this worktree; the 67 single-paragraph source files (named `NNN-Title.md`) sit directly in the working directory. All evidence above is drawn from those files.

ANSWER: 2,548 square miles