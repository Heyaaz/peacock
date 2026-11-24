# Third-party notices

## Nerd Fonts Symbols Only

The terminal bundles `SymbolsNerdFontMono-Regular.ttf` from Nerd Fonts v3.4.0
(https://github.com/ryanoasis/nerd-fonts), licensed under MIT.

Copyright (c) 2014 Ryan L McIntyre

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## herdr-web-ui

Portions of the desktop terminal are adapted from
[herdr-web-ui](https://github.com/devswha/herdr-web-ui) (MIT):

- `server/pty/pty-host.mjs` — JSON-line control frames for input, resize, and
  pause/resume, including the dimension clamp and resuming the reader before
  the process is killed
- `server/pty/session.ts` — the session methods that send those frames
- `src/components/PaneTerminal.tsx` — mounting xterm.js with the fit and
  web-links addons, and refitting when the container changes
- `src/lib/ws.ts` — acknowledging terminal output so the PTY reader can pause

The chat screen's terminal, and a terminal session's shell when herdr-core is
unavailable, run through `node-pty` in the Electron main process. Terminal
sessions otherwise run in herdr-core (see below). Gajae does not ship herdr's
web-UI sidecar or the herdr app itself.

```
MIT License

Copyright (c) 2026 devswha

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Ovis

Portions of the agent runtime are adapted from
[Ovis](https://github.com/devswha/ovis) (MIT):

- `shared/agent-catalog.ts` and `shared/supported-agents.ts` — the agent
  names, the executables that mean an agent is installed, where each vendor's
  installer puts them, and the version flag, in Gajae's `shared/agent-catalog.ts`
- `server/herdr-core/connection.ts` — herdr-core's framed protocol connection,
  in `electron/herdr-core/connection.ts`
- `server/herdr-core/attach-session.ts` and its tests — one viewer's attach
  (display-query replies, credit flow control, cursor-mode tracking), in
  `electron/herdr-core/attach-session.ts`
- `scripts/hc-types.ts` — the type generator, in `scripts/hc-types.mjs`
- `app/electron/scripts/runtimes.ts` — the pinned, checksum-verified download,
  in `scripts/herdr-core-pin.mjs` and `scripts/fetch-herdr-core.mjs`
- `app/electron/src/children.ts` — closing inherited descriptors before hc runs
  and installing the core into the app's data folder, in
  `electron/herdr-core/env.ts` and `electron/herdr-core/install.ts`
- `server/herdr-core/terminal-env.ts` — reading an `env -0` block, in
  `electron/herdr-core/env.ts`
- `shared/launch-rules.ts` — the effort levels each agent CLI takes and the
  model-name rule, in `shared/agent-launch.ts`
- `server/agent-catalog-detect.ts` — finding an agent's executable on PATH,
  then where its installer puts it, in `electron/herdr-core/agent-detect.ts`
- `server/transcript-records.ts` and `server/claude-transcript.ts` — reading
  Claude Code and omp transcripts into chat rows, in
  `electron/herdr-core/transcript/transcript-records.ts`,
  `electron/herdr-core/transcript/claude-transcript.ts` and
  `electron/herdr-core/transcript/omp-transcript.ts`
- `server/session-history.ts` and `server/omp.ts` — omp's session folder
  names and its terminal breadcrumb, in `electron/herdr-core/omp-session.ts`

```
MIT License

Copyright (c) 2026 devswha

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## herdr-core

The macOS app bundles `Herdr Core.app` from herdr-core 0.1.18
(https://github.com/herdrdev/herdr-core, release archive
`herdr-core-macos-aarch64.tar.gz`, SHA-256
`77d8af092e25ae650f4424d6dad27514f6916a11d807fb0752858cd27c21e4fc`), signed and
notarized by Herdr, Inc. and shipped unmodified in `Contents/Resources`. Terminal
sessions' shells run in it so they outlive the app. It is licensed under the
Apache License, Version 2.0; its `LICENSE` and its own `THIRD-PARTY-NOTICES`
(what hc includes, such as Ghostty's libghostty-vt) ship beside it in
`Contents/Resources/herdr-core-licenses/`, and `herdr-core --licenses` prints
them too. `electron/herdr-core/hc-api.generated.ts` is generated from hc's own
OpenRPC schema (Apache-2.0).

## omo-ui-macosapp

Portions of the conversation view are adapted from
[omo-ui-macosapp](https://github.com/realsigridjin/omo-ui-macosapp) (MIT):

- `src/ui/conversation/work-log.ts`: folding a finished turn's work between its
  prompt and its last answer into one line
- `src/ui/conversation/working-status.ts`: a running turn's elapsed time, the
  30-second quiet threshold before naming its last activity, and noticing a
  message sent into the running turn

```
MIT License

Copyright (c) 2026 sigridjineth

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## JetBrains Mono

`src/assets/jetbrains-mono-400.woff2` and `src/assets/jetbrains-mono-700.woff2`
are the Latin subsets of JetBrains Mono from
[`@fontsource/jetbrains-mono`](https://github.com/fontsource/font-files), the
font Ghostty uses by default.

```
Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) JetBrainsMono-Italic[wght].ttf: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
