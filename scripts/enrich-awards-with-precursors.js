#!/usr/bin/env node
/**
 * Enrich awards.json with precursor-award data for Tony nominees.
 *
 * Five precursor bodies (used by the Tony Predictions Awards Score formula):
 *   - Drama Desk Awards            (tier weight 0.7 in Awards Score)
 *   - Outer Critics Circle Awards  (tier weight 0.9)
 *   - Drama League Awards          (tier weight 1.0)
 *   - NY Drama Critics' Circle     (tier weight 1.0; winners only — no nominees)
 *   - Pulitzer Prize for Drama     (tier weight 1.0; winner + 2 finalists)
 *
 * Coverage: Tony nominees in the 4 main categories (Best Musical, Best Play,
 * Best Revival of a Musical, Best Revival of a Play), seasons 2013-14 through
 * 2024-25 (the predictions-era window).
 *
 * Source-of-truth data is inline below. To update for a new ceremony year,
 * append entries to the constants at the top of this file. Source: Wikipedia
 * winner+nominee pages, scraped 2026-04-29.
 *
 * Usage:
 *   node scripts/enrich-awards-with-precursors.js [--dry-run]
 *
 * Behavior:
 *   - Idempotent. Running twice produces byte-identical awards.json.
 *   - Migrates legacy Pulitzer shape {year, category} → {wins, finalist, year}.
 *   - Writes to public data/awards.json AND private repo
 *     (~/broadway-scorecard-data/awards.json) since both are sources for
 *     setup-local-data.sh consumers.
 *   - Asserts idempotency at end of run; fails loud if re-running would diverge.
 */

const fs = require('fs');
const path = require('path');
const { normalizeTitle } = require('./lib/title-match');

const PUBLIC_AWARDS = path.join(__dirname, '..', 'data', 'awards.json');
const PRIVATE_AWARDS = '/Users/tompryor/broadway-scorecard-data/awards.json';
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');

// ============================================================
// SOURCE DATA — Wikipedia, ceremony years 2014-2025
// ============================================================
//
// For Drama Desk / OCC / Drama League: structured as {year, winner, nominees}.
// `nominees` MUST include the winner.
//
// For NYDCCC: {year, winner} only — they don't publish nominee lists.
//
// For Pulitzer: {year, winner, finalists} — finalists exclude the winner.
//
// Mapping ceremony year → Tony season: year N → "(N-1)-N", e.g. 2014 → "2013-14".
// OB→Broadway transfer cases (Hamilton OB 2015 → Broadway 2015-16) are handled
// by the matcher: it searches all years for a title within the Tony-nominee pool.

