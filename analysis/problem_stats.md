# Problem stats: 911 jams, warnings fail, and who gets left behind

One-liners for the video, pitch and Devpost. Every line links its source. Numbers from our own fire data come from `nirops_eda.ipynb` (section 8 prints them ready to paste).

Rule: these show the problem is real. They don't prove our product works. Our proof is the scoreboard number (fire-first vs first-come).

## Best hooks

- In 1991 the Oakland Hills fire destroyed one building every 11 seconds, 790 in the first hour. ([NFPA][nfpa])
- 11 of its 25 victims died trapped in a traffic jam. 8 more died on the same narrow streets. ([NFPA][nfpa])
- Evacuating the Berkeley hills could take more than 4 hours, and a Stanford expert calls that "an absolute minimum." ([KQED][kqed])
- Lahaina 2023: 911 got 4,500+ calls and texts in one day, against about 1,600 on a normal day. ([HPR][hpr])
- Camp Fire 2018: 68 of the 85 people who died were 65 or older. ([Civil Beat][cb])

## 911 jams when everyone calls at once

- Oakland 1991: calls flooded the dispatch center's lines, so dispatchers couldn't even make outgoing calls. ([NFPA][nfpa])
- Oakland 1991: radio channels, including mutual aid channels, were saturated. ([NFPA][nfpa])
- Lahaina 2023: dispatchers "apologized but said there was no one available to send." ([HPR][hpr])
- Camp Fire 2018: 911 answered 132 calls between 6:30 and 8:20 AM, then calls were rerouted. ([PBS][pbs])
- Nationally, about 1 in 4 911 jobs sat empty from 2019 to 2022. ([WOWT / Gray, Sept 2026][gray])
- Nearly a third of 774 surveyed 911 centers had 30% or more of their jobs unfilled in 2022. ([EMS1, IAED and NASNA survey][ems1])

## Warnings don't reach people

- Camp Fire 2018: Paradise's phone alerts reached fewer than 6,200 of its 27,000 residents. ([GovTech][gov])
- Camp Fire 2018: only about 30% of residents had signed up for alerts, and the county never sent a phone-wide emergency alert. ([GovTech][gov])
- Camp Fire 2018: 7 to 9 cell towers went down. ([GovTech][gov])
- Eaton fire 2025: all 17 deaths in the first count were in west Altadena, where evacuation orders came more than 9 hours after the fire started. ([Yahoo News][yahoo])
- Eaton fire 2025: 18 of 19 deaths were in west Altadena, and when the fire got there, only one county fire truck was there. ([IFSJ][ifsj])
- Oakland 1991: most of the people who died had little warning. ([NFPA][nfpa])

## Who gets left behind

- Camp Fire 2018: 68 of the 85 people who died were 65 or older. ([Civil Beat][cb])
- Lahaina 2023: about two-thirds of the known victims were 60 or older. ([HPR][hpr])
- Eaton fire 2025: the dead included a 95-year-old and a 67-year-old wheelchair user who died with his adult son, who had cerebral palsy. ([Yahoo News][yahoo])
- Over 22 years in California, Oregon and Washington, older adults were hit by wildfires more than their share. ([Civil Beat][cb], from a Science Advances study)

## Fires move faster than people

