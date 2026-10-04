# Final Answer

## Task restated

> What is the meaning of the name of the city where the Yongle emperor greeted the person to whom the edict was addressed?

The question is a four-hop chain: (1) find the edict that is *addressed* to a person; (2) identify that person; (3) find the city where the Yongle Emperor *greeted* that same person; (4) give the *meaning* of that city's name. All four hops are resolved below from the source paragraphs, with the supporting passages quoted verbatim.

## Corpus location (as actually found)

There is **no `musique/` subdirectory** in this worktree; the source paragraphs are the 67 numbered `.md` files in the working directory (`001-Nanjing.md` … `067-History-of-Delhi.md`), each holding one source paragraph. This was confirmed by the executor:

```
$ ls
001-Nanjing.md
002-Sino-Tibetan-relations-during-the-Ming-dynasty.md
...
067-History-of-Delhi.md

$ find . -type d;  →  .
$ find . -iname '*musique*';  →  (no output, exit 0)
$ find . -type f | wc -l  →  67
```

All quotes below are from those files.

## Hop 1 — the edict "addressed to" a person

Exhaustive search for the word *addressed* across the corpus returns exactly three hits:

```
$ grep -rn "addressed" .
./002-Sino-Tibetan-relations-during-the-Ming-dynasty.md:3:The Information Office of the State Council of the PRC preserves an edict of the Zhengtong Emperor (r. 1435–1449) addressed to the Karmapa in 1445, written after the latter's agent had brought holy relics to the Ming court. Zhengtong had the following message delivered to the Great Treasure Prince of Dharma, the Karmapa:
./020-Athanasius-of-Alexandria.md:3:...Julian... addressed an order to Ecdicius, the Prefect of Egypt...
./035-Bloomingdale-Florida.md:3:...The ZIP Codes serving the community are 33511 (which is addressed to Brandon) and 33596 (which is addressed to Valrico).
```