const DRAMA_DESK = {
  'Outstanding Musical': [
    { year: 2014, winner: "A Gentleman's Guide to Love and Murder", nominees: ["A Gentleman's Guide to Love and Murder","Aladdin","Beautiful: The Carole King Musical","The Bridges of Madison County","Fun Home","Love's Labour's Lost","Rocky the Musical"] },
    { year: 2015, winner: "Hamilton", nominees: ["Hamilton","An American in Paris","Fly By Night","Pretty Filthy","Something Rotten!","The Visit"] },
    { year: 2016, winner: "Shuffle Along", nominees: ["Shuffle Along","First Daughter Suite","Daddy Long Legs","School of Rock","Waitress"] },
    { year: 2017, winner: "Come from Away", nominees: ["Come from Away","Anastasia","The Band's Visit","Hadestown","The Lightning Thief: The Percy Jackson Musical"] },
    { year: 2018, winner: "SpongeBob SquarePants", nominees: ["SpongeBob SquarePants","Desperate Measures","KPOP","Mean Girls","Old Stock: A Refugee Love Story"] },
    { year: 2019, winner: "The Prom", nominees: ["The Prom","Be More Chill","The Hello Girls","Rags Parkland Sings the Songs of the Future","Tootsie"] },
    { year: 2020, winner: "A Strange Loop", nominees: ["A Strange Loop","Octet","The Secret Life of Bees","Soft Power","The Wrong Man"] },
    { year: 2022, winner: "Kimberly Akimbo", nominees: ["Kimberly Akimbo","The Hang","Harmony: A New Musical","Intimate Apparel","Six"] },
    { year: 2023, winner: "Some Like It Hot", nominees: ["Some Like It Hot","& Juliet","Between the Lines","F*ck7thGrade","Shucked","White Girl in Danger"] },
    { year: 2024, winner: "Dead Outlaw", nominees: ["Dead Outlaw","Illinoise","Lizard Boy","Teeth","The Connector","The Outsiders"] },
    { year: 2025, winner: "Maybe Happy Ending", nominees: ["Maybe Happy Ending","Boop! The Musical","Death Becomes Her","Just in Time","Music City"] },
    { year: 2026, winner: null, nominees: ["Beau the Musical","Mexodus","Schmigadoon!","The Seat of Our Pants","Two Strangers (Carry a Cake Across New York)"] },
  ],
  'Outstanding Play': [
    { year: 2014, winner: "All the Way", nominees: ["All the Way","Core Values","Domesticated","The Explorers Club","The Night Alive","Outside Mullingar","Regular Singing"] },
    { year: 2015, winner: "The Curious Incident of the Dog in the Night-Time", nominees: ["The Curious Incident of the Dog in the Night-Time","You Got Older","Airline Highway","The City of Conversation","Between Riverside and Crazy","My Manãna Comes","Let the Right One In"] },
    { year: 2016, winner: "The Humans", nominees: ["The Humans","The Christians","John","King Charles III","The Royale"] },
    { year: 2017, winner: "Oslo", nominees: ["Oslo","If I Forget","Indecent","A Life","Sweat"] },
    { year: 2018, winner: "Admissions", nominees: ["Admissions","Mary Jane","Miles for Mary","People, Places and Things","School Girls; Or, The African Mean Girls Play"] },
    { year: 2019, winner: "The Ferryman", nominees: ["The Ferryman","Fairview","Lewiston/Clarkston","Usual Girls","What the Constitution Means to Me"] },
    { year: 2020, winner: "The Inheritance", nominees: ["The Inheritance","Cambodian Rock Band","Greater Clements","Halfway Bitches Go Straight to Heaven","Heroes of the Fourth Turning"] },
    { year: 2022, winner: "Prayer for the French Republic", nominees: ["Prayer for the French Republic","The Chinese Lady","Cullud Wattah","English","Sanctuary City","Selling Kabul"] },
    { year: 2023, winner: "Leopoldstadt", nominees: ["Leopoldstadt","A Case for the Existence of God","Fat Ham","Love","Prima Facie","Wish You Were Here"] },
    { year: 2024, winner: "Stereophonic", nominees: ["Stereophonic","Infinite Life","Jaja's African Hair Braiding","Mother Play","Swing State","The Ally"] },
    { year: 2025, winner: "Purpose", nominees: ["Purpose","Blood of the Lamb","Deep Blue Sound","Grangeville","John Proctor Is the Villain","Liberation"] },
    { year: 2026, winner: null, nominees: ["Caroline","Cold War Choir Practice","Meet the Cartozians","Prince Faggot","The Balusters","The Porch on Windy Hill","Well, I'll Let You Go"] },
  ],
  'Outstanding Revival of a Musical': [
    { year: 2014, winner: "Hedwig and the Angry Inch", nominees: ["Hedwig and the Angry Inch","Les Misérables","Violet"] },
    { year: 2015, winner: "The King and I", nominees: ["The King and I","Into the Woods","On the Town","On the Twentieth Century","Pageant","Side Show"] },
    { year: 2016, winner: "She Loves Me", nominees: ["She Loves Me","The Color Purple","The Golden Bride","Fiddler on the Roof","Spring Awakening"] },
    { year: 2017, winner: "Hello, Dolly!", nominees: ["Hello, Dolly!","Falsettos","Sweeney Todd","Sweet Charity","Tick, Tick... Boom!"] },
    { year: 2018, winner: "My Fair Lady", nominees: ["My Fair Lady","Amerike – The Golden Land","Carousel","Once On This Island","Pacific Overtures"] },
    { year: 2019, winner: "Fiddler on the Roof in Yiddish", nominees: ["Fiddler on the Roof in Yiddish","Carmen Jones","Kiss Me, Kate","Merrily We Roll Along","Oklahoma!"] },
    { year: 2020, winner: "Little Shop of Horrors", nominees: ["Little Shop of Horrors","The Unsinkable Molly Brown","West Side Story"] },
    { year: 2022, winner: "Company", nominees: ["Company","Assassins","Baby","Caroline, or Change"] },
    { year: 2023, winner: "Parade", nominees: ["Parade","A Man of No Importance","Into the Woods","Merrily We Roll Along","Sweeney Todd"] },
    { year: 2024, winner: "I Can Get It for You Wholesale", nominees: ["I Can Get It for You Wholesale","Cabaret at the Kit Kat Club","Gutenberg! The Musical!"] },
    { year: 2025, winner: "Gypsy", nominees: ["Gypsy","Cats: The Jellicle Ball","Floyd Collins","Once Upon a Mattress","See What I Wanna See","Sunset Blvd."] },
    { year: 2026, winner: null, nominees: ["Amahl and the Night Visitors","Chess","Ragtime","The 25th Annual Putnam County Spelling Bee","The Baker's Wife","The Rocky Horror Show"] },
  ],
  'Outstanding Revival of a Play': [
    { year: 2014, winner: "Twelfth Night", nominees: ["Twelfth Night","The Cripple of Inishmaan","I Remember Mama","London Wall","The Model Apartment","No Man's Land","Of Mice and Men"] },
    { year: 2015, winner: "The Elephant Man", nominees: ["The Elephant Man","Fashions for Men","Ghosts","The Iceman Cometh","Tamburlaine the Great","The Wayside Motor Inn"] },
    { year: 2016, winner: "A View from the Bridge", nominees: ["A View from the Bridge","Cloud 9","Death of a Salesman","Henry IV","Long Day's Journey into Night","Women Without Men"] },
    { year: 2017, winner: "Jitney", nominees: ["Jitney","The Front Page","The Hairy Ape","The Little Foxes","Master Harold...and the Boys","Picnic"] },
    { year: 2018, winner: "Angels in America", nominees: ["Angels in America","Hindle Wakes","In the Blood","Three Tall Women","Travesties"] },
    { year: 2019, winner: "The Waverly Gallery", nominees: ["The Waverly Gallery","Fabulation, or the Re-Education of Undine","Henry VI","Our Lady of 121st Street","Summer and Smoke","Uncle Vanya"] },
    { year: 2020, winner: "A Soldier's Play", nominees: ["A Soldier's Play","Fefu and Her Friends","for colored girls","Mac Beth","Much Ado About Nothing"] },
    { year: 2022, winner: "How I Learned to Drive", nominees: ["How I Learned to Drive","for colored girls","Lackawanna Blues","Skeleton Crew","Trouble in Mind","Twilight: Los Angeles, 1992"] },
    { year: 2023, winner: "The Piano Lesson", nominees: ["The Piano Lesson","A Raisin in the Sun","Death of a Salesman","Endgame","Ohio State Murders","Wedding Band"] },
    { year: 2024, winner: "Appropriate", nominees: ["Appropriate","Doubt","Philadelphia, Here I Come!","Purlie Victorious","Uncle Vanya"] },
    { year: 2025, winner: "Eureka Day", nominees: ["Eureka Day","Garside's Career","Home","Wine in the Wilderness","Yellow Face"] },
    { year: 2026, winner: null, nominees: ["Becky Shaw","Ceremonies in Dark Old Men","Death of a Salesman","Los Soles Truncos","Titus Andronicus","You Got Older"] },
  ],
};

