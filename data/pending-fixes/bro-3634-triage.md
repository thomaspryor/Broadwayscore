# BRO-3634: draft outlet triage plans

This is a review queue, not an approved or executable fix plan. No article has been checked live by this pass. Do not submit this file to execute-approved-fix.

Baseline: 548 unmatched shipped reviews across 350 shows, from 2643 review-text directories. All 548 findings remain active. The queues cover 113 outlets and contain identifiers and metadata hints only. No review text or verifier reasoning is included.

Buckets use existing contentTier and active flags. A wrong-production bucket can reflect wrongShow=true; it is a hint to inspect existing flags, not a new exclusion. Excerpt and truncated records still need attribution checks. An unresolved record is not evidence of a wrong article. No record in this set has an active roundup flag; do not infer one from a URL or an old roundupArticleReason.

Before applying any correction: read the current article, verify its show and production, record the evidence, and create a separate pending JSON plan using the existing approved-fix schema and compare-and-set oldValue. Do not copy copyrighted text into a plan. If the article is correct but the detector misses a legitimate title variant, add a narrowly verified matcher regression instead of excluding the review. A short excerpt alone does not justify wrongShow or wrongProduction.

Regenerate the structured queue with `node scripts/audit-fulltext-mentions-show-lifetime.js --json --no-snapshot`. Its `triage.outletPlans` contains these outlet queues. The regular daily sweep also writes them into its existing lifetime snapshot; no additional cron or network call is needed.

| Bucket | Records |
| --- | ---: |
| roundup | 0 |
| wrong-production | 11 |
| truncated | 72 |
| stub | 0 |
| excerpt | 158 |
| unresolved | 307 |

Every candidate below requires article review. The final column names the next verification step, not a field edit.

## act-three-the-reviews (4)

| Review file | Bucket | Next step |
| --- | --- | --- |
| in-transit-2016/act-three-the-reviews--doug-marino.json | unresolved | read-article-and-verify-title-and-production |
| the-encounter-2016/act-three-the-reviews--doug-marino.json | unresolved | read-article-and-verify-title-and-production |
| the-front-page-2016/act-three-the-reviews--doug-marino.json | unresolved | read-article-and-verify-title-and-production |
| the-terms-of-my-surrender-2017/act-three-the-reviews--doug-marino.json | truncated | recover-full-article-and-verify-attribution |

## all-that-dazzles-uk (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| dugsi-dayz-west-end-2024/all-that-dazzles-uk--unknown.json | unresolved | read-article-and-verify-title-and-production |
| john-proctor-is-the-villain-west-end-2026/all-that-dazzles-uk--daz-gale.json | excerpt | recover-full-article-and-verify-attribution |

## america-magazine (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| ragtime-2025/america-magazine--weinert-kendt.json | wrong-production | verify-production-and-existing-flags |

## amny (3)

| Review file | Bucket | Next step |
| --- | --- | --- |
| les-miserables-2014/amny--matt-windman.json | unresolved | read-article-and-verify-title-and-production |
| the-terms-of-my-surrender-2017/amny--matt-windman.json | excerpt | recover-full-article-and-verify-attribution |
| the-winslow-boy-2013/amny--matt-windman.json | wrong-production | verify-production-and-existing-flags |

## ap (27)

| Review file | Bucket | Next step |
| --- | --- | --- |
| a-behanding-in-spokane-2010/ap--michael-kuchwara.json | excerpt | recover-full-article-and-verify-attribution |
| a-gentlemans-guide-to-love-and-murder-2013/ap--jennifer-farrar.json | excerpt | recover-full-article-and-verify-attribution |
| a-raisin-in-the-sun-2014/ap--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| a-steady-rain-2009/ap--michael-kuchwara.json | excerpt | recover-full-article-and-verify-attribution |
| aladdin-2014/ap--mark-kennedy.json | unresolved | read-article-and-verify-title-and-production |
| all-the-way-2014/ap--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| all-the-way-2014/ap--unknown.json | excerpt | recover-full-article-and-verify-attribution |
| american-psycho-2016/ap--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| an-ark-off-broadway-2026/ap--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| annie-2012/ap--jennifer-farrar.json | excerpt | recover-full-article-and-verify-attribution |
| big-fish-2013/ap--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| born-yesterday-2011/ap--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| breakfast-at-tiffanys-2013/ap--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| chinglish-2011/ap--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| elf-2012/ap--peter-santilli.json | excerpt | recover-full-article-and-verify-attribution |
| hedda-gabler-2009/ap--michael-kuchwara.json | excerpt | recover-full-article-and-verify-attribution |
| mj-2022/ap--mark-kennedy.json | unresolved | read-article-and-verify-title-and-production |
| nice-work-if-you-can-get-it-2012/ap--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| noises-off-2016/ap--mark-kennedy.json | unresolved | read-article-and-verify-title-and-production |
| old-times-2015/ap--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| one-man-two-guvnors-2012/ap--jennifer-farrar.json | excerpt | recover-full-article-and-verify-attribution |
| one-man-two-guvnors-2012/ap--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| private-lives-2011/ap--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| the-importance-of-being-earnest-2011/ap--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| the-mountaintop-2011/ap--mark-kennedy.json | unresolved | read-article-and-verify-title-and-production |
| the-realistic-joneses-2014/ap--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| wit-2012/ap--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |

## artsdesk (4)

| Review file | Bucket | Next step |
| --- | --- | --- |
| dark-of-the-moon-west-end-2026/artsdesk--unknown.json | unresolved | read-article-and-verify-title-and-production |
| london-tide-west-end-2024/artsdesk--aleks-sierz.json | unresolved | read-article-and-verify-title-and-production |
| the-prince-of-egypt-west-end-2020/artsdesk--marianka-swain.json | unresolved | read-article-and-verify-title-and-production |
| titanique-west-end-2024/artsdesk--gary-naylor.json | unresolved | read-article-and-verify-title-and-production |

## attitude (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| mrs-warrens-profession-west-end-2025/attitude--jamie-tabberer.json | unresolved | read-article-and-verify-title-and-production |

## backstage (10)

| Review file | Bucket | Next step |
| --- | --- | --- |
| a-life-in-the-theatre-2010/backstage--david-sheward.json | truncated | recover-full-article-and-verify-attribution |
| burn-the-floor-2009/backstage--jo-sagolla.json | excerpt | recover-full-article-and-verify-attribution |
| catch-me-if-you-can-2011/backstage--erik-haagensen.json | excerpt | recover-full-article-and-verify-attribution |
| collected-stories-2010/backstage--david-sheward.json | excerpt | recover-full-article-and-verify-attribution |
| everyday-rapture-2010/backstage--david-sheward.json | excerpt | recover-full-article-and-verify-attribution |
| fela-2012/backstage--david-sheward.json | excerpt | recover-full-article-and-verify-attribution |
| good-people-2011/backstage--erik-haagensen.json | excerpt | recover-full-article-and-verify-attribution |
| magicbird-2012/backstage--suzy-evans.json | excerpt | recover-full-article-and-verify-attribution |
| one-man-two-guvnors-2012/backstage--david-sheward.json | excerpt | recover-full-article-and-verify-attribution |
| time-stands-still-2010/backstage--david-sheward.json | excerpt | recover-full-article-and-verify-attribution |

## bloomberg (5)

| Review file | Bucket | Next step |
| --- | --- | --- |
| a-life-in-the-theatre-2010/bloomberg--john-simon.json | excerpt | recover-full-article-and-verify-attribution |
| collected-stories-2010/bloomberg--jeremy-gerard.json | excerpt | recover-full-article-and-verify-attribution |
| godspell-2011/bloomberg--jeremy-gerard.json | excerpt | recover-full-article-and-verify-attribution |
| jekyll-and-hyde-2013/bloomberg--philip-boroff.json | excerpt | recover-full-article-and-verify-attribution |
| on-a-clear-day-you-can-see-forever-2011/bloomberg--jeremy-gerard.json | unresolved | read-article-and-verify-title-and-production |

## bnn (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| sunset-boulevard-west-end-2023/bnn--sheena-oberoi.json | excerpt | recover-full-article-and-verify-attribution |

## bobs-theater-blog (5)

