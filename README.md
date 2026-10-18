# PhoneCam

Use your Android phone as the camera and microphone in **Google Meet** and other browser video calls (Google Classroom's Meet, Zoom web, Teams web, Discord, Jitsi and Whereby). It works like DroidCam, but you don't need a driver or OBS, and you don't need to change any Windows security settings.

```
📱 Android app (React Native)
     │  Wi-Fi: WebRTC video + audio, directly to the browser
     ▼
💻 Chrome extension (JavaScript + React popup)
     │  adds "PhoneCam" and "PhoneCam Microphone" to the browser's device list
     ▼
Google Meet → Settings → Video → Camera: PhoneCam

🖥 PhoneCam server (Node.js) only introduces the phone and the browser to each other.
```

## Folders

| Folder | What it is |
| --- | --- |
| `server/` | Node.js server for pairing and signaling, plus the preview and test pages |
| `extension/` | Chrome extension. `public/inject.js` creates the virtual camera; `src/` holds the React popup |
| `mobile/` | Android app (React Native + Expo + react-native-webrtc) |
| `mobile/modules/phonecam-native/` | Small native Android module in Kotlin: background streaming service, flashlight, zoom, focus, landscape lock |
| `e2e/` | Automated test that runs a real Chrome with the extension, a fake phone and a fake meeting page |

## One-time setup

1. **Server:** you need [Node.js](https://nodejs.org) 18 or newer.
2. **Chrome extension:**
   ```
   cd extension
   npm install
   npm run build
   ```
   Then go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose `extension/dist`. Pin PhoneCam to the toolbar.
3. **Phone app:** install `PhoneCam.apk` on your phone (see [Building the app](#building-the-app)).

## Every class

1. On the PC, double-click the **PhoneCam** icon on the Desktop. It starts the server and opens the preview page. If Windows Firewall asks, allow Node.js on **Private networks**.
2. On the phone, open **PhoneCam** and tap **Scan QR code**. Scan the code shown on the preview page or in the extension popup. After the first time, just tap **Connect**.
3. In Meet, go to **⋮ → Settings → Video → Camera → PhoneCam**. You can also set **Audio → Microphone → PhoneCam Microphone**.
4. **Close the PhoneCam preview tab during class.** Every tab that shows the camera makes the phone send one more video stream. The preview only streams while it's visible on screen.

The phone and the PC must be on the same home network. While streaming, a **"PhoneCam is streaming"** notification keeps the camera and mic running, even with the screen off or when you switch to another app. Tap the notification to come back.

**Desktop shortcut:** run `powershell -ExecutionPolicy Bypass -File install-shortcuts.ps1 -NoStartup` once. Leave out `-NoStartup` if you also want PhoneCam to start with Windows, or use `-Remove` to undo.

If you pick PhoneCam before the phone has connected, Meet shows a "Waiting for your phone" picture. The video switches to live by itself when the phone connects. If the phone disconnects, the waiting picture comes back and Meet keeps PhoneCam selected.

## Phone app controls

- **Switch**: front or back camera.
- **Mic on/off**: mutes the phone mic.
- **Light**: the flashlight. It only appears when the current camera has one.
- **720p / 1080p / 480p**: changes the quality. 720p is the best balance. 1080p adds delay on mid-range phones.
- **Saver**: battery saver, which streams at 15 fps and half the bitrate. Good for long classes.
- **Stop**: disconnects.
- **Gestures on the picture:** pinch to **zoom**, tap to **focus** on that spot, double-tap to reset zoom and focus.
- The picture is locked to landscape while streaming, so turning the phone doesn't flip the video.

## How the connection works (and why)

- **Two routers (double NAT):** if the phone is on a Wi-Fi router that is itself plugged into another router, Chrome can't reach the phone's private address. The server includes a tiny **STUN** responder on UDP port 8080 so the phone learns the address it appears as. The server also replaces Chrome's hidden `xxxx.local` address with the PC's real IP, so the phone can open the path from its side.
- **Delay:** the phone prefers **H.264**, which its hardware encodes. Chrome is told to keep its receive buffer minimal. Frames are never queued: under load the stream lowers quality instead of falling behind.
- **Diagnostics:** with the phone connected, run `node e2e/diagnose.js`. It prints the candidates, connection state, codec, frame rate, buffer and round-trip time.

## Building the app

You need Android Studio (for the SDK) and JDK 17. Code minification (R8) is turned off on purpose: WebRTC, ML Kit and the camera controls look up classes by name, and R8 broke them.

```
cd mobile
npm install
npx expo prebuild --platform android      # creates android/ (only needed once, or after changing app.json)
npm run build:apk                         # -> android/app/build/outputs/apk/release/app-release.apk
```

Install it on the phone in one of two ways:

- **Over USB:** turn on USB debugging (Settings → About phone → tap *Build number* 7 times, then Developer options → USB debugging). Connect the phone and run `npm run install:phone`.
- **Copy the file:** copy the `.apk` to the phone and open it. Allow "Install unknown apps" when asked.

For development with live reload, use `npx expo run:android` with the phone connected.

## Testing without a phone

- `http://localhost:8080/test-phone.html` is a fake phone that sends a moving test pattern with a beep, or your PC's webcam.
- `http://localhost:8080/test.html` is a fake meeting page that picks a camera the same way Meet does.
- Automated test: start the server, then
  ```
  cd e2e
  npm install
  npx puppeteer browsers install chrome
  npm test
  ```
  It checks that the device appears, the waiting picture works, phone video and audio arrive, and the stream stops, restarts and reconnects correctly.

## Privacy and security

- **Video stays on your network.** WebRTC always encrypts it, and it goes directly from the phone to the browser. Nothing is sent to the internet.
- **The pairing key never travels over the network.** The phone and the server each prove they know the key with a challenge and response (HMAC-SHA256), and every message after that is signed with sequence numbers. Someone else on the Wi-Fi can't learn the key, pretend to be your phone or PC, or swap in their own video connection.
- **Wrong keys are locked out.** After 5 wrong attempts, the address is blocked for a minute.
- **The phone only streams to home-network addresses** (`192.168.x.x`, `10.x.x.x`, `172.16–31.x.x`). A `phonecam://` link from a website or message never starts the camera by itself: the app asks you first.
- **Only this PC can watch.** That means the PhoneCam extension (by its fixed ID) and `localhost` pages. Other websites and other extensions are refused.
- **Sites need camera permission for PhoneCam too.** A site that isn't allowed to use your webcam can't use PhoneCam either.
- To make a new key, delete `server/.data/config.json` and restart. Then scan the QR code again.

**Known limits:**
- **Supported sites could request the stream directly.** Scripts on the sites the extension runs on (Meet, Zoom, …) share the page with PhoneCam's script. In theory they could ask for the stream without going through the camera menu.
- **The pairing QR code is a secret.** Don't share screenshots of it.
- **The APK is signed with Expo's public development key.** Create your own signing key before giving the app to others.

## Code quality

From the project root, after `npm install`:

- `npm run lint`: ESLint over the server, extension, app and tests.
- `npm test`: unit tests (pairing rules, HMAC against Node's crypto).
- `npm run test:e2e`: with the server running, a real Chrome with the extension, the fake phone and the fake meeting, plus the server security checks.


Did you mean this?
  npm test # Test a package
To see a list of supported npm commands, run:
  npm help runs the unit tests.  runs the browser and security tests, with the server running.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| The app says "Can't reach your PC" | Make sure start.bat is running, both devices are on the same Wi-Fi, and Node.js is allowed in Windows Firewall (Private). Guest and office networks often block devices from reaching each other. |
| PhoneCam isn't in Meet's camera list | Reload the Meet tab once after installing or updating the extension. Check that the extension is enabled in `chrome://extensions`. |
| Meet stays on "Connecting to phone…" | Windows Firewall may be blocking Chrome. Allow Chrome on Private networks, or try another Wi-Fi network. |
| Picture is blurry for the first seconds | That's normal: WebRTC starts at low quality and sharpens within a few seconds. |
| The picture is sideways | Turn on auto-rotate on the phone. The app follows the phone's rotation. |

## Limitations

- It only works in **browser** video calls. Desktop apps like Zoom or Teams for Windows need a real Windows camera driver, which Smart App Control would block unless it's signed.
- The extension only runs on the sites listed in `extension/public/manifest.json`. Add more sites there if you need them.
- The app is Android only.