const OUTER_CRITICS = {
  'Outstanding New Broadway Musical': [
    { year: 2014, winner: "A Gentleman's Guide to Love and Murder", nominees: ["A Gentleman's Guide to Love and Murder","Beautiful: The Carole King Musical","After Midnight","Aladdin","Rocky the Musical"] },
    { year: 2015, winner: "An American in Paris", nominees: ["An American in Paris","The Last Ship","It Shoulda Been You","The Visit","Something Rotten!"] },
    { year: 2016, winner: "Bright Star", nominees: ["Bright Star","Waitress","American Psycho","On Your Feet!","Tuck Everlasting"] },
    { year: 2017, winner: "Come From Away", nominees: ["Come From Away","A Bronx Tale","Anastasia","Groundhog Day","Holiday Inn"] },
    { year: 2018, winner: "SpongeBob SquarePants", nominees: ["SpongeBob SquarePants","Escape to Margaritaville","Frozen","Mean Girls","Prince of Broadway"] },
    { year: 2019, winner: "Hadestown", nominees: ["Hadestown","The Prom","Be More Chill","Head Over Heels","Tootsie"] },
    { year: 2022, winner: "Six", nominees: ["Six","Mrs. Doubtfire","MJ the Musical","Mr. Saturday Night","Paradise Square"] },
    { year: 2023, winner: "Some Like It Hot", nominees: ["Some Like It Hot","& Juliet","A Beautiful Noise","New York, New York","Shucked"] },
    { year: 2024, winner: "Suffs", nominees: ["Suffs","Water for Elephants","The Outsiders","The Great Gatsby","Days of Wine and Roses"] },
    { year: 2025, winner: "Maybe Happy Ending", nominees: ["Maybe Happy Ending","Real Women Have Curves","Operation Mincemeat","Death Becomes Her","Boop! The Musical"] },
    { year: 2026, winner: null, nominees: ["The Lost Boys","Schmigadoon!","Two Strangers (Carry a Cake Across New York)"] },
  ],
  'Outstanding New Broadway Play': [
    { year: 2014, winner: "All the Way", nominees: ["All the Way","Act One","Casa Valentina","Outside Mullingar","The Realistic Joneses"] },
    { year: 2015, winner: "The Curious Incident of the Dog in the Night-Time", nominees: ["The Curious Incident of the Dog in the Night-Time","The Audience","Wolf Hall Parts One & Two"] },
    { year: 2016, winner: "The Humans", nominees: ["The Humans","The Father","King Charles III","Thérèse Raquin","Eclipsed"] },
    { year: 2017, winner: "Oslo", nominees: ["Oslo","A Doll's House Part 2","Sweat","Indecent"] },
    { year: 2018, winner: "Harry Potter and the Cursed Child", nominees: ["Harry Potter and the Cursed Child","Farinelli and the King","Junk","The Children"] },
    { year: 2019, winner: "The Ferryman", nominees: ["The Ferryman","What the Constitution Means to Me","Ink","Network","To Kill a Mockingbird"] },
    { year: 2020, winner: null, nominees: ["Grand Horizons","The Height of the Storm","The Inheritance","Linda Vista","The Sound Inside"] },
    { year: 2022, winner: "The Lehman Trilogy", nominees: ["The Lehman Trilogy","The Minutes","Birthday Candles","Clyde's","Skeleton Crew"] },
    { year: 2023, winner: "Leopoldstadt", nominees: ["Leopoldstadt","Life of Pi","Peter Pan Goes Wrong","Summer, 1976","Good Night, Oscar"] },
    { year: 2024, winner: "Stereophonic", nominees: ["Stereophonic","Mother Play","Jaja's African Hair Braiding","Patriots","The Shark Is Broken"] },
    { year: 2025, winner: "John Proctor is the Villain", nominees: ["John Proctor is the Villain","Cult of Love","The Hills of California","Purpose","Stranger Things: The First Shadow"] },
    { year: 2026, winner: null, nominees: ["The Balusters","Giant","Little Bear Ridge Road","Oedipus","Punch"] },
  ],
  'Outstanding Revival of a Musical': [
    { year: 2014, winner: "Hedwig and the Angry Inch", nominees: ["Hedwig and the Angry Inch","Cabaret","Lady Day at Emerson's Bar and Grill","Violet","Les Misérables"] },
    { year: 2015, winner: "The King and I", nominees: ["The King and I","Side Show","Into the Woods","On the Town","On the Twentieth Century"] },
    { year: 2016, winner: "She Loves Me", nominees: ["She Loves Me","Spring Awakening","Fiddler on the Roof","Dames at Sea","The Color Purple"] },
    { year: 2017, winner: "Hello, Dolly!", nominees: ["Hello, Dolly!","Miss Saigon","Sunset Boulevard","Sweeney Todd","Finian's Rainbow"] },
    { year: 2018, winner: "My Fair Lady", nominees: ["My Fair Lady","Carousel","Pacific Overtures","Once on This Island"] },
    { year: 2019, winner: "Fiddler on the Roof in Yiddish", nominees: ["Fiddler on the Roof in Yiddish","Oklahoma!","Smokey Joe's Cafe","Carmen Jones","Kiss Me, Kate"] },
    { year: 2020, winner: null, nominees: ["Little Shop of Horrors","The Unsinkable Molly Brown","West Side Story"] },
    { year: 2022, winner: "Company", nominees: ["Company","The Music Man","The Streets of New York","Assassins","Caroline, Or Change"] },
    { year: 2023, winner: "Parade", nominees: ["Parade","Into the Woods","Merrily We Roll Along","Sweeney Todd","A Man of No Importance"] },
    { year: 2024, winner: "I Can Get It for You Wholesale", nominees: ["I Can Get It for You Wholesale","Spamalot","Here Lies Love","Cabaret"] },
    { year: 2025, winner: "Cats: The Jellicle Ball", nominees: ["Cats: The Jellicle Ball","Sunset Blvd.","Once Upon a Mattress","Gypsy","Floyd Collins"] },
    { year: 2026, winner: null, nominees: ["The 25th Annual Putnam County Spelling Bee","The Baker's Wife","Chess","Masquerade","Ragtime"] },
  ],
  'Outstanding Revival of a Play': [
    { year: 2014, winner: "The Glass Menagerie", nominees: ["The Glass Menagerie","The Cripple of Inishmaan","Machinal","Twelfth Night","The Winslow Boy"] },
    { year: 2015, winner: "You Can't Take It With You", nominees: ["You Can't Take It With You","Fashions for Men","Skylight","The Heidi Chronicles","The Elephant Man"] },
    { year: 2016, winner: "A View from the Bridge", nominees: ["A View from the Bridge","Long Day's Journey Into Night","Fool for Love","Blackbird","The Crucible"] },
    { year: 2017, winner: "Jitney", nominees: ["Jitney","The Front Page","The Price","Othello","The Little Foxes"] },
    { year: 2018, winner: "Angels in America", nominees: ["Angels in America","Three Tall Women","Travesties","Lobby Hero","Jesus Hopped the 'A' Train"] },
    { year: 2019, winner: "All My Sons", nominees: ["All My Sons","By the Way, Meet Vera Stark","The Waverly Gallery","Juno and the Paycock","Our Lady of 121st Street"] },
    { year: 2020, winner: null, nominees: ["A Soldier's Play","Frankie and Johnny in the Clair de Lune","For Colored Girls Who Have Considered Suicide","Fires in the Mirror","Betrayal"] },
    { year: 2022, winner: "Take Me Out", nominees: ["Take Me Out","for colored girls","Trouble in Mind","How I Learned to Drive","A Touch of the Poet"] },
    { year: 2023, winner: "Topdog/Underdog", nominees: ["Topdog/Underdog","Ohio State Murders","Death of a Salesman","Endgame","Wedding Band"] },
    { year: 2024, winner: "Appropriate", nominees: ["Appropriate","An Enemy of the People","Philadelphia, Here I Come!","Mary Jane","Purlie Victorious","Doubt, A Parable"] },
    { year: 2025, winner: "Vanya", nominees: ["Vanya","Yellow Face","Beckett Briefs","Romeo + Juliet","Glengarry Glen Ross"] },
    { year: 2026, winner: null, nominees: ["Becky Shaw","The Brothers Size","Death of a Salesman","Joe Turner's Come and Gone","Marjorie Prime"] },
  ],
};