| Review file | Bucket | Next step |
| --- | --- | --- |
| a-gentlemans-guide-to-love-and-murder-2013/bobs-theater-blog--robert-sholiton.json | unresolved | read-article-and-verify-title-and-production |
| long-days-journey-into-night-2016/bobs-theater-blog--robert-sholiton.json | unresolved | read-article-and-verify-title-and-production |
| the-color-purple-2015/bobs-theater-blog--robert-sholiton.json | unresolved | read-article-and-verify-title-and-production |
| the-ferryman-2018/bobs-theater-blog--robert-sholiton.json | unresolved | read-article-and-verify-title-and-production |
| the-parisian-woman-2017/bobs-theater-blog--robert-sholiton.json | truncated | recover-full-article-and-verify-attribution |

## british-theatre (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| the-tempest-globe-west-end-2026/british-theatre--howard-loxton.json | unresolved | read-article-and-verify-title-and-production |

## britishtheatrecom (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| rosmersholm-west-end-2019/britishtheatrecom--mark-ludmon.json | excerpt | recover-full-article-and-verify-attribution |

## broadway-blog (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| les-miserables-2014/broadway-blog--matthew-wexler.json | unresolved | read-article-and-verify-title-and-production |

## broadway-voice (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| mamma-mia-2001/broadway-voice--kristen-balzano.json | unresolved | read-article-and-verify-title-and-production |

## broadwaynews (5)

| Review file | Bucket | Next step |
| --- | --- | --- |
| grey-house-2023/broadwaynews--brittani-samuel.json | truncated | recover-full-article-and-verify-attribution |
| oklahoma-2019/broadwaynews--charles-isherwood.json | excerpt | recover-full-article-and-verify-attribution |
| purlie-victorious-2023/broadwaynews--brittani-samuel.json | truncated | recover-full-article-and-verify-attribution |
| stranger-things-2024/broadwaynews--brittani-samuel.json | truncated | recover-full-article-and-verify-attribution |
| the-boys-in-the-band-2018/broadwaynews--charles-isherwood.json | excerpt | recover-full-article-and-verify-attribution |

## broadwayworld (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| the-color-purple-2015/broadwayworld--michael-dale.json | excerpt | recover-full-article-and-verify-attribution |
| titanique-west-end-2024/broadwayworld--aliya-al-hassan.json | unresolved | read-article-and-verify-title-and-production |

## chasingsupermom (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| les-miserables-tour-2022/chasingsupermom--bekki.json | unresolved | read-article-and-verify-title-and-production |

## chicagotribune (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| titanique-2026/chicagotribune--chris-jones.json | unresolved | read-article-and-verify-title-and-production |
| waiting-for-godot-2009/chicagotribune--chris-jones.json | excerpt | recover-full-article-and-verify-attribution |

## cititour (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| grey-house-2023/cititour--brian-scott-lipton.json | excerpt | recover-full-article-and-verify-attribution |

## city-am (4)

| Review file | Bucket | Next step |
| --- | --- | --- |
| hello-dolly-west-end-2024/city-am--adam-bloodworth.json | excerpt | recover-full-article-and-verify-attribution |
| oliver-west-end-2024/city-am--adam-bloodworth.json | excerpt | recover-full-article-and-verify-attribution |
| spirited-away-west-end-2024/city-am--steve-dinneen.json | excerpt | recover-full-article-and-verify-attribution |
| sunset-boulevard-west-end-2023/city-am--adam-bloodworth.json | excerpt | recover-full-article-and-verify-attribution |

## country-stars-central (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| 9-to-5-2009/country-stars-central--christian-scalise.json | excerpt | recover-full-article-and-verify-attribution |

## culture-whisper (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| the-human-voice-west-end-2022/culture-whisper--holly-omahoney.json | excerpt | recover-full-article-and-verify-attribution |

## culturesauce (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| anon-a-tempest-at-our-kitchen-table-off-broadway-2026/culturesauce--thom-geier.json | excerpt | recover-full-article-and-verify-attribution |

## daily-mail (3)

| Review file | Bucket | Next step |
| --- | --- | --- |
| lemons-lemons-lemons-lemons-lemons-west-end-2023/daily-mail--patrick-marmion.json | unresolved | read-article-and-verify-title-and-production |
| lyonesse-west-end-2023/daily-mail--patrick-marmion.json | unresolved | read-article-and-verify-title-and-production |
| the-corn-is-green-west-end-2022/daily-mail--patrick-marmion.json | unresolved | read-article-and-verify-title-and-production |

## dailybeast (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| mj-2022/dailybeast--tim-teeman.json | unresolved | read-article-and-verify-title-and-production |

## dayoutwiththekids (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| dinosaur-world-live-off-west-end-2026/dayoutwiththekids--jessica-degraag.json | truncated | recover-full-article-and-verify-attribution |

## deadline (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| titanique-2026/deadline--greg-evans.json | unresolved | read-article-and-verify-title-and-production |

## dtli (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| mj-2022/dtli--juan-michael-porter-ii.json | unresolved | read-article-and-verify-title-and-production |

## epoch-times (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| children-of-a-lesser-god-2018/epoch-times--diana-barth.json | unresolved | read-article-and-verify-title-and-production |

## equality365 (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| les-miserables-tour-2022/equality365--eric-andrews-katz.json | unresolved | read-article-and-verify-title-and-production |

## ew (9)

| Review file | Bucket | Next step |
| --- | --- | --- |
| a-delicate-balance-2014/ew--marc-snetiker.json | excerpt | recover-full-article-and-verify-attribution |
| burn-the-floor-2009/ew--jennifer-armstrong.json | excerpt | recover-full-article-and-verify-attribution |
| casa-valentina-2014/ew--adam-markovitz.json | excerpt | recover-full-article-and-verify-attribution |
| clybourne-park-2012/ew--melissa-rose-bernardo.json | excerpt | recover-full-article-and-verify-attribution |
| disgraced-2014/ew--thom-geier.json | excerpt | recover-full-article-and-verify-attribution |
| les-miserables-2014/ew--thom-geier.json | unresolved | read-article-and-verify-title-and-production |
| master-class-2011/ew--melissa-rose-bernardo.json | excerpt | recover-full-article-and-verify-attribution |
| the-anarchist-2012/ew--lisa-schwarzbaum.json | excerpt | recover-full-article-and-verify-attribution |
| the-velocity-of-autumn-2014/ew--stephan-lee.json | excerpt | recover-full-article-and-verify-attribution |

## express-uk (5)

| Review file | Bucket | Next step |
| --- | --- | --- |
| bleak-expectations-west-end-2023/express-uk--neil-norman.json | truncated | recover-full-article-and-verify-attribution |
| opening-night-west-end-2024/express-uk--stefan-kyriazis.json | unresolved | read-article-and-verify-title-and-production |
| pygmalion-west-end-2023/express-uk--neil-norman.json | truncated | recover-full-article-and-verify-attribution |
| slave-play-west-end-2024/express-uk--neil-norman.json | unresolved | read-article-and-verify-title-and-production |
| standing-at-the-skys-edge-west-end-2024/express-uk--neil-norman.json | truncated | recover-full-article-and-verify-attribution |

## fandango (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| cosi-fan-tutte-off-broadway-2026/fandango--unknown.json | truncated | recover-full-article-and-verify-attribution |

## financialtimes (9)

| Review file | Bucket | Next step |
| --- | --- | --- |
| evening-all-afternoon-west-end-2026/financialtimes--sarah-hemming.json | unresolved | read-article-and-verify-title-and-production |
| good-people-2011/financialtimes--unknown.json | excerpt | recover-full-article-and-verify-attribution |
| man-to-man-west-end-2026/financialtimes--tim-bano.json | unresolved | read-article-and-verify-title-and-production |
| mass-west-end-2026/financialtimes--unknown.json | unresolved | read-article-and-verify-title-and-production |
| shadowlands-west-end-2026/financialtimes--sarah-hemming.json | unresolved | read-article-and-verify-title-and-production |
| spring-awakening-2015/financialtimes--brendan-lemon.json | unresolved | read-article-and-verify-title-and-production |
| stereophonic-west-end-2025/financialtimes--sarah-hemming.json | unresolved | read-article-and-verify-title-and-production |
| teeth-n-smiles-west-end-2026/financialtimes--tim-bano.json | unresolved | read-article-and-verify-title-and-production |
| wit-2012/financialtimes--brendan-lemon.json | excerpt | recover-full-article-and-verify-attribution |

