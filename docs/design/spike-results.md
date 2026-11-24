# P0.5 스파이크 결과 (herdr-core 도입)

상태: 2026-11-24 실측 · 대상 설계안: [agent-runtime-herdr.md](agent-runtime-herdr.md) §7 P0.5 ①~⑥
스파이크 코드는 버리는 코드라서 저장소에 두지 않았다(세션 scratchpad `spike/`). 이 문서에는 명령, 관찰, 결론만 남긴다.

## 0. 환경과 격리

- macOS 26 (Darwin 25.6.0, arm64), Electron 44.0.0, Node 24.20.0, Claude Code 2.1.331 (`/opt/homebrew/bin/claude` 실행 파일을 절대 경로로 직접 실행. 셸 함수 래퍼는 거치지 않음).
- hc 바이너리 출처: `https://releases.herdr.dev/core/<버전>/manifest.json`. GitHub `herdrdev/herdr-core`에는 태그(v0.1.10~v0.1.22)만 있고 릴리스 자산은 없다.

| 버전 | 파일 | sha256 (manifest와 일치) |
|---|---|---|
| 0.1.17 | herdr-core-macos-aarch64.tar.gz | `cedbd4d4d9ba1385588198dd4d3c67d2654478f33add5b6445d4d0eb9da5fcf3` |
| 0.1.18 | herdr-core-macos-aarch64.tar.gz | `77d8af092e25ae650f4424d6dad27514f6916a11d807fb0752858cd27c21e4fc` |

- 0.1.17 압축에는 `herdr-core` 단일 실행 파일만 있다. 0.1.18에는 같은 실행 파일과 `Herdr Core.app` 번들이 함께 들어 있다.
- 모든 코어는 전용 `HC_SESSION`(`gajae-spike`, `gajae-spike-17`, `gajae-spike-e17`, `gajae-spike-e18`, `gajae-spike-e18b`, `gajae-spike-eapp`)으로만 띄웠다. 상태는 `~/.local/state/herdr-core/<세션>/`에 따로 생겼다.
- 사용자의 기존 `herdr server`와 Ovis 플러그인 프로세스(pid 4931~5028)는 시작 전후로 그대로였다. `~/.config/herdr-core/config.toml`은 없다(`socket=` 설정 없음).
- 정리: 모든 스파이크 세션에 `hc server stop` → `{"stopped":true}`. 이후 스파이크 프로세스, `/tmp/hc-launchd-*`, `dev.herdr.core.*` launchd 작업이 남지 않은 것을 확인했다.
  - 남은 것: `~/.local/state/herdr-core/gajae-spike*` 상태 폴더 6개, `$TMPDIR/gjs/h.sock`(죽은 소켓 파일), Claude Code 세션 기록(`~/.claude/projects/-private-tmp-claude-501--…-spike-cc-work/`).
  - 이것들은 삭제 명령이 막혀 있어 지우지 않았다.
  - **주의**: `gajae-spike-e18/screens/t2.snap`에는 변형 A에서 `/usr/bin/env`를 출력한 터미널 화면이 저장돼 있다. 상속된 개인 환경 변수(토큰·DB 접속 정보) 줄이 들어 있으므로 이 폴더는 지워야 한다(사용자 승인 필요).

## 1. ① 패키지 앱에서 시작 → 종료 → 재접속, FD·환경 누수

### 명령

- 최소 Electron 앱을 만들었다: `node_modules/electron/dist/Electron.app` 복사, 번들 id `com.gajae.spike`.
  - `Contents/Resources/bin/`에 hc 0.1.17·0.1.18 실행 파일, `Contents/Resources/Herdr Core.app`에 0.1.18 번들을 넣었다.
  - Gajae와 같은 ad-hoc 서명: `codesign --force --deep --sign -`.