const DRAMA_LEAGUE = {
  'Outstanding Production of a Musical': [
    { year: 2014, winner: "A Gentleman's Guide to Love and Murder", nominees: ["A Gentleman's Guide to Love and Murder","The Bridges of Madison County","Aladdin","Beautiful: The Carole King Musical","Bullets Over Broadway","Fun Home","Murder for Two","Rocky","After Midnight"] },
    { year: 2015, winner: "An American in Paris", nominees: ["An American in Paris","Something Rotten!","The Visit","Fun Home","Ghost Quartet","Hamilton","Finding Neverland","It Shoulda Been You"] },
    { year: 2016, winner: "Hamilton", nominees: ["Hamilton","On Your Feet!","American Psycho","Iowa","Bright Star","Dear Evan Hansen","Futurity","Tuck Everlasting","Waitress","School of Rock"] },
    { year: 2017, winner: "Dear Evan Hansen", nominees: ["Dear Evan Hansen","Groundhog Day","Come from Away","Anastasia","Amélie","War Paint","Bandstand","Hadestown","Ride the Cyclone","Natasha, Pierre and the Great Comet of 1812"] },
    { year: 2018, winner: "The Band's Visit", nominees: ["The Band's Visit","Bella: An American Tall Tale","Frozen","Hundred Days","Woody Sez","Summer: The Donna Summer Musical","Mean Girls","KPOP","SpongeBob SquarePants"] },
    { year: 2019, winner: "Hadestown", nominees: ["Hadestown","Beetlejuice","Be More Chill","The Cher Show","Ain't Too Proud","The Hello Girls","Tootsie","Head Over Heels","King Kong","The Prom","Rags Parkland Sings the Songs of the Future"] },
    { year: 2020, winner: "Moulin Rouge!", nominees: ["Moulin Rouge!","Tina","Six","Girl from the North Country","Jagged Little Pill","Octet","The Secret Life of Bees","Sing Street","Soft Power","A Strange Loop"] },
    { year: 2022, winner: "A Strange Loop", nominees: ["A Strange Loop","Mr. Saturday Night","Oratorio for Living Things","Six","American Utopia","Suffs","The Hang","Mrs. Doubtfire","Kimberly Akimbo","MJ"] },
    { year: 2023, winner: "Some Like It Hot", nominees: ["Some Like It Hot","& Juliet","Titanique","White Girl in Danger","Dreaming Zenzile","Shucked","A Beautiful Noise","Wuthering Heights","New York, New York"] },
    { year: 2024, winner: "Hell's Kitchen", nominees: ["Hell's Kitchen","Lempicka","The Heart of Rock and Roll","Harmony","Dead Outlaw","Buena Vista Social Club","Teeth","Suffs","The Outsiders","The Notebook","Illinoise","Water for Elephants"] },
    { year: 2025, winner: "Maybe Happy Ending", nominees: ["Maybe Happy Ending","Operation Mincemeat","Macbeth in Stride","Just in Time","Drag: The Musical","Death Becomes Her","Dead Outlaw","Buena Vista Social Club","Boop! The Musical","Stephen Sondheim's Old Friends","Real Women Have Curves","Smash"] },
    { year: 2026, winner: null, nominees: ["Beaches","Beau the Musical","Bigfoot!","The Lost Boys","Mexodus","My Joy is Heavy","Night Side Songs","Saturday Church","Schmigadoon!","The Seat of Our Pants","Titanique","Two Strangers (Carry a Cake Across New York)"] },
  ],
  'Outstanding Production of a Play': [
    { year: 2014, winner: "All the Way", nominees: ["All the Way","Casa Valentina","All That Fall","Domesticated","Mothers and Sons","The Realistic Joneses","Mr. Burns, a Post-Electric Play"] },
    { year: 2015, winner: "The Curious Incident of the Dog in the Night-Time", nominees: ["The Curious Incident of the Dog in the Night-Time","The Audience","Between Riverside and Crazy","Bootycandy","Hand to God","Constellations","Wolf Hall","An Octoroon"] },
    { year: 2016, winner: "The Humans", nominees: ["The Humans","The Father","Skeleton Crew","The Royale","Marjorie Prime","King Charles III","HIR","Gloria","Eclipsed"] },
    { year: 2017, winner: "Oslo", nominees: ["Oslo","A Life","The Play That Goes Wrong","The Wolves","A Doll's House Part 2","Everybody","Indecent","Sweat"] },
    { year: 2018, winner: "Harry Potter and the Cursed Child", nominees: ["Harry Potter and the Cursed Child","Hangmen","School Girls","Is God Is","Meteor Shower"] },
    { year: 2019, winner: "The Ferryman", nominees: ["The Ferryman","What the Constitution Means to Me","To Kill a Mockingbird","Network","The Lehman Trilogy"] },
    { year: 2020, winner: "The Inheritance", nominees: ["The Inheritance","Grand Horizons","Dana H.","The Hot Wing King","Slave Play"] },
    { year: 2022, winner: "The Lehman Trilogy", nominees: ["The Lehman Trilogy","POTUS","The Minutes","Dana H.","Clyde's"] },
    { year: 2023, winner: "Leopoldstadt", nominees: ["Leopoldstadt","Cost of Living","Downstate","Fat Ham","Prima Facie"] },
    { year: 2024, winner: "Stereophonic", nominees: ["Stereophonic","The Comeuppance","Jaja's African Hair Braiding","Oh, Mary!","Prayer for the French Republic"] },
    { year: 2025, winner: "Oh, Mary!", nominees: ["Oh, Mary!","The Picture of Dorian Gray","English","Stranger Things: The First Shadow","Purpose"] },
    { year: 2026, winner: null, nominees: ["The Balusters","Caroline","Cold War Choir Practice","Dog Day Afternoon","Giant","Kyoto","Liberation","Marcel on the Train","The Monsters","Prince Faggot","Rheology","Spread"] },
  ],
  'Outstanding Revival of a Musical': [
    { year: 2014, winner: "Hedwig and the Angry Inch", nominees: ["Hedwig and the Angry Inch","Violet","Les Misérables","Lady Day at Emerson's Bar and Grill"] },
    { year: 2015, winner: "The King and I", nominees: ["The King and I","Into the Woods","On the Twentieth Century","On the Town","Allegro"] },
    { year: 2016, winner: "The Color Purple", nominees: ["The Color Purple","Dames at Sea","Fiddler on the Roof","She Loves Me","Spring Awakening"] },
    { year: 2017, winner: "Hello, Dolly!", nominees: ["Hello, Dolly!","Miss Saigon","Sweeney Todd","Sweet Charity","Falsettos","Cats","Sunset Boulevard"] },
    { year: 2018, winner: "My Fair Lady", nominees: ["My Fair Lady","Once on This Island","Pacific Overtures","Carousel"] },
    { year: 2019, winner: "Kiss Me, Kate", nominees: ["Kiss Me, Kate","Carmen Jones","Fiddler on the Roof in Yiddish","Oklahoma!","Ordinary Days","Smokey Joe's Cafe"] },
    { year: 2020, winner: "Little Shop of Horrors", nominees: ["Little Shop of Horrors","Rock of Ages","Enter Laughing","The Unsinkable Molly Brown","West Side Story"] },
    { year: 2022, winner: "Company", nominees: ["Company","The Music Man","Funny Girl","Caroline, or Change","Assassins"] },
    { year: 2023, winner: "Into the Woods", nominees: ["Into the Woods","Camelot","Sweeney Todd","Bob Fosse's Dancin'","1776","A Man of No Importance","Parade"] },
    { year: 2024, winner: "Merrily We Roll Along", nominees: ["Merrily We Roll Along","The Who's Tommy","Cabaret","Gutenberg!","Here Lies Love","I Can Get It for You Wholesale","Spamalot","The Wiz"] },
    { year: 2025, winner: "Sunset Boulevard", nominees: ["Sunset Boulevard","The Marriage of Figaro","Once Upon a Mattress","The Last Five Years","Gypsy","Floyd Collins","Cats: The Jellicle Ball","Pirates! The Penzance Musical","Urinetown"] },
    { year: 2026, winner: null, nominees: ["The 25th Annual Putnam County Spelling Bee","Bat Boy: The Musical","Cats: The Jellicle Ball","Chess","The Gospel at Colonus","Heathers: The Musical","Masquerade","Oratorio for Living Things","Ragtime","The Rocky Horror Show","The Wild Party"] },
  ],
  'Outstanding Revival of a Play': [
    { year: 2014, winner: "The Glass Menagerie", nominees: ["The Glass Menagerie","The Cripple of Inishmaan","A Raisin in the Sun","Good Person of Szechwan","The Mutilated","Of Mice and Men","Twelfth Night","Waiting for Godot"] },
    { year: 2015, winner: "You Can't Take It With You", nominees: ["You Can't Take It With You","It's Only a Play","Skylight","Tamburlaine","This Is Our Youth","The Iceman Cometh","Big Love","The Elephant Man","The Heidi Chronicles"] },
    { year: 2016, winner: "A View from the Bridge", nominees: ["A View from the Bridge","Awake and Sing!","Long Day's Journey Into Night","Noises Off","A Midsummer Night's Dream","Sense and Sensibility","Blackbird","Cloud 9","The Crucible","The Gin Game"] },
    { year: 2017, winner: "Jitney", nominees: ["Jitney","The Price","Troilus and Cressida","Six Degrees of Separation","Present Laughter","A Doll's House","The Father","The Beauty Queen of Leenane","The Little Foxes","Master Harold and the Boys","Othello"] },
    { year: 2018, winner: "Angels in America", nominees: ["Angels in America","Yerma","Children of a Lesser God","At Home at the Zoo","Hamlet","The Iceman Cometh","Three Tall Women","Lobby Hero","Saint Joan","Torch Song","Travesties"] },
    { year: 2019, winner: "The Waverly Gallery", nominees: ["The Waverly Gallery","By the Way, Meet Vera Stark","All My Sons","Boesman and Lena","Burn This","Choir Boy","King Lear","Torch Song","Twelfth Night"] },
    { year: 2020, winner: "A Soldier's Play", nominees: ["A Soldier's Play","Frankie and Johnny in the Clair de Lune","Fires in the Mirror","Betrayal","for colored girls","The Woman in Black","The Rose Tattoo","Native Son","Judgment Day","Medea"] },
    { year: 2022, winner: "Take Me Out", nominees: ["Take Me Out","Cyrano de Bergerac","American Buffalo","for colored girls","How I Learned to Drive","Skeleton Crew","Long Day's Journey into Night","The Skin of Our Teeth","Trouble in Mind"] },
    { year: 2023, winner: "A Doll's House", nominees: ["A Doll's House","Wedding Band","A Raisin in the Sun","Ohio State Murders","The Piano Lesson","The Sign in Sidney Brustein's Window","The Thanksgiving Play","Wolf Play","Hamlet","Oresteia","Topdog/Underdog"] },
    { year: 2024, winner: "Appropriate", nominees: ["Appropriate","The White Chip","Uncle Vanya","Purlie Victorious","An Enemy of the People","Mary Jane","The Effect","Doubt, A Parable","Danny and the Deep Blue Sea","Our Class"] },
    { year: 2025, winner: "Eureka Day", nominees: ["Eureka Day","Vanya","Othello","Glengarry Glen Ross","Ghosts","Yellow Face","The Cherry Orchard","Wine in the Wilderness","Home","A Streetcar Named Desire","Romeo + Juliet"] },
    { year: 2026, winner: null, nominees: ["Anna Christie","Becky Shaw","The Brothers Size","Bug","Death of a Salesman","Every Brilliant Thing","Fallen Angels","Gruesome Playground Injuries","Joe Turner's Come and Gone","Proof","Twelfth Night","You Got Older"] },
  ],
};