## front-row-center (3)

| Review file | Bucket | Next step |
| --- | --- | --- |
| amelie-a-new-musical-2017/front-row-center--casey-curtis.json | unresolved | read-article-and-verify-title-and-production |
| burn-this-2019/front-row-center--sarah-downs.json | truncated | recover-full-article-and-verify-attribution |
| les-miserables-2014/front-row-center--tulis-mccall.json | unresolved | read-article-and-verify-title-and-production |

## guardian (82)

| Review file | Bucket | Next step |
| --- | --- | --- |
| 4-48-psychosis-west-end-2025/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| 9-to-5-the-musical-west-end-2019/guardian--michael-billington.json | unresolved | read-article-and-verify-title-and-production |
| a-good-house-west-end-2025/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| a-kind-of-people-west-end-2019/guardian--michael-billington.json | unresolved | read-article-and-verify-title-and-production |
| a-month-in-the-country-west-end-2026/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| a-taste-of-honey-west-end-2019/guardian--gregory-robinson.json | truncated | recover-full-article-and-verify-attribution |
| a-tupperware-of-ashes-west-end-2024/guardian--anya-ryan.json | truncated | recover-full-article-and-verify-attribution |
| a-world-elsewhere-off-west-end-2026/guardian--miriam-gillinson.json | truncated | recover-full-article-and-verify-attribution |
| aint-too-proud-west-end-2023/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| all-my-sons-west-end-2019/guardian--michael-billington.json | unresolved | read-article-and-verify-title-and-production |
| alterations-west-end-2025/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| an-enemy-of-the-people-west-end-2024/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| as-you-like-it-globe-west-end-2026/guardian--miriam-gillinson.json | unresolved | read-article-and-verify-title-and-production |
| ballad-lines-off-west-end-2026/guardian--emma-john.json | truncated | recover-full-article-and-verify-attribution |
| best-of-enemies-west-end-2022/guardian--arifa-akbar.json | truncated | recover-full-article-and-verify-attribution |
| bitter-wheat-west-end-2019/guardian--michael-billington.json | unresolved | read-article-and-verify-title-and-production |
| blue-mist-west-end-2023/guardian--arifa-akbar.json | truncated | recover-full-article-and-verify-attribution |
| bluets-west-end-2024/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| brace-brace-west-end-2024/guardian--arifa-akbar.json | truncated | recover-full-article-and-verify-attribution |
| brokeback-mountain-west-end-2023/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| broken-glass-west-end-2026/guardian--michael-billington.json | unresolved | read-article-and-verify-title-and-production |
| copenhagen-west-end-2026/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| dear-liar-off-west-end-2026/guardian--david-jays.json | truncated | recover-full-article-and-verify-attribution |
| dear-octopus-west-end-2024/guardian--kate-wyver.json | unresolved | read-article-and-verify-title-and-production |
| echo-every-cold-hearted-oxygen-west-end-2024/guardian--kate-wyver.json | truncated | recover-full-article-and-verify-attribution |
| evening-all-afternoon-west-end-2026/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| expendable-west-end-2024/guardian--arifa-akbar.json | truncated | recover-full-article-and-verify-attribution |
| frozen-west-end-2021/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| g-west-end-2024/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| g-west-end-2024/guardian--susannah-clapp.json | unresolved | read-article-and-verify-title-and-production |
| groan-ups-west-end-2019/guardian--michael-billington.json | unresolved | read-article-and-verify-title-and-production |
| hansard-west-end-2019/guardian--michael-billington.json | unresolved | read-article-and-verify-title-and-production |
| high-society-west-end-2026/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| hole-off-west-end-2026/guardian--holly-omahony.json | unresolved | read-article-and-verify-title-and-production |
| im-not-running-west-end-2018/guardian--michael-billington.json | unresolved | read-article-and-verify-title-and-production |
| is-god-is-west-end-2021/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| just-for-one-day-west-end-2024/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| lemons-lemons-lemons-lemons-lemons-west-end-2023/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| les-miserables-west-end-2021/guardian--michael-billington.json | unresolved | read-article-and-verify-title-and-production |
| london-tide-west-end-2024/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| man-and-boy-west-end-2026/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| man-and-boy-west-end-2026/guardian--sign-has-arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| man-of-la-mancha-west-end-2019/guardian--michael-billington.json | unresolved | read-article-and-verify-title-and-production |
| mean-girls-west-end-2024/guardian--chris-wiegand.json | unresolved | read-article-and-verify-title-and-production |
| much-ado-about-nothing-west-end-2025/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| now-you-see-me-live-west-end-2026/guardian--brian-logan.json | unresolved | read-article-and-verify-title-and-production |
| now-you-see-me-live-west-end-2026/guardian--unknown.json | unresolved | read-article-and-verify-title-and-production |
| operation-mincemeat-west-end-2024/guardian--unknown.json | truncated | recover-full-article-and-verify-attribution |
| pah-la-west-end-2019/guardian--michael-billington.json | unresolved | read-article-and-verify-title-and-production |
| palesteenian-off-west-end-2026/guardian--arifa-akbar.json | truncated | recover-full-article-and-verify-attribution |
| player-kings-west-end-2024/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| please-please-me-west-end-2026/guardian--emma-john.json | truncated | recover-full-article-and-verify-attribution |
| relics-west-end-2026/guardian--arifa-akbar.json | truncated | recover-full-article-and-verify-attribution |
| rockets-and-blue-lights-west-end-2021/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| roi-return-on-investment-west-end-2026/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| rosmersholm-west-end-2019/guardian--michael-billington.json | truncated | recover-full-article-and-verify-attribution |
| standing-at-the-skys-edge-west-end-2023/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| sweetmeats-west-end-2026/guardian--anya-ryan.json | unresolved | read-article-and-verify-title-and-production |
| the-47th-west-end-2022/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| the-american-clock-west-end-2019/guardian--michael-billington.json | unresolved | read-article-and-verify-title-and-production |
| the-antipodes-west-end-2019/guardian--michael-billington.json | unresolved | read-article-and-verify-title-and-production |
| the-authenticator-west-end-2026/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| the-confessions-west-end-2023/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| the-corn-is-green-west-end-2022/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| the-end-of-history-west-end-2019/guardian--michael-billington.json | unresolved | read-article-and-verify-title-and-production |
| the-estate-west-end-2025/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| the-grapes-of-wrath-west-end-2024/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| the-guilty-west-end-2026/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| the-importance-of-being-earnest-west-end-2025/guardian--david-jays.json | unresolved | read-article-and-verify-title-and-production |
| the-legends-of-them-west-end-2024/guardian--arifa-akbar.json | truncated | recover-full-article-and-verify-attribution |
| the-man-in-the-white-suit-west-end-2019/guardian--michael-billington.json | unresolved | read-article-and-verify-title-and-production |
| the-playboy-of-the-western-world-west-end-2025/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| the-price-off-west-end-2026/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| the-price-off-west-end-2026/guardian--unknown.json | truncated | recover-full-article-and-verify-attribution |
| the-tempest-west-end-2024/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| the-unbelievers-west-end-2025/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| till-the-stars-come-down-west-end-2024/guardian--unknown.json | unresolved | read-article-and-verify-title-and-production |
| top-girls-west-end-2019/guardian--michael-billington.json | truncated | recover-full-article-and-verify-attribution |
| trouble-in-mind-2021/guardian--arifa-akbar.json | unresolved | read-article-and-verify-title-and-production |
| under-the-shadow-off-west-end-2026/guardian--unknown.json | truncated | recover-full-article-and-verify-attribution |
| waiting-for-godot-2013/guardian--jesse-green.json | excerpt | recover-full-article-and-verify-attribution |
| wolf-hall-parts-one-and-two-2015/guardian--jesse-green.json | truncated | recover-full-article-and-verify-attribution |

## hampstead-highgate-express (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| the-importance-of-being-earnest-west-end-2024/hampstead-highgate-express--bridget-galton.json | unresolved | read-article-and-verify-title-and-production |

## hollywood-reporter (7)

