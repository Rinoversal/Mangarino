# Mangarino internals

## Stack

Expo SDK 57, React Native 0.86, TypeScript, expo-router (routes under `src/app`), zustand for
state, expo-sqlite for the library database, expo-file-system's `File`/`FileHandle` for random
access reads, `fflate` for inflate, expo-image for decoding, react-native-gesture-handler and
Reanimated for the reader. No custom native modules. The APK is built locally with Gradle.

## Reading pages out of a CBZ without extracting it

A CBZ is a zip. Extracting a 470 MB volume per read would double the storage and add a long
wait, so Mangarino reads single pages straight out of the archive:

1. **Locate the central directory.** The End Of Central Directory record is scanned for
   backwards from the end of the file (the Berserk archives carry a comment, so it is not at
   the last 22 bytes). ZIP64 is detected and parsed but untested (no sample archive over 4 GB).
2. **Index once.** The central directory (about 30 KB) is parsed into `zip_entries` rows:
   name, method, sizes, CRC and local header offset. Image entries are natural-sorted into
   `pages`. Junk (`__MACOSX`, `._*`, `Thumbs.db`) is skipped. This runs at scan time and a
   re-open is a single SELECT.
3. **Read one entry.** The local header is read to find the true data offset (its extra field
   length differs from the central directory's), the compressed bytes are read with
   `FileHandle.readBytes` at that offset, and inflated with fflate. Entries over 1 MB stream
   through `Inflate` in 512 KB chunks, yielding to the event loop between chunks so taps keep
   working. The output buffer is preallocated at the declared size; nothing goes through
   base64.
4. **Cache on disk.** The page lands in `cache/pages/<archive>/<n>.jpg` and expo-image loads
   it from the file URI. An LRU capped at the setting (200 MB default) evicts the oldest
   pages; every hit re-checks that Android has not purged the cache folder.
5. **Prefetch.** `PageLoader` is a single-flight queue ordered by distance from the current
   page: the current page, three ahead, one behind. Jumping far reprioritises without any
   cancellation logic. One inflate at a time bounds memory.

`src/zip/inflate.ts` is the only place to swap for a native inflater if Hermes turns out too
slow on a given device; per-page timings are logged as `[mangarino] page N: inflate X ms`.

## Filename intelligence

`src/library/parse.ts` is pure and unit-tested against the real archives. `parseArchiveName`
strips bracket groups and years, then looks for volume tokens (`v01`, `Vol. 1`, `tome 3`),
chapter tokens (`c048`, `Ch.005`, `Chapter 12`, `#7`) and finally a trailing bare number,
which is taken as a chapter. The series is whatever precedes the first token.
`parseEntryName` handles the digital release pattern (`Series - 001 (v01) - p000x1`) and
generic `v`/`c`/`p` tokens, falling back to the last number. Page order inside an archive is a
natural sort of the entry name; parsed fields are labels only (chapter chips, extras).

Library layout: `root/<Series>/*.cbz`, `root/<Series>/<Vol>/*.jpg`,
`root/<Series>/<Vol>/<Ch>/*.jpg`, or loose archives in the root grouped by parsed series
name. Series folders are the series title; the user can override it.

## Reader

- **Page mode.** A horizontal `FlatList` with paging. Right-to-left is done by reversing the
  data (page 0 at the right end), not the `inverted` transform. Each cell is a `ZoomablePage`
  with pinch (focal-point preserving), pan (only while zoomed, so the pager scrolls otherwise),
  double-tap zoom and single-tap zones. Progress saves are debounced 400 ms and flushed on
  exit.
- **Panel mode.** If the archive contains `mangarino-panels.json`, each page's panel boxes are
  stored in `pages.panels_json` in reading order. The reader mounts the page at full
  resolution inside an animated stage and animates translate/scale so the current box fills
  the viewport (with 4 % margin, capped at 3x page-fit). Crossing a page boundary fades out,
  swaps the image, positions instantly and fades in. Pages without boxes show whole.
- **Progress.** `progress` (per archive: page, panel, completed) and `series_progress`
  (per series: last archive and page) are written in one transaction. `history` records each
  session. Bookmarks are unique per archive/page/panel.

## Panel data format

Written into the archive as `mangarino-panels.json` by `tools/panelizer/panelize.py`:

```json
{
  "version": 1, "rtl": true, "model": "leoxs22/manga-panel-detector-yolo26n", "conf": 0.25,
  "pages": { "<entry name>": { "w": 1810, "h": 2560, "panels": [ { "x": 206, "y": 655, "w": 1349, "h": 1673 } ] } }
}
```

Coordinates are pixels in the original image. Boxes are class 0 (panel) detections, filtered
(area over 1 % of the page, IoU over 0.7 merged), clustered into rows by vertical overlap and
ordered top to bottom, right to left (left to right with `--ltr`). The app also accepts the
bare `{ "<entry>": [rects] }` form.

## Android specifics

- `MANAGE_EXTERNAL_STORAGE` (All files access) so archives are read in place from
  `/storage/emulated/0/Mangarino`. Fine for a sideloaded APK; the Play Store would not allow
  it. `minSdkVersion` is 30 so one permission path covers every supported device.
- There is no JS API to query that permission, so `probeAllFilesAccess` creates the library
  folder and writes a throwaway file; the request opens the per-app system screen through an
  intent.
- The reader hides the status and navigation bars and keeps the screen awake.

## Building

```powershell
npm install
npx expo prebuild -p android
cd android; .\gradlew assembleRelease   # APK at app\build\outputs\apk\release\app-release.apk
```

Needs JDK 17, the Android SDK (platform 36, build-tools 36, NDK 27.1, CMake 3.30) and
`ANDROID_HOME`/`JAVA_HOME` set. On Windows, if Gradle reports `AccessDeniedException` on a
`kotlin-compiler-*.alive` file under `C:\WINDOWS`, point the JVM temp dir somewhere writable:
`android/gradle.properties` carries `-Djava.io.tmpdir=...` in both `org.gradle.jvmargs` and
`kotlin.daemon.jvmargs`.

Tests (`npm test`) run the parser suite and open the real Berserk v01 CBZ through a Node byte
source to validate the zip code end to end.