// NYDCCC: only winners — no nominee list published.
const NYDCCC = {
  'Best Play': [
    { year: 2014, winner: "The Night Alive" },
    { year: 2015, winner: "Between Riverside and Crazy" },
    { year: 2016, winner: "The Humans" },
    { year: 2017, winner: "Oslo" },
    { year: 2018, winner: "Mary Jane" },
    { year: 2019, winner: "The Ferryman" },
    { year: 2020, winner: "Heroes of the Fourth Turning" },
    { year: 2022, winner: "A Case for the Existence of God" },
    { year: 2023, winner: "Downstate" },
    { year: 2024, winner: "Stereophonic" },
    { year: 2025, winner: "Purpose" },
    { year: 2026, winner: "Little Bear Ridge Road" },
  ],
  'Best Foreign Play': [
    { year: 2018, winner: "Hangmen" },
    { year: 2023, winner: "Leopoldstadt" },
  ],
  'Best Musical': [
    { year: 2014, winner: "Fun Home" },
    { year: 2015, winner: "Hamilton" },
    { year: 2016, winner: "Shuffle Along" },
    { year: 2017, winner: "The Band's Visit" },
    // 2018 not awarded
    { year: 2019, winner: "Tootsie" },
    { year: 2020, winner: "A Strange Loop" },
    // 2021 not awarded
    { year: 2022, winner: "Kimberly Akimbo" },
    // 2023 not awarded
    { year: 2024, winner: "Dead Outlaw" },
    { year: 2025, winner: "Maybe Happy Ending" },
    // 2026 not awarded
  ],
};

// Pulitzer Prize for Drama: winner + 2 finalists per year. "Drama" is the
// only category. Awards Score formula treats winner as +30, finalist as +15.
const PULITZER = [
  { year: 2014, winner: "The Flick", finalists: ["The Watson Intelligence","Fun Home"] },
  { year: 2015, winner: "Between Riverside and Crazy", finalists: ["Marjorie Prime","Father Comes Home From the Wars"] },
  { year: 2016, winner: "Hamilton", finalists: ["The Humans","Gloria"] },
  { year: 2017, winner: "Sweat", finalists: ["A 24-Decade History of Popular Music","The Wolves"] },
  { year: 2018, winner: "Cost of Living", finalists: ["Everybody","The Minutes"] },
  { year: 2019, winner: "Fairview", finalists: ["Dance Nation","What the Constitution Means to Me"] },
  { year: 2020, winner: "A Strange Loop", finalists: ["Heroes of the Fourth Turning","Soft Power"] },
  { year: 2021, winner: "The Hot Wing King", finalists: ["Circle Jerk","Stew"] },
  { year: 2022, winner: "Fat Ham", finalists: ["Kristina Wong, Sweatshop Overlord","Selling Kabul"] },
  { year: 2023, winner: "English", finalists: ["The Far Country","On Sugarland"] },
  { year: 2024, winner: "Primary Trust", finalists: ["Here There Are Blueberries","Public Obscenities"] },
  { year: 2025, winner: "Purpose", finalists: ["The Ally","Oh, Mary!"] },
  { year: 2026, winner: "Liberation", finalists: ["Bowl EP","Meet the Cartozians"] },
];