| Review file | Bucket | Next step |
| --- | --- | --- |
| la-bete-2010/hollywood-reporter--david-rooney.json | unresolved | read-article-and-verify-title-and-production |
| mj-2022/hollywood-reporter--angie-han.json | unresolved | read-article-and-verify-title-and-production |
| mj-2022/hollywood-reporter--love-gyarkye.json | unresolved | read-article-and-verify-title-and-production |
| mj-2022/hollywood-reporter--lovia-gayarkye.json | unresolved | read-article-and-verify-title-and-production |
| mj-2022/hollywood-reporter--lovia-gyarkye.json | unresolved | read-article-and-verify-title-and-production |
| promises-promises-2010/hollywood-reporter--frank-scheck.json | excerpt | recover-full-article-and-verify-attribution |
| the-importance-of-being-earnest-2011/hollywood-reporter--david-rooney.json | unresolved | read-article-and-verify-title-and-production |

## huffpost (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| ifthen-2014/huffpost--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| wit-2012/huffpost--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |

## i-paper (8)

| Review file | Bucket | Next step |
| --- | --- | --- |
| bitter-wheat-west-end-2019/i-paper--alice-jones.json | excerpt | recover-full-article-and-verify-attribution |
| frozen-west-end-2021/i-paper--sam-marlowe.json | excerpt | recover-full-article-and-verify-attribution |
| guess-how-much-i-love-you-west-end-2026/i-paper--fiona-mountford.json | unresolved | read-article-and-verify-title-and-production |
| just-for-one-day-west-end-2024/i-paper--fiona-mountford.json | unresolved | read-article-and-verify-title-and-production |
| london-tide-west-end-2024/i-paper--fiona-mountford.json | unresolved | read-article-and-verify-title-and-production |
| pygmalion-west-end-2023/i-paper--fiona-mountford.json | unresolved | read-article-and-verify-title-and-production |
| the-human-voice-west-end-2022/i-paper--sam-marlowe.json | excerpt | recover-full-article-and-verify-attribution |
| titanique-west-end-2024/i-paper--fiona-mountford.json | unresolved | read-article-and-verify-title-and-production |

## jonathan-baz (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| equus-west-end-2026/jonathan-baz--unknown.json | truncated | recover-full-article-and-verify-attribution |

## latimes (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| the-vertical-hour-2006/latimes--charles-mcnulty.json | unresolved | read-article-and-verify-title-and-production |

## lighting-and-sound-america (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| shit-meet-fan-off-broadway-2024/lighting-and-sound-america--david-barbour.json | unresolved | read-article-and-verify-title-and-production |

## london-box-office (3)

| Review file | Bucket | Next step |
| --- | --- | --- |
| amelie-west-end-2021/london-box-office--phil-willmott.json | unresolved | read-article-and-verify-title-and-production |
| fiddler-on-the-roof-west-end-2019/london-box-office--phil-willmott.json | unresolved | read-article-and-verify-title-and-production |
| the-corn-is-green-west-end-2022/london-box-office--phil-willmott.json | unresolved | read-article-and-verify-title-and-production |

## london-theatre (3)

| Review file | Bucket | Next step |
| --- | --- | --- |
| amelie-west-end-2021/london-theatre--mark-shenton.json | unresolved | read-article-and-verify-title-and-production |
| are-you-watching-west-end-2026/london-theatre--matt-wolf.json | unresolved | read-article-and-verify-title-and-production |
| les-liaisons-dangereuses-west-end-2026/london-theatre--marianka-swain.json | unresolved | read-article-and-verify-title-and-production |

## londonatlarge (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| kimberly-akimbo-off-west-end-2026/londonatlarge--laladmin.json | truncated | recover-full-article-and-verify-attribution |

## londonpubtheatres (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| children-of-the-night-off-west-end-2026/londonpubtheatres--chris-lilly.json | truncated | recover-full-article-and-verify-attribution |

## londontheatre1 (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| john-proctor-is-the-villain-west-end-2026/londontheatre1--chris-omaweng.json | unresolved | read-article-and-verify-title-and-production |

## mail-on-sunday (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| to-kill-a-mockingbird-west-end-2022/mail-on-sunday--neil-armstrong.json | unresolved | read-article-and-verify-title-and-production |

## metro-uk (3)

| Review file | Bucket | Next step |
| --- | --- | --- |
| a-day-in-the-death-of-joe-egg-west-end-2019/metro-uk--john-nathan.json | excerpt | recover-full-article-and-verify-attribution |
| dear-evan-hansen-west-end-2019/metro-uk--john-nathan.json | excerpt | recover-full-article-and-verify-attribution |
| rosmersholm-west-end-2019/metro-uk--john-nathan.json | excerpt | recover-full-article-and-verify-attribution |

## minneapolis-star-tribune (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| les-miserables-tour-2022/minneapolis-star-tribune--star-tribune-staff.json | unresolved | read-article-and-verify-title-and-production |

## new-city-stage (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| les-miserables-tour-2022/new-city-stage--dennis-polkow.json | unresolved | read-article-and-verify-title-and-production |

## new-jersey-newsroom (4)

| Review file | Bucket | Next step |
| --- | --- | --- |
| book-of-mormon-2011/new-jersey-newsroom--michael-sommers.json | excerpt | recover-full-article-and-verify-attribution |
| everyday-rapture-2010/new-jersey-newsroom--michael-sommers.json | excerpt | recover-full-article-and-verify-attribution |
| motown-the-musical-2013/new-jersey-newsroom--michael-sommers.json | excerpt | recover-full-article-and-verify-attribution |
| the-big-knife-2013/new-jersey-newsroom--michael-sommers.json | excerpt | recover-full-article-and-verify-attribution |

## new-york-classical-review (3)

| Review file | Bucket | Next step |
| --- | --- | --- |
| la-boheme-off-broadway-2025/new-york-classical-review--rick-perdian.json | unresolved | read-article-and-verify-title-and-production |
| la-boheme-off-broadway-2026/new-york-classical-review--david-wright.json | unresolved | read-article-and-verify-title-and-production |
| la-boheme-off-broadway-2026/new-york-classical-review--rick-perdian.json | unresolved | read-article-and-verify-title-and-production |

## newsday (5)

| Review file | Bucket | Next step |
| --- | --- | --- |
| a-view-from-the-bridge-2010/newsday--linda-winer.json | excerpt | recover-full-article-and-verify-attribution |
| chinglish-2011/newsday--linda-winer.json | excerpt | recover-full-article-and-verify-attribution |
| grease-2007/newsday--linda-winer.json | excerpt | recover-full-article-and-verify-attribution |
| master-class-2011/newsday--linda-winer.json | excerpt | recover-full-article-and-verify-attribution |
| the-mystery-of-edwin-drood-2012/newsday--linda-winer.json | excerpt | recover-full-article-and-verify-attribution |

## newyorker (4)

| Review file | Bucket | Next step |
| --- | --- | --- |
| brief-encounter-2010/newyorker--uncredited.json | excerpt | recover-full-article-and-verify-attribution |
| in-the-heights-2008/newyorker--hilton-als.json | excerpt | recover-full-article-and-verify-attribution |
| south-pacific-2008/newyorker--john-lahr.json | excerpt | recover-full-article-and-verify-attribution |
| titanique-off-broadway-2022/newyorker--dan-stahl.json | truncated | recover-full-article-and-verify-attribution |

## northjerseycom (11)

| Review file | Bucket | Next step |
| --- | --- | --- |
| a-time-to-kill-2013/northjerseycom--robert-feldberg.json | excerpt | recover-full-article-and-verify-attribution |
| anything-goes-2002/northjerseycom--robert-feldberg.json | excerpt | recover-full-article-and-verify-attribution |
| big-fish-2013/northjerseycom--robert-feldberg.json | excerpt | recover-full-article-and-verify-attribution |
| here-lies-love-2023/northjerseycom--robert-feldberg.json | excerpt | recover-full-article-and-verify-attribution |
| les-miserables-2014/northjerseycom--robert-feldberg.json | unresolved | read-article-and-verify-title-and-production |
| machinal-2014/northjerseycom--robert-feldberg.json | excerpt | recover-full-article-and-verify-attribution |
| of-mice-and-men-2014/northjerseycom--robert-feldberg.json | excerpt | recover-full-article-and-verify-attribution |
| other-desert-cities-2011/northjerseycom--robert-feldberg.json | excerpt | recover-full-article-and-verify-attribution |
| the-heidi-chronicles-2015/northjerseycom--robert-feldberg.json | excerpt | recover-full-article-and-verify-attribution |
| the-road-to-mecca-2012/northjerseycom--robert-feldberg.json | excerpt | recover-full-article-and-verify-attribution |
| waiting-for-godot-2009/northjerseycom--robert-feldberg.json | excerpt | recover-full-article-and-verify-attribution |