- `open -W -n "Gajae Spike.app" --args --mode=start|check …`로 실행했다.
  - start: `hc connect` 자식 프로세스 → hello → `terminal.run`(1초마다 `tick-N` 출력, label `gajae.session`) → `app.quit()`.
  - check: 재실행 → `terminal.list {labels}` → `terminal.read`.
- 변형: A(0.1.18, 상속 env, FD 래퍼 없음), B(0.1.18, 허용 목록 env, bash FD 닫기 래퍼), C(0.1.17, 허용 목록), D(Resources 안의 `Herdr Core.app/Contents/MacOS/herdr-core`).
- 관찰 도구: `lsof -p`, `ps -E -ww`, `ps -o ppid,pgid`, 터미널 안에서 `/usr/bin/env`.

### 관찰

- **코어 시작 방식**: hc 명령 하나(`server status`, `connect`, `schema` 포함)가 코어가 없으면 띄운다.
  - 띄우는 방식: `launchctl bootstrap gui/<uid>`로 임시 작업 `dev.herdr.core.<시작한 pid>.<ns>`(plist는 `/tmp/hc-launchd-*/job.plist`)을 올리고 detach handshake를 한다. 이어서 약 20 ms 안에 작업을 `bootout`한다(launchd 로그: `service inactive` → `removing service`).
  - 결과: 코어 프로세스는 `PPID=1`, 자기 PGID로 계속 돈다. `launchctl list`나 `~/Library/LaunchAgents`에는 아무것도 남지 않는다.
  - A~D 네 변형과 0.1.17·0.1.18 모두 같았다.
- **생존**: A start 뒤 앱이 종료돼도 코어(pid 7318)와 터미널(pid 7343)이 그대로였다.
  - 약 50초 뒤 check 실행: 같은 코어 pid(`uptime_ms` 50237)에서 `terminal.list {labels:{gajae.session:…}}`가 `t1 live`를 돌려줬다.
  - `terminal.read` 끝 줄은 `tick-48..50`(출력이 계속 쌓임). core id(`94a5…`)도 그대로였다.
- **FD 누수 없음** (래퍼 유무와 무관, A·B 동일)
  - Electron 자식 `hc connect`: 0~2(pipe)와 코어로 가는 unix socket 2개뿐이다. 이때 Electron 프로세스는 lsof 82줄이었다. macOS libuv가 자식에게 stdio만 넘긴다.
  - 코어: `/dev/null`, `core.log`, `core.lock`, 소켓, kqueue, 내부 socketpair뿐이다. launchd가 새로 띄우므로 앱의 FD를 받을 길이 없다.