- Oakland 1991: the fire spread about 1.67 meters per second, about 6 km/h. ([NFPA][nfpa]) That's faster than a typical walk (~1.4 m/s, a general figure, not from the report).
- Camp Fire 2018: it spread up to 80 football fields a minute and took 4 hours to burn through Paradise. ([PBS][pbs])
- Oakland 1991: 10 key reservoirs were dry by 5 PM on the first day. ([NFPA][nfpa])
- In California, 2020-2024, 30.7% of mapped fire-days saw one fire grow more than the entire 1991 Oakland Hills fire (1,520 acres).
- Biggest one-day jump: the North Complex Fire added 205,757 acres in 27 hours, 135x the Oakland Hills fire.
- Fastest: the North Complex Fire burned about 97 football fields a minute for 27 hours.
- The North Complex Fire's edge moved 38 km in 27 hours.
- 5 mapped fires burned within 100 km of Berkeley since 2020; the biggest, SCU Lightning Complex (2020), reached 396,492 acres.
- Source: NIROPS daily fire perimeters (Magstadt, O'Connor et al., Mendeley Data, doi:10.17632/95rj5d379g.1, CC BY 4.0).

## Local stakes: Berkeley and Oakland Hills

- Oakland 1991: 25 killed, 150 injured, 3,280 homes and apartments destroyed, 1,520 acres burned, $1.5B in damage. ([Wikipedia][wiki])
- Oakland 1991: fire engines couldn't get past cars full of fleeing residents, and some people abandoned their cars and ran. ([NFPA][nfpa])
- Berkeley's 2025 evacuation study simulated a repeat of the 1923 Berkeley Fire, which destroyed more than 600 structures. ([KQED][kqed])
- Berkeley's deputy fire chief: "The streets were built a long time ago," and "the road capacity is tight already." ([KQED][kqed])

## Sources

- [NFPA report on the 1991 Oakland/Berkeley Hills fire (Cal OES copy)][nfpa]
- [Wikipedia: Oakland firestorm of 1991][wiki]
- [KQED, Aug 2025: Berkeley hills evacuation could take 4+ hours][kqed]
- [Hawaii Public Radio, Oct 2023: Lahaina 911 calls (AP recordings)][hpr]
- [PBS Frontline: Camp Fire by the numbers][pbs]
- [GovTech: Camp Fire phone alert failures][gov]
- [Civil Beat, Oct 2023: wildfire risk for vulnerable people (Science Advances study)][cb]
- [Yahoo News: all 17 Eaton fire deaths in the late-order zone][yahoo]
- [International Fire & Safety Journal: Eaton fire truck data][ifsj]
- [WOWT / Gray, Sept 2026: America's 911 staffing shortage][gray]
- [EMS1, Mar 2023: IAED and NASNA 911 staffing survey][ems1]
- Fire data: NIROPS daily fire perimeters, Magstadt, O'Connor et al., Mendeley Data, doi:10.17632/95rj5d379g.1, CC BY 4.0

[nfpa]: https://www.caloes.ca.gov/wp-content/uploads/Fire-Rescue/Documents/NFPA-Oakland-Berkeley-Hills-Fire-Report.pdf
[wiki]: https://en.wikipedia.org/wiki/Oakland_firestorm_of_1991
[kqed]: https://www.kqed.org/science/1997994/wildfire-evacuation-from-berkeley-hills-could-take-over-4-hours-study-finds
[hpr]: https://www.hawaiipublicradio.org/local-news/2023-10-13/911-calls-from-lahaina-fire-reveal-panicked-residents-and-overwhelmed-officials
[pbs]: https://www.pbs.org/wgbh/frontline/article/camp-fire-by-the-numbers
[gov]: https://www.govtech.com/gov-experience/californias-camp-fire-highlights-major-failings-in-phone-based-alerts.html
[cb]: https://www.civilbeat.org/2023/10/wildfire-risk-is-soaring-for-vulnerable-people-in-california-washington-and-oregon
[yahoo]: https://www.yahoo.com/news/17-deaths-eaton-fire-were-024433120.html
[ifsj]: https://internationalfireandsafetyjournal.com/fire-truck-data-raises-questions-over-eaton-fire-response-in-altadena/
[gray]: https://www.wowt.com/2026/09/16/america-is-facing-critical-911-staffing-shortage-heres-why/
[ems1]: https://www.ems1.com/communications-dispatch/articles/study-staffing-an-issue-for-nearly-50-of-911-dispatch-centers-nN3N0zaPzmKNi7V8/