## nowthenmagazine (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| the-car-man-west-end-2026/nowthenmagazine--unknown.json | truncated | recover-full-article-and-verify-attribution |

## ny1 (5)

| Review file | Bucket | Next step |
| --- | --- | --- |
| ann-2013/ny1--roma-torre.json | excerpt | recover-full-article-and-verify-attribution |
| constellations-2015/ny1--roma-torre.json | excerpt | recover-full-article-and-verify-attribution |
| god-of-carnage-2009/ny1--roma-torre.json | excerpt | recover-full-article-and-verify-attribution |
| million-dollar-quartet-2010/ny1--roma-torre.json | excerpt | recover-full-article-and-verify-attribution |
| the-scottsboro-boys-2010/ny1--roma-torre.json | excerpt | recover-full-article-and-verify-attribution |

## nydailynews (5)

| Review file | Bucket | Next step |
| --- | --- | --- |
| baby-its-you-2011/nydailynews--joe-dziemianowicz.json | excerpt | recover-full-article-and-verify-attribution |
| book-of-mormon-2011/nydailynews--joe-dziemianowicz.json | excerpt | recover-full-article-and-verify-attribution |
| merrily-we-roll-along-1981/nydailynews--joe-dzieminaowicz.json | excerpt | recover-full-article-and-verify-attribution |
| proof-2000/nydailynews--david-kaufman.json | unresolved | read-article-and-verify-title-and-production |
| wit-2012/nydailynews--joe-dziemianowicz.json | excerpt | recover-full-article-and-verify-attribution |

## nypost (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| death-of-a-salesman-2026/nypost--elisabeth-vincentelli.json | excerpt | recover-full-article-and-verify-attribution |
| wolf-hall-parts-one-and-two-2015/nypost--elisabeth-vincentelli.json | excerpt | recover-full-article-and-verify-attribution |

## nysr (4)

| Review file | Bucket | Next step |
| --- | --- | --- |
| almost-famous-2022/nysr--sandy-macdonald.json | unresolved | read-article-and-verify-title-and-production |
| becky-shaw-2026/nysr--david-finkle.json | wrong-production | verify-production-and-existing-flags |
| hangmen-2022/nysr--frank-scheck.json | unresolved | read-article-and-verify-title-and-production |
| mj-2022/nysr--elysa-gardner.json | unresolved | read-article-and-verify-title-and-production |

## nyt-theater (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| illinoise-2024/nyt-theater--jonathan-mandell.json | excerpt | recover-full-article-and-verify-attribution |

## nytheatre (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| a-life-in-the-theatre-2010/nytheatre--martin-denton.json | excerpt | recover-full-article-and-verify-attribution |
| how-to-succeed-in-business-without-really-trying-2011/nytheatre--david-gordon.json | excerpt | recover-full-article-and-verify-attribution |

## nytimes (9)

| Review file | Bucket | Next step |
| --- | --- | --- |
| amelie-a-new-musical-2017/nytimes--ben-brantley.json | unresolved | read-article-and-verify-title-and-production |
| la-bete-2010/nytimes--charles-isherwood.json | unresolved | read-article-and-verify-title-and-production |
| les-miserables-2006/nytimes--ben-brantley.json | unresolved | read-article-and-verify-title-and-production |
| les-miserables-2014/nytimes--charles-isherwood.json | unresolved | read-article-and-verify-title-and-production |
| schmigadoon-2026/nytimes--jesse-green.json | wrong-production | verify-production-and-existing-flags |
| stranger-things-2024/nytimes--houman-barekat.json | wrong-production | verify-production-and-existing-flags |
| the-merchant-of-venice-2010/nytimes--ben-brantley.json | excerpt | recover-full-article-and-verify-attribution |
| waiting-for-godot-2009/nytimes--ben-brantley.json | excerpt | recover-full-article-and-verify-attribution |
| wolf-hall-parts-one-and-two-2015/nytimes--ben-brantley.json | excerpt | recover-full-article-and-verify-attribution |

## observer (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| an-act-of-god-2016/observer--rex-reed.json | truncated | recover-full-article-and-verify-attribution |
| titanique-west-end-2024/observer--olivia-ovenden.json | unresolved | read-article-and-verify-title-and-production |

## operawire (3)

| Review file | Bucket | Next step |
| --- | --- | --- |
| la-boheme-off-broadway-2024/operawire--jennifer-e-pyron.json | unresolved | read-article-and-verify-title-and-production |
| la-boheme-off-broadway-2025/operawire--david-salazar.json | unresolved | read-article-and-verify-title-and-production |
| la-boheme-off-broadway-2026/operawire--operawireadmin2.json | unresolved | read-article-and-verify-title-and-production |

## philadelphia-inquirer (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| harvey-2012/philadelphia-inquirer--howard-shapiro.json | excerpt | recover-full-article-and-verify-attribution |

## pioneer-press (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| life-of-pi-tour-2024/pioneer-press--rob-hubbard.json | excerpt | recover-full-article-and-verify-attribution |

## plays-to-see (3)

| Review file | Bucket | Next step |
| --- | --- | --- |
| end-of-the-world-and-hard-boiled-wonderland-off-west-end-2026/plays-to-see--sonya-tarkhanova.json | unresolved | read-article-and-verify-title-and-production |
| golden-boy-off-west-end-2026/plays-to-see--tim-hochstrasser.json | unresolved | read-article-and-verify-title-and-production |
| the-standard-of-living-west-end-2026/plays-to-see--tim-hochstrasser.json | unresolved | read-article-and-verify-title-and-production |

## rachelsreviewstheatre (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| les-miserables-tour-2022/rachelsreviewstheatre--unknown.json | unresolved | read-article-and-verify-title-and-production |

## radio-times (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| death-note-the-musical-west-end-2026/radio-times--katelyn-mensah.json | truncated | recover-full-article-and-verify-attribution |

## rollingstone (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| mj-2022/rollingstone--david-browne.json | unresolved | read-article-and-verify-title-and-production |

## scheckontheater (4)

| Review file | Bucket | Next step |
| --- | --- | --- |
| anything-goes-2011/scheckontheater--frank-scheck.json | excerpt | recover-full-article-and-verify-attribution |
| ghetto-klown-2011/scheckontheater--frank-scheck.json | excerpt | recover-full-article-and-verify-attribution |
| high-2011/scheckontheater--frank-scheck.json | excerpt | recover-full-article-and-verify-attribution |
| war-horse-2011/scheckontheater--frank-scheck.json | excerpt | recover-full-article-and-verify-attribution |

## seen-and-heard-international (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| la-boheme-off-broadway-2026/seen-and-heard-international--rick-perdian.json | unresolved | read-article-and-verify-title-and-production |

## sfgate (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| nice-work-if-you-can-get-it-2012/sfgate--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |

## stagezine (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| les-miserables-2014/stagezine--david-nounou.json | unresolved | read-article-and-verify-title-and-production |

## standard (29)