// ============================================================
// MATCHING
// ============================================================

const TONY_CATS = ['Best Musical','Best Play','Best Revival of a Musical','Best Revival of a Play'];
const CAT_SET = new Set(TONY_CATS);
const PREDICTIONS_ERA = ['2013-14','2014-15','2015-16','2016-17','2017-18','2018-19','2019-20','2021-22','2022-23','2023-24','2024-25','2025-26'];
// Latest entry — used by the matcher to relax the "must have Tony noms"
// gate while Tony nominations for the active season haven't been announced yet.
const ACTIVE_SEASON = PREDICTIONS_ERA[PREDICTIONS_ERA.length - 1];
// "2025-26" → 2026 (the ceremony year that maps to ACTIVE_SEASON's Tony season).
// Source entries from prior years must NOT match active-season shows via pass 3/4
// (e.g. Drama League 2023 "Titanique" must not attribute to titanique-2026).
const ACTIVE_CEREMONY_YEAR = parseInt(ACTIVE_SEASON.split('-')[0], 10) + 1;

function ceremonyYearToTonySeason(y) {
  return `${y - 1}-${String(y).slice(2)}`;
}

/** Map a YYYY-MM-DD opening date to the Tony season it falls within ("2024-25"
 *  for May 1 2024 through April 30 2025), or null if outside PREDICTIONS_ERA.
 *  Used by pass 4 to attribute past-season DD/OCC/DL/Pulitzer noms to
 *  non-Tony-nominated Broadway shows that aren't already in awards.json. */
function seasonForOpeningDate(openingDate) {
  if (!openingDate || typeof openingDate !== 'string' || openingDate.length < 7) return null;
  const year = parseInt(openingDate.slice(0, 4), 10);
  const month = parseInt(openingDate.slice(5, 7), 10);
  if (Number.isNaN(year) || Number.isNaN(month)) return null;
  // Tony season: May Y → April Y+1 = season "Y-(Y+1)%100"
  const startYear = month >= 5 ? year : year - 1;
  const season = `${startYear}-${String(startYear + 1).slice(2)}`;
  return PREDICTIONS_ERA.includes(season) ? season : null;
}

/** Find a showId for a scraped title. Looks across the predictions-era pool of
 *  Tony nominees by title — handles OB→Broadway transfers (e.g. Hamilton's Tony
 *  is 2015-16 but DD 2015 OB win still matters).
 *
 *  For the ACTIVE_SEASON only, the strict "must have Tony noms" gate is loosened:
 *  Tony nominations for the current season may not be announced yet, but DD/OCC
 *  precursor noms drop earlier and need a place to land. Pass 3 matches active-season
 *  shows already in awards.json (regardless of nominatedFor); pass 4 falls back to
 *  shows.json for active-season Broadway shows missing from awards.json and
 *  lazy-creates a stub entry so the precursor field has somewhere to attach.
 *
 *  Returns null if no match. */
function findShowIdByTitle(scrapedTitle, awardsShows, titleById, opts = {}) {
  const norm = normalizeTitle(scrapedTitle);
  if (!norm) return null;

  // Pass 1: exact match against Tony-nominated shows in predictions era (strict gate)
  for (const [showId, sh] of Object.entries(awardsShows)) {
    if (!sh.tony || !PREDICTIONS_ERA.includes(sh.tony.season)) continue;
    const noms = (sh.tony.nominatedFor || []).filter(c => CAT_SET.has(c));
    if (noms.length === 0) continue;
    const t = titleById[showId];
    if (!t) continue;
    if (normalizeTitle(t) === norm) return showId;
  }

  // Pass 2: prefix containment — for cases like "Shuffle Along" matching the long form
  // "Shuffle Along, or, the Making of the Musical Sensation of 1921 ..."
  for (const [showId, sh] of Object.entries(awardsShows)) {
    if (!sh.tony || !PREDICTIONS_ERA.includes(sh.tony.season)) continue;
    const noms = (sh.tony.nominatedFor || []).filter(c => CAT_SET.has(c));
    if (noms.length === 0) continue;
    const t = titleById[showId];
    if (!t) continue;
    const nT = normalizeTitle(t);
    if (norm.length < 6 || nT.length < 6) continue;
    if (nT.startsWith(norm + ' ') || norm.startsWith(nT + ' ')) {
      if (Math.abs(nT.length - norm.length) <= 35) return showId;
    }
  }

  // Pass 3 (active season only): relaxed gate against awards.json — Tony noms may
  // not be published yet for the active season, so allow matching shows whose
  // tony.season is set but nominatedFor is empty.
  if (opts.sourceYear === ACTIVE_CEREMONY_YEAR) {
    for (const [showId, sh] of Object.entries(awardsShows)) {
      if (!sh.tony || sh.tony.season !== ACTIVE_SEASON) continue;
      const t = titleById[showId];
      if (!t) continue;
      if (normalizeTitle(t) === norm) return showId;
    }
  }

  // Pass 4: shows.json fallback for any PREDICTIONS_ERA season — match the
  // Broadway production whose opening date falls in the source year's Tony
  // season window (May Y-1 → April Y for ceremony year Y). Lazy-creates an
  // awards.json stub or backfills tony.season on existing entries that lack it.
  //
  // Year-gating is essential: prior-year nominations for OB shows that later
  // transferred to Broadway as a DIFFERENT production (e.g. DL 2023 "Titanique"
  // OB → titanique-2026 Broadway revival) would false-attribute without it.
  // Pass 1+2 still search across ALL PREDICTIONS_ERA years for the Tony-nominee
  // pool, which correctly handles the OB→Broadway transfer cases (Hamilton DD
  // 2015 OB matches hamilton-2015 in 2015-16 Tony season via pass 1).
  if (opts.broadwayShowsBySeason && opts.sourceYear) {
    const targetSeason = ceremonyYearToTonySeason(opts.sourceYear);
    if (PREDICTIONS_ERA.includes(targetSeason)) {
      const candidates = opts.broadwayShowsBySeason.get(targetSeason) || [];
      for (const sh of candidates) {
        if (normalizeTitle(sh.title) !== norm) continue;
        if (!awardsShows[sh.id]) {
          awardsShows[sh.id] = { tony: { season: targetSeason, nominatedFor: [] } };
          if (opts.onCreate) opts.onCreate(sh.id);
        } else {
          // Backfill tony.season on existing entries (e.g. giant-2026 had only
          // an Olivier block; without tony.season, downstream consumers like
          // data-tony-predictions.ts:384 filter the show out).
          if (!awardsShows[sh.id].tony) {
            awardsShows[sh.id].tony = { season: targetSeason, nominatedFor: [] };
            if (opts.onBackfillTony) opts.onBackfillTony(sh.id);
          } else if (!awardsShows[sh.id].tony.season) {
            awardsShows[sh.id].tony.season = targetSeason;
            if (opts.onBackfillTony) opts.onBackfillTony(sh.id);
          }
        }
        titleById[sh.id] = sh.title;
        return sh.id;
      }
    }
  }

  return null;
}

