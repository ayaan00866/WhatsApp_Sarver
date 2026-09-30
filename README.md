# Auto typer

Auto typer is a native Kotlin Android custom keyboard. It includes a real
`InputMethodService`, an optional `AccessibilityService` for visible Send
controls, a line-by-line Auto-Type engine, FYT character repetition, persistent
keyboard settings, and a dark/light control panel.

## What changed in 1.2.0

- Auto-Type now uses a persisted lifecycle (`IDLE`, `RUNNING`, `PAUSED`,
  `STOPPED`, `COMPLETED`) and resumes the saved line/character cursor after
  STOP, pause, activity recreation, or IME recreation.
- Target Name is now an optional message prefix. For example, setting `Ali`
  sends each queue line as `Ali message` without adding a colon.
- The Auto-Type panel and keyboard use a black, charcoal, violet, and electric
  blue visual system inspired by the supplied Auto typer icon.
- The supplied Auto typer artwork is used as the launcher icon, and the
  supplied profile image is shown in Developer/About.
- The app drawer now has stable Auto typer navigation plus working Dark and
  Light appearance choices.
- Tapping the keyboard's four-square toolbar opens a working Tools launcher
  for FYT controls, Caps Lock, clipboard history, Auto-Type, multi-row emoji
  input, keyboard return, and app settings.
- The keyboard bottom inset is kept compact so the black area below the keys
  does not consume unnecessary space.
- Auto-Type prevents duplicate jobs, retries an unverified send twice, and
  stops safely without advancing past a line that was not sent.
- Accessibility send detection scores semantic labels, resource IDs,
  clickability, visibility, class names, and package hints for WhatsApp,
  Messenger, Instagram, Facebook/Facebook Lite, and generic messaging UIs.
  Semantic node clicks are preferred; a bounded gesture fallback is used only
  when Android exposes the required capability.
- The Auto-Type screen can send Start, Pause/Resume, and Stop commands to the
  active keyboard service. The compact panel keeps its primary controls in a
  stable two-button row and highlights the running state in red.
- Enter and editor actions respect the active `EditorInfo` action instead of
  always forcing a newline.

## Open the project

1. Install Android Studio Hedgehog (2023.1.1) or newer.
2. Open Android Studio and choose **Open**.
3. Select the `GhostTypePro` folder (the folder containing `settings.gradle.kts`).
4. Let Android Studio sync Gradle. If prompted, use the embedded JDK 17 or a
   compatible JDK 17 installation.
5. Connect an Android phone with Developer options and USB debugging enabled,
   or create an Android Emulator running API 26 or newer.

## Build an APK

From Android Studio, choose **Build > Build App Bundle(s) / APK(s) > Build APK(s)**.
The debug APK is created at:

`app/build/outputs/apk/debug/app-debug.apk`

From a terminal with the Android SDK configured, the equivalent command is:

```bash
./gradlew assembleDebug
```

For a release APK, configure a signing key in Android Studio and use
**Build > Generate Signed Bundle / APK**.

## Install the APK

1. In Android Studio, press the Run button with a device selected, or install
   `app-debug.apk` from the APK notification.
2. If installing manually, copy the APK to the phone and open it. Allow
   installation from that source when Android asks.
3. Launch **Auto typer** once after installation.

## Enable and select the keyboard

1. Open Auto typer and tap **Open Keyboard Settings**.
2. Find **Auto typer** under available keyboards and turn it on.
3. Return to the app and tap **Open Input Picker**, or focus any text field and
   select Auto typer from the keyboard picker.
4. The Home page detects both the enabled and default-input-method states.

The app never changes the system keyboard selection for the user.

## Enable Accessibility for Auto-Type send-button support

1. Open Auto typer and tap **Open Accessibility Settings**.
2. Select **Auto typer Auto-Type**.
3. Turn the service on and accept Android's confirmation.
4. In **Auto Type**, choose **Access** when you want the service to look for a
   visible, enabled button whose label indicates Send, Submit, Post, or a
   supported translation.

Accessibility is optional. The service only acts after the user explicitly
presses START, and it reports when a Send button could not be safely located.

## Test Auto-Type

1. Enable and select Auto typer as described above.
2. In the app's **Auto Type** page, enter one message per line and tap
   **Use this text**.
3. Focus a text field in a test app (a notes app is recommended).
4. Tap the keyboard's four-square icon.
5. Confirm the text in the Auto-Type panel, then tap **START**.
6. Use **PAUSE / RESUME**, change delay or typing speed, and use **STOP** to
   end the run. Starting again continues from the saved cursor; use **Reset
   task progress** only when you intentionally want to begin again.
7. To test send behavior safely, use a draft/chat screen with a visible Send
   button and enable Accessibility. Start with one harmless test line.

## Test FYT Type

1. Open **FYT Type** and switch FYT mode on.
2. Set Type Count to a small number such as 3.
3. Select Auto typer in a notes field and type a letter. The character
   repeats according to the count.
4. Turn FYT mode off and confirm normal typing is restored.

## Test dark/light mode and settings

1. Open the hamburger menu.
2. Tap **Light mode** or **Dark mode**. The theme changes immediately and is
   retained after restarting the app.
3. Open **Keyboard Settings** and adjust height, size, feedback, layout, and
   emoji/number-row options.
4. Open **Reset Settings** and confirm the dialog only when you want to erase
   GhostType preferences. Android's keyboard selection is intentionally left
   untouched.

## Project notes

- Package name: `com.ayan.ghosttype`
- Minimum Android version: API 26
- Target Android version: API 35
- No unrelated runtime permissions are requested.
- Auto-Type advances one input operation at a time on a cancellable handler
  schedule. It never creates duplicate loops, and its cursor/state is stored in
  the app's private SharedPreferences.