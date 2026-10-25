// WARNING: this collector targets cnn.com. Do NOT run it: the hackathon disqualifies scraping paywalled sites.
// Kept only as a reference for the date-prefilter idea (skip articles outside a date window before loading them).
// Bright Data Scraper Studio: stage 1 (search listing). Reference copy of the team's collector,
// extended with date-window inputs. UNTESTED in the IDE: paste it in, run one small test job,
// and compare the Runs tab page-load count with and without date_from/date_to.
//
// New optional inputs (declare them under "Add another input" in the collector's input schema):
//   date_from, date_to  YYYY-MM-DD. Articles whose URL date is outside the window are never loaded.
//                       CNN article URLs look like /2020/09/28/us/glass-fire-... so the check is free.
//   max_pages           search result pages to read (default 2; each page is a billed page load)
//   sort                CNN search sort ("newest" default). For old windows try "relevance": untested.
// Undeclared inputs just read as undefined here, so this still works unchanged with the current schema.
const wait_sel = 'a.container__link--type-NewsArticle, .container__headline-text';
let base;
if (input.url) {
  base = new URL(input.url);
} else {
  const q = [input.search_keyword || 'wildfire', input.location || 'Oakland Berkeley'].join(' ').trim();
  base = new URL('https://www.cnn.com/search');
  base.searchParams.set('q', q);
  base.searchParams.set('sort', input.sort || 'newest');
  base.searchParams.set('types', 'article');
}
const page = +input.page || 1;
const url = new URL(base.href);
if (page > 1) {
  url.searchParams.set('from', String((page - 1) * 10));
  url.searchParams.set('size', '10');
  url.searchParams.set('page', String(page));
}
navigate(url.href);
wait(wait_sel);

const { urls, total } = parse();

if (!input.is_rerun) {
  const max_pages = Math.min(+input.max_pages || 2, 10);
  const total_pages = Math.min(Math.ceil((total || 0) / 10), max_pages);
  for (let i = 2; i <= total_pages; i++) {
    rerun_stage({
      search_keyword: input.search_keyword,
      location: input.location,
      url: base.href,
      page: i,
      is_rerun: true,
      date_from: input.date_from,
      date_to: input.date_to,
      max_pages: input.max_pages,
      sort: input.sort,
    });
  }
}

// Skip articles outside the window before paying to load them. Undated URLs are kept (the
// news agent filters on the article's own published_date afterwards).
const url_date = (u) => {
  const m = new URL(u).pathname.match(/^\/(\d{4})\/(\d{2})\/(\d{2})\//);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const in_window = (u) => {
  const d = url_date(u);
  if (!d) return true;
  if (input.date_from && d < input.date_from) return false;
  if (input.date_to && d > input.date_to) return false;
  return true;
};
for (let u of urls.filter(in_window)) next_stage({ url: u });