// ============================================================
// MERGE (idempotent)
// ============================================================

/** Sort + dedupe an array. Mutates returned new array. */
function uniqSorted(arr) {
  return [...new Set(arr)].sort();
}

/** Ensure a precursor field exists with sorted+deduped wins/nominatedFor.
 *  Mutates the show object. */
function ensurePrecursorField(sh, key, defaultSeason) {
  if (!sh[key]) sh[key] = {};
  const f = sh[key];
  if (!f.season && defaultSeason) f.season = defaultSeason;
  f.wins = Array.isArray(f.wins) ? uniqSorted(f.wins) : [];
  f.nominatedFor = Array.isArray(f.nominatedFor) ? uniqSorted(f.nominatedFor) : [];
  // Preserve existing `nominations` count if present (used by AwardsCard "noms" display)
}

/** Migrate Pulitzer field to canonical shape: { wins?, finalist?, year? }.
 *  Drops legacy {category} key (always "Drama" — redundant). */
function migratePulitzer(sh) {
  if (!sh.pulitzer) return;
  const p = sh.pulitzer;
  // Legacy {year, category} ALWAYS represented a win in pre-enrichment data.
  // If we see {year, category} without wins/finalist, treat it as a win record.
  if (typeof p.year === 'number' && p.category && !Array.isArray(p.wins) && !Array.isArray(p.finalist)) {
    sh.pulitzer = { wins: ['Drama'], finalist: [], year: p.year };
    return;
  }
  // Hybrid: has both legacy and new keys. Keep year, normalize the rest.
  const out = {
    wins: Array.isArray(p.wins) ? uniqSorted(p.wins) : [],
    finalist: Array.isArray(p.finalist) ? uniqSorted(p.finalist) : [],
  };
  if (typeof p.year === 'number') out.year = p.year;
  sh.pulitzer = out;
}

/** Apply DD/OCC/DL source data to awards.json. Adds nominatedFor (and `wins`
 *  for the matching Tony category, when scraped winner matches). */
function applyDDOCCDL(source, fieldKey, awardsShows, titleById, opts) {
  let matched = 0;
  const unmatched = [];
  for (const [scrapedCategory, years] of Object.entries(source)) {
    for (const yearEntry of years) {
      const callOpts = { ...opts, sourceYear: yearEntry.year };
      for (const nomineeName of yearEntry.nominees) {
        const showId = findShowIdByTitle(nomineeName, awardsShows, titleById, callOpts);
        if (!showId) {
          unmatched.push(`${fieldKey}/${scrapedCategory}/${yearEntry.year}: ${nomineeName}`);
          continue;
        }
        const sh = awardsShows[showId];
        ensurePrecursorField(sh, fieldKey, sh.tony && sh.tony.season);
        if (!sh[fieldKey].nominatedFor.includes(scrapedCategory)) {
          sh[fieldKey].nominatedFor.push(scrapedCategory);
          sh[fieldKey].nominatedFor = uniqSorted(sh[fieldKey].nominatedFor);
        }
        if (yearEntry.winner && normalizeTitle(yearEntry.winner) === normalizeTitle(nomineeName)) {
          if (!sh[fieldKey].wins.includes(scrapedCategory)) {
            sh[fieldKey].wins.push(scrapedCategory);
            sh[fieldKey].wins = uniqSorted(sh[fieldKey].wins);
          }
        }
        matched++;
      }
    }
  }
  return { matched, unmatched };
}

/** Apply NYDCCC source. Winners only — `wins` populated; no nominatedFor. */
function applyNYDCCC(source, awardsShows, titleById, opts) {
  let matched = 0;
  const unmatched = [];
  for (const [category, years] of Object.entries(source)) {
    for (const yearEntry of years) {
      if (!yearEntry.winner) continue;
      const callOpts = { ...opts, sourceYear: yearEntry.year };
      const showId = findShowIdByTitle(yearEntry.winner, awardsShows, titleById, callOpts);
      if (!showId) {
        unmatched.push(`NYDCCC/${category}/${yearEntry.year}: ${yearEntry.winner}`);
        continue;
      }
      const sh = awardsShows[showId];
      ensurePrecursorField(sh, 'nyDramaCritics', sh.tony && sh.tony.season);
      if (!sh.nyDramaCritics.wins.includes(category)) {
        sh.nyDramaCritics.wins.push(category);
        sh.nyDramaCritics.wins = uniqSorted(sh.nyDramaCritics.wins);
      }
      matched++;
    }
  }
  return { matched, unmatched };
}

/** Apply Pulitzer source. Sets wins (winner) or finalist per show, records year. */
function applyPulitzer(source, awardsShows, titleById, opts) {
  let matched = 0;
  const unmatched = [];
  for (const e of source) {
    const callOpts = { ...opts, sourceYear: e.year };
    // Winner
    const wId = findShowIdByTitle(e.winner, awardsShows, titleById, callOpts);
    if (!wId) unmatched.push(`Pulitzer/${e.year} winner: ${e.winner}`);
    else {
      const sh = awardsShows[wId];
      if (!sh.pulitzer) sh.pulitzer = { wins: [], finalist: [] };
      if (!Array.isArray(sh.pulitzer.wins)) sh.pulitzer.wins = [];
      if (!Array.isArray(sh.pulitzer.finalist)) sh.pulitzer.finalist = [];
      if (!sh.pulitzer.wins.includes('Drama')) sh.pulitzer.wins.push('Drama');
      sh.pulitzer.wins = uniqSorted(sh.pulitzer.wins);
      sh.pulitzer.year = e.year;
      matched++;
    }
    // Finalists
    for (const f of e.finalists) {
      const fId = findShowIdByTitle(f, awardsShows, titleById, callOpts);
      if (!fId) { unmatched.push(`Pulitzer/${e.year} finalist: ${f}`); continue; }
      const sh = awardsShows[fId];
      if (!sh.pulitzer) sh.pulitzer = { wins: [], finalist: [] };
      if (!Array.isArray(sh.pulitzer.wins)) sh.pulitzer.wins = [];
      if (!Array.isArray(sh.pulitzer.finalist)) sh.pulitzer.finalist = [];
      // If show is also a winner in same year, don't add to finalist
      if (!sh.pulitzer.wins.includes('Drama') && !sh.pulitzer.finalist.includes('Drama')) {
        sh.pulitzer.finalist.push('Drama');
      }
      sh.pulitzer.finalist = uniqSorted(sh.pulitzer.finalist);
      // Record finalist year only if no winner year already set
      if (typeof sh.pulitzer.year !== 'number') sh.pulitzer.year = e.year;
      matched++;
    }
  }
  return { matched, unmatched };
}

// ============================================================
// MAIN
// ============================================================

