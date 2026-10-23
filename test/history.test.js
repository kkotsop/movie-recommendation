import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseViewingHistoryCsv, seriesNameFromTitle, groupHistory, normalizeTitle } from '../src/history.js';

test('parseCsv handles quotes, commas and CRLF', () => {
  const rows = parseCsv('﻿Title,Date\r\n"Love, Death & Robots: Volume 1: ""Sonnie\'s Edge""",3/15/19\r\n');
  assert.deepEqual(rows, [['Title', 'Date'], ['Love, Death & Robots: Volume 1: "Sonnie\'s Edge"', '3/15/19']]);
});

test('US month-first dates with 2-digit years', () => {
  const rows = parseViewingHistoryCsv('Title,Date\n"Roma","12/25/22"\n"Okja","1/2/23"\n');
  assert.deepEqual(rows, [{ title: 'Roma', date: '2022-12-25' }, { title: 'Okja', date: '2023-01-02' }]);
});

test('day-first dates are detected from the whole file', () => {
  const rows = parseViewingHistoryCsv('Title,Date\n"A","02/03/2024"\n"B","25/12/2023"\n');
  assert.equal(rows[0].date, '2024-03-02');
  assert.equal(rows[1].date, '2023-12-25');
});

test('series names are extracted from season markers in several languages', () => {
  assert.equal(seriesNameFromTitle('The Crown: Season 1: Wolferton Splash'), 'The Crown');
  assert.equal(seriesNameFromTitle('Narcos: Mexico: Season 1: Camelot'), 'Narcos: Mexico');
  assert.equal(seriesNameFromTitle("The Queen's Gambit: Limited Series: Openings"), "The Queen's Gambit");
  assert.equal(seriesNameFromTitle('Money Heist: Part 1: Episode 1'), 'Money Heist');
  assert.equal(seriesNameFromTitle('Dark: Staffel 1: Geheimnisse'), 'Dark');
  assert.equal(seriesNameFromTitle('Ελίτ: Σεζόν 2: Επεισόδιο 3'), 'Ελίτ');
  assert.equal(seriesNameFromTitle('Stranger Things: Stranger Things 4: Chapter One: The Hellfire Club'), 'Stranger Things');
  assert.equal(seriesNameFromTitle('Mission: Impossible - Fallout'), null);
  assert.equal(seriesNameFromTitle('Roma'), null);
});

test('groupHistory merges episodes and keeps two-part movie titles intact', () => {
  const groups = groupHistory([
    { title: 'Dark: Season 1: Secrets', date: '2024-01-01' },
    { title: 'Dark: Season 1: Lies', date: '2024-01-02' },
    { title: 'Dark: Season 2: Beginnings and Endings', date: '2024-02-01' },
    { title: 'Mission: Impossible - Fallout', date: '2023-06-01' },
    { title: 'Our Planet: One Planet', date: '2023-01-01' },
    { title: 'Our Planet: Frozen Worlds', date: '2023-01-02' },
    { title: 'Our Planet: Jungles', date: '2023-01-03' },
  ]);
  const byName = Object.fromEntries(groups.map((g) => [g.name, g]));
  assert.equal(byName.Dark.views, 3);
  assert.equal(byName.Dark.kind, 'series');
  assert.equal(byName.Dark.lastWatched, '2024-02-01');
  assert.equal(byName['Mission: Impossible - Fallout'].kind, 'movie');
  assert.equal(byName['Our Planet'].kind, 'series');
  assert.equal(groups[0].name, 'Dark', 'most recent first');
});

test('normalizeTitle ignores accents, punctuation and &', () => {
  assert.equal(normalizeTitle('Love, Death & Robots'), 'love death and robots');
  assert.equal(normalizeTitle('Pokémon: The Movie'), 'pokemon the movie');
});

test('headerless files need real dates, so random CSVs are rejected but localized headers still work', () => {
  assert.deepEqual(parseViewingHistoryCsv('not,a,netflix file\n1,2,3'), []);
  const greek = parseViewingHistoryCsv('Τίτλος,Ημερομηνία\n"Dark: Σεζόν 1: Μυστικά","28/09/2026"\n"The Irishman","30/08/2026"\n');
  assert.equal(greek.length, 3,'header row is kept as a harmless dateless entry');
  assert.equal(greek.filter((e) => e.date).length, 2);
});