- **환경: 코어 자신과 터미널이 다르다** (핵심 발견)
  - 코어 프로세스 env는 launchd 기본값(`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, HOME, USER, SHELL, TMPDIR, SSH_AUTH_SOCK, XPC_* 등)이다.
  - 그러나 터미널 holder(`herdr-core hold`, 부모는 코어)와 새 터미널의 env는 **코어를 처음 띄운 클라이언트의 env 전체**다.
  - A(상속)에서는 앱이 받은 env가 그대로 터미널에 들어갔다. `open`으로 실행해서 호출한 셸의 env가 넘어온 경우다. 들어간 것: `CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID`, 메시징 토큰, `TERMINFO`, DB 접속 정보 같은 개인 변수, `__CFBundleIdentifier=com.gajae.spike`.
  - 이 터미널에서 Claude Code를 띄우면 자기가 다른 세션의 자식이라고 오인할 수 있다.
  - 이후 다른 클라이언트(깨끗한 env)가 `terminal.run`을 불러도 결과는 같았다. 앱 env가 남고 호출별 `env`만 위에 얹힌다(`GAJAE_PROBE=per-call` 확인).
  - B(허용 목록)에서는 터미널 env가 허용 목록, `HC_SCOPE`/`HC_SESSION`/`HC_TERMINAL_ID`/`HC_TERMINAL_SOCKET`, hc가 덮어쓰는 `TERM=xterm-256color`, `TERM_PROGRAM=ghostty`, `COLORTERM=truecolor`뿐이었다.
  - 0.1.17도 같은 동작이다. 시작한 클라이언트 env에 `SSH_AUTH_SOCK`이 없으면 터미널에도 없다.
- **`server restart`로 env 교체 (0.1.18)**: 오염된 코어(e18)에 깨끗한 env 클라이언트가 `hc server restart`를 보냈다.
  - core id는 같고 코어 pid만 새로 바뀌었다.
  - 돌던 터미널 `t1`은 이전 holder에서 계속 살았다.
  - 새 터미널은 새 holder에서 **재시작한 클라이언트의 env**를 받았다(`CLAUDECODE` 없음).
- **화면 스냅숏 영속화**: `server restart` 때 hc가 각 터미널 화면을 `~/.local/state/herdr-core/<세션>/screens/t<N>.snap`(GHOSTSNP 형식, 글자는 평문으로 읽힘)에 저장했다. 폴더는 0700, 파일은 0644다. 즉 터미널에 찍힌 비밀값이 디스크에 남을 수 있다.
- **번들/서명**: `codesign --force --deep --sign -` 뒤에도 `Resources/bin/herdr-core-*`는 Herdr Inc. Developer ID 서명(TeamIdentifier 2W9652Q7QR)을 그대로 유지했다.
  - `Resources/Herdr Core.app`도 `valid on disk`, `satisfies its Designated Requirement`였다.
  - 앱 전체 `codesign --verify --deep --strict` 통과.
  - 맨 실행 파일(A~C)과 번들 안 실행 파일(D) 모두 앱 번들 안에서 코어를 띄웠다.

### 결론

- 앱을 종료해도 코어와 터미널은 유지되고, 재접속과 출력 이어보기가 된다.
- macOS에서는 FD 누수가 없었다. 설계안의 "FD를 닫는 래퍼"는 필수가 아니라 방어용이다. hc 안에 launchd handshake가 실패하면 직접 띄우는 경로가 있으므로(`HC_LAUNCHD_DIRECT`, "removing the job before direct startup" 문자열) 래퍼는 싸게 남겨 둔다.
- **환경은 허용 목록이 필수다.**
  - 앱 env를 그대로 넘기면 개인 비밀값과 `CLAUDECODE`류가 모든 터미널에 퍼진다.
  - Finder로 실행한 앱은 launchd 기본 PATH만 가진다(이번에 실측하지 않음, macOS 기본 동작). 그래서 허용 목록 env의 PATH는 로그인 셸 PATH로 채워야 한다.
- 이미 오염된 코어는 Gajae의 깨끗한 env로 `server.restart`하면 새 터미널부터 고쳐진다(0.1.18 실측). 돌던 프로그램은 죽지 않는다.

## 2. ② launchd / TCC / 백그라운드 항목 알림

### 명령

- 코어를 6번 띄운 시간대의 통합 로그를 봤다.
  - `/usr/bin/log show --predicate 'subsystem == "com.apple.backgroundtaskmanagement" OR process == "backgroundtaskmanagementd" OR subsystem == "com.apple.TCC" …'`에서 `herdr`/`gajae`로 필터.
  - launchd 로그는 `dev.herdr.core`로 필터.
- `spctl -a -t exec -vv`, `codesign -dv`, `codesign -d --entitlements -`, `stapler validate`.

### 관찰

- **launchd**: §1의 임시 작업뿐이다. LaunchAgents plist도, 상시 작업도 남지 않는다.
- **백그라운드 항목(BTM)**: 코어를 띄운 6번 동안 BTM 로그에 herdr·gajae 항목이 하나도 없었다. 같은 시간대에 다른 앱(Karabiner) 항목은 정상으로 보였으므로 로그는 수집되고 있었다. 따라서 "백그라운드 항목 추가됨" 알림이 생길 경로가 관찰되지 않았다. 알림 센터 화면은 직접 보지 않았다.
- **TCC**: tccd 로그에는 Electron 자신의 WindowServer/Accessibility 확인만 있었다(주체 `com.gajae.spike`). 터미널 프로그램이 보호 자원에 접근하지 않았으므로 herdr-core 관련 TCC 요청은 없었다.
  - 보호 자원 접근 시 책임 프로세스(누구 이름으로 묻는지)는 사용자 화면에 권한 대화상자를 띄우게 되므로 실측하지 않았다 → **미확인**.
  - 참고: 0.1.18 실행 파일에는 Info.plist(카메라·마이크·로컬 네트워크·문서 폴더 등 사용 목적 문구)가 내장돼 있다. `_HC_RESPONSIBLE_PID`와 "responsibility disclaimer" 문자열도 있어서 hc가 책임 프로세스를 스스로 떼어 내는 것으로 보인다. 그렇다면 권한 요청은 Gajae가 아니라 herdr-core/Herdr Core 이름으로 뜰 것으로 추정한다(미확인).
- **공증**
  - 0.1.17 실행 파일: `Unnotarized Developer ID`, hardened runtime 없음(`flags=0x0`).
  - 0.1.18 실행 파일: hardened runtime(`flags=0x10000(runtime)`) + entitlements(apple-events, allow-dyld-environment-variables, audio-input, camera 등).
  - 0.1.18 `Herdr Core.app`: `accepted / source=Notarized Developer ID`, 티켓 stapled.
  - Gajae Developer ID 서명·공증 경로는 자격증명이 없어 **미확인**이다.
    - 0.1.17처럼 hardened runtime이 없는 실행 파일을 넣으면 공증 제출이 거부될 가능성이 높다(추론).
    - `@electron/osx-sign`이 Resources 안 Mach-O를 Gajae 서명으로 다시 서명하는지도 미확인이다. 다시 서명하면 Herdr의 신원과 공증이 바뀐다.

### 결론

- ad-hoc 빌드 기준으로는 launchd 흔적과 백그라운드 항목 등록이 남지 않는다.
- TCC 책임 귀속과 공증 빌드 동작은 **미확인**이다. P5 공증 빌드에서 확인해야 한다.
- 번들은 공증된 `Herdr Core.app` 통째로 넣는다. 공증 서명 단계는 이 번들을 다시 서명하지 않도록 제외해야 한다.

## 3. ③ Claude Code: `--session-id` + `--settings` 훅

### 명령

- 깨끗한 env로 띄운 코어 `gajae-spike`(0.1.18)에서 다음을 실행했다.

```
terminal.run argv=[/opt/homebrew/bin/claude, --session-id <uuid>, --settings <spike>/hooks/settings.json,
                   --model haiku, --permission-mode default]
             cwd=<spike>/cc-work  labels={gajae.session: spike-cc}  no_parent=true
```

- settings에 등록한 훅: SessionStart, UserPromptSubmit, Stop, Notification, PermissionRequest, PreToolUse, PostToolUse, SessionEnd. 모두 `/bin/sh <relay.sh> <이벤트>`로 전달한다(§4).
- 모델 호출은 haiku 프롬프트 1회뿐이다. 나머지는 로컬 명령(`/clear` 2회)과 `terminal.kill`이다.

### 관찰

- 새 폴더라 먼저 작업 공간 신뢰 대화상자가 떴다. hc status는 `blocked/permission "trust this folder"`였고, `terminal.keys [down] → [enter]`로 넘겼다.
- **SessionStart**: `session_id`가 지정한 uuid와 같았다. `source: "startup"`.
  - `transcript_path = ~/.claude/projects/-private-tmp-claude-501--…-spike-cc-work/<uuid>.jsonl`
  - **경로는 cwd의 realpath**(`/private/tmp/…`)에서 영숫자가 아닌 문자를 `-`로 바꾼 것이다.
  - payload 키: `session_id, transcript_path, cwd, scratchpad_dir, hook_event_name, source, model`.
- **UserPromptSubmit**: `prompt_id, permission_mode, prompt` 포함.
- **Stop**: `stop_hook_active, last_assistant_message, background_tasks, session_crons`.
- 기록 파일은 첫 턴 뒤 62줄(약 340 KB)이었다. 종류: `user`, `assistant:thinking|tool_use|text`, `user:tool_result`, `system`, `attachment`, `file-history-snapshot`, `ai-title`, `cost-state` 등.
- **`/clear`**: `SessionEnd(reason: "clear")` 다음 `SessionStart(source: "clear")`가 **새 session_id와 새 transcript_path**로 다시 보고됐다.
- **`terminal.kill`**: `SessionEnd(reason: "other")`.
- **PermissionRequest에는 `tool_use_id`가 없다**(2.1.331). 키: `tool_name, tool_input, permission_suggestions, permission_mode, prompt_id`.
  - 바로 앞 **PreToolUse**에는 `tool_use_id`가 있다. **PostToolUse**에는 `tool_use_id, tool_response, duration_ms`가 있다.
- 사용자 설정의 Code Mode(실험 기능) 때문에 Bash가 `REPL` 도구 안에서 불렸다.
  - 그래서 PreToolUse/PostToolUse가 바깥 `REPL`(`toolu_…`)과 안쪽 `Bash`(`repl_…`)에서 두 번씩 왔다.
  - 사용자 환경에 따라 도구 id 체계가 달라질 수 있다는 뜻이다.
- **pid 폴백**: `~/.claude/sessions/<pid>.json`에 `{pid, sessionId, cwd, status, version, …}`이 있다. `/clear` 뒤에는 sessionId가 새 값으로 갱신돼 있었다. hc `terminal.get`의 `foreground.pid`(= claude pid)로 이 파일을 바로 찾을 수 있다.

### 결론

- `--session-id`와 훅으로 session_id, transcript_path를 받는다. `/clear` 뒤에도 다시 받는다. 동작 확인 완료.
- 앱을 다시 켠 뒤에도 훅은 계속 들어온다(§4).
- 기록 위치 계산은 realpath와 Claude의 치환 규칙을 따라야 한다.
- 앱이 꺼져 있던 동안 놓친 SessionStart는 pid 파일로 보정할 수 있다.
- 승인 카드와 도구 호출의 연결은 PermissionRequest만으로는 안 된다. 직전 PreToolUse(같은 세션, 같은 `tool_name`과 `tool_input`)와 짝지어야 한다.

## 4. ④ `/bin/sh` + `/usr/bin/nc -U` 릴레이

### 명령

```sh
# relay.sh <이벤트>   (0700, 토큰 파일과 settings는 0600, 소켓 폴더는 0700)
SOCK='<$TMPDIR>/gjs/h.sock'           # 58바이트
TOKEN=$(cat <token 파일>)
{ printf '{"token":"%s","event":"%s","pid":%s,"payload":' "$TOKEN" "$1" "$$"; tr -d '\n\r'; printf '}\n'; } \
  | /usr/bin/nc -U -w 2 "$SOCK" >/dev/null 2>&1
exit 0
```

- 수신 측은 Node `net` 서버(앱 역할)다. 시작할 때 이전 소켓 파일을 지우고 listen한 뒤 `chmod 600`, 첫 줄을 받으면 연결을 닫고 토큰을 확인한다.

### 관찰

- 첫 시도는 payload 안 줄바꿈 때문에 JSON이 잘렸다. `tr -d '\n\r'`로 해결했다. JSON 문자열 안의 줄바꿈은 이스케이프돼 있으므로 날것의 줄바꿈만 지워도 안전하다.
- 수동 전송 왕복 약 90 ms. 훅 이벤트는 순서대로, 모두 `tokenOk: true`로 도착했다.
- **수신 측이 꺼졌을 때**: Node 서버를 SIGTERM으로 죽이자 소켓 파일이 남았다.
  - 이 상태에서 `/clear`를 보내면 릴레이는 곧바로 실패하고(ECONNREFUSED, 소켓 파일이 없을 때도 약 43 ms) exit 0으로 끝난다.
  - Claude Code는 막히지 않았다(status idle). 그 사이 훅 2개(SessionEnd, SessionStart)는 **유실**됐다.
- **같은 경로로 재시작**: 같은 경로에서 다시 listen하자, 계속 돌던 같은 Claude Code의 다음 `/clear` 훅이 새 수신 측(L2)으로 정상 도착했다.

### 결론

- 소켓 경로와 토큰이 고정이면 앱을 다시 켜도 기존 에이전트의 훅이 이어진다. 동작 확인 완료.
- 메시지 규칙: 한 연결에 한 줄, 줄바꿈 제거, 수신 측이 첫 줄을 받고 닫는다.
- 꺼져 있던 동안의 이벤트는 사라진다. 시작할 때 hc `terminal.list`/`terminal.get`과 pid 파일로 상태를 다시 맞춰야 한다.

## 5. ⑤ OSC 7501 보고와 승인 대화상자 중 `terminal.send`

### 관찰

- 시작 직후부터 `reported: true`였다.
- 이벤트(`events.subscribe`)로 본 상태 순서:
  - `blocked/permission "trust this folder"`
  - `null`(대화상자를 닫은 직후 잠깐)
  - `idle`
  - (프롬프트) `working`
  - `blocked/permission "approve Bash: touch spike-marker.txt"`
  - (승인) `working`
  - `done`
  - (`/clear`) `working`
  - `idle`
- `turn` 이벤트는 `{state, turn}`으로 함께 왔다. `heartbeat`는 15초마다 왔다.
- **대화상자 중 `terminal.send`는 거부됐다** (신뢰 대화상자와 Bash 승인 대화상자에서 각각 확인):

```json
{"code":-32000,"message":"t1 is blocked (permission)",
 "data":{"kind":"blocked","hint":"typing would answer its dialog; read its screen first (hc read t1), or --force"}}
```

- idle/done 상태의 `terminal.send`는 `{"started":true,"status":"idle"|"done","turn":N}`을 돌려줬다.
- `terminal.keys`는 blocked 상태에서도 동작한다(대화상자 응답에 사용). 응답 형식은 `{"status":"blocked","turn":0}`.
- 승인은 `keys [enter]`(1. Yes)로 했다. 이어서 PostToolUse(Bash, REPL), Stop 훅이 왔고 파일이 생성됐다.

### 결론

- Claude Code 2.1.331은 hc 아래에서 7501로 상태를 보고한다. `capabilities.send`는 `reported`로 판정해도 된다.
- 승인 대화상자 중 채팅 입력은 hc가 `blocked` 오류로 막는다. Gajae는 이 오류를 "터미널에서 승인 대기 중"으로 보여 주면 된다.

## 6. ⑥ 버전 결정: **0.1.18 채택**

- **API**: 프로토콜 generation 1로 같다. 메서드 목록도 같다(32개).
  - 0.1.18에서 추가된 것: hello feature `automatic_input`, `terminal.run`의 `display`·`size`, `Terminal.first_message`, `AttachResult.automatic_input`.
  - 두 버전 모두 있는 것: `terminal.send`의 `if`/`force`/`wait`, `terminal.list`·`events.subscribe`의 `labels` 필터, `terminal.interrupt` (설계안 위험 4 해소).
  - schema는 `hc schema`로 받아 비교했다. 주의: 실행 중인 코어가 있으면 그 코어의 schema가 나온다. 그래서 0.1.17은 따로 띄운 0.1.17 코어에서 받았다.
- **패키징**: 0.1.18만 hardened runtime이 켜져 있고, 공증된 `Herdr Core.app`을 제공한다. 0.1.17은 공증되지 않았다.
- **타입 생성 기준**: Ovis `hc-api.generated.ts`가 0.1.18 schema에서 생성됐다. 번들 버전과 타입 기준이 같아진다.
- 참고: 이후 0.1.19~0.1.22가 나와 있다.
  - 0.1.19: `nohup` 프로그램이 터미널 종료 뒤에도 생존.
  - 0.1.20: `server restart --fresh`.
  - 0.1.22: `events --doc` 필터.
  - 이번 범위 밖이다. generation이 같으므로 기능 판정을 hello의 `methods/features`로 하면 나중에 올리기 쉽다.

## 7. 설계 변경점 요약 (agent-runtime-herdr.md 반영)

1. **코어 시작**: hc 명령이 launchd 임시 작업으로 코어를 띄우고 떼어 낸다. "존재 확인은 `--version`만"을 유지한다(`server status`나 `schema`도 코어를 띄움).
2. **env 허용 목록 필수, 위반 시 `server.restart`**: 터미널 env는 코어를 처음 띄운 클라이언트 env다.
   - Gajae는 hc를 항상 허용 목록 env로 실행한다: HOME, USER, LOGNAME, SHELL, LANG/LC_*, TMPDIR, SSH_AUTH_SOCK, __CF_USER_TEXT_ENCODING, 로그인 셸에서 얻은 PATH.
   - 오염이 감지되면 Gajae env로 `server.restart`해 새 터미널부터 교정한다.
   - 감지 방법(예: `machine.exec`로 env 확인)은 P1에서 확인한다.
3. **FD 래퍼**: 필수가 아니라 방어용으로 낮춘다.
4. **번들**: 0.1.18 `Herdr Core.app`을 통째로 넣고, userData 사본에서 실행한다(앱 업데이트로 번들 경로가 바뀌므로). 공증 서명은 이 번들을 다시 서명하지 않는다(미확인, P5).
5. **훅 파일 배치**
   - 소켓만 짧은 경로(예: `$TMPDIR/<짧은 이름>/h.sock`, 약 58바이트)에 둔다.
   - 릴레이 스크립트, settings, 토큰은 실행 중인 에이전트가 계속 참조하므로 영속 경로(userData, 0600/0700)에 둔다. `$TMPDIR`는 오래된 파일이 정리될 수 있다.
   - 메시지 규칙: 한 연결에 한 줄, 줄바꿈 제거.
6. **승인 연결**: PermissionRequest와 직전 PreToolUse를 짝지어 `tool_use_id`를 얻는다. 카드 닫기는 PostToolUse/Stop의 `tool_use_id`로 한다.
7. **기록 위치**: ① 훅 ② `--session-id` + realpath 치환 경로 ③ hc `foreground.pid` → `~/.claude/sessions/<pid>.json`. 시작할 때 ③으로 유실분을 보정한다.
8. **상태 매핑**: 실측 값은 `idle/working/blocked(kind)/done`과 잠깐 나오는 `null`이다. `null`이 잠깐 나오면 직전 상태를 유지한다.
9. **첫 실행 신뢰 대화상자**도 `blocked/permission`으로 보고된다. 채팅 화면에서는 "터미널에서 폴더 신뢰 필요"로 안내한다.

## 8. 남은 미확인

- 공증(Developer ID) 빌드에서 Herdr Core.app 서명 보존과 공증 통과 여부.
- 보호 자원 접근 시 TCC 책임 귀속(누구 이름으로 묻는지).
- Finder로 실행했을 때 앱 env 실측.
- 오염 감지 방법(`machine.exec` env가 터미널 env와 같은지).
- Claude Code 최소 지원 버전(이번에는 2.1.331만 확인).
- 화면 스냅숏(`screens/*.snap`)이 언제 지워지는지(`terminal.rm`, `server stop` 때 등). 세션 삭제 시 Gajae가 `terminal.rm`까지 해야 하는지 P1에서 확인.
- omp의 7501 보고와 확장 훅 동작.
