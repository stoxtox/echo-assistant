# Mac permissions that survive rebuilds

Echo's Mac app needs four macOS permissions for listening, screen awareness, the pointer, push-to-talk and computer use:

| Permission | What it's for | System Settings page |
| --- | --- | --- |
| Screen Recording | looking at the screen when you ask | `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` |
| Accessibility | finding buttons by name; clicking and typing when you let Echo use the computer | `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` |
| Microphone | the app's own mic: hearing you whichever app is in front, auto-listen after a question, "stop" during computer use | `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` |
| Input Monitoring | push-to-talk from anywhere; any key you press stops Echo driving | `x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent` |

## Why they used to disappear

macOS remembers these permissions per app *signature* (the app's bundle id plus the certificate it's signed with). The build used to sign `Echo.app` ad hoc, which gives every build a new signature, so each rebuild or update looked like a different app and the permissions were lost.

## How the build signs now

`scripts/build-app.sh` (`npm run build-app`, the installer and auto-updates all use it) always signs with the **same identity**, and the bundle id is fixed at `local.echo.app`:

1. A **Developer ID Application** certificate from your keychain, if you have one.
2. Otherwise an **Apple Development** certificate (the free one Xcode makes).
3. Otherwise (or always, with `ECHO_SIGN_IDENTITY=local`) a local self-signed certificate called **Echo Local Signing**. The script makes it once (with `/usr/bin/openssl`) and stores it in your login keychain; every later build reuses it. The first time codesign uses it, macOS may ask to allow access to the key: click **Always Allow**.

The resulting designated requirement stays the same from build to build (for the local certificate: `identifier "local.echo.app" and certificate leaf = H"…"`), so macOS keeps the permissions.

If stable signing ever fails, the build falls back to ad hoc and says so (the app still works; macOS will just ask again).

A `--dist` build (the shareable package) stays ad hoc, so no personal certificate goes into an app you share. Whoever installs it gets their own stable signature when the installer builds the app on their Mac.

Useful commands:

```sh
bash scripts/build-app.sh --identity          # which identity the build would use (doesn't create anything)
codesign -dv --verbose=2 ~/Applications/Echo.app   # how the installed app is signed
codesign -d -r- ~/Applications/Echo.app            # its designated requirement
```

Overrides: `ECHO_SIGN_IDENTITY` picks an identity (a name or SHA-1, `-` for ad hoc, or `local` for the self-signed Echo Local Signing identity even when an Apple certificate is there; it's made once if missing). Stick with one choice: switching identity is a new signature, so macOS asks once more. `ECHO_SIGN_KEYCHAIN` (with `ECHO_SIGN_KEYCHAIN_PASSWORD`) uses a different keychain, for testing the local-certificate path in a throwaway keychain without touching your login keychain.

## One-time switch-over

The first build signed with the stable identity is still a "new" app to macOS compared with the old ad-hoc one. Allow Echo once more in the four panes (if a switch for Echo is already there, turn it off and on, or remove it with the minus button and open Echo again). From then on, rebuilds and updates keep them.

## Checking the local identity without touching your keychain

This is how the self-signed path was checked: make a throwaway keychain (`security create-keychain -p pw /tmp/t.keychain-db`), run the build with `ECHO_SIGN_IDENTITY=local ECHO_SIGN_KEYCHAIN=/tmp/t.keychain-db ECHO_SIGN_KEYCHAIN_PASSWORD=pw`, and compare `codesign -d -r-` on two builds. The certificate is made on the first build and reused on the second, and both builds get the same designated requirement. The certificate shows as "not trusted" in `security find-identity`; that's expected for a self-signed certificate, and codesign and macOS's permission records don't need it trusted. Delete the keychain afterwards with `security delete-keychain`.

## In the app

Settings → Screen shows a **Mac permissions** list: each permission, whether it's allowed (checked by the Mac app), an **Allow…** button that asks macOS, and an **Open** button for its exact Privacy & Security page. **Open permission settings** opens the first one that still needs you. Below the list, Echo says how the installed `Echo.app` is signed (`GET /api/permissions/app`, `lib/appsign.js`) and whether the permissions will stick.
