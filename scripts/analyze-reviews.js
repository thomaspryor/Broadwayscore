// Script to analyze Hamilton reviews - compare Show-Score with existing files

const existingFiles = [
  'amny--matt-windman',
  'ap--mark-kennedy',
  'bww--michael-dale',
  'chtrib--chris-jones',
  'dc-theatre-scene--jonathan-mandell',
  'deadline--jeremy-gerard',
  'ew--leah-greenblatt',
  'hollywood-reporter--frank-scheck',
  'huffpost--steven-suskin',
  'nbc--robert-kahn',
  'newsday--linda-winer',
  'nydn--joe-dziemianowicz',
  'nyp--elisabeth-vincentelli',
  'nytimes--ben-brantley',
  'observer--david-cote',
  'theatermania--zachary-stewart',
  'thewrap--robert-hofler',
  'thr--david-rooney',
  'timeout-ny--david-cote',
  'usa-today--elysa-gardner',
  'variety--marilyn-stasio',
  'vulture--jesse-green',
  'wsj--terry-teachout'
];

const showScoreReviews = [
  { outlet: 'The New York Times', author: 'Ben Brantley', url: 'http://www.nytimes.com/2015/08/07/theater/review-hamilton-young-rebels-changing-history-and-theater.html?ref=theater&_r=0' },
  { outlet: 'Time Out New York', author: 'David Cote', url: 'http://www.timeout.com/newyork/theater/hamilton-1' },
  { outlet: 'New York Magazine / Vulture', author: 'Jesse Green', url: 'http://www.vulture.com/2015/08/theater-review-hamilton.html' },
  { outlet: 'The Wall Street Journal', author: 'Terry Teachout', url: 'http://www.wsj.com/articles/hamilton-review-the-revolution-moves-uptown-1438907400' },
  { outlet: 'Deadline', author: 'Jeremy Gerard', url: 'http://deadline.com/2015/08/hamilton-broadway-opening-review-1201492933/' },
  { outlet: 'New York Daily News', author: 'Joe Dziemianowicz', url: 'http://www.nydailynews.com/entertainment/theater-arts/hamilton-musical-mint-condition-broadway-article-1.2316761' },
  { outlet: 'Variety', author: 'Marilyn Stasio', url: 'http://variety.com/2015/legit/reviews/hamilton-review-broadway-1201557679/' },
  { outlet: 'The Hollywood Reporter', author: 'Frank Scheck', url: 'http://www.hollywoodreporter.com/review/lin-manuel-mirandas-hamilton-theater-813145' },
  { outlet: 'The Washington Post', author: 'Peter Marks', url: 'http://www.washingtonpost.com/entertainment/theater_dance/hamilton-making-ecstatic-history/2015/08/06/6bc85fb4-3b72-11e5-8e98-115a3cf7d7ae_story.html' },
  { outlet: 'Chicago Tribune', author: 'Chris Jones', url: 'http://www.chicagotribune.com/entertainment/theater/broadway/sc-hamilton-broadway-review-20150806-column.html#page=1' },
  { outlet: 'New York Post', author: 'Elisabeth Vincentelli', url: 'http://nypost.com/2015/08/06/hamilton-isnt-quite-revolutionary/' },
  { outlet: 'Entertainment Weekly', author: 'Leah Greenblatt', url: 'http://www.ew.com/article/2015/08/06/hamilton-ew-stage-review' },
  { outlet: 'AM New York', author: 'Matt Windman', url: 'http://www.amny.com/entertainment/hamilton-review-lin-manuel-miranda-alexander-hamilton-musical-inventive-1.10715576' },
  { outlet: 'NY1', author: 'Roma Torre', url: 'http://www.ny1.com/nyc/all-boroughs/lifestyles/2015/08/6/ny1-theater-review---hamilton-.html' },
  { outlet: 'Theatermania', author: 'Zachary Stewart', url: 'http://www.theatermania.com/broadway/reviews/hamilton_73764.html' },
  { outlet: 'BroadwayWorld', author: 'Michael Dale', url: 'http://www.broadwayworld.com/article/BWW-Reviews-HAMILTON-Takes-a-Shot-at-Broadway-20150807' },
  { outlet: 'Talkin Broadway', author: 'Matthew Murray', url: 'http://www.talkinbroadway.com/world/Hamilton2015.html' },
  { outlet: 'TheaterScene.net', author: 'Victor Gluck', url: 'http://www.theaterscene.net/musicals/hamilton-broadway/victor-gluck/' },
  { outlet: 'Theatre is Easy', author: 'Molly Marinik', url: 'http://www.theasy.com/Reviews/2015/H/hamiltonbroadway.php' },
  { outlet: 'Front Mezz Junkies', author: 'Steven Ross', url: 'http://frontmezzjunkies.com/2016/02/09/finally-heres-hamilton/' },
  { outlet: 'Theatre Reviews Limited', author: 'David Roberts', url: 'http://www.theatrereviews.com/review-hamilton-grapples-richly-with-the-past-at-the-richard-rogers-theatre/' },
  { outlet: 'New York Theater', author: 'Jonathan Mandell', url: 'https://newyorktheater.me/2019/03/08/hamilton-on-broadway-2019-new-cast-new-clarity/' },
  { outlet: 'Cititour', author: 'Brian Scott Lipton', url: 'http://cititour.com/NYC_Broadway/Hamilton/838' },
  { outlet: 'The Clyde Fitch Report', author: 'David Finkle', url: 'http://www.clydefitchreport.com/2015/08/hamilton-broadway-musical/' },
  { outlet: 'The Wrap', author: 'Robert Hofler', url: 'http://www.thewrap.com/hamilton-broadway-review-the-founding-fathers-never-looked-or-sounded-so-cool/' },
  { outlet: 'The Huffington Post', author: 'Steven Suskin', url: 'http://www.huffingtonpost.com/steven-suskin/aisle-view-smiling-man-on_b_7952484.html' },
  { outlet: 'Towleroad', author: 'Naveen Kumar', url: 'http://www.towleroad.com/2015/08/hamilton-review/' },
  { outlet: 'NorthJersey.com', author: 'Robert Feldberg', url: 'http://www.northjersey.com/arts-and-entertainment/theater/revolutionary-musical-fits-on-broadway-1.1388340' },
  { outlet: 'WNBC', author: 'Robert Kahn', url: 'http://www.nbcnewyork.com/entertainment/the-scene/Hamilton-Miranda-Review-320828191.html' },
  { outlet: 'Zeal NYC', author: 'Jil Picariello', url: 'https://zealnyc.com/hamilton-review-genius-yeah-i-said-it-genius/' },
  { outlet: 'StageZine', author: 'Scott Harrah', url: 'http://www.stagezine.com/hamilton-start-of-the-broadway-revolution/' },
  { outlet: 'The Associated Press', author: 'Mark Kennedy', url: 'http://www.washingtontimes.com/news/2015/aug/6/review-hamilton-gets-even-better-on-its-trip-to-br/' },
  { outlet: 'BackStage Barbie', author: 'BackStage Barbie', url: 'http://backstagebarbie.blogspot.com/2016/02/hamilton-from-public-to-rodgers.html' },
  { outlet: 'Our Theater Blog', author: 'Tamara Beck', url: 'https://tandbontheaisle.wordpress.com/2015/11/10/hamilton-is-still-a-perfect-10/' },
  { outlet: 'Boston Globe', author: 'Don Aucoin', url: 'https://www.bostonglobe.com/arts/theater-art/2015/08/06/political-rivalries-and-rap-battles-broadway-dynamic-hamilton/tnohgXXg2ud9ffjQGrCX5I/story.html' },
  { outlet: 'ThisbroadSway', author: 'Sandra McFarland', url: 'http://www.thisbroadsway.com/hamilton.html' },
  { outlet: 'Roy Berko Info', author: 'Roy Berko', url: 'http://royberkinfo.blogspot.com/2018/04/a-cleveland-reviewer-gets-to-evaluate.html' },
  { outlet: 'The Three Tomatoes', author: 'Valerie Samaldone', url: 'http://thethreetomatoes.com/hamilton-an-american-musical' },
  { outlet: 'Newsday', author: 'Linda Winer', url: 'http://www.newsday.com/entertainment/theater/hamilton-review-even-better-on-broadway-1.10711524' },
  { outlet: 'USA Today', author: 'Elysa Gardner', url: 'http://www.usatoday.com/story/life/theater/2015/08/06/hamilton-win-hearts-and-minds/31104087/?utm_source=feedblitz&utm_medium=FeedBlitzRss&utm_campaign=usatoday-lifetopstories' },
  { outlet: 'Bobs Theater Blog', author: 'Robert Sholiton', url: 'http://bobs-theater-blog.blogspot.com/2016/10/hamilton-revisited.html' },
  { outlet: 'Act Three - The Reviews', author: 'Doug Marino', url: 'https://dougmarino.blogspot.com/2017/04/hamilton.html' },
  { outlet: 'As Her World Turns', author: 'Erica Meyer', url: 'http://www.asherworldturns.com/winter-2015-16-nyc-theater-guide/' },
  { outlet: 'BroadwaySelect', author: 'Peter Filichia', url: 'http://broadwayselect.com/hamilton-alexs-wonderland/' }
];

// Normalize for comparison
function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const existingNormalized = existingFiles.map(f => normalize(f));

const missing = showScoreReviews.filter(r => {
  const authorNorm = normalize(r.author);
  // Check if any existing file contains this author's last name
  const lastName = r.author.split(' ').pop();
  const lastNameNorm = normalize(lastName);
  const found = existingNormalized.some(e =>
    e.includes(lastNameNorm) && lastNameNorm.length > 3
  );
  return !found;
});

console.log('=== EXISTING REVIEWS (' + existingFiles.length + ') ===');
existingFiles.forEach(f => console.log('  ' + f));

console.log('\n=== SHOW-SCORE REVIEWS (44 total) ===');

console.log('\n=== MISSING REVIEWS (' + missing.length + ') ===');
missing.forEach(r => {
  console.log('  ' + r.outlet + ' - ' + r.author);
  console.log('    URL: ' + r.url);
});