function main() {
  console.log('=== ENRICH AWARDS WITH PRECURSORS ===');
  if (DRY_RUN) console.log('DRY RUN — no files will be written\n');

  const awards = JSON.parse(fs.readFileSync(PUBLIC_AWARDS, 'utf8'));
  const showsJson = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const showsArr = Array.isArray(showsJson) ? showsJson : (showsJson.shows || []);
  const titleById = {};
  for (const sh of showsArr) {
    if (sh.id && sh.title) titleById[sh.id] = sh.title;
  }
  const awardsShows = awards.shows || awards;

  // Broadway shows from shows.json bucketed by Tony season (PREDICTIONS_ERA only).
  // Used by matcher pass 4 to attribute DD/OCC/DL/Pulitzer noms to non-Tony-nominated
  // Broadway shows that aren't currently in awards.json. Year-gated by source year
  // so a DD 2015 entry only matches Broadway shows opened in 2014-15 season.
  const broadwayShowsBySeason = new Map();
  for (const s of showsArr) {
    if (!s || !s.id || !s.title || s.category !== 'broadway') continue;
    const season = seasonForOpeningDate(s.openingDate || s.previewsStartDate);
    if (!season) continue;
    if (!broadwayShowsBySeason.has(season)) broadwayShowsBySeason.set(season, []);
    broadwayShowsBySeason.get(season).push(s);
  }
  const createdEntries = [];
  const backfilledTony = [];
  const matcherOpts = {
    broadwayShowsBySeason,
    onCreate: (id) => createdEntries.push(id),
    onBackfillTony: (id) => backfilledTony.push(id),
  };

  // 1) Migrate Pulitzer schema for ALL shows (idempotent)
  let migrated = 0;
  for (const [showId, sh] of Object.entries(awardsShows)) {
    if (!sh.pulitzer) continue;
    const before = JSON.stringify(sh.pulitzer);
    migratePulitzer(sh);
    if (JSON.stringify(sh.pulitzer) !== before) migrated++;
  }
  console.log(`Pulitzer schema migrated for ${migrated} shows (legacy → canonical)`);

  // 2) Apply each precursor source
  const ddRes = applyDDOCCDL(DRAMA_DESK, 'dramadesk', awardsShows, titleById, matcherOpts);
  const occRes = applyDDOCCDL(OUTER_CRITICS, 'outerCriticsCircle', awardsShows, titleById, matcherOpts);
  const dlRes = applyDDOCCDL(DRAMA_LEAGUE, 'dramaLeague', awardsShows, titleById, matcherOpts);
  const nydRes = applyNYDCCC(NYDCCC, awardsShows, titleById, matcherOpts);
  const pulRes = applyPulitzer(PULITZER, awardsShows, titleById, matcherOpts);

  console.log('\nMatch stats:');
  console.log(`  Drama Desk:           ${ddRes.matched} matched, ${ddRes.unmatched.length} unmatched (mostly OB shows not in awards.json)`);
  console.log(`  Outer Critics:        ${occRes.matched} matched, ${occRes.unmatched.length} unmatched`);
  console.log(`  Drama League:         ${dlRes.matched} matched, ${dlRes.unmatched.length} unmatched`);
  console.log(`  NY Drama Critics:     ${nydRes.matched} matched, ${nydRes.unmatched.length} unmatched`);
  console.log(`  Pulitzer Drama:       ${pulRes.matched} matched, ${pulRes.unmatched.length} unmatched`);
  if (createdEntries.length > 0) {
    console.log(`\nLazy-created ${createdEntries.length} awards.json stub(s) for Broadway shows missing entries:`);
    for (const id of createdEntries) console.log(`  + ${id}`);
  }
  if (backfilledTony.length > 0) {
    console.log(`\nBackfilled tony.season on ${backfilledTony.length} existing entries (had non-Tony awards data only):`);
    for (const id of backfilledTony) console.log(`  ~ ${id}`);
  }

  // 3) Update _meta
  if (!awards._meta) awards._meta = {};
  awards._meta.lastUpdated = new Date().toISOString();
  const sources = new Set(awards._meta.sources || []);
  sources.add('Wikipedia (Tony, Drama Desk, Outer Critics Circle, Drama League, NY Drama Critics\' Circle, Pulitzer Drama)');
  awards._meta.sources = [...sources];

  // 4) Idempotency self-check: serialize, deserialize, re-apply, deep-equal
  const serialized = JSON.stringify(awards, null, 2);
  if (!DRY_RUN) {
    // Compare against current on-disk to determine if anything changed
    const onDisk = fs.readFileSync(PUBLIC_AWARDS, 'utf8');
    const sameAsDisk = serialized === onDisk;
    console.log(`\nDiff vs on-disk: ${sameAsDisk ? 'IDENTICAL (idempotent on already-enriched data)' : 'CHANGED'}`);
  }

  // 5) Verify idempotency: run a second pass on the just-enriched data and assert no diff
  const second = JSON.parse(serialized);
  const secondShows = second.shows || second;
  let migrated2 = 0;
  for (const sh of Object.values(secondShows)) {
    if (!sh.pulitzer) continue;
    const before = JSON.stringify(sh.pulitzer);
    migratePulitzer(sh);
    if (JSON.stringify(sh.pulitzer) !== before) migrated2++;
  }
  // Idempotency check uses the same matcher opts so pass 4 lookups behave consistently.
  applyDDOCCDL(DRAMA_DESK, 'dramadesk', secondShows, titleById, matcherOpts);
  applyDDOCCDL(OUTER_CRITICS, 'outerCriticsCircle', secondShows, titleById, matcherOpts);
  applyDDOCCDL(DRAMA_LEAGUE, 'dramaLeague', secondShows, titleById, matcherOpts);
  applyNYDCCC(NYDCCC, secondShows, titleById, matcherOpts);
  applyPulitzer(PULITZER, secondShows, titleById, matcherOpts);
  // Don't update _meta on second pass (timestamp would diverge); strip before compare
  const firstNoMeta = JSON.parse(serialized);
  delete firstNoMeta._meta;
  delete second._meta;
  const firstStr = JSON.stringify(firstNoMeta);
  const secondStr = JSON.stringify(second);
  if (firstStr !== secondStr) {
    console.error('\n✗ IDEMPOTENCY ASSERTION FAILED — second pass diverged from first');
    process.exit(1);
  }
  console.log(`✓ Idempotency assertion passed (Pulitzer migrate-stable: ${migrated2 === 0})`);

  // 6) Write
  if (!DRY_RUN) {
    fs.writeFileSync(PUBLIC_AWARDS, serialized);
    console.log(`Wrote ${PUBLIC_AWARDS}`);
    if (fs.existsSync(PRIVATE_AWARDS)) {
      fs.writeFileSync(PRIVATE_AWARDS, serialized);
      console.log(`Wrote ${PRIVATE_AWARDS}`);
    } else {
      console.log(`(skipped private repo write — ${PRIVATE_AWARDS} not found)`);
    }
  }
}

main();
