// Script: restaura los 31 cortos de Chaplin (Essanay y Mutual) perdidos tras el escaneo.
// Elimina entradas manuales de Chaplin que sobrevivieron y re-crea las 31 entradas individuales.
// Uso: node scripts/restore-chaplin.js

const fs    = require('fs');
const https = require('https');

const CONFIG_PATH  = 'c:/Users/Julian/Documents/cinemateca/data/config.json';
const LIBRARY_PATH = 'c:/Users/Julian/Documents/cinemateca/data/library.json';

// ─── TMDB helpers ──────────────────────────────────────────────────────────

function tmdbGet(apiKey, path) {
  return new Promise((resolve, reject) => {
    const sep = path.includes('?') ? '&' : '?';
    const url = new URL(`https://api.themoviedb.org/3${path}${sep}api_key=${apiKey}`);
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function searchMovie(apiKey, title, year) {
  const q = encodeURIComponent(title);
  const data = await tmdbGet(apiKey, `/search/movie?query=${q}&year=${year}&language=en-US`);
  if (data.results?.length) return data.results[0];
  const data2 = await tmdbGet(apiKey, `/search/movie?query=${q}&language=en-US`);
  return data2.results?.[0] || null;
}

async function getMovieDetails(apiKey, tmdbId) {
  return tmdbGet(apiKey, `/movie/${tmdbId}?language=en-US&append_to_response=credits,videos,keywords,release_dates`);
}

// ─── IMDb certifications ───────────────────────────────────────────────────

function fetchIMDb(imdbId) {
  return new Promise((resolve) => {
    const url = new URL(`https://www.imdb.com/title/${imdbId}/parentalguide/`);
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchIMDb(res.headers.location.replace('https://www.imdb.com', '')).then(resolve);
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', () => resolve(''));
  });
}

function extractCerts(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return { ar: null, us: null };
  try {
    const str = match[1];
    const certsMatch = str.match(/"certificates":\[(\{"country":.+?)\],"fetchedCertificates"/);
    if (certsMatch) {
      const certs = JSON.parse('[' + certsMatch[1] + ']');
      const ar = certs.find(c => c.country === 'Argentina');
      const us = certs.find(c => c.country === 'United States');
      return { ar: ar?.ratings?.[0]?.rating || null, us: us?.ratings?.[0]?.rating || null };
    }
  } catch(e) {}
  return { ar: null, us: null };
}

// ─── Build entry ───────────────────────────────────────────────────────────

function getCert(results, country) {
  const entry = (results || []).find(r => r.iso_3166_1 === country);
  if (!entry) return null;
  const t = entry.release_dates.find(rd => rd.type === 3 && rd.certification);
  const f = entry.release_dates.find(rd => rd.certification);
  return t?.certification || f?.certification || null;
}

function buildEntry(filePath, fileName, details, certAR, certUS) {
  const credits = details.credits || {};
  const directors = (credits.crew || [])
    .filter(p => p.job === 'Director')
    .map(p => ({ id: p.id, name: p.name, profile_path: p.profile_path || null }));
  const cast = (credits.cast || []).slice(0, 15)
    .map(p => ({ id: p.id, name: p.name, character: p.character, profile_path: p.profile_path || null }));
  const writers = (credits.crew || [])
    .filter(p => ['Screenplay','Writer','Story','Novel'].includes(p.job)).slice(0, 5)
    .map(p => ({ id: p.id, name: p.name, job: p.job }));
  const trailer = (details.videos?.results || []).find(v => v.type === 'Trailer' && v.site === 'YouTube');
  const releaseDate = details.release_date || '';
  const year = releaseDate ? releaseDate.substring(0, 4) : '';

  const folderPath = filePath.substring(0, filePath.lastIndexOf('\\'));
  const folderName = folderPath.split('\\').pop();

  return {
    id: `mu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    folderPath,
    folderName,
    mainFile: { name: fileName, path: filePath, size: 0 },
    extras: [],
    seasons: null,
    mediaType: 'movie',
    manualMatch: true,
    tmdbId: details.id || null,
    imdbId: details.imdb_id || null,
    title: details.title || fileName,
    originalTitle: details.original_title || '',
    overview: details.overview || '',
    tagline: details.tagline || '',
    releaseDate,
    year,
    runtime: details.runtime || null,
    voteAverage: details.vote_average || null,
    voteCount: details.vote_count || 0,
    popularity: details.popularity || 0,
    posterPath: details.poster_path || null,
    backdropPath: details.backdrop_path || null,
    genres: (details.genres || []).map(g => g.name),
    directors,
    cast,
    writers,
    productionCountries: (details.production_countries || []).map(c => c.name),
    language: details.original_language || '',
    keywords: (details.keywords?.keywords || []).slice(0, 10).map(k => k.name),
    trailerKey: trailer?.key || null,
    numberOfSeasons: null,
    numberOfEpisodes: null,
    status: null,
    certificationAR: certAR,
    certificationUS: certUS,
    dateAdded: new Date().toISOString(),
    watched: false,
    watchedDate: null,
    rating: null,
    favorite: false,
    notes: ''
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Films to process ──────────────────────────────────────────────────────

const ESSANAY_FOLDER = 'Z:\\Directors\\Charlie Chaplin\\Charlie Chaplin - Essanay Comedies (1915\u20131916) (1080p BluRay x265 HEVC 10bit AAC 2.0 Garshasp)';
const MUTUAL_FOLDER  = 'Z:\\Directors\\Charlie Chaplin\\Charlie Chaplin - The Mutual Comedies (1916\u20131917) (1080p BluRay x265 HEVC 10bit AAC 2.0 Garshasp)';

const ESSANAY_FILMS = [
  { title: "Burlesque on Carmen",      year: 1916, file: "Burlesque on 'Carmen' (1916) (1080p BluRay x265 Garshasp).mkv",   folder: ESSANAY_FOLDER },
  { title: "A Jitney Elopement",        year: 1915, file: "A Jitney Elopement (1915) (1080p BluRay x265 Garshasp).mkv",       folder: ESSANAY_FOLDER },
  { title: "A Night in the Show",       year: 1915, file: "A Night in the Show (1915) (1080p BluRay x265 Garshasp).mkv",      folder: ESSANAY_FOLDER },
  { title: "A Night Out",               year: 1915, file: "A Night Out (1915) (1080p BluRay x265 Garshasp).mkv",              folder: ESSANAY_FOLDER },
  { title: "A Woman",                   year: 1915, file: "A Woman (1915) (1080p BluRay x265 Garshasp).mkv",                  folder: ESSANAY_FOLDER },
  { title: "By the Sea",                year: 1915, file: "By the Sea (1915) (1080p BluRay x265 Garshasp).mkv",               folder: ESSANAY_FOLDER },
  { title: "His New Job",               year: 1915, file: "His New Job (1915) (1080p BluRay x265 Garshasp).mkv",              folder: ESSANAY_FOLDER },
  { title: "His Regeneration",          year: 1915, file: "His Regeneration (1915) (1080p BluRay x265 Garshasp).mkv",         folder: ESSANAY_FOLDER },
  { title: "In the Park",               year: 1915, file: "In the Park (1915) (1080p BluRay x265 Garshasp).mkv",              folder: ESSANAY_FOLDER },
  { title: "Police",                    year: 1916, file: "Police (1916) (1080p BluRay x265 Garshasp).mkv",                   folder: ESSANAY_FOLDER },
  { title: "Shanghaied",                year: 1915, file: "Shanghaied (1915) (1080p BluRay x265 Garshasp).mkv",               folder: ESSANAY_FOLDER },
  { title: "The Bank",                  year: 1915, file: "The Bank (1915) (1080p BluRay x265 Garshasp).mkv",                 folder: ESSANAY_FOLDER },
  { title: "The Champion",              year: 1915, file: "The Champion (1915) (1080p BluRay x265 Garshasp).mkv",             folder: ESSANAY_FOLDER },
  { title: "The Tramp",                 year: 1915, file: "The Tramp (1915) (1080p BluRay x265 Garshasp).mkv",                folder: ESSANAY_FOLDER },
  { title: "Work",                      year: 1915, file: "Work (1915) (1080p BluRay x265 Garshasp).mkv",                    folder: ESSANAY_FOLDER },
  // Featurettes subfolder
  { title: "Charlie Butts In",          year: 1920, file: "Charlie Butts In (1920).mkv",                                     folder: ESSANAY_FOLDER + '\\Featurettes' },
  { title: "Triple Trouble",            year: 1918, file: "Triple Trouble (1918).mkv",                                       folder: ESSANAY_FOLDER + '\\Featurettes' },
];

const MUTUAL_FILMS = [
  { title: "The Floorwalker",  year: 1916, file: "The Floorwalker (1916) (1080p BluRay x265 Garshasp).mkv",  folder: MUTUAL_FOLDER },
  { title: "Behind the Screen",year: 1916, file: "Behind the Screen (1916) (1080p BluRay x265 Garshasp).mkv", folder: MUTUAL_FOLDER },
  { title: "Easy Street",      year: 1917, file: "Easy Street (1917) (1080p BluRay x265 Garshasp).mkv",       folder: MUTUAL_FOLDER },
  { title: "One A.M.",         year: 1916, file: "One A.M. (1916) (1080p BluRay x265 Garshasp).mkv",          folder: MUTUAL_FOLDER },
  { title: "The Adventurer",   year: 1917, file: "The Adventurer (1917) (1080p BluRay x265 Garshasp).mkv",    folder: MUTUAL_FOLDER },
  { title: "The Count",        year: 1916, file: "The Count (1916) (1080p BluRay x265 Garshasp).mkv",         folder: MUTUAL_FOLDER },
  { title: "The Cure",         year: 1917, file: "The Cure (1917) (1080p BluRay x265 Garshasp).mkv",          folder: MUTUAL_FOLDER },
  { title: "The Fireman",      year: 1916, file: "The Fireman (1916) (1080p BluRay x265 Garshasp).mkv",       folder: MUTUAL_FOLDER },
  { title: "The Immigrant",    year: 1917, file: "The Immigrant (1917) (1080p BluRay x265 Garshasp).mkv",     folder: MUTUAL_FOLDER },
  { title: "The Pawnshop",     year: 1916, file: "The Pawnshop (1916) (1080p BluRay x265 Garshasp).mkv",      folder: MUTUAL_FOLDER },
  { title: "The Rink",         year: 1916, file: "The Rink (1916) (1080p BluRay x265 Garshasp).mkv",          folder: MUTUAL_FOLDER },
  { title: "The Vagabond",     year: 1916, file: "The Vagabond (1916) (1080p BluRay x265 Garshasp).mkv",      folder: MUTUAL_FOLDER },
  // Documentary subfolder
  { title: "Chaplin's Goliath",        year: 1996, file: "Chaplin's Goliath (1996).mkv",          folder: MUTUAL_FOLDER + '\\Documentary' },
  { title: "The Birth of the Tramp",   year: 2013, file: "The Birth of The Tramp (2013).mkv",     folder: MUTUAL_FOLDER + '\\Documentary' },
];

const ALL_FILMS = [...ESSANAY_FILMS, ...MUTUAL_FILMS];

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const config  = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const apiKey  = config.tmdbApiKey;
  if (!apiKey) { console.error('No tmdbApiKey'); process.exit(1); }

  const library = JSON.parse(fs.readFileSync(LIBRARY_PATH, 'utf8'));

  // Remove any existing Chaplin manual entries (the 4 survivors + any collection entries)
  const chaplinPaths = new Set([ESSANAY_FOLDER, MUTUAL_FOLDER,
    ESSANAY_FOLDER + '\\Featurettes', MUTUAL_FOLDER + '\\Documentary']);
  const cleaned = library.filter(m =>
    !(m.manualMatch && chaplinPaths.has(m.folderPath)) &&
    !m.folderName?.includes('Essanay') &&
    !m.folderName?.includes('Mutual Comedies')
  );
  console.log(`Limpiadas entradas Chaplin previas. Librería: ${library.length} → ${cleaned.length}`);

  const newEntries = [];
  let ok = 0, fail = 0;

  for (let i = 0; i < ALL_FILMS.length; i++) {
    const f = ALL_FILMS[i];
    const filePath = f.folder + '\\' + f.file;
    process.stdout.write(`[${i+1}/${ALL_FILMS.length}] ${f.title} (${f.year})... `);

    try {
      // 1. Search TMDB
      const basic = await searchMovie(apiKey, f.title, f.year);
      if (!basic) { console.log('NO TMDB RESULT'); fail++; continue; }
      await sleep(150);

      // 2. Get details
      const details = await getMovieDetails(apiKey, basic.id);
      await sleep(150);

      // 3. Certs from TMDB release_dates
      const certAR_tmdb = getCert(details.release_dates?.results, 'AR');
      const certUS_tmdb = getCert(details.release_dates?.results, 'US');

      // 4. Try IMDb certs if we have imdbId
      let certAR = certAR_tmdb, certUS = certUS_tmdb;
      if (details.imdb_id) {
        try {
          const html = await fetchIMDb(details.imdb_id);
          const imdbCerts = extractCerts(html);
          if (imdbCerts.ar) certAR = imdbCerts.ar;
          if (imdbCerts.us) certUS = imdbCerts.us;
          await sleep(300);
        } catch(e) {}
      }

      // 5. Build entry
      const entry = buildEntry(filePath, f.file, details, certAR, certUS);
      newEntries.push(entry);
      console.log(`✓ "${entry.title}" (${entry.year}) tmdb=${entry.tmdbId} AR=${certAR||'-'} US=${certUS||'-'}`);
      ok++;
    } catch(e) {
      console.log(`ERROR: ${e.message}`);
      fail++;
    }
  }

  // Insert new entries at the end of the library
  const final = [...cleaned, ...newEntries];

  fs.writeFileSync(LIBRARY_PATH, JSON.stringify(final, null, 2), 'utf8');
  console.log(`\nListo. Entradas creadas: ${ok}  Fallidas: ${fail}`);
  console.log(`Librería final: ${final.length} entradas`);
}

main().catch(e => { console.error(e); process.exit(1); });
