# Mangarino Hub

Mangarino Hub shares your PC's manga folder with Mangarino on your phone or tablet over Wi-Fi.
No cable, no cloud:

- **Get manga onto your device:** pick a volume or a whole series from your PC and download it.
- **Send your device's manga to the PC,** for example to read or keep a copy there.
- **Panels on the PC's graphics card:** new volumes get panel detection automatically, with
  speech bubbles kept inside their panels.
- **Away from home** too, with Tailscale (below).

It handles `.cbz` and `.zip` files and folders of images. Anything else in the folder (text files,
covers next to volume folders, `Thumbs.db`, Mac `__MACOSX` leftovers) is ignored.

## Start it

1. Get the hub, either way:
   - **Mangarino-Hub-Setup.exe** from the Releases page (the "Mangarino Hub … (Windows)" release).
     Run it and click **Install**; no Python needed. Windows asks once whether to let it make
     changes: click **Yes**. Setup uses that to let your devices reach the hub through Windows
     Firewall, so there's no firewall question later. Setup isn't signed yet, so Windows may first
     say "Windows protected your PC": click **More info**, then **Run anyway**.
   - Or double-click **Mangarino Hub.bat** in this folder (needs Python 3.11 or newer). The first
     time, Windows Firewall may ask about Python: tick **Private networks** and click **Allow**.
2. Mangarino Hub opens in its own window, with an icon in the tray. Closing the window keeps it
   running in the tray, so your devices can still sync; **Quit Mangarino Hub** in the tray icon's
   menu stops it.
3. Click **Choose folder** and pick your manga folder. The layout is the same as on the device: one
   folder per series, with the volumes inside.

Panel detection needs the panelizer set up on the PC (see [../panelizer](../panelizer/README.md)).
The .bat uses it directly when it's in the same repository. The .exe asks for its folder once: in
**Settings**, **Choose panelizer folder** and pick `tools\panelizer`.

## Connect your device

In Mangarino, tap **PC** in the Library, then tap your PC's name. The hub's window asks whether
to let the device in: check that its number matches the one on the device, then click **Allow**.
There's nothing to type.

If your PC isn't listed, open **Other ways to connect** in the app: **Scan QR code** (the QR code
is in the hub under **Devices › Other ways to connect**) or **Enter a code** (the 6-digit code
shown there).

The device and the PC must be on the same Wi-Fi (a phone hotspot works too, and copying between
two devices on it doesn't use mobile data). Pairing happens once; after that the app finds the PC
by itself, even if its address changes.

## Away from home (Tailscale)

Turn on **Away from home** in the hub's **Settings**, then:

1. Install Tailscale from https://tailscale.com on the PC and on your device.
2. Sign in to the **same account** on both: Google, GitHub or a passkey all work. It's free for
   personal use.
3. While at home, scan the hub's QR code once (**Show the QR code**). It includes the PC's
   Tailscale address.

From then on, when the home Wi-Fi isn't there, Mangarino connects through Tailscale by itself.
Transfers then run at your home internet's upload speed. The PC has to be on with the hub running.

## Panels

Volumes without panels are processed automatically when the PC has an NVIDIA graphics card
(**Auto**). **On** also uses the CPU, which is slow; **Off** never runs it. Volumes panelized
before the speech-bubble fix are redone automatically, and devices pick up the new panels without
downloading the volume again. Detection pauses while a device is transferring.

## Safety

- Only devices on your home network (or your Tailscale network) can talk to the hub, and only after
  you allow them on the PC or they enter the code shown there. After 5 wrong codes the code
  changes, and a device that keeps guessing has to wait 10 minutes.
- Each paired device has its own key, stored on the PC only as a hash. **Forget** on the hub's page
  (or in the app) revokes it.
- The hub's settings page only works on the PC itself.
- Plain HTTP is used on the home network. Tailscale traffic is encrypted.

## Troubleshooting

- **The device can't find the PC:** check both are on the same Wi-Fi. In the hub's **Settings**,
  **Network access** says whether Windows lets devices in; if it shows **Allow devices**, click it.
  Some routers' guest networks block devices from seeing each other.
- **A volume doesn't show up:** it appears once its copy has finished (up to a minute). Files the
  hub can't read as zips are listed on the page.

## For developers

`hub.py [--port 6264] [--root FOLDER] [--background] [--no-window] [--no-panels] [--config FILE] [--host ADDR]`.
Settings live in `%APPDATA%\Mangarino\hub.json`; packed folder volumes are cached in
`%LOCALAPPDATA%\Mangarino\hub-cache` (8 GB at most). API and internals: see `mangarino_hub/server.py`
and TECHNICAL.md. Tests:

```powershell
tools\panelizer\.venv\Scripts\python.exe -m unittest discover -s tools\hub\tests
```
