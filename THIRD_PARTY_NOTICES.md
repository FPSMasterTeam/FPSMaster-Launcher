# Third-party notices

The launcher source is MIT-licensed. Third-party software, artwork, trademarks,
and downloaded game/runtime files retain their own terms. This document does
not relicense them. Exact dependency versions are pinned in
`tauri-app/package-lock.json` and `tauri-app/src-tauri/Cargo.lock`.

## Application dependencies

License identifiers below are the upstream declarations for the direct
dependencies. `OR` means a choice of license, not a requirement to accept both.
Keep upstream LICENSE/NOTICE files when redistributing dependency sources or
bundled binaries; this summary is not a replacement for those files.

| Component | Upstream | License |
|---|---|---|
| React / React DOM | https://github.com/facebook/react | MIT |
| Radix UI Checkbox / Select | https://github.com/radix-ui/primitives | MIT |
| Lucide React | https://github.com/lucide-icons/lucide | ISC |
| Tauri, tauri-build, JavaScript API | https://github.com/tauri-apps/tauri | MIT OR Apache-2.0 |
| Tauri dialog (Rust and JS), autostart, single-instance plugins | https://github.com/tauri-apps/plugins-workspace | MIT OR Apache-2.0 |
| aes-gcm | https://github.com/RustCrypto/AEADs | Apache-2.0 OR MIT |
| base64 | https://github.com/marshallpierce/rust-base64 | MIT OR Apache-2.0 |
| flate2 | https://github.com/rust-lang/flate2-rs | MIT OR Apache-2.0 |
| image | https://github.com/image-rs/image | MIT OR Apache-2.0 |
| keyring | https://github.com/hwchen/keyring-rs | MIT OR Apache-2.0 |
| rand | https://github.com/rust-random/rand | MIT OR Apache-2.0 |
| regex | https://github.com/rust-lang/regex | MIT OR Apache-2.0 |
| reqwest | https://github.com/seanmonstar/reqwest | MIT OR Apache-2.0 |
| serde / serde_json | https://github.com/serde-rs | MIT OR Apache-2.0 |
| sha1 / sha2 | https://github.com/RustCrypto/hashes | MIT OR Apache-2.0 |
| sysinfo | https://github.com/GuillaumeGomez/sysinfo | MIT |
| tar | https://github.com/composefs/tar-rs | MIT OR Apache-2.0 |
| xz2 | https://github.com/alexcrichton/xz2-rs | MIT OR Apache-2.0 |
| zip | https://github.com/zip-rs/zip2 | MIT |
| windows | https://github.com/microsoft/windows-rs | MIT OR Apache-2.0 |

Build/test tools include Vite and its React plugin (MIT), TypeScript
(Apache-2.0), Tailwind CSS (MIT), ESLint and its plugins (MIT), Prettier (MIT),
React type declarations (MIT), and tempfile (MIT OR Apache-2.0).
They and their transitive dependencies remain governed by their own license
files, available in the npm package or Rust crate source distributions.

## Native libraries and platform runtimes

- xz2 is built with the `static` feature and includes liblzma from XZ Utils.
  Preserve the exact bundled XZ version's COPYING and license notices:
  https://tukaani.org/xz/ . The Rust wrapper's license does not replace liblzma's.
- The Rust dependency graph also includes TLS/cryptography and system
  integration libraries. Their exact target-specific versions are recorded in
  Cargo.lock; redistribute their license/notice files with binary distributions
  as applicable, rather than assuming every transitive crate is MIT.
- Windows uses Microsoft Edge WebView2. The Windows 7 build uses the fixed
  WebView2 109 runtime. WebView2 remains subject to Microsoft's distribution
  terms: https://developer.microsoft.com/en-us/microsoft-edge/webview2/ .
- macOS WKWebView and Linux WebKitGTK are platform components, not covered by
  the launcher's MIT license.

## Game files, artwork, and third-party services

Minecraft, Microsoft, Xbox, Forge, Fabric, Modrinth, CurseForge and other
product/service names, logos and server icons belong to their respective
owners. Their presence identifies compatibility or a content source; it does
not imply endorsement or grant trademark rights.

Minecraft client jars, assets, libraries, Java runtimes, loader installers,
mods and modpacks downloaded at runtime retain their original licenses and
terms. The launcher's MIT license does not permit redistribution of Mojang
game files. Edge AOT packages must not include Mojang client jars.

- Minecraft EULA and usage guidelines: https://www.minecraft.net/eula and
  https://www.minecraft.net/usage-guidelines
- Fabric: https://github.com/FabricMC
- Forge: https://github.com/MinecraftForge
- Modrinth: https://modrinth.com/legal/terms
- CurseForge: https://www.curseforge.com/terms-of-service

Network-loaded images/fonts, if enabled, retain their provider's terms and
are not necessarily bundled assets. Forks should audit and replace branding
and third-party artwork before redistribution.

## liquid-glass-react

The Liquid Glass filter architecture and shader-derived displacement mapping
are adapted from [rdev/liquid-glass-react](https://github.com/rdev/liquid-glass-react).

Copyright 2025 MAX ROVENSKY

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Microsoft Visual C++ Redistributable and Universal CRT

The Windows 7 installer may bundle copies of the Visual C++ 2015-2022 CRT
(`vcruntime140.dll`, `msvcp140.dll`, and related files), the Universal CRT
(`ucrtbase.dll` and `api-ms-win-*.dll`), `vc_redist.x64.exe`, and when
available the KB2999226 MSU. Those files are Microsoft redistributables. Their
use is governed by the Visual Studio / Windows SDK license terms, not the
launcher MIT license. See:

- https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist
- https://learn.microsoft.com/en-us/cpp/windows/universal-crt-deployment
