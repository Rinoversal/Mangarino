<p align="center"><img src="assets/logo/mangarino-logo.png" alt="Mangarino" width="180"></p>

# Mangarino

**A manga reader for Android that reads the files you already have, remembers where you are,
and can step through a page panel by panel.**

Drop your CBZ files on the tablet, tap Rescan, read. Mangarino works out the series, volumes,
chapters and page order from the file names, never copies or unpacks your archives, and saves
your place per series and per volume. Bookmarks are one tap away.

- **Download:** https://github.com/Rinoversal/Mangarino/releases/latest, or try the
  [1.1.0 beta](https://github.com/Rinoversal/Mangarino/releases/tag/v1.1.0-beta.1) with the PC hub
- **Details:** [TECHNICAL.md](TECHNICAL.md) explains how the reader gets pages out of a 500 MB zip
  without extracting it, and how panel mode works
- **Panel tool:** [tools/panelizer](tools/panelizer/README.md) runs on your PC and writes panel
  boxes into each CBZ
- **PC hub:** [tools/hub](tools/hub/README.md) shares your PC's manga with the app over Wi-Fi (or
  from anywhere with Tailscale), and adds panels on the PC's graphics card

## Getting started

1. Install the APK (Android 11 or newer). Android shows an "unknown app" warning the first time;
   that is what a sideloaded app looks like.
2. Open Mangarino › Sources and grant **All files access**. The app needs it to read archives
   where they sit instead of copying 20 GB into its own folder.
3. Get your manga onto the device, either way:
   - **Over Wi-Fi:** install [Mangarino Hub](tools/hub/README.md) on your PC, then tap **PC** in the
     Library, tap your PC's name and click **Allow** on the PC.
   - **By cable:** copy your archives into `Internal storage › Mangarino › <series name> ›`. One
     folder per series, one CBZ, ZIP or folder of images per volume or chapter. Then tap **Rescan**.
4. Covers appear as each archive is indexed.

## Reading

- **Manga mode** reads right to left; **Western mode** reads left to right. Set the default in
  Settings, flip it per volume from the reader bar.
- Tap the left or right third of the page to turn it, the centre to show the controls. Pinch
  or double-tap to zoom.
- **Panel mode** steps through the panels of a page in reading order. It is available on
  archives processed by the panelizer (the "panels" badge in the volume grid).
- Reaching the last page and tapping next opens the next volume.
- ☆ in the reader bar bookmarks the page. Long-press a volume to mark it read or unread.

## Naming your files

Mangarino understands most conventions: `Berserk v01.cbz`, `Series Vol.01 Ch.005.cbz`,
`Series - Chapter 12.cbz`, `[Group] Series 012.cbz`, and loose image folders such as
`Series/Vol 1/001.jpg`. When a name gives nothing away, the series takes the folder name and
you can rename it from the series screen.

## Credits and licences

Panel detection uses Leandro Narosky's
[manga-panel-detector-yolo26n](https://huggingface.co/leoxs22/manga-panel-detector-yolo26n)
(Apache-2.0), trained on the Manga109-s dataset by Aizawa et al., and ogkalu's
[comic-text-and-bubble-detector](https://huggingface.co/ogkalu/comic-text-and-bubble-detector)
(Apache-2.0) to keep speech bubbles inside their panels. The app itself is
BSD-2-Clause, see [LICENSE](LICENSE).

Mangarino 2026 - Made by Carterino, a Rinoversal project