| Review file | Bucket | Next step |
| --- | --- | --- |
| a-month-in-the-country-west-end-2026/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| amelie-west-end-2021/standard--jessie-thompson.json | truncated | recover-full-article-and-verify-attribution |
| broken-glass-west-end-2026/standard--asserts-dominic-cavendish.json | unresolved | read-article-and-verify-title-and-production |
| consumed-west-end-2026/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| dear-evan-hansen-west-end-2019/standard--nick-curtis.json | excerpt | recover-full-article-and-verify-attribution |
| john-proctor-is-the-villain-west-end-2026/standard--nick-curtis.json | wrong-production | verify-production-and-existing-flags |
| man-and-boy-west-end-2026/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| marvellous-west-end-2022/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| mrs-warrens-profession-west-end-2025/standard--tim-bano.json | unresolved | read-article-and-verify-title-and-production |
| phaedra-west-end-2023/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| pretty-woman-the-musical-west-end-2020/standard--nick-curtis.json | excerpt | recover-full-article-and-verify-attribution |
| pygmalion-west-end-2023/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| retrograde-west-end-2025/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| standing-at-the-skys-edge-west-end-2024/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| sunset-boulevard-west-end-2023/standard--nick-curtis.json | excerpt | recover-full-article-and-verify-attribution |
| the-corn-is-green-west-end-2022/standard--farah-najib.json | unresolved | read-article-and-verify-title-and-production |
| the-crucible-west-end-2023/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| the-estate-west-end-2025/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| the-importance-of-being-earnest-west-end-2024/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| the-importance-of-being-earnest-west-end-2025/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| the-oresteia-west-end-2026/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| the-oresteia-west-end-2026/standard--tim-bano.json | unresolved | read-article-and-verify-title-and-production |
| the-score-regional-2026/standard--tim-bano.json | excerpt | recover-full-article-and-verify-attribution |
| the-standard-of-living-west-end-2026/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| the-unbelievers-west-end-2025/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| the-way-old-friends-do-west-end-2023/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |
| total-immediate-collective-imminent-terrestrial-salvation-west-end-2019/standard--jessie-thompson.json | truncated | recover-full-article-and-verify-attribution |
| total-immediate-collective-imminent-terrestrial-salvation-west-end-2019/standard--unknown.json | truncated | recover-full-article-and-verify-attribution |
| why-am-i-so-single-west-end-2024/standard--nick-curtis.json | unresolved | read-article-and-verify-title-and-production |

## sunday-times (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| when-we-have-sufficiently-tortured-each-other-west-end-2019/sunday-times--patricia-nicol.json | excerpt | recover-full-article-and-verify-attribution |

## talkinbroadway (10)

| Review file | Bucket | Next step |
| --- | --- | --- |
| bandstand-2017/talkinbroadway--matthew-murray.json | unresolved | read-article-and-verify-title-and-production |
| dear-evan-hansen-2016/talkinbroadway--matthew-murray.json | unresolved | read-article-and-verify-title-and-production |
| illinoise-2024/talkinbroadway--matthew-murray.json | unresolved | read-article-and-verify-title-and-production |
| kinky-boots-2013/talkinbroadway--matthew-murray.json | unresolved | read-article-and-verify-title-and-production |
| sylvia-2015/talkinbroadway--matthew-murray.json | unresolved | read-article-and-verify-title-and-production |
| the-color-purple-2005/talkinbroadway--matthew-murray.json | unresolved | read-article-and-verify-title-and-production |
| the-winters-tale-off-broadway-2026/talkinbroadway--unknown.json | excerpt | recover-full-article-and-verify-attribution |
| titanique-2026/talkinbroadway--howard-miller.json | unresolved | read-article-and-verify-title-and-production |
| waitress-2016/talkinbroadway--matthew-murray.json | unresolved | read-article-and-verify-title-and-production |
| war-paint-2017/talkinbroadway--matthew-murray.json | unresolved | read-article-and-verify-title-and-production |

## telegraph (14)

| Review file | Bucket | Next step |
| --- | --- | --- |
| a-day-in-the-death-of-joe-egg-west-end-2019/telegraph--claire-allfree.json | excerpt | recover-full-article-and-verify-attribution |
| all-my-sons-west-end-2025/telegraph--dominic-cavendish.json | unresolved | read-article-and-verify-title-and-production |
| amelie-west-end-2021/telegraph--fiona-mountford.json | unresolved | read-article-and-verify-title-and-production |
| groundhog-day-west-end-2023/telegraph--dominic-cavendish.json | unresolved | read-article-and-verify-title-and-production |
| just-for-one-day-west-end-2024/telegraph--dominic-cavendish.json | unresolved | read-article-and-verify-title-and-production |
| lemons-lemons-lemons-lemons-lemons-west-end-2023/telegraph--dominic-cavendish.json | unresolved | read-article-and-verify-title-and-production |
| mrs-warrens-profession-west-end-2025/telegraph--dominic-cavendish.json | unresolved | read-article-and-verify-title-and-production |
| pygmalion-west-end-2023/telegraph--marianka-swain.json | unresolved | read-article-and-verify-title-and-production |
| standing-at-the-skys-edge-west-end-2023/telegraph--claire-allfree.json | unresolved | read-article-and-verify-title-and-production |
| the-authenticator-west-end-2026/telegraph--fiona-mountford.json | unresolved | read-article-and-verify-title-and-production |
| the-color-purple-2005/telegraph--robbie-collin.json | excerpt | recover-full-article-and-verify-attribution |
| the-importance-of-being-earnest-west-end-2025/telegraph--dominic-cavendish.json | unresolved | read-article-and-verify-title-and-production |
| the-starry-messenger-west-end-2019/telegraph--dominic-cavendish.json | excerpt | recover-full-article-and-verify-attribution |
| titanique-west-end-2024/telegraph--dominic-cavendish.json | wrong-production | verify-production-and-existing-flags |

## the-culture-mom (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| eclipsed-2016/the-culture-mom--holly-rosen-fink.json | unresolved | read-article-and-verify-title-and-production |

## the-jewish-chronicle (3)

| Review file | Bucket | Next step |
| --- | --- | --- |
| arcadia-west-end-2026/the-jewish-chronicle--john-nathan.json | truncated | recover-full-article-and-verify-attribution |
| when-we-have-sufficiently-tortured-each-other-west-end-2019/the-jewish-chronicle--john-nathan.json | excerpt | recover-full-article-and-verify-attribution |
| whos-afraid-of-virginia-woolf-west-end-2026/the-jewish-chronicle--john-nathan.json | unresolved | read-article-and-verify-title-and-production |

## the-nation (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| copenhagen-2000/the-nation--carol-rocamora.json | truncated | recover-full-article-and-verify-attribution |

## the-new-criterion (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| la-boheme-off-broadway-2024/the-new-criterion--unknown.json | unresolved | read-article-and-verify-title-and-production |
| la-boheme-off-broadway-2026/the-new-criterion--james-bowman.json | unresolved | read-article-and-verify-title-and-production |

## the-rapidian (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| the-outsiders-tour-2025/the-rapidian--john-kissane.json | excerpt | recover-full-article-and-verify-attribution |

## the-recs (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| titanique-2026/the-recs--david-cook.json | unresolved | read-article-and-verify-title-and-production |
| titanique-2026/the-recs--randall-david-cook.json | excerpt | recover-full-article-and-verify-attribution |

## theater-life (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| mj-2022/theater-life--samuel-l-leiter.json | unresolved | read-article-and-verify-title-and-production |
| orphans-2013/theater-life--eric-march.json | unresolved | read-article-and-verify-title-and-production |

## theater-news-online (3)

| Review file | Bucket | Next step |
| --- | --- | --- |
| linda-vista-2019/theater-news-online--joe-dziemianowicz.json | excerpt | recover-full-article-and-verify-attribution |
| the-height-of-the-storm-2019/theater-news-online--david-cote.json | excerpt | recover-full-article-and-verify-attribution |
| the-new-one-2018/theater-news-online--joe-dziemianowicz.json | unresolved | read-article-and-verify-title-and-production |

## theatermania (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| mj-2022/theatermania--zachary-stewart.json | unresolved | read-article-and-verify-title-and-production |
| titanique-off-broadway-2022/theatermania--zachary-stewart.json | unresolved | read-article-and-verify-title-and-production |

## theatre-reviews-limited (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| disruption-off-broadway-2026/theatre-reviews-limited--unknown.json | excerpt | recover-full-article-and-verify-attribution |
| dog-day-afternoon-2026/theatre-reviews-limited--david-roberts.json | truncated | recover-full-article-and-verify-attribution |

## theatreandtonic (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| inter-alia-west-end-2026/theatreandtonic--becky-k.json | excerpt | recover-full-article-and-verify-attribution |
| inter-alia-west-end-2026/theatreandtonic--unknown.json | excerpt | recover-full-article-and-verify-attribution |

## theatrecat (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| a-small-and-quiet-light-off-west-end-2026/theatrecat--unknown.json | unresolved | read-article-and-verify-title-and-production |
| the-standard-of-living-west-end-2026/theatrecat--unknown.json | unresolved | read-article-and-verify-title-and-production |

## theatrely (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| titanique-2026/theatrely--kobi-kassal.json | unresolved | read-article-and-verify-title-and-production |

