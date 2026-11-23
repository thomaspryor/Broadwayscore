
      const Module = require('node:module');
      const original = Module._load;
      const pages = {"https://www.barbican.org.uk/whats-on/2026/event/end-of-the-world-and-hard-boiled-wonderland":"<main><header><h1>End of the World and Hard-Boiled Wonderland</h1><h2>Haruki Murakami / Philippe Decouflé</h2><p>Thu 8 –Sun 11 Oct 2026</p><p>Theatre</p></header></main>","https://www.thecoronettheatre.com/whats-on/berliner-ensemble-de-profundis-by-oscar-wilde/":"<main><h1>Berliner Ensemble: De Profundis By Oscar Wilde</h1><p>02–07 Oct 2026</p><p class=\"event-venue\">The Coronet Theatre</p></main>","https://www.londontheatre.co.uk/show/hamilton":"<script type=\"application/ld+json\">{\"@context\":\"https://schema.org\",\"@type\":\"TheaterEvent\",\"name\":\"Hamilton\",\"location\":{\"@type\":\"Place\",\"name\":\"Victoria Palace Theatre\"},\"startDate\":\"2017-12-21\",\"endDate\":\"2027-03-28\"}</script>"};
      const shows = [{"id":"end-of-the-world-and-hard-boiled-wonderland-off-west-end-2026","title":"End of the World and Hard-Boiled Wonderland","venue":"Barbican Theatre","category":"off-west-end","market":"west-end","openingDate":"2026-10-08","closingDate":"2026-10-11"},{"id":"de-profundis-off-west-end-2026","title":"De Profundis","venue":"Coronet Theatre","category":"off-west-end","market":"west-end","openingDate":"2026-10-02","closingDate":"2026-10-07"},{"id":"hamilton-west-end-2017","title":"Hamilton","venue":"Victoria Palace Theatre","category":"west-end","market":"west-end","openingDate":"2017-12-21","closingDate":null},{"id":"hamilton-2015","title":"Hamilton","venue":"Richard Rodgers Theatre","openingDate":"2015-08-06","category":"broadway","market":"broadway"},{"id":"wicked-2003","title":"Wicked","venue":"Gershwin Theatre","openingDate":"2003-10-30","category":"broadway","market":"broadway"},{"id":"hadestown-2019","title":"Hadestown","venue":"Walter Kerr Theatre","openingDate":"2019-04-17","category":"broadway","market":"broadway"}];
      Module._load = function(id, parent, ...rest) {
        if (/(?:^|\/)scraper$/.test(id)) return {
          fetchPage: async url => {
            if (pages[url]) return { content: pages[url] };
            if (new URL(url).hostname !== 'playbill.com') throw Error('Unexpected URL: ' + url);
            const show = shows.find(s => s.category === 'broadway' && url.toLowerCase().includes(s.title.toLowerCase()));
            if (!show) throw Error('Unexpected Playbill URL: ' + url);
            return { content: '<title>' + show.title + ' (Broadway, ' + show.venue + ', ' + show.openingDate.slice(0,4) + ') | Playbill</title>' + ' '.repeat(5100) };
          }, getScraperStats: () => ({ pwBrowserMissingCount: 0 }), cleanup: async () => {},
        };
        if (/(?:^|\/)url-discovery$/.test(id)) return { serpQuery: async query => {
          if (query.includes('playbill.com')) return [];
          if (process.env.BRO_5178_SEARCH_MODE === 'empty') return [];
          if (process.env.BRO_5178_SEARCH_MODE === 'outage') return null;
          if (query.includes('De Profundis')) return [{ url: "https://www.thecoronettheatre.com/whats-on/berliner-ensemble-de-profundis-by-oscar-wilde/" }];
          if (query.includes('Hamilton')) return [{ url: "https://www.londontheatre.co.uk/show/hamilton" }];
          return [{ url: "https://www.barbican.org.uk/whats-on/2026/event/end-of-the-world-and-hard-boiled-wonderland" }];
        } };
        return original.call(this, id, parent, ...rest);
      };
    