Only one is an **edict addressed to a person**: `002`, the edict of the Zhengtong Emperor addressed to **the Karmapa**. (`020` is Julian's order in Roman Alexandria; `035` is Florida ZIP codes.) Full text of `002-Sino-Tibetan-relations-during-the-Ming-dynasty.md`:

> # Sino-Tibetan relations during the Ming dynasty
>
> The Information Office of the State Council of the PRC preserves an edict of the Zhengtong Emperor (r. 1435–1449) addressed to the Karmapa in 1445, written after the latter's agent had brought holy relics to the Ming court. Zhengtong had the following message delivered to the Great Treasure Prince of Dharma, the Karmapa:

A narrower pattern search for "addressed to <Name>" confirms the same:

```
$ grep -rniE "addressed to [A-Z][a-z]+" --include='*.md' .
./002-...:...addressed to the Karmapa in 1445...
./035-Bloomingdale-Florida.md:3:...which is addressed to Brandon... which is addressed to Valrico...
```

Note the deliberate separation of actors in the question: the edict's *issuer* is the **Zhengtong Emperor**, while the *greeter* in hop 3 is the **Yongle Emperor** (`grep -rn "Zhengtong"` → only `002`; `grep -rn "Yongle"` → 11 files). Both concern the same addressee, the Karmapa.

## Hop 2 — the person addressed is the Karmapa = Deshin Shekpa

The addressee in `002` is styled "the Great Treasure Prince of Dharma, the Karmapa". The same title is bestowed on Deshin Shekpa in `016-Sino-Tibetan-relations-during-the-Ming-dynasty.md` (full text):

> # Sino-Tibetan relations during the Ming dynasty
>
> Throughout the following month, the Yongle Emperor and his court showered the Karmapa with presents. At Linggu Temple in Nanjing, he presided over the religious ceremonies for the Yongle Emperor's deceased parents, while twenty-two days of his stay were marked by religious miracles that were recorded in five languages on a gigantic scroll that bore the Emperor's seal. During his stay in Nanjing, Deshin Shekpa was bestowed the title "Great Treasure Prince of Dharma" by the Yongle Emperor. Elliot Sperling asserts that the Yongle Emperor, in bestowing Deshin Shekpa with the title of "King" and praising his mystical abilities and miracles, was trying to build an alliance with the Karmapa as the Mongols had with the Sakya lamas, but Deshin Shekpa rejected the Yongle Emperor's offer. In fact, this was the same title that Kublai Khan had offered the Sakya Phagpa lama, but Deshin Shekpa persuaded the Yongle Emperor to grant the title to religious leaders of other Tibetan Buddhist sects.

Uniqueness check:

```
$ grep -rn "Great Treasure Prince of Dharma" .
./002-...:...Zhengtong had the following message delivered to the Great Treasure Prince of Dharma, the Karmapa:
./016-...:...During his stay in Nanjing, Deshin Shekpa was bestowed the title "Great Treasure Prince of Dharma" by the Yongle Emperor...
```

So the edict's addressee (*Karmapa*) = **Deshin Shekpa**, whom the Yongle Emperor invited. `009-Sino-Tibetan-relations-during-the-Ming-dynasty.md` (full text) makes the identification explicit:

> # Sino-Tibetan relations during the Ming dynasty
>
> In his usurpation of the throne from the Jianwen Emperor (r. 1398–1402), the Yongle Emperor was aided by the Buddhist monk Yao Guangxiao, and like his father, the Hongwu Emperor, the Yongle Emperor was "well-disposed towards Buddhism", claims Rossabi. On March 10, 1403, the Yongle Emperor invited Deshin Shekpa, 5th Karmapa Lama (1384–1415), to his court, even though the fourth Karmapa had rejected the invitation of the Hongwu Emperor. A Tibetan translation in the 16th century preserves the letter of the Yongle Emperor, which the Association for Asian Studies notes is polite and complimentary towards the Karmapa. The letter of invitation reads,

And `012-Sino-Tibetan-relations-during-the-Ming-dynasty.md` (full text) independently ties Yongle to "Deshin Shekpa (1384–1415), the Karmapa":

> # Sino-Tibetan relations during the Ming dynasty
>
> Some scholars note that Tibetan leaders during the Ming frequently engaged in civil war and conducted their own foreign diplomacy with neighboring states such as Nepal. Some scholars underscore the commercial aspect of the Ming-Tibetan relationship, noting the Ming dynasty's shortage of horses for warfare and thus the importance of the horse trade with Tibet. Others argue that the significant religious nature of the relationship of the Ming court with Tibetan lamas is underrepresented in modern scholarship. In hopes of reviving the unique relationship of the earlier Mongol leader Kublai Khan (r. 1260–1294) and his spiritual superior Drogön Chögyal Phagpa (1235–1280) of the Sakya school of Tibetan Buddhism, the Yongle Emperor (r. 1402–1424) made a concerted effort to build a secular and religious alliance with Deshin Shekpa (1384–1415), the Karmapa of the Karma Kagyu school. However, the Yongle Emperor's attempts were unsuccessful.

`grep -rn "Deshin Shekpa"` → `003`, `009`, `012`, `016`, all consistent.

## Hop 3 — the city where the Yongle Emperor greeted that person

Exhaustive search for *greet* returns exactly three hits:

```
$ grep -rni "greet" .
./003-Sino-Tibetan-relations-during-the-Ming-dynasty.md:3:During his travels beginning in 1403, Deshin Shekpa was induced by further exhortations by the Ming court to visit Nanjing by April 10, 1407. Norbu writes that the Yongle Emperor, following the tradition of Mongol emperors and their reverence for the Sakya lamas, showed an enormous amount of deference towards Deshin Shekpa. The Yongle Emperor came out of the palace in Nanjing to greet the Karmapa and did not require him to kowtow like a tributary vassal. According to Karma Thinley, the emperor gave the Karmapa the place of honor at his left, and on a higher throne than his own. Rossabi and others describe a similar arrangement made by Kublai Khan and the Sakya Phagpa lama, writing that Kublai would "sit on a lower platform than the Tibetan cleric" when receiving religious instructions from him.
./025-Kadayawan-Festival.md:3:The Kadayawan Festival is an annual festival in the city of Davao in the Philippines. Its name derives from the friendly greeting "Madayaw", from the Dabawenyo word "dayaw", meaning good, valuable, superior or beautiful. ...
./041-Hello.md:3:The use of hello as a telephone greeting has been credited to Thomas Edison; ... Alexander Graham Bell initially used Ahoy (as used on ships) as a telephone greeting. ...
```

Only `003` is a Yongle greeting of a person; `025` (Davao festival) and `041` (telephone greeting) are unrelated. Verbose co-occurrence searches confirm the same single hit:

```
$ grep -rniE "yongle.{0,200}greet|greet.{0,200}yongle" --include='*.md' .
./003-Sino-Tibetan-relations-during-the-Ming-dynasty.md:3:...The Yongle Emperor came out of the palace in Nanjing to greet the Karmapa...
exit:0

$ grep -rniE "came out of the palace" --include='*.md' .
./003-Sino-Tibetan-relations-during-the-Ming-dynasty.md:3:...The Yongle Emperor came out of the palace in Nanjing to greet the Karmapa...
exit:0

$ grep -rniE "palace in [A-Za-z]+" --include='*.md' .
./003-Sino-Tibetan-relations-during-the-Ming-dynasty.md:3:...came out of the palace in Nanjing...
exit:0
```

Full text of `003-Sino-Tibetan-relations-during-the-Ming-dynasty.md`:

> # Sino-Tibetan relations during the Ming dynasty
>
> During his travels beginning in 1403, Deshin Shekpa was induced by further exhortations by the Ming court to visit Nanjing by April 10, 1407. Norbu writes that the Yongle Emperor, following the tradition of Mongol emperors and their reverence for the Sakya lamas, showed an enormous amount of deference towards Deshin Shekpa. The Yongle Emperor came out of the palace in Nanjing to greet the Karmapa and did not require him to kowtow like a tributary vassal. According to Karma Thinley, the emperor gave the Karmapa the place of honor at his left, and on a higher throne than his own. Rossabi and others describe a similar arrangement made by Kublai Khan and the Sakya Phagpa lama, writing that Kublai would "sit on a lower platform than the Tibetan cleric" when receiving religious instructions from him.

The city is therefore **Nanjing**.

## Hop 4 — the meaning of the city's name

Search for the gloss returns exactly one file:

```
$ grep -rn "Southern Capital" .
./001-Nanjing.md:3:Nanjing ( listen; Chinese: 南京, "Southern Capital") is the city ... The city whose name means "Southern Capital" has a prominent place in Chinese history and culture ...
exit:0
```

Full text of `001-Nanjing.md`:

> # Nanjing
>
> Nanjing ( listen; Chinese: 南京, "Southern Capital") is the city situated in the heartland of lower Yangtze River region in China, which has long been a major centre of culture, education, research, politics, economy, transport networks and tourism. It is the capital city of Jiangsu province of People's Republic of China and the second largest city in East China, with a total population of 8,216,100, and legally the capital of Republic of China which lost the mainland during the civil war. The city whose name means "Southern Capital" has a prominent place in Chinese history and culture, having served as the capitals of various Chinese dynasties, kingdoms and republican governments dating from the 3rd century AD to 1949. Prior to the advent of pinyin romanization, Nanjing's city name was spelled as Nanking or Nankin. Nanjing has a number of other names, and some historical names are now used as names of districts of the city, and among them there is the name Jiangning (江寧), whose former character Jiang (江, River) is the former part of the name Jiangsu and latter character Ning (寧, simplified form 宁, Peace) is the short name of Nanjing. When being the capital of a state, for instance, ROC, Jing (京) is adopted as the abbreviation of Nanjing. Although as a city located in southern part of China becoming Chinese national capital as early as in Jin dynasty, the name Nanjing was designated to the city in Ming dynasty, about a thousand years later. Nanjing is particularly known as Jinling (金陵, literally meaning Gold Mountain) and the old name has been used since the Warring States Period in Zhou Dynasty.

The meaning is stated twice: `Chinese: 南京, "Southern Capital"` and `The city whose name means "Southern Capital"`. No other file glosses the city's name (e.g. `063-Nanjing.md` calls it "Yingtian" historically without a translation; the nearby parallel gloss in `052-Meiji-era.md` is Tokyo = "Eastern Capital", a different city).

## Distractors ruled out

- **Other edicts** (`grep -rni "edict"`): `007` (Hongwu's edict granting the title "Initiation State Master" to Sagya Gyaincain — not addressed to a person and not linked to a Yongle greeting), `014`, `023` (imperial edicts generally), `008` (Taika Reform), `011` (Decius), `013`/`032` (Qing), `015` (Heian), `018` (Hundred Days Reform), `020` (Julian), `024`/`026` (Edict of Milan/Thessalonica). None is "addressed to" a named person.
- **Other persons invited by Yongle who were never greeted**: Tsongkhapa (`004`, `029` — declined the invitation), the 4th Karmapa Rolpe Dorje (`014` — rejected Hongwu's invitation, sent disciples only).
- **Other capital-name glosses**: `052-Meiji-era.md` — "to Tokyo (Eastern Capital)"; `025-Kadayawan-Festival.md` — "Its name derives from the friendly greeting 'Madayaw', from the Dabawenyo word 'dayaw', meaning good, valuable, superior or beautiful"; these concern other places and are not Nanjing.
- **Other Nanjing files** (`027`, `028`, `033`, `036`, `037`, `043`, `048`, `051`, `053`, `061`, `063`) discuss the city's history, population, geography, arts, sports or economy but none shows Yongle greeting anyone and none glosses the name.

## Conclusion

Verified four-hop chain, each hop quoted above:

1. `002`: the Zhengtong Emperor's 1445 edict is "**addressed to the Karmapa**" / "delivered to the Great Treasure Prince of Dharma, the Karmapa".
2. `009`/`012`/`016`: the Karmapa is **Deshin Shekpa, 5th Karmapa Lama**, who received the "Great Treasure Prince of Dharma" title from the Yongle Emperor.
3. `003`: "The **Yongle Emperor came out of the palace in Nanjing to greet the Karmapa**" — so the city is **Nanjing**.
4. `001`: Nanjing "**means 'Southern Capital'**" (Chinese: 南京).

The question asks for the *meaning* of the city's name, not the city name itself.

ANSWER: Southern Capital