## theatremonkey (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| whos-afraid-of-virginia-woolf-west-end-2026/theatremonkey--unknown.json | unresolved | read-article-and-verify-title-and-production |

## thereviewshub (3)

| Review file | Bucket | Next step |
| --- | --- | --- |
| here-there-are-blueberries-theatre-royal-stratford-east-west-end-2026/thereviewshub--chris-lilly.json | unresolved | read-article-and-verify-title-and-production |
| rosmersholm-west-end-2019/thereviewshub--scott-matthewman.json | excerpt | recover-full-article-and-verify-attribution |
| teeth-n-smiles-west-end-2026/thereviewshub--the-reviews-hub-london.json | unresolved | read-article-and-verify-title-and-production |

## thestage (68)

| Review file | Bucket | Next step |
| --- | --- | --- |
| 1536-west-end-2026/thestage--holly-omahony.json | unresolved | read-article-and-verify-title-and-production |
| a-day-in-the-death-of-joe-egg-west-end-2019/thestage--natasha-tripney.json | unresolved | read-article-and-verify-title-and-production |
| a-kind-of-people-west-end-2019/thestage--ava-wong-davies.json | truncated | recover-full-article-and-verify-attribution |
| a-midsummer-nights-dream-globe-west-end-2026/thestage--holly-omahony.json | unresolved | read-article-and-verify-title-and-production |
| after-the-act-west-end-2025/thestage--laurie-yule.json | unresolved | read-article-and-verify-title-and-production |
| aint-too-proud-west-end-2023/thestage--siobhan-murphy.json | unresolved | read-article-and-verify-title-and-production |
| all-male-as-you-like-it-regional-2026/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| all-my-sons-west-end-2025/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| an-enemy-of-the-people-west-end-2024/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| an-oak-tree-off-west-end-2026/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| appropriate-2023/thestage--patrick-a-bradford.json | unresolved | read-article-and-verify-title-and-production |
| arcadia-west-end-2026/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| blood-of-my-blood-west-end-2026/thestage--holly-omahony.json | unresolved | read-article-and-verify-title-and-production |
| boys-from-the-blackstuff-west-end-2024/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| evening-all-afternoon-west-end-2026/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| every-brilliant-thing-west-end-2025/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| evita-west-end-2025/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| grace-pervades-west-end-2026/thestage--the-stage.json | truncated | recover-full-article-and-verify-attribution |
| inter-alia-west-end-2026/thestage--holly-omahony.json | excerpt | recover-full-article-and-verify-attribution |
| les-liaisons-dangereuses-west-end-2026/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| les-miserables-west-end-2021/thestage--matthew-hemley.json | unresolved | read-article-and-verify-title-and-production |
| loves-labours-lost-globe-west-end-2026/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| manic-street-creature-west-end-2026/thestage--holly-o.json | truncated | recover-full-article-and-verify-attribution |
| manic-street-creature-west-end-2026/thestage--holly-omahony.json | unresolved | read-article-and-verify-title-and-production |
| mass-west-end-2026/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| mrs-warrens-profession-west-end-2025/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| next-to-normal-west-end-2024/thestage--sam-marlowe.json | excerpt | recover-full-article-and-verify-attribution |
| on-your-feet-west-end-2019/thestage--tim-bano.json | excerpt | recover-full-article-and-verify-attribution |
| only-fools-and-horses-west-end-2019/thestage--natasha-tripney.json | unresolved | read-article-and-verify-title-and-production |
| opening-night-west-end-2024/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| please-please-me-west-end-2026/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| pygmalion-west-end-2023/thestage--sam-marlowe.json | excerpt | recover-full-article-and-verify-attribution |
| retrograde-west-end-2025/thestage--laurie-yule.json | unresolved | read-article-and-verify-title-and-production |
| roi-return-on-investment-west-end-2026/thestage--dave-fargnoli.json | truncated | recover-full-article-and-verify-attribution |
| slave-play-west-end-2024/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| spirited-away-west-end-2024/thestage--sam-marlowe.json | excerpt | recover-full-article-and-verify-attribution |
| standing-at-the-skys-edge-west-end-2023/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| starlight-express-west-end-2024/thestage--paul-vale.json | truncated | recover-full-article-and-verify-attribution |
| stereophonic-west-end-2025/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| summerfolk-west-end-2026/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| sunset-boulevard-west-end-2023/thestage--sam-marlowe.json | excerpt | recover-full-article-and-verify-attribution |
| sweetmeats-west-end-2026/thestage--holly-omahony.json | unresolved | read-article-and-verify-title-and-production |
| teeth-n-smiles-west-end-2026/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| the-authenticator-west-end-2026/thestage--tom-wicker.json | truncated | recover-full-article-and-verify-attribution |
| the-children-off-west-end-2026/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| the-corn-is-green-west-end-2022/thestage--tim-bano.json | unresolved | read-article-and-verify-title-and-production |
| the-deep-blue-sea-west-end-2025/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| the-estate-west-end-2025/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| the-girl-who-fell-west-end-2019/thestage--frey-kwa-hawking.json | unresolved | read-article-and-verify-title-and-production |
| the-grapes-of-wrath-west-end-2024/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| the-last-man-off-west-end-2026/thestage--paul-vale.json | unresolved | read-article-and-verify-title-and-production |
| the-oresteia-west-end-2026/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| the-price-off-west-end-2026/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| the-price-off-west-end-2026/thestage--unknown.json | truncated | recover-full-article-and-verify-attribution |
| the-rat-trap-west-end-2026/thestage--dave-fargnoli.json | truncated | recover-full-article-and-verify-attribution |
| the-smile-of-her-off-west-end-2026/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| the-unbelievers-west-end-2025/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| the-visit-or-the-old-lady-comes-to-call-west-end-2020/thestage--tim-bano.json | unresolved | read-article-and-verify-title-and-production |
| the-wiz-2024/thestage--lane-williamson.json | truncated | recover-full-article-and-verify-attribution |
| the-world-is-full-of-married-men-off-west-end-2026/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| titanique-west-end-2024/thestage--paul-vale.json | truncated | recover-full-article-and-verify-attribution |
| unicorn-west-end-2025/thestage--unknown.json | excerpt | recover-full-article-and-verify-attribution |
| water-for-elephants-2024/thestage--lane-williamson.json | truncated | recover-full-article-and-verify-attribution |
| white-rabbit-red-rabbit-west-end-2024/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| whos-afraid-of-virginia-woolf-west-end-2026/thestage--dave-fargnoli.json | unresolved | read-article-and-verify-title-and-production |
| woman-in-mind-west-end-2025/thestage--sam-marlowe.json | unresolved | read-article-and-verify-title-and-production |
| woman-in-mind-west-end-2025/thestage--unknown.json | unresolved | read-article-and-verify-title-and-production |
| youre-so-special-off-west-end-2026/thestage--holly-omahony.json | unresolved | read-article-and-verify-title-and-production |

## theupcoming (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| avenue-q-west-end-2026/theupcoming--benedetta-mancusi.json | wrong-production | verify-production-and-existing-flags |

## thewrap (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| mj-2022/thewrap--robert-hofler.json | unresolved | read-article-and-verify-title-and-production |
| mj-2022/thewrap--steve-pond.json | wrong-production | verify-production-and-existing-flags |

## timeout (4)

| Review file | Bucket | Next step |
| --- | --- | --- |
| amelie-a-new-musical-2017/timeout--adam-feldman.json | truncated | recover-full-article-and-verify-attribution |
| les-liaisons-dangereuses-2016/timeout--david-cote.json | truncated | recover-full-article-and-verify-attribution |
| les-miserables-2014/timeout--david-cote.json | unresolved | read-article-and-verify-title-and-production |
| mj-2022/timeout--adam-feldman.json | unresolved | read-article-and-verify-title-and-production |

## timeout-london (4)

| Review file | Bucket | Next step |
| --- | --- | --- |
| a-kind-of-people-west-end-2019/timeout-london--holly-williams.json | unresolved | read-article-and-verify-title-and-production |
| les-miserables-west-end-2021/timeout-london--andrzej-lukowski.json | unresolved | read-article-and-verify-title-and-production |
| pride-and-prejudice-sort-of-west-end-2021/timeout-london--andrzej-lukowski.json | wrong-production | verify-production-and-existing-flags |
| retrograde-west-end-2025/timeout-london--time-out.json | unresolved | read-article-and-verify-title-and-production |

