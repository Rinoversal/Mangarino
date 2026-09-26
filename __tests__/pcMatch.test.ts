import {
  DeviceVolume,
  PcSeries,
  destinationFolder,
  deviceOnly,
  matchPcSeries,
  progressKey,
  seriesFolderOf,
  updateReason,
} from '../src/pc/match';

const pcVol = (file: string, size: number, panels = 'ready') =>
  ({ id: file, file, kind: 'file' as const, size, version: `${size}-1`, panels });

let nextId = 1;
const dev = (folder: string, file: string, size: number, hasPanels = false, kind: 'cbz' | 'dir' = 'cbz'): DeviceVolume => ({
  archiveId: nextId++, seriesId: 1, uri: `file:///storage/emulated/0/Mangarino/${folder}/${file}`,
  folder, file, size, hasPanels, kind,
});

const berserk: PcSeries = {
  id: 's1', folder: 'Berserk', title: 'Berserk',
  volumes: [pcVol('Berserk v01.cbz', 100), pcVol('Berserk v02.cbz', 200), pcVol('Berserk v03.cbz', 300)],
};

describe('matchPcSeries', () => {
  it('finds exact copies, newer copies and missing volumes', () => {
    const device = [dev('Berserk', 'Berserk v01.cbz', 100), dev('Berserk', 'Berserk v02.cbz', 150)];
    const states = matchPcSeries(berserk, device).map((v) => [v.file, v.state]);
    expect(states).toEqual([
      ['Berserk v01.cbz', 'onDevice'],
      ['Berserk v02.cbz', 'changed'],
      ['Berserk v03.cbz', 'missing'],
    ]);
  });

  it('ignores letter case and Unicode normalisation', () => {
    const device = [dev('berserk', 'BERSERK V01.CBZ', 100)];
    expect(matchPcSeries(berserk, device)[0].state).toBe('onDevice');
    const nfd = 'Pokémon v01.cbz'.normalize('NFD');
    const pokemon: PcSeries = { id: 's2', folder: 'Pokémon', title: 'Pokémon', volumes: [pcVol('Pokémon v01.cbz', 5)] };
    expect(matchPcSeries(pokemon, [dev('Pokémon'.normalize('NFD'), nfd, 5)])[0].state).toBe('onDevice');
  });

  it('never treats a same-named volume in another series as an update', () => {
    const vagabond: PcSeries = { id: 's3', folder: 'Vagabond', title: 'Vagabond', volumes: [pcVol('Vol 01.cbz', 10)] };
    const device = [dev('Monster', 'Vol 01.cbz', 99)];
    expect(matchPcSeries(vagabond, device)[0].state).toBe('missing');
  });

  it('explains why an update is worth it', () => {
    const device = [dev('Berserk', 'Berserk v02.cbz', 150, false)];
    const v02 = matchPcSeries(berserk, device)[1];
    expect(updateReason(v02)).toBe('adds panels');
    expect(updateReason(matchPcSeries(berserk, [dev('Berserk', 'Berserk v02.cbz', 150, true)])[1])).toBe('better panels');
  });
});

describe('deviceOnly', () => {
  it('lists archives the PC lacks, skipping image folders', () => {
    const device = [
      dev('Berserk', 'Berserk v01.cbz', 100),
      dev('Monster', 'Monster v01.cbz', 50),
      dev('Pluto', 'Vol 01', 0, false, 'dir'),
    ];
    expect(deviceOnly([berserk], device).map((d) => d.file)).toEqual(['Monster v01.cbz']);
  });

  it('tells apart generic names in different series', () => {
    const pc = { id: 'b', folder: 'Berserk', title: 'Berserk', volumes: [pcVol('Vol 01.cbz', 100)] };
    const device = [dev('Berserk', 'Vol 01.cbz', 100), dev('Monster', 'Vol 01.cbz', 100)];
    expect(deviceOnly([pc], device).map((d) => d.folder)).toEqual(['Monster']);
  });

  it('matches imported files by name and size', () => {
    const pc = { id: 'x', folder: 'Imported', title: 'Imported', volumes: [pcVol('One Shot.cbz', 70)] };
    const imported = { ...dev('', 'One Shot.cbz', 70), underRoot: false };
    const other = { ...dev('', 'One Shot.cbz', 71), underRoot: false };
    expect(deviceOnly([pc], [imported, other]).map((d) => d.size)).toEqual([71]);
  });
});

describe('folders', () => {
  it('works out the series folder from a file path', () => {
    const root = '/storage/emulated/0/Mangarino';
    expect(seriesFolderOf('file:///storage/emulated/0/Mangarino/Berserk/Berserk%20v01.cbz', root)).toBe('Berserk');
    expect(seriesFolderOf('file:///storage/emulated/0/Mangarino/Berserk/Vol%2001/x.cbz', root)).toBe('Berserk');
    expect(seriesFolderOf('file:///storage/emulated/0/Mangarino/Loose.cbz', root)).toBe('');
    expect(seriesFolderOf('file:///data/user/0/app/files/imports/x.cbz', root)).toBe('');
  });

  it('reuses an existing device folder whatever its letter case', () => {
    expect(destinationFolder('Berserk', ['berserk', 'Monster'])).toBe('berserk');
    expect(destinationFolder('Vagabond', ['berserk'])).toBe('Vagabond');
  });
});

describe('progressKey', () => {
  it('names volumes the same way as the hub, whatever the case or accent form', () => {
    expect(progressKey('Berserk', 'Berserk v01.cbz')).toBe('berserk/berserk v01.cbz');
    expect(progressKey('Pokémon'.normalize('NFD'), 'Vol 01.CBZ')).toBe('pokémon/vol 01.cbz');
    expect(progressKey('', 'Loose.cbz')).toBe('/loose.cbz');
  });

  it('names a folder of images like the hub names folder volumes', () => {
    expect(progressKey('Vagabond', 'Vol 01', 'dir')).toBe('vagabond/vol 01.cbz');
  });
});