## times-uk (32)

| Review file | Bucket | Next step |
| --- | --- | --- |
| a-kind-of-people-west-end-2019/times-uk--sam-marlowe.json | truncated | recover-full-article-and-verify-attribution |
| an-enemy-of-the-people-west-end-2024/times-uk--clive-davis.json | truncated | recover-full-article-and-verify-attribution |
| back-to-the-future-west-end-2021/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| barcelona-west-end-2024/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| cinderella-west-end-2021/times-uk--clive-davis.json | excerpt | recover-full-article-and-verify-attribution |
| clueless-west-end-2025/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| dear-octopus-west-end-2024/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| eureka-day-west-end-2022/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| hay-fever-west-end-2026/times-uk--dominic-maxwell.json | unresolved | read-article-and-verify-title-and-production |
| here-we-are-west-end-2025/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| jersey-boys-west-end-2021/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| man-and-boy-west-end-2026/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| man-and-boy-west-end-2026/times-uk--tim-bano.json | unresolved | read-article-and-verify-title-and-production |
| manhunt-west-end-2025/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| mary-poppins-west-end-2019/times-uk--clive-davis.json | excerpt | recover-full-article-and-verify-attribution |
| master-harold-and-the-boys-west-end-2019/times-uk--chris-bennion.json | truncated | recover-full-article-and-verify-attribution |
| medea-west-end-2023/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| mrs-warrens-profession-west-end-2025/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| nye-west-end-2024/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| our-generation-west-end-2022/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| pygmalion-west-end-2023/times-uk--unknown.json | excerpt | recover-full-article-and-verify-attribution |
| the-corn-is-green-west-end-2022/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| the-deep-blue-sea-west-end-2025/times-uk--dominic-maxwell.json | unresolved | read-article-and-verify-title-and-production |
| the-estate-west-end-2025/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| the-hills-of-california-west-end-2024/times-uk--clive-davis.json | truncated | recover-full-article-and-verify-attribution |
| the-holy-rosenbergs-west-end-2026/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| the-importance-of-being-earnest-west-end-2024/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| the-importance-of-being-earnest-west-end-2025/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| the-motive-and-the-cue-west-end-2023/times-uk--dominic-maxwell.json | unresolved | read-article-and-verify-title-and-production |
| the-unbelievers-west-end-2025/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| waiting-for-godot-west-end-2024/times-uk--clive-davis.json | unresolved | read-article-and-verify-title-and-production |
| witness-for-the-prosecution-west-end-2022/times-uk--clive-davis.json | truncated | recover-full-article-and-verify-attribution |

## usatoday (4)

| Review file | Bucket | Next step |
| --- | --- | --- |
| la-bete-2010/usatoday--elysa-gardner.json | unresolved | read-article-and-verify-title-and-production |
| les-miserables-2014/usatoday--elysa-gardner.json | unresolved | read-article-and-verify-title-and-production |
| promises-promises-2010/usatoday--elysa-gardner.json | excerpt | recover-full-article-and-verify-attribution |
| waitress-2016/usatoday--elysa-gardner.json | truncated | recover-full-article-and-verify-attribution |

## variety (7)

| Review file | Bucket | Next step |
| --- | --- | --- |
| big-fish-2013/variety--marilyn-stasio.json | excerpt | recover-full-article-and-verify-attribution |
| collected-stories-2010/variety--charles-isherwood.json | unresolved | read-article-and-verify-title-and-production |
| the-iceman-cometh-2018/variety--marilyn-stasio.json | unresolved | read-article-and-verify-title-and-production |
| the-road-to-mecca-2012/variety--marilyn-stasio.json | excerpt | recover-full-article-and-verify-attribution |
| the-sound-inside-2019/variety--marilyn-stasio.json | unresolved | read-article-and-verify-title-and-production |
| titanique-2026/variety--frank-rizzo.json | unresolved | read-article-and-verify-title-and-production |
| wolf-hall-parts-one-and-two-2015/variety--marilyn-stasio.json | excerpt | recover-full-article-and-verify-attribution |

## village-voice (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| a-life-in-the-theatre-2010/village-voice--michael-feingold.json | excerpt | recover-full-article-and-verify-attribution |
| the-pitmen-painters-2010/village-voice--michael-feingold.json | excerpt | recover-full-article-and-verify-attribution |

## vulture (4)

| Review file | Bucket | Next step |
| --- | --- | --- |
| amelie-a-new-musical-2017/vulture--jesse-green.json | unresolved | read-article-and-verify-title-and-production |
| ink-2019/vulture--jesse-green.json | excerpt | recover-full-article-and-verify-attribution |
| la-bete-2010/vulture--scott-brown.json | unresolved | read-article-and-verify-title-and-production |
| les-miserables-2014/vulture--jesse-green.json | unresolved | read-article-and-verify-title-and-production |

## w42st (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| the-rocky-horror-show-2026/w42st--michael-musto.json | excerpt | recover-full-article-and-verify-attribution |

## washpost (7)

| Review file | Bucket | Next step |
| --- | --- | --- |
| betrayal-2019/washpost--peter-marks.json | truncated | recover-full-article-and-verify-attribution |
| doctor-zhivago-2015/washpost--mark-kennedy.json | excerpt | recover-full-article-and-verify-attribution |
| falsettos-2016/washpost--peter-marks.json | truncated | recover-full-article-and-verify-attribution |
| my-fair-lady-2018/washpost--peter-marks.json | truncated | recover-full-article-and-verify-attribution |
| on-the-town-2014/washpost--peter-marks.json | truncated | recover-full-article-and-verify-attribution |
| the-price-2017/washpost--peter-marks.json | truncated | recover-full-article-and-verify-attribution |
| what-the-constitution-means-to-me-2019/washpost--peter-marks.json | truncated | recover-full-article-and-verify-attribution |

## whatsonstage (9)

| Review file | Bucket | Next step |
| --- | --- | --- |
| 2-22-a-ghost-story-west-end-2023/whatsonstage--alex-wood.json | unresolved | read-article-and-verify-title-and-production |
| a-month-in-the-country-west-end-2026/whatsonstage--alex-wood.json | unresolved | read-article-and-verify-title-and-production |
| a-month-in-the-country-west-end-2026/whatsonstage--sarah-crompton.json | unresolved | read-article-and-verify-title-and-production |
| all-of-us-west-end-2022/whatsonstage--gareth-carr.json | unresolved | read-article-and-verify-title-and-production |
| glengarry-glen-ross-west-end-2026/whatsonstage--sarah-crompton.json | unresolved | read-article-and-verify-title-and-production |
| lemons-lemons-lemons-lemons-lemons-west-end-2023/whatsonstage--sarah-crompton.json | unresolved | read-article-and-verify-title-and-production |
| les-miserables-1987/whatsonstage--tanyel-gumushan.json | wrong-production | verify-production-and-existing-flags |
| only-fools-and-horses-west-end-2019/whatsonstage--alun-hood.json | unresolved | read-article-and-verify-title-and-production |
| underdog-the-other-other-bronte-west-end-2024/whatsonstage--sarah-crompton.json | unresolved | read-article-and-verify-title-and-production |

## wsj (3)

| Review file | Bucket | Next step |
| --- | --- | --- |
| catch-me-if-you-can-2011/wsj--terry-teachout.json | truncated | recover-full-article-and-verify-attribution |
| la-boheme-off-broadway-2025/wsj--by-tim-page.json | unresolved | read-article-and-verify-title-and-production |
| looped-2010/wsj--terry-teachout.json | truncated | recover-full-article-and-verify-attribution |

## yonkers-tribune (2)

| Review file | Bucket | Next step |
| --- | --- | --- |
| man-and-boy-2011/yonkers-tribune--john-simon.json | excerpt | recover-full-article-and-verify-attribution |
| the-mountaintop-2011/yonkers-tribune--john-simon.json | excerpt | recover-full-article-and-verify-attribution |

## zap-2-it (1)

| Review file | Bucket | Next step |
| --- | --- | --- |
| magicbird-2012/zap-2-it--jacqueline-cutler.json | excerpt | recover-full-article-and-verify-attribution |
