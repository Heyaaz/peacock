# 설계안: 범용 에이전트 런타임 (herdr-core 도입)

상태: v3 (2026-11-24, fable-advisor 검토 + P0.5 스파이크 반영, 실측: [spike-results.md](spike-results.md)) · 대상: gajae-bot (dev 기준) · 이름 변경은 범위 밖

## 1. 목표 / 비목표

**목표**
- Gajae를 GJC 전용 앱에서 **범용 코딩 에이전트 껍데기**로 바꾼다. GJC는 여러 에이전트 중 하나로 유지.
- Claude Code · omp · codex는 **herdr-core 위 터미널**에서 실행하고, 같은 세션을 **채팅 화면**으로도 본다(기록 파일 파싱).
- 터미널/에이전트는 **앱을 꺼도 유지**된다.
- 승인 카드 · 명령 규칙 · 알림 · 폰 원격이 herdr 세션에서도 동작한다.

**비목표**
- 이름 변경, Windows/Linux, Claude Code SDK 채팅 어댑터, herdr TUI 호환(herdr 프로토콜 shim 미이식).
- 검색 색인 · 병렬 실행의 herdr 세션 지원 → **P6로 분리**(병렬은 `parallel-run-service.ts:334`가 `runtime:"gjc"` 고정).

## 2. 현재 구조 요약
- 렌더러 `AgentBackend`(~50 메서드) → `GjcAgentBackend`가 GJC/터미널을 `terminal-` 접두사로 분기.
- 메인: IPC 핸들러·RemoteAccess·ParallelRun·Productivity가 구체 클래스 `GjcSdkController`에 직접 연결(`main.ts:229,441,558,566,576`). 이벤트는 `broadcastAgentEvent`.
- 터미널: node-pty `LoginShellSession` + 창 단위 `TerminalHost`. 앱 종료 시 전부 kill, 상태 idle 고정, 원격 비노출.

## 3. 목표 구조

```
Renderer
  AgentBackend (기존) — 세션별 capabilitiesOf(session)로 기능 노출
Main
  AgentRouter : 핵심 AgentHost + 선택 facet(goal/workflow/model …) 구현
    ├ GjcSdkController      (기존, runtime "gjc")
    └ HerdrAgentController  (신규, runtime "herdr")
        ├ HcCore       : 번들 Herdr Core.app 설치/시작/연결, 모드별 HC_SESSION, 허용 목록 env
        ├ HcConnection : 프레임 프로토콜 (Ovis connection.ts 이식, Node stream 어댑터)
        ├ TerminalAttach: CoreAttachSession 이식
        ├ AgentHooks   : 실행 시 주입하는 훅 채널 (세션 보고 · 턴 상태 · 승인)
        ├ TranscriptBridge: 기록 파서(claude → omp) → TranscriptItem
        └ StatusTracker: hc events + 훅 → session.updated / session.activity
  WorkspaceServices: git/diff를 workspace 기준 공통 서비스로 분리
  shared/agent-catalog.ts : 에이전트 목록·감지·실행 옵션
```

## 4. 데이터 모델

- **RuntimeKind**: P0에서 `"herdr"` **추가만**. `"terminal"`/`"hermes"` 제거는 P5(영향: `shell.tsx:445`, `sidebar.tsx:301,913,952`, `gjc-input-validation.ts:78`).
  - **P5 결과**: `RuntimeKind = "gjc" | "hermes" | "herdr"`. 셸·에이전트 행은 모두 `"herdr"`. `"terminal"`은 타입에서 빠지고 `normalizeRuntimeKind`가 옛 이름을 `"herdr"`로 읽는다(저장된 입력, 구버전 원격 요청). 렌더러의 `runtime === "terminal"` 분기는 `runsInTerminal(session)`(herdr 또는 agentKind가 GJC 아님)과 `capabilitiesOf`(fork 등), `agentKind === "shell"`(아이콘)로 바꿨다. `"hermes"`는 목(mock) 백엔드 전용으로 남긴다(라우터는 GJC 쪽에 둠).
- **AgentKindId**: `"claude" | "omp" | "codex" | "gjc" | "shell"`.
- **세션 ID**: Gajae UUID 유지(`terminal-<uuid>` 체계 확장). 세션 ≠ 터미널. 레코드에 `{coreId, terminalAddress, agentKind, agentSessionRef}` 저장.
  - hc 주소는 코어 단위로만 유일 → hello의 `core.id`와 함께 저장.
  - `terminal.run` labels에 `gajae.session=<id>`, 시작 시 `terminal.list`와 대조해 고아 정리.
  - 터미널이 죽어도 세션은 남고, 새 터미널에서 `claude --resume <agentSessionRef>`로 이어감.
- **capabilities**: `AgentSession.capabilities?`(optional) + shared `capabilitiesOf(session)` 기본값. **동적 값**(승인은 버전·훅 키 생존, send는 hc `reported` 여부에 따라).
  - 항목: `send, cancel, approvals, questions, goal, compact, sideQuestion, suggestion, modelConfig, thinking, fork, git, attachments, streaming`.
- **상태 매핑**

| hc/훅 | SessionStatus | 추가 이벤트 |
|---|---|---|
| working | running | — |
| blocked (승인·폴더 신뢰 대기, `kind`=permission 등) | waiting | session.activity(permission) |
| idle | idle | — |
| done | idle | session.activity(completed) |
| finished(비정상 종료) | failed | session.activity(failed) |
| 미보고 | unknown | — |
| `status: null` (대화상자 직후 잠깐, 실측) | 직전 상태 유지 | — |

- **설정**: `gjcExecutable` → `agents.<kind>.{executable, defaultLaunch}`, `newSession: {agentKind, surface}`. 기존 값 마이그레이션.
  - **P5 결과**: `agents: Partial<Record<AgentKindId, {executable?, launch?}>>`(`defaultLaunch` 대신 `launch`, 검증은 `launchOptionsFault` 공용). `gjcExecutable` → `agents.gjc.executable`, GJC 실행 파일은 `GJC_BIN` → 설정 순(`gjcExecutableOf`). `newSessionKind` → `newSession`: `"app"`(또는 `newSession` 키가 없는 기존 파일) → GJC 채팅, `"cli"` → 셸 터미널. 처음 쓰는 사용자의 파일에는 `newSession: null`(아직 고르지 않음)을 저장해, 기존 파일(키 없음 → GJC 유지)과 구분한다.
- **원격**: 새 필드는 optional. 구버전 PWA는 capabilities를 모르므로 **서버 쪽에서** 제한(§5.7).

## 5. 기능별 설계

### 5.1 herdr-core 수명주기
- **hc 0.1.18 채택**(스파이크 ⑥): 번들 버전 = 타입 생성 기준 0.1.18. 공증된 `Herdr Core.app`을 통째로 번들하고(0.1.17은 비공증·hardened runtime 없음) userData 사본에서 실행. 공증 서명 단계는 이 번들을 재서명하지 않는다(P5에서 확인). 기능 유무는 hello의 `methods/features`로 판정.
- 코어는 hc 명령 하나(`connect`·`server status`·`schema` 포함)가 없으면 launchd 임시 작업(`dev.herdr.core.<pid>.<ns>`)으로 띄우고 곧바로 떼어 낸다(PPID 1, LaunchAgents 흔적 없음).
- **설치는 버전별 폴더**(P1 실측으로 변경): `userData/bin/herdr-core/<버전>/Herdr Core.app`에 ditto로 복사한다. 이미 설치된 서명 번들을 `hc update --from`으로 바꾸려 하면 hc가 "isn't writable by you"로 거부한다(0.1.18→0.1.19 실측). 대신 새 버전 폴더를 만들고, 실행 중 코어가 더 오래된 버전이면 새 바이너리로 `hc server restart`를 한다(실측: 코어만 새 버전으로 바뀌고 돌던 터미널은 이전 holder에서 유지). 더 새 버전 폴더가 이미 있으면 그것을 쓴다(다운그레이드 금지). 연결할 때마다 hello 버전을 확인한다.
- **모드별 세션명**: `gajae` / `gajae-dev` / `gajae-smoke-<pid>` (상태가 `~/.local/state/herdr-core/<session>` 전역이라 dev/smoke 격리 필수). 세션명은 holder 소켓 경로(`<state>/<s>/<s>.holder.<8hex>.sock`, 103바이트 이하)에 두 번 들어가므로 짧아야 한다(P1 실측: 홈 경로가 18자일 때 세션명 19자까지). 스모크 세션명은 넘치면 `gs-<pid>`로 줄인다. 스모크가 스스로 이름 붙인 코어는 앱 종료 시 `server stop`하고 상태 폴더도 지운다. `GAJAE_HC_SESSION`으로 이름을 받은 코어는 호출한 쪽이 정리한다.
- 환경: **허용 목록 필수**(Ovis `terminal-env.ts:18`). 실측상 터미널 env는 **코어를 처음 띄운 클라이언트의 env 전체**이고 `terminal.run` env는 그 위에 덮어쓰기만 된다(앱 env를 넘기면 `CLAUDECODE`·토큰·개인 변수가 모든 터미널로 샌다). 허용 목록: HOME, USER, LOGNAME, SHELL, LANG/LC_*, TMPDIR, SSH_AUTH_SOCK, __CF_USER_TEXT_ENCODING, **로그인 셸 PATH**(Finder 실행 앱은 launchd 기본 PATH). 오염 감지 시 Gajae의 깨끗한 env로 `server.restart` → 돌던 프로그램은 유지되고 새 터미널부터 교정(0.1.18 실측). 감지 방법은 P1에서 확정.
- **빈 `NO_COLOR=""` 주입은 이식하지 않는다.**
- macOS 실측에서 FD 누수 없음(libuv가 stdio만 넘기고, 코어는 launchd가 새로 띄움). FD 닫는 래퍼(`children.ts:18`)는 hc의 직접 실행 폴백 대비 **방어용**으로만 둔다. 존재 확인은 `--version`만(다른 명령은 코어를 띄움).
- 앱 종료 시 코어·터미널 유지. 설정에 "백그라운드 터미널 모두 종료" 제공.

### 5.2 터미널
- `LoginShellOptions`에 세션 식별자가 없으므로 `open` 시그니처를 바꾼다(P1: `SessionTerminalProvider.open({record, cols, rows, restart, onData, onExit})`, `electron/terminal-backend.ts`).
- `TerminalHost`의 `dispose`를 **detach / kill(세션 삭제) / restart**로 분리. 창 닫기·앱 종료는 detach.
- replay: hc history(최대 2000줄)를 1순위, 자체 512KB ReplayBuffer는 attach 이후 분량만.
- 채팅 화면의 임시 셸(`SURFACE_KEY`)은 **node-pty 유지**(hc로 옮기면 뷰마다 죽지 않는 터미널이 샘).
- attach 종료 `exit_code=null` = 연결 끊김(재접속), exit 0으로 표시하지 않음.
- 디스플레이 질의(OSC 10/11/12, CSI 16t) 응답 처리 이식(`attach-session.ts:5`).
- node-pty는 폴백으로 P5까지 유지, 제거 여부는 P5에서 결정.
  - **P5 결정: node-pty 유지.** 터미널 쪽 쓰임은 둘: ① 채팅 화면의 임시 셸(`SURFACE_KEY`, 뷰가 닫히면 같이 끝나야 하는 터미널), ② hc를 쓸 수 없을 때(macOS 외, 번들 없음, 코어 시작 실패) 셸 세션의 앱 안 폴백. 에이전트 세션은 폴백하지 않고 오류를 보인다(P2). 그 밖에 GJC CLI 세션 삭제(`gjc-cli-session-delete.ts`)도 pty로 대화형 GJC를 띄운다. 빼면 ①을 hc로 옮겨야 하고(뷰마다 남는 터미널, 정리 경로 추가) ②의 실패 시 셸이 아예 열리지 않는다. 네이티브 모듈 재빌드 비용은 이미 패키징에 들어가 있어 유지 비용이 작다.

### 5.3 에이전트 실행
- 카탈로그: claude, omp, codex, gjc, shell. 감지는 PATH → 로그인 셸 PATH → install_dirs, `--version` 캐시.
- `terminal.run`의 program은 **절대 경로 강제**(argv[0]이 hc 템플릿 이름으로 해석될 수 있음, Ovis `adapter.ts:880`).
- 실행 옵션 검증: Ovis `launch-rules.ts`/`agentLaunchMode.ts` 축소 이식.
- Claude Code는 `--session-id <uuid>`로 시작해 세션을 Gajae가 정한다(실측: SessionStart의 `session_id`가 그 값). 새 폴더 첫 실행은 작업 공간 신뢰 대화상자(`blocked/permission "trust this folder"`)가 먼저 뜬다.
- (P2) 세션 ID는 `terminal-<uuid>` 그대로(셸·에이전트 공통): 렌더러와 터미널 IPC가 이미 이 접두사로 라우팅한다. 레코드는 `TerminalSessionStore`에 `agentKind`·`launch`·`agentSessionRef`·`transcriptPath`를 더해 저장한다. 행의 `runtime`은 렌더러 호환을 위해 P5까지 `"terminal"`로 두고, 라우터 소유권(`registerRuntime("herdr")`)으로 구분한다(P5에서 `"herdr"`로 바꿈, §4). 터미널이 끝난 에이전트를 다시 열면 기록이 있을 때 `--resume <agentSessionRef>`로 시작한다.
- (P2) 에이전트 터미널에는 `GAJAE_SESSION_ID`를 넣어, 훅이 `/clear`로 바뀐 `session_id`와 상관없이 Gajae 세션을 가리키게 한다. 에이전트 세션은 herdr-core가 없으면 앱 안 셸로 폴백하지 않고 오류를 보인다.

### 5.4 훅 채널 (P2부터)
- 실행 시 주입: Claude는 `--settings <file>`로 SessionStart / UserPromptSubmit / Stop / PermissionRequest(P4) / PostToolUse(P4) 훅, omp는 `-e <extension>`.
- SessionStart로 `session_id`, `transcript_path`를 받는다 → 기록 위치 1순위. `/clear`·`/resume`로 세션이 바뀌어도 다시 보고됨.
- 턴 시작/종료를 훅으로 받아 OSC 7501 의존을 줄인다.
- (P2) 소켓 위치: `userData/agent-hooks/h.sock`이 100바이트 이하면 거기, 아니면 `$TMPDIR/gajae-hooks-<해시>/h.sock`. 릴레이·settings·토큰은 `userData/agent-hooks/`(0700/0600)에 둔다. 앱을 다시 켠 뒤 살아 있던 Claude Code의 `/clear` 훅이 들어오는 것을 실측했다.
- **릴레이**: `/bin/sh` + `/usr/bin/nc -U -w 2` + 토큰(실측 동작). **소켓만** 짧은 고정 경로(예: `$TMPDIR/<짧은 이름>/h.sock` ≈ 58바이트, 폴더 0700, 소켓 0600)에 두고, 실행 중인 에이전트가 참조하는 릴레이 스크립트·settings·토큰은 영속 경로(userData, 0700/0600)에 둔다. 메시지는 한 연결에 한 줄(payload의 날 줄바꿈 제거), 수신 측은 첫 줄을 받고 닫는다. 수신 측이 없으면 릴레이는 즉시 exit 0(에이전트 비차단), 이벤트는 유실 → 시작 시 보정(§5.5). 0700 unix socket이면 AES 봉인 생략.
- **훅 키와 설정 파일은 0600으로 영속화**, 소켓 경로 고정. 앱 재시작 후에도 살아 있는 세션의 훅이 계속 동작. hc `removed` 이벤트에서 정리. (Ovis 허브는 키가 메모리에만 있고 시작 시 파일을 지움 → 그대로 이식하면 안 됨)

### 5.5 채팅 화면
- 기록 위치: ① 훅 보고(`transcript_path`, `/clear` 뒤 새 값으로 재보고) ② `--session-id`로 계산한 경로(**cwd의 realpath**에서 영숫자 외 문자를 `-`로 바꾼 `~/.claude/projects/<…>/<id>.jsonl`) ③ hc `foreground.pid` → `~/.claude/sessions/<pid>.json`의 `sessionId`(실측, `/clear` 뒤 갱신됨). 앱이 꺼져 있던 동안 놓친 훅은 시작 시 ③으로 보정.
- 파서: `claude-transcript.ts`, `transcript-records.ts`만 떼어 이식(subagents/skills/code-mode/images는 스텁). `claude-store.ts`/`omp.ts`는 의존이 커서 **200~300줄로 재작성**.
- **id 규칙**(파서 수정 필요): tool = `call_id`, text/thinking = `<record uuid>:<block idx>`, user = `<record uuid>`, 앞에 sessionId. 파일 경로는 id에 넣지 않음.
- 스트리밍 delta 없음(파일 갱신 단위). 사용자 메시지는 기록에 나타날 때 확정(낙관적 표시 없음).
- 감시: 250ms stat 폴링 → `transcript.synced`/`appended`.
- 입력: **hc `terminal.send`** 사용(붙여넣기+Enter, 사용자 입력 ~3초 대기, 차단 상태 거부). 호출 타임아웃 30초. hc `reported=false`면 `capabilities.send=false`. Gajae 자체 대기열은 두지 않음. 첨부 불가 → `attachments=false`.
- 취소: `terminal.keys`(Esc) 또는 hc stop/interrupt(버전 확인).
- **P3 결과(실측·구현)**:
  - 구현 위치: `electron/herdr-core/transcript/`(`transcript-records.ts` 공통 판독, `claude-transcript.ts`, `omp-transcript.ts` 이식 파서, `transcripts.ts` 파일 추종·250ms 폴링·이벤트), `electron/herdr-core/omp-session.ts`(omp 기록 위치). 파서는 Ovis의 turn 대신 Gajae `TranscriptItem`을 바로 만든다. 행은 교체만 하고 제자리 변경은 하지 않는다(이전 목록과 비교해 바뀐 행만 보냄).
  - id: `<sessionId>:<call_id>`, `<sessionId>:<uuid>:<idx>`, `<sessionId>:<uuid>`(omp는 entry id). 파일 중간부터 읽어도, 한 줄씩 읽어도 같은 id(단위 테스트).
  - 첫 읽기는 파일 끝 16MiB만(Claude Code 2.1.33x는 턴마다 수십 KB의 요청 shape·prompt snapshot을 기록). 그보다 앞의 기록은 채팅에서 볼 수 없다(`hasMoreBefore`는 창 안 기준). 관련 없는 타입의 줄은 JSON 파싱 전에 건너뛴다.
  - 이벤트: 창이 페이지를 읽은 세션만, 바뀐 행 16개 이하면 `transcript.appended`(행 단위 upsert), 그보다 많으면 `transcript.synced`(창이 가진 행부터의 꼬리), 행이 사라지거나 순서가 바뀌면(다른 파일, `/clear`) `transcript.invalidated`.
  - `/clear`: SessionStart 훅이 새 `transcript_path`를 보고하면 추종 파일이 바뀌고 채팅은 새 기록만 보인다(스모크 2단계 실측). 앱 재시작 뒤에도 같은 파일에서 같은 id로 다시 읽는다(스모크 2단계).
  - 보내기: `terminal.send`(타임아웃 30초). blocked 거부는 `{kind:"not_executed", detail:<7501 msg>}`로 돌려주고 입력창에 이유를 보인다. 대기(waiting) 중엔 입력창에 "터미널 열기" 안내. 낙관적 표시 없음(기록에 나타날 때 행이 생김). `/compact` 등 기존 위험 명령 확인 대화는 GJC와 같은 경로를 탄다.
  - capabilities: 카탈로그 상한에서 `send = reported && live`, `approvals=false`(P4), `attachments/streaming=false`, `git`은 카탈로그 값 그대로(Claude Code·omp·Codex true, 셸 false: 폴더를 읽을 뿐 에이전트의 도움이 필요 없다. 터미널 화면의 변경 파일 패널은 §5.9 끝의 B1 참고). 렌더러는 Claude Code·omp 세션에 GJC Composer 대신 전용 입력창(텍스트·보내기·중단만)을 쓰고, 이 채팅 화면(터미널에 닿지 않는 기기)에서는 헤더의 사이드 채팅·변경 파일·세션 정보 버튼과 goal/subagent/명령 목록 조회를 끈다. 세션마다 채팅/터미널 선택을 기억하고 처음엔 카탈로그 `defaultSurface`(터미널)로 연다.
  - omp: **omp 19.1.1은 hc 아래에서 7501을 보고한다**(`reported=true`, idle→running 실측) → `send` 허용. 기록 위치는 ① 터미널 breadcrumb(`~/.omp/agent/terminal-sessions/<tty>`, 터미널 pid의 tty를 `ps`로, 터미널 시작 이후에 쓰였고 cwd가 같을 때만) ② 레코드에 저장한 경로 ③ cwd 폴더(`-<home 상대>`/`-tmp-<상대>`/`--<경로>--`)의 터미널 시작 이후 최신 파일. 실측은 ①로 찾음. 찾은 경로와 omp 세션 id는 레코드에 저장하고, 새 터미널은 `omp --resume <파일>`로 이어 간다. Gajae가 띄우는 omp에는 profile 관련 env가 전달되지 않으므로(허용 목록) 기본 store만 본다.

### 5.6 승인 / 질문 (P4)
- PermissionRequest 훅 → `ToolActivity{approval-required}`, `permissionOptions`는 **allow_once / reject_once만**.
- PermissionRequest에는 `tool_use_id`가 없다(2.1.331 실측). 같은 세션의 직전 PreToolUse(같은 `tool_name`·`tool_input`)와 짝지어 id를 얻는다. 사용자 설정(예: Code Mode)에 따라 바깥 도구와 안쪽 도구의 Pre/PostToolUse가 둘 다 올 수 있다.
- 승인 대화상자 중 `terminal.send`는 hc가 `data.kind: "blocked"`로 거부한다(실측) → 채팅에는 "터미널에서 승인 대기"로 표시.
- 명령 규칙(`matchCommandRule`) 먼저 적용.
- **터미널에서 직접 답한 경우 해제 규칙**: PostToolUse/Stop 훅 또는 기록의 tool_result가 오면 카드 닫음(Ovis는 화면 판독으로 해제, 600초 타임아웃).
- 최소 지원 버전은 Gajae 기준으로 따로 측정(Ovis의 2.1.286은 화면 대조용 기준).
- **P4 결과(실측·구현)**:
  - 구현: `electron/herdr-core/approvals.ts`(HerdrApprovals: 짝짓기·규칙·카드·해제), 훅 채널(`agent-hooks.ts`: PreToolUse/PostToolUse/PermissionRequest 추가, PermissionRequest만 연결을 열어 두고 답을 기다림), 카드는 transcript 행 위에 겹쳐 그림(`transcripts.ts` composeRows: 같은 id의 transcript 행이 있으면 그 자리, 없으면 요청 당시 마지막 행 뒤).
  - 릴레이: macOS `nc`는 입력이 끝나면 연결을 바로 닫는다(실측) → 입력을 0.2초마다 개행으로 열어 두고, 답(Claude 훅 형식 JSON)만 출력. 앱이 없거나 답이 비면 출력 없이 종료(= 결정 없음 → 터미널 대화상자). 훅 `timeout` 620초, Gajae 대기 600초(먼저 놓음).
  - **Claude Code 2.1.331은 훅이 기다리는 동안 자기 대화상자를 그린다**(실측: 카드 대기 중 화면에 대화상자, hc 상태 waiting) → 훅이 에이전트를 막지 않음. 대기 600초는 카드가 답할 수 있는 시간일 뿐.
  - 짝짓기: PermissionRequest(tool_use_id 없음) ↔ 같은 세션의 직전 PreToolUse(같은 tool_name, 키 순서 무관 같은 tool_input). Code Mode(REPL 안 Bash)는 안쪽 `repl_…` id로 짝지어지고, transcript 행이 없으면 독립 카드 → PostToolUse의 출력으로 완료 표시(실측).
  - 답: allow → `{behavior:"allow"}`, 거절 → `{behavior:"deny", message, interrupt}`(코멘트가 있으면 interrupt=false로 계속, 없으면 터미널의 No처럼 멈춤). 옵션은 allow_once/reject_once만.
  - 해제(카드가 고아로 남지 않게): PostToolUse(실행됨), transcript의 tool_result(끝난 행), hc 상태가 blocked를 벗어남(그 시점까지의 요청), Stop/SessionEnd, 훅 연결 끊김(Claude 타임아웃·omp가 자기 대화상자로 답함), 터미널 종료, 600초. 실측: 터미널에서 Enter로 답한 요청의 카드가 닫힘. 사용자 설정(Code Mode, autoMode, 사용자 훅)을 그대로 둔 실행에서는 대화상자가 1.6~29초 뒤 Gajae 밖에서 승인됐고 카드도 그때 닫혔다(원인은 사용자 설정으로 추정, `--setting-sources project,local` 실행에서는 재현 안 됨).
  - 명령 규칙: Bash(omp bash)의 command에 `matchCommandRule`(GJC와 같은 CommandRuleStore) 먼저 → 일치하면 카드 없이 즉시 답하고 autoDecision 표시. 카드의 "앞부분 항상 허용/거부"는 규칙 저장 후 답(저장 실패해도 답은 감).
  - capabilities.approvals: 카탈로그 상한 && (이 앱이 훅과 함께 띄움[Claude ≥ 2.1.331, omp ≥ 19.1.1] 또는 PreToolUse/PermissionRequest 훅이 들어옴, omp는 재시작 뒤 argv의 `-e <확장>`) && 훅 채널이 듣는 중.
  - omp: Ovis extension.ts/omp.ts 방식 `-e <omp-approvals.js>`. omp 19.1.1의 `tool_approval_requested`(call id)와 `tool_call`(입력)로 요청을 만들고 `ui.approve`를 감싸 omp 대화상자와 경주. **19.1.1에서 동작 실측**(카드 승인 → 실행). omp에 승인을 묻게 하려면 승인 모드가 필요해 launch 옵션 `permissionMode` → `--approval-mode`(always-ask 등)를 추가. 사용자의 omp 기본(yolo)은 아무것도 묻지 않는다.
  - 행 id의 call id 부분은 id 검사(`[A-Za-z0-9._:-]`)에 맞게 정규화(omp의 `call_…|fc_…` → `_`).

### 5.7 메인 라우터 / 원격
- `registerGjcIpcHandlers(controller: GjcSdkController)` → 핵심 `AgentHost` 인터페이스 + 선택 facet.
- RemoteAccess의 host를 라우터로 교체하되:
  - **agentKind `shell`은 원격 목록·조작에서 서버 쪽 제외**(폰에서 임의 명령 실행 방지).
  - `resolveToolCall(toolId)`에 sessionId가 없으므로 toolId에 네임스페이스(`<sessionId>/<id>`) 부여.
    - **P4 구현**: herdr 행 id는 이미 `<sessionId>:<call id>`(P3)라 `:`를 구분자로 씀(`/`는 IPC·원격 id 검사 `[A-Za-z0-9._:-]`가 거부). 라우터 `sessionOfTool`이 접두어로 소유 런타임을 찾고(목록에 없으면 런타임에 물음), 없으면 GJC로(기존 id 그대로 → 구버전 PWA도 같은 경로). 원격 `resolve-tool-call`은 도구 id의 세션이 원격 숨김(shell)이면 거부. 폰(터미널 없음)에서는 에이전트 세션을 채팅만으로 보여 줌.
- GJC 전용 기능은 herdr 세션에서 `unsupported` 타입 오류 + UI 숨김.
- (P5) **원격 와이어 이름**: 데스크톱 행은 `runtime: "herdr"`지만 원격 기기로 나가는 행(`state`의 `sessions`, `session.created/updated` 이벤트)은 `toRemoteSession`/`toRemoteEvent`로 옛 이름 `"terminal"`을 유지한다. P5 이전 PWA는 `runtime === "terminal"`로만 터미널 세션을 알아보므로, 바꾸면 Claude Code 세션을 GJC 대화로 연다. 새 PWA는 두 이름을 모두 읽으므로(`runsInTerminal`) 프로토콜 버전은 1 그대로.

### 5.8 온보딩 / 설정 (P5)
- 설치된 에이전트 감지 결과로 기본 에이전트 선택. GJC 설치/로그인은 GJC 카드 안 선택 동작.
- 환경 점검 `gjc|provider-login|model-preset`은 GJC 선택 시에만 필수.
- **P5 구현**
  - **첫 실행**: 온보딩 첫 단계는 `"agent"`(`OnboardingStep = "agent" | "install" | "sign-in"`). 감지 목록(설치 여부·버전·사유)에서 Claude Code → omp → codex → GJC 중 처음 설치된 것을 미리 고른다. 설치 안 된 에이전트는 고를 수 없고 GJC만 예외(고르면 설치 단계로). `chooseAgent`가 `newSession = {agentKind, surface: 카탈로그 defaultSurface}`를 저장하고, GJC가 아니면 온보딩을 끝낸 뒤 새 세션 창을 연다. GJC면 기존 설치/로그인 단계로 이어진다. 이미 온보딩을 마친 사용자(`onboarded`)는 다시 묻지 않는다.
  - **새 세션 창**: 에이전트 목록(터미널 브리지 `listAgents`, 설치 안 된 것은 사유와 함께 비활성)에서 고른다. 시작 에이전트는 마지막 선택이 설치돼 있으면 그것, 아니면 위 순서의 첫 설치 에이전트(없으면 셸, 셸도 없으면 GJC). 두 화면이 있는 에이전트는 채팅/터미널 선택, Claude Code·omp는 권한 모드 선택(기본 `에이전트 설정 따름` = 플래그 없음). 실행 옵션 = 설정의 에이전트 기본값 + 창에서 고른 권한 모드. 창에서 만든 세션의 {agentKind, surface}가 다음 기본값이 된다. 넘겨받은 요청(빠른 입력·링크·CI 수정)은 항상 GJC로 열고 기본값을 바꾸지 않는다. 원격(브리지 없음)은 GJC만.
  - **설정**: 기본 탭을 `에이전트`로. 새 세션 기본값(자동 = 처음 설치된 에이전트), 백그라운드 터미널, 에이전트별 섹션(감지 경로·버전 또는 사유, 실행 파일 지정, 기본 모델·effort·권한 모드)을 둔다. 저장은 즉시(`setAgentPreferences`, `setNewSession`). GJC 섹션은 GJC 탭(실행 파일·모델 프로필·도구 승인·업데이트·AI 로그인·명령 규칙)으로 안내하고, 그 기능은 그대로 GJC 탭에 남는다. 감지기는 설정한 실행 파일을 모든 검색보다 먼저 쓰고, 실행할 수 없으면 `configured: true`와 사유를 보인다(GJC는 `GJC_BIN` → 설정).
  - **환경 점검**: 행의 `required`가 `true | false | "gjc"`. `"gjc"`(bun·gjc·provider-login)는 `newSession.agentKind === "gjc"`일 때만 필수. model-preset은 원래 선택 항목.
  - **실측**(`npm run desktop:onboarding-smoke -- --agent=claude`): GJC가 없는 Mac(빈 HOME, PATH에 gjc 없음)의 첫 실행에서 에이전트 선택에 Claude Code 2.1.331이 미리 선택됨 → 고르면 `newSession = {claude, terminal}` 저장, 온보딩 완료, GJC 미설치 그대로 → 새 세션 창이 Claude Code·터미널·`에이전트 설정 따름`으로 열림 → 환경 점검 ready(GJC 행은 선택 항목) → 세션 생성(`runtime: "herdr"`, agentKind claude) → 이 실행 전용 herdr-core에서 Claude Code 첫 화면("Welcome to Claude Code")이 그려짐 → 온보딩 다시 열리지 않음. 모델 호출 없음. 기본 모드(GJC 선택)는 기존 설치·로그인 경로를 그대로 지나고 새 세션 창이 GJC로 열림을 확인.
  - 스모크의 HOME은 `/tmp/goh-*`(짧은 경로): hc 소켓이 `~/.local/state/herdr-core` 아래라 TMPDIR 안의 HOME이면 소켓 경로 한도(103바이트)를 넘는다(첫 측정에서 "socket path … too long" 148바이트로 실패).

### 5.9 검색 / 병렬 실행 (P6)
- **검색**: `ProductivityService`의 원천은 원래 라우터라 herdr 세션도 목록에 있었다. P6에서 색인 대상을 `searchable(session)`으로 정했다: GJC 세션 전부와, 채팅 화면이 있는 터미널 에이전트(Claude Code·omp, 카탈로그 `surfaces`에 chat). 셸·codex는 읽지 않는다. 터미널 에이전트의 기록은 창이 따라가는 동안만 `transcript.*` 이벤트가 나오므로(§5.5), 검색은 답하기 전에(1초에 한 번) 각 세션의 `getTranscriptRevision`을 색인 때 값과 비교해 바뀐 세션만 다시 읽는다. `transcript.invalidated`(행이 사라지거나 다른 파일로 옮김)도 색인 무효화 이벤트에 넣었다. 검색 결과를 고르면 터미널 에이전트 세션은 채팅 화면으로 열린다. 한계: 기록 파일이 크면 따라가기가 끝부분부터 읽으므로(`initialBytes`) 그 앞 내용은 색인되지 않는다.
- **병렬 실행**: `ParallelStartInput`·`ParallelGroup`에 `agentKind`(없으면 GJC, P6 이전 기록 그대로). `parallelAgentSupport`가 에이전트별 가능 여부와 사유를 정한다: 셸("셸은 병렬 실행에 쓸 수 없습니다"), codex(채팅 입력을 받지 않음), 미설치(감지 사유). `parallel.agents()` 브리지로 그 목록을 준다. 시도의 preset은 터미널 에이전트에선 모델(`default` = 에이전트 기본값), `launch`는 권한 모드·effort.
  - worktree: GJC는 SDK가 만들지만 터미널 에이전트는 Gajae가 같은 규칙(`<repo>.gajae-worktrees/best-of-<id>-<n>`, `git worktree add -b`)으로 만들고 그 폴더를 cwd로 세션을 연다. 세션 생성이 실패하면 방금 만든 worktree·브랜치를 지운다. 정리(cleanup)는 기존 그대로 `git worktree list`에서 브랜치로 찾으므로 위치와 무관하다. 정리 시 herdr 세션은 `hideSession`이 터미널을 끝내고 세션을 지운다(확인 문구도 그렇게 바꿈).
  - 전송: `HerdrAgentController.sendWhenReady` — 창이 없어도 터미널을 띄우고(`startTerminal` = `HcSessionTerminals.open` 후 바로 detach), 에이전트가 프롬프트에 있을 때(상태 idle + hc가 입력 가능) `terminal.send` 한 번. 대화상자(새 worktree의 폴더 신뢰)는 사용자가 답할 일이라 자동으로 답하지 않고 최대 10분 기다린다. 거부(not_executed)는 아무것도 입력되지 않은 것이므로 다시 시도한다. 시간이 다 되면 무엇을 기다렸는지와 함께 시도를 실패로 둔다.
  - 비교 화면: 터미널 에이전트에는 `diff.list_files` 같은 질의가 없어 `workspaceDiff`가 worktree에서 `git diff HEAD`와 추적 안 된 파일을 읽는다(인덱스를 건드리지 않음). B1 이후 capabilities.git은 카탈로그 값이고, 터미널 화면의 변경 파일 패널이 같은 `workspaceDiff`를 읽는다.
  - **시작 UI는 없다**: 새 세션 창의 병렬 실행 시작 경로는 이 브랜치 이전 커밋 b9bd4e2에서 의도적으로 지워졌고(`docs/usage.md` "The new-session dialog no longer starts parallel runs"), P6에서 되살리지 않았다. 지원 불가 조합은 서비스가 사유와 함께 거부하고 `parallel.agents()`가 사유를 주므로, 시작 UI를 다시 만들면 그 값으로 비활성+사유를 표시하면 된다.
  - **실측**(`GAJAE_SMOKE_CLAUDE_ARGS="--setting-sources project,local" GAJAE_AGENT_SMOKE_PHASES=8 npm run desktop:hc-agent-smoke`): 임시 저장소에서 Claude Code(haiku) 시도 2개 → 각자 worktree·브랜치 생성, 창 없이 터미널 시작, 폴더 신뢰 대화상자를 터미널 키로 답한 뒤 요청이 한 번씩 입력되고 둘 다 "OK" 응답, 그룹은 comparing. 셸 지정은 "셸은 병렬 실행에 쓸 수 없습니다"로 거부. 같은 실행에서 전체 검색이 두 시도의 기록을 찾음(2/2). 모델 호출은 실행당 짧은 요청 2개(두 번 실행).
  - **터미널 화면의 변경 파일 패널(B1)**: 터미널 세션의 `git` capability는 카탈로그 값(Codex는 `git: true`로 올렸다)이고, `HerdrAgentController`가 `getGitStatus`와 stage/unstage/commit/push를 omp 채팅처럼 `gjc-sdk-git.ts`의 `GitScope`(세션 폴더 하나)로 돌린다. 쓰기는 `mutateGit` 규칙 그대로 managed worktree에서만이고, A2로 새 worktree에서 시작한 세션은 행에 `worktree`가 있어 허용된다. 폴더 그대로 시작한 세션과 Git 저장소가 아닌 폴더는 읽기만 되고 패널이 그렇게 안내한다. 화면: `TerminalSessionPane` 헤더에 브랜치와 변경 파일 버튼이 생기고, 패널(`DiffPanel`)은 같은 `.workspace-body` 안 터미널 옆에 열린다. 터미널은 그대로 두고 폭만 줄며 `TerminalView`의 ResizeObserver가 다시 맞추고 pty 크기를 한 번 알린다(패널을 열고 닫을 때 에이전트 TUI가 한 번 다시 그려진다). git 상태는 세션을 고를 때·턴이 끝날 때(`useTurnEnds`: 상태가 running/starting/waiting에서 벗어날 때)·창에 포커스가 돌아올 때만 읽고, 상태 전이마다 읽지 않는다(터미널 에이전트는 상태가 자주 바뀐다). 열린 패널은 같은 때에 diff와 git 상태를 다시 읽는다. 리뷰 코멘트는 터미널 입력으로 가며(`terminal.send`, 입력창의 보류·steer 규칙은 터미널에 없다), 에이전트가 대화상자에서 답을 기다려 `not_executed`가 오면 보내지 않은 것으로 알리고 코멘트를 그대로 둬 답한 뒤 다시 보낼 수 있다. 보내려면 `send` capability(에이전트가 상태를 보고하는 동안, Claude Code·omp)가 있어야 하므로 Codex 패널에는 보내기 버튼이 없다. 검증은 단위 테스트(컨트롤러 git 읽기·쓰기·거절, 훅의 읽기 시점, 패널의 전송 결과, 창 구성)이고 앱 화면은 확인하지 않았다.
- **P5 후속**: 사이드바 하단은 GJC가 연결되지 않았고 새 세션 기본값도 아니며 GJC 세션도 없으면 "GJC · 연결 중" 대신 "새 세션: <에이전트>"(자동이면 "설치된 첫 에이전트")를 보이고 연결 점을 숨긴다(`desktop:onboarding-smoke -- --agent=claude`가 GJC 없는 첫 실행 뒤 "새 세션: Claude Code"를 실측). 에이전트 버전 확인은 실행 파일의 폴더 → 로그인 셸 PATH → 앱 PATH 순 PATH로 실행한다(`versionSearchPath`; `#!/usr/bin/env node`인 codex가 Finder 실행 앱에서도 감지되게). `desktop:deep-link-smoke`는 대화상자에 요청이 보이지 않는 현재 UI에 맞춰, 만든 세션의 입력창에 요청이 남아 있는지로 확인한다.

## 6. 이식 원칙과 규모
- 출처 표기: Ovis(MIT, © 2026 devswha), herdr-core(Apache-2.0, 바이너리 번들). `THIRD_PARTY_NOTICES.md` 갱신, 이식 파일 상단에 출처 주석.
- Bun API 치환: `Bun.spawn`→`child_process`, `Bun.connect`→`net`, `Bun.gunzipSync`→`zlib`, web ReadableStream → `Readable.toWeb` 어댑터.
- 함께 이식: `hc-api.generated.ts` + 생성 스크립트.

| 대상 | 방식 | 예상 |
|---|---|---|
| hc 연결/attach | 이식 | ~1.5k |
| 수명주기 | `children.ts` 일부 이식, `discovery.ts`는 `hcVersion`만 | ~0.6k |
| 상태 | `core-model.ts:127-170` 분기만 재작성 | ~0.3k |
| 기록 파서 | 2개 파일 이식 + 스텁 | ~2.5k |
| 기록 위치 | 재작성 | ~0.3k |
| 훅/승인 | hub·claude·extension·omp 재구성 + 셸 릴레이 | ~1k |

## 7. 단계 (각 단계 끝: lint/test/build + 관련 smoke)

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| P0 | 브랜치, `AgentHost`+`AgentRouter`(GJC만 위임), 타입 **추가만**, 카탈로그 골격 | 동작 변화 없음, 기존 테스트 통과 |
| **P0.5 스파이크** (버리는 코드, **완료** → [spike-results.md](spike-results.md)) | ① 패키지 빌드에서 hc 시작→앱 종료→재접속, FD/env 확인(lsof, ps -E) ② launchd/TCC·백그라운드 항목 알림(ad-hoc·공증 서명 양쪽) ③ `--session-id`+훅으로 `transcript_path` 수신, 앱 재시작 후에도 ④ 셸 릴레이 동작 ⑤ hc 아래 Claude Code의 7501 보고와 승인 대화상자 중 send 거부 ⑥ hc 버전(0.1.17 vs 0.1.18) 확정 | 각 항목 결과 기록, 설계 확정 |
| P1 | hc 수명주기 + 셸 터미널(detach/kill/restart, 고아 정리, node-pty 폴백) | 앱 재시작 후 셸 터미널과 출력 유지 (**완료**: `npm run desktop:hc-terminal-smoke`가 앱 재시작 뒤 같은 pid·출력 유지를 실측) |
| P2 | 에이전트 실행 + 훅 채널(세션·턴 보고) + 상태·알림 | Claude Code 세션 상태 표시, 완료 알림 (**완료**: `npm run desktop:hc-agent-smoke`가 실제 Claude Code로 사이드바 waiting→running→idle, 승인·완료 알림 요청, 앱 재시작 뒤 훅 수신을 실측. 단 개발 Electron은 macOS 알림 권한이 없어 배너 표시는 거부됨) |
| P3a/b/c | a 읽기 전용 채팅(claude) → b 채팅 입력(`terminal.send`) → c omp | 채팅/터미널 전환, 채팅 입력이 터미널에 반영 (**완료**: `GAJAE_AGENT_SMOKE_PHASES=3,4 npm run desktop:hc-agent-smoke`가 실제 Claude Code(haiku)와 omp(작은 모델)로 창에서 세션을 열고 채팅으로 전환해 보낸 메시지가 터미널 화면에 나타나고 답이 채팅에 나타남을, 전환 뒤에도 같은 id임을 실측. 2단계는 재시작 뒤 같은 기록과 `/clear` 뒤 새 기록 추종을 실측) |
| P4 | 승인(claude → omp) + 규칙 + 원격 노출 정책 | 폰에서 Claude Code 도구 승인 (**완료**: `GAJAE_SMOKE_CLAUDE_ARGS="--setting-sources project,local" GAJAE_AGENT_SMOKE_PHASES=5,6 npm run desktop:hc-agent-smoke`가 실제 Claude Code(haiku, `--permission-mode default`)로 창의 카드 승인, 앱 재시작 뒤 원격 프로토콜(페어링한 기기 HTTP)로 카드 확인·승인, 터미널에서 답한 요청의 카드 해제를 실측. `GAJAE_AGENT_SMOKE_PHASES=7`은 omp 19.1.1 승인을 실측) |
| P5 | 온보딩/설정 일반화, 타입 정리, node-pty 결정, 문서 | GJC 미설치 첫 실행 → Claude Code 세션까지 (**완료**: `npm run desktop:onboarding-smoke -- --agent=claude`가 GJC 없는 첫 실행 → 에이전트 선택 → Claude Code 세션 생성과 그 터미널의 첫 화면까지 실측(§5.8). node-pty는 유지(§5.2). 공증 빌드에서 Herdr Core.app 서명 보존(§5.1)은 공증 자격이 없어 확인하지 못함) |
| P6 | 검색 색인·병렬 실행의 herdr 세션 지원 | herdr 기록 검색, 병렬 Claude Code 세션 2개 이상 생성·전송 (**완료**: `GAJAE_AGENT_SMOKE_PHASES=8 npm run desktop:hc-agent-smoke`가 Claude Code 시도 2개의 worktree·세션 생성, 요청 전송·응답, 전체 검색이 두 기록을 찾음을 실측(§5.9). deep-link-smoke 포함 기존 smoke 통과) |

## 8. 위험 / 미확인 가정
1. hc 0.1.x 변동. 버전 불일치는 0.1.18 채택으로 해소. 0.1.19~0.1.22가 이미 나와 있어 업그레이드는 hello `methods/features` 판정으로 대비.
2. TCC 권한 주체(미확인), 공증 빌드에서 Herdr Core.app 서명 보존(미확인). 확인됨: ad-hoc `codesign --deep`은 Resources 안 hc를 재서명하지 않음, 백그라운드 항목 등록 로그 없음.
3. Claude Code: `session_id`/`transcript_path`/`--session-id`는 확인(2.1.331). PermissionRequest에 tool_use_id 없음 → PreToolUse로 짝짓기. 최소 지원 버전은 미측정.
4. (해소) 0.1.17·0.1.18 모두 `terminal.send`의 `if`/`force`, labels 필터, `terminal.interrupt` 있음.
5. 앱 밖 데몬·고아 터미널, dev/smoke가 실사용 코어를 건드리는 문제(세션명 분리로 대응, 스파이크에서 `HC_SESSION`별 상태·소켓 분리 확인).
8. 코어 env 오염: 코어를 처음 띄운 클라이언트 env가 모든 터미널로 감 → 허용 목록 필수, 오염 시 `server.restart`(§5.1).
6. 원격에서 shell 세션 노출(서버 쪽 차단으로 대응), 구버전 PWA(P5: 와이어의 runtime 이름을 `"terminal"`로 유지, §5.7).
7. TerminalView가 디스플레이 질의에 응답하는지.

## 9. 최종 요약 (P6 이후)
P0~P6 완료. Gajae는 GJC 전용에서 Claude Code·omp·codex·GJC·셸을 고르는 범용 에이전트 셸이 됐다: 터미널은 herdr-core에서 앱 재시작을 넘어 유지되고, Claude Code·omp는 상태·알림·도구 승인(창·폰)·전체 검색·병렬 실행까지 된다. 창에서 Claude Code·codex는 터미널만(2dd1f3b), omp는 "터미널"(herdr 터미널)과 "채팅"(§10의 RPC 채팅, 별도 런타임) 중 고른다. 기존 omp 터미널 세션의 기록 채팅은 폰·검색용으로 남았다.

**남은 한계**
- 병렬 실행 시작 UI 없음(b9bd4e2에서 제거된 상태 유지, 브리지로만 시작). 터미널 에이전트 시도는 새 worktree의 폴더 신뢰 대화상자를 사용자가 답해야 요청이 들어간다(자동 응답 안 함).
- codex: 기록 파서가 없어 채팅 화면·검색·병렬 실행·승인 없음. 터미널과 상태(hc가 보고하는 만큼)만.
- 검색은 기록 파일의 따라가기 범위(끝부분 `initialBytes`)만 색인. Inbox·모델 설정·목표·사이드 채팅 등은 GJC 전용.
- 터미널 에이전트 세션의 변경 파일 패널(B1, §5.9 끝)은 터미널 화면에만 있다. 터미널에 닿지 않는 기기(폰)의 채팅 화면에는 변경 파일 버튼이 없다.
- node-pty는 유지(채팅 화면 임시 셸, hc 실패 시 셸 폴백, GJC CLI 세션 삭제).
- omp RPC 채팅의 한계는 §10 끝에 따로 적었다(프로세스 수, 거절 사유 미전달, 승인 범위, 폼 판독 범위, 터미널 전환 없음).
- macOS 외 플랫폼은 hc가 없어 셸만 앱 안 셸로 폴백하고 에이전트 세션은 오류.

**미확인**
- 공증(notarized) 빌드에서 Herdr Core.app 서명 보존, TCC 권한 주체(§8-2).
- Claude Code 최소 지원 버전(2.1.331로만 측정), omp는 19.1.1로만 측정. hc 0.1.19 이상으로의 실제 업그레이드 경로(§5.1 설계만, 0.1.18→0.1.19 한 번 측정).
- TerminalView의 디스플레이 질의(OSC 10/11/12, CSI 16t) 응답은 이식했지만 별도 실측 기록이 없다(§8-7).
- omp의 병렬 실행·검색은 단위 테스트로만 확인(실측은 Claude Code). 개발 Electron은 macOS 알림 권한이 없어 배너 표시는 실측하지 못함.
- 구버전 PWA 호환은 와이어 이름 유지로 대응했지만 실제 구버전 PWA 기기로는 확인하지 않았다.

## 10. omp RPC 채팅

상태: P0 스파이크(2026-11-25, omp 19.1.1, 임시 cwd·`--session-dir`, 기본 모델 deepseek flash). 실측 프레임은 `electron/omp-rpc/fixtures/`(홈·임시 경로를 지우고 시스템 프롬프트·MCP 이름 등은 뺀 사본). 참고 소스는 npm의 `@oh-my-pi/pi-coding-agent` **19.1.1**(`src/modes/rpc/`, `src/tools/approval.ts`)이다. 처음 본 18.20 소스와 다른 점: `form` UI 요청과 `{data}` 응답이 19.1.1 타입에 정식으로 있고(`ui.formDialog`, opt-in 불필요), `get_model_picker`(가벼운 모델 목록), `set_model`의 `thinkingLevel`/`role`, `set_thinking_level`의 `auto`, `get_state`의 `configuredThinkingLevel`·`thinkingLevels`, `abort_and_deliver_queue`·`resume` 명령이 늘었다. RPC 승인은 19.1.1에서도 `ui.approve`가 없어 `select`로 온다(라벨: grant들, "Approve"/"Approve Once", "Approve <tool> for this session", "Deny").

**결정**
- omp의 "채팅"은 터미널 기록 판독기가 아니라 `omp --mode rpc-ui` 프로세스를 쓰는 새 런타임 `runtime: "omp-rpc"`(`agentKind: "omp"`)이다. herdr 컨트롤러에 섞지 않는다. 기존 omp 터미널 세션의 기록 채팅(폰·검색이 씀)은 그대로 둔다. v1에서 한 세션을 터미널↔RPC로 바꾸지 않는다.
- **`--mode rpc`가 아니라 `--mode rpc-ui`**(설계안 변경): `rpc`는 `hasUI=false`라 ask 도구가 아예 없다(실측: 모델이 "ask 도구가 없다"고 답함, omp main.ts `options.hasUI = isInteractive || mode === "rpc-ui"`). `rpc-ui`에서만 ask가 생기고 그 UI가 프로토콜로 온다. 승인은 두 모드 모두 같다. `rpc-ui`는 bash를 pty 없이 돌린다(`PI_NO_PTY=1`).
- 프로세스는 세션당 하나, 열거나 보낼 때 띄우고 앱과 함께 끝난다. 다시 열면 `--resume <sessionFile>`.
- 승인 모드: 창에서 고른 값, 없으면 `always-ask`(omp 기본은 사용자 설정, 이 Mac은 yolo라 카드가 뜨지 않는다).

**실측 (P0)**
1. 시작: 0.2~0.6초에 `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,…}`. 첫 메시지 전에도 `get_state`가 `sessionFile`·`sessionId`를 준다(파일은 첫 메시지 때 생김, 옆에 `.<이름>.jsonl.lock.os`). `get_state`는 시스템 프롬프트 때문에 ~50KB, `get_available_models`는 ~345KB, `available_commands_update`는 ~38KB.
2. 스트림(`set_event_filter {events:null, messageUpdates:"delta"}`): 사용자 메시지도 `message_start/end`(role user, `messageId: "msg-N"`)로 온다. assistant의 `message_start` content는 이미 델타보다 앞서 있다(`"OK"`가 든 message_start 뒤에 text_start·text_delta "OK"가 같은 ms에 옴) → message_start 본문은 버리고 `*_start`/`*_delta`로 쌓은 뒤 `text_end`·`thinking_end`(전체 `content`)와 `message_end`(전체 메시지)를 권위로 쓴다. `toolcall_end`는 `toolCall{id,name,arguments}` 전체. 턴은 `turn_start/turn_end`, 작업 끝은 `agent_end` → `prompt_result{id,status,agentInvoked,sessionSettled}` → `session_settled`.
3. 사용자 설정이 그대로 적용된다: 이 Mac의 prewalk가 첫 답 뒤 custom 메시지(`prewalk-plan`)를 넣어 두 번째 턴을 시작했고, `prompt_result`는 그 뒤 한 번만 온다. 앱은 사용자 설정을 건드리지 않는다(스파이크만 `--no-prewalk --thinking low`).
4. 승인(`--approval-mode always-ask`): `extension_ui_request` method `select`, `title: "Allow tool: bash\nCommand: echo gajae-a"`, `options: ["Approve","Approve bash for this session","Deny"]`, 호출 id 없음. 병렬 호출 둘: `tool_execution_start`(A)·(B) → `select`(A)·(B) 순서, `{value:"Approve"}`로 답하면 `tool_execution_update/end`. 세션 파일에는 `tool_approval_requested` custom 엔트리(호출 id 포함)가 남지만 RPC 프레임으로는 나오지 않는다. todo 같은 읽기 도구는 묻지 않는다.
5. 질문: 19.1.1의 ask는 HTML 폼이다 — `extension_ui_request` method **`form`** `{html:"<form><fieldset><legend>Pick a color</legend><label><input type=radio name=color value=Red> Red</label>…"}`, 답은 `{data:{color:"Red"}}`(단일 선택은 value 문자열, checkbox·multiple은 배열, 텍스트는 문자열, 취소는 `{cancelled:true}`). 도구 결과는 `User answers: {"color":"Red"}`. form 요청은 ask의 `tool_execution_start`보다 먼저 오고 html은 직전 `toolcall_end`의 `arguments.html`과 같다. 18.20의 method `ask`(`set_ask_dialog`)는 확장의 `ui.askDialog`용으로 남아 있다(명령은 받음).
6. 취소: `abort` → `message_end`(stopReason aborted) → `agent_end` → abort 응답 → `prompt_result{status:"aborted"}`.
7. 클라이언트가 끊기면 대기 중 UI 요청에 `cancel` 프레임이 오고 도구 결과는 "RPC client disconnected before extension UI response completed", 세션 파일에 `session_exit`.
8. `--resume <file>`: 같은 `sessionFile`·`sessionId`·`messageCount`. `get_messages`에는 엔트리 id가 없다 → 기록과 행 id는 파일 판독기(`omp-transcript.ts`)가 맡는다. 실시간 `messageId`(msg-N)는 프로세스 안에서만 유일하고 파일 엔트리 id와 다르다. 도구 호출 id는 양쪽이 같다.
9. `rpc_chunk`: `negotiate_protocol 2` 뒤 1MiB 넘는 프레임(합성한 큰 세션의 `get_messages`, 1.4MB)이 `{type:"rpc_chunk",chunkId:"rpc-1",index,count:6,byteLength,data:<base64 256KiB>}` 여섯 줄로 왔다. v1에서는 큰 프레임의 문자열이 잘린다.
10. 그 밖의 프레임: `notice{level,message,source}`(MCP 도구 추가 등 info), `advisor_cost_changed`, `setWidget`(autoresearch), `queue_update`.

**승인 짝짓기 결정**: select 제목을 "실행 중(`tool_execution_start` 뒤·end 전)이고 아직 짝이 없는 호출"과 내용으로 맞춘다. 첫 줄 `Allow tool: <이름>`이 같은 호출 중 인자의 문자열 값(command, path …) 첫 줄이 모두 제목에 들어 있는 것을, 그중 먼저 시작한 것을 고른다. 없으면 같은 이름의 가장 오래된 호출, 그래도 없으면 독립 카드. 병렬 2개 실측에서 정확히 짝지어졌다. 같은 이름·같은 인자의 병렬 호출은 구분할 수 없지만 카드 내용이 같아 결과도 같다. 확장(`-e`) 방식은 쓰지 않는다: 기존 omp 확장은 TUI에서만 `ui.approve`를 감싸고(`ctx.mode !== "tui"`면 손대지 않음), RPC 프레임에는 `tool_approval_requested`가 없어 확장이 호출 id를 넘기려면 `setStatus` 같은 우회 통로가 또 필요하다. 카드 id는 `<sessionId>:<callIdPart(callId)>` — 파일 판독기의 도구 행 id와 같아 턴이 끝나 파일로 다시 맞춰도 카드 자리가 유지된다.

**구현 (P1~P5)**
- 런타임: `electron/omp-rpc/` — `rpc-client.ts`(JSONL, `rpc_chunk` 재조립, id 대응, ready 대기, 종료 시 대기 중인 것 모두 거절), `session-store.ts`(`omp-rpc-sessions.json`, 0600, `{id: "omp-<uuid>", workspace, title, sessionFile, ompSessionId, launch}`), `live-rows.ts`(RPC 이벤트 → `TranscriptItem`·`AgentEvent`), `ui-requests.ts`(승인 짝짓기·HTML 폼 판독), `controller.ts`. `main.ts`가 `registerRuntime("omp-rpc")`로 라우터에 붙이고, 카탈로그의 omp에 `chatRuntime: "omp-rpc"`·`chatCapabilities`(goal·fork·git 제외)를 뒀다. 새 세션 창에서 omp "채팅"을 고르면 `CreateSessionInput.runtime = "omp-rpc"`(`sessionRuntimeFor`), 저장된 `newSession {omp, chat}`은 그대로 쓴다. `runsInTerminal`은 omp-rpc 행을 터미널로 보지 않는다(셸·사이드바·검색이 이 기준).
- 실행: 세션당 프로세스 하나, 창이 세션을 열 때(`refreshSessionContext`)나 보낼 때 띄운다: `omp --mode rpc-ui --cwd <ws> [--resume <sessionFile>] --approval-mode=<창의 선택 | always-ask> [--model=…]`. 환경은 herdr 코어와 같은 허용 목록 + 로그인 셸 PATH(`agentEnvironment`), Chromium FD는 `withoutInherited`로 닫는다. ready 뒤 `negotiate_protocol 2` → `set_event_filter {messageUpdates:"delta"}` → `set_ask_dialog` → `get_state`(sessionFile 저장). 앱 종료(`dispose`)에 stdin을 닫아 omp를 끝낸다.
- 화면: 렌더러는 새 백엔드 없이 GJC 채팅 경로(Composer·QuestionBanner·ApprovalBanner·스트림 합치기)를 그대로 쓴다. omp-rpc 행은 화면 전환·세션 정보·변경 파일 버튼이 없고(헤더 `agentIcon="chat"`), goal·subagent·git 조회와 목표 줄은 `capabilitiesOf`로 막았다. 명령 목록은 omp 것만(GJC 번들 명령 제외), 입력창의 작업 폴더 전환과 `/new`는 omp 채팅을 새로 만든다.
- 이벤트: `text_delta`→`message.delta`, `thinking_delta`→`thought.delta`, `toolcall_*`·`tool_execution_*`(부분 출력 포함)→`tool.updated`, `message_end`→`message.updated`, `available_commands_update`→`session.commands`(`btw` 추가: 목록엔 없지만 RPC가 답함), `get_state`·`model_changed`·`thinking_level_changed`→`session.config`(모델: `get_model_picker` 100개, 생각: `thinkingLevels`)·`session.updated`(model·thinking·컨텍스트 %), 압축 시작/끝→행 `phase: "compacting"`, `auto_retry_*`→행 `retry`, `notice`의 warning/error→알림 행.
- 턴 끝(`prompt_result`): 세션 파일을 다시 읽어 실시간 행(`<session>:live:msg-N…`)을 파일 행(엔트리 id)으로 바꾸고 `transcript.synced`로 꼬리를 보낸다(둘이 공유하는 마지막 행부터, 없으면 전체). 파일이 아직 안 늘었으면 150ms~3s 간격으로 다시 읽는다. 도구 행은 양쪽 id가 같아 그대로다. 앱이 띄운 알림 행·열린 카드만 남긴다.
- 승인(P3): 위 짝짓기로 도구 행에 카드를 올리고(`approval-required` + allow_once/reject_once), 답은 omp의 옵션 라벨("Approve"/"Approve Once", "Deny")로 보낸다. 짝이 없으면 `<session>:ui:approval-<요청 id>` 독립 카드. bash는 `commandRules`가 먼저 답하고(autoDecision), 카드의 "앞부분 항상 허용/거부"는 규칙 저장 뒤 답한다. omp가 `cancel`을 보내거나 턴이 끝나거나 프로세스가 죽으면 카드를 닫는다. 대기 중 상태는 waiting + `session.activity: permission`.
- 질문(P3): `form`은 필드마다 질문 카드(라디오·체크박스·select·textarea·텍스트 입력, 라벨/legend/앞 문장을 질문으로), 모든 카드에 답이 모이면 `{data}` 한 번. `ask`(질문 배열)·`select`(승인 아닌 것)·`confirm`(예/아니요)·`input`/`editor`도 같은 카드, `notify`는 알림 행, `setStatus`·`setWidget` 등은 무시. 형식에 안 맞는 답(select에 직접 입력 등)은 카드에 이유를 띄우고 다시 받는다.
- P4: `set_model`(provider/나머지 id)·`set_thinking_level`·`cycle_thinking_level`, `compact`, 실행 중 `/steer`·`/queue`와 `steerSession`·`queueFollowUp`(`steer`/`follow_up`), `listQueuedMessages`(`queue_update`), `flushQueuedNow`(`abort_and_deliver_queue`), 첨부(그림은 prompt.images, 다른 파일은 경로를 본문에), `/btw`(`btw` → `btw_record` 완료까지), `controlRetry("abort")`(`abort_retry`).
- 모델 선택기(P4 후속): 입력창의 모델 칩이 omp 채팅에서는 새 카탈로그 선택기(`model-catalog-picker.tsx`)를 연다 — 검색, 범위(역할) 드롭다운, "맞는 수 / 전체", esc, "최근"(omp 피커의 recent 블록)과 "모든 모델/검색 결과", 행마다 provider 표식·모델 id·무료 배지·역할 태그(색 점)·Int·t/s·Ctx·$/M 열·사용 중 체크, ↑↓ Enter. 데이터는 `get_model_picker`(순서·최근·역할, limit 1000)와 `get_available_models`(`int` 131/286, `tps` 33/286, `contextWindow`, `cost`)를 합친 것이고, 채우는 모델이 없는 열은 숨긴다. RPC의 `set_model`은 역할을 저장하지 않고(`persist` 없음) 이 세션의 모델만 바꾸므로 범위는 "메인"만 고를 수 있고 다른 역할은 지금 쥔 모델과 함께 비활성으로 보인다. GJC 채팅도 같은 선택기를 쓴다(이전 `.config-option-menu--model` 메뉴와 `ModelPicker`는 지움): GJC의 데이터는 프로필(`models.profiles.list`, 그룹·설명)과 구체 모델(`models.list/current`, provider/id·이름)뿐이라 수치 열과 범위는 나오지 않고, 섹션은 "사용 중·즐겨찾기"(이전 메뉴의 별표 즐겨찾기, 같은 localStorage 키) → 프로필 그룹(Built-in/Custom) → "모델". 검색 아래 줄에 사고 수준(선택해도 메뉴가 열려 있음)과 GJC의 Fast on/off(`/fast`)를 둔다. omp 쪽 선택기에도 사고 수준 줄이 생겼고, omp의 빠른 모드는 컨텍스트 막대의 "실행 모드"에 있다. `models.list/current`가 contextWindow·cost를 주는지는 실행 중인 GJC 세션이 없어 확인하지 못했다(`gjc --list-models`는 context를 보여 주지만 앱 경로에는 아직 연결 안 함).
- P5: 앱을 다시 켜면 목록은 저장소에서, 기록은 파일에서 읽고(프로세스 없이), 열 때 `--resume`으로 omp를 띄운다. 전체 검색은 omp 채팅도 `getTranscriptRevision`으로 파일 증가를 확인한다(`followsTranscriptFile`). 원격: 와이어 이름은 `omp-rpc` 그대로다. 구버전 PWA의 `runsInTerminal`은 GJC 아닌 에이전트를 모두 터미널로 보므로, 폰에서는 omp의 채팅(보내기·중지·카드)으로 열린다 — `gjc`로 바꿔도 그 PWA에는 차이가 없고(agentKind가 omp), 새 PWA에는 GJC 기능을 열게 된다. 단위 테스트로 확인(`shared/remote-protocol.test.ts`), 실제 구버전 기기로는 확인하지 않았다. 삭제는 목록에서 지우고 omp를 끝내되 omp의 세션 파일은 남긴다(터미널에서 이어 갈 수 있음, 확인 문구도 그렇게).
- 실측(`npm run desktop:omp-rpc-smoke`, omp 19.1.1·기본 모델, `GAJAE_SMOKE_OMP_ARGS=--no-prewalk`): 9단계 — 채팅 만들기 → 창에서 열기(GJC Composer, 화면 전환 없음) → "OK" 응답이 `message.delta`로 스트리밍되어 0.5초에 표시 → bash `echo` 요청에 창의 카드가 뜨고 상태 waiting → 카드 승인 → 실행·출력 → "DONE" → 행 id가 모두 파일 id(`:live:` 남지 않음). 10단계(앱 재시작) — 같은 행이 목록에 있고, 열면 같은 id 5개로 다시 읽히고, omp가 세션 파일로 다시 떠 모델이 행에 돌아옴. 같은 스모크에서 앱 시작 직후 처음 받은 세션 목록이 사용자의 선택을 지우던 버그(`use-session-sync` 초기 목록이 늦게 오면 선택이 null)를 찾아 고쳤다.
- `hc-agent-smoke` 3단계(Claude Code 채팅)는 Claude Code의 채팅 화면이 없어져 뺐다(4단계가 omp 기록 채팅).

**P6 (omp 채팅 화면 보강, Tern에서 기능만 가져옴)**
- 도구 카드: 결과 details의 `wallTimeMs`(bash, P0 실측 29.97ms), 없으면 `tool_execution_start`~`end` 시간을 `ToolActivity.durationMs`로 두고 카드 끝에 "완료 · 0.03s". 출력 꼬리는 기존 카드 미리보기. edit는 결과 details의 `diff`·`path`(19.1.1 edit/index.ts)를 `diff`·`targetPath`로 넘겨 기존 DiffView가 그리고, 12줄이 넘는 diff는 "N줄 더 · 모두 보기"로 접는다(GJC 카드에도 같은 접기). 파일 판독기(`omp-transcript.ts`)도 같은 details를 읽으므로 턴이 파일로 바뀐 뒤와 omp 터미널 세션의 기록 채팅에도 남는다.
- 생각: `thinking_start`~`thinking_end` 시간을 `ThoughtActivity.durationMs`로 두고 접힌 카드에 "N초 생각함". 턴이 파일 행으로 바뀌면 같은 턴의 새 생각 행에 순서대로 옮긴다(메모리에만 — 파일에 블록별 시간이 없어 앱을 다시 켜면 "추론"으로 돌아감).
- 상태 줄(입력창 위, `AgentSession.liveStatus`): 턴 경과 시간(1초마다), 지금 하는 일(실행 중 도구 "이름 · 설명", 없으면 "생각하는 중"/"답을 쓰는 중"), 할 일 진행 "완료/전체"(`get_state.todoPhases`, todo 도구가 끝나면 다시 읽음; 누르면 체크리스트 팝오버), 컨텍스트 %(`get_state.contextUsage`).
- 서브에이전트 패널(헤더 버튼): `set_subagent_subscription {level:"progress"}`, `subagent_lifecycle`/`subagent_progress` 프레임과 `get_subagents`로 실행 중·대기·완료·실패 목록과 작업·모델·비용·시간·도구 수·컨텍스트·최근 활동·기록 파일 경로. 진행 정보(`AgentProgress`)의 타입은 19.1.1 패키지 밖(pi-tui)에 있어, 바이너리의 서브에이전트 렌더러가 쓰는 이름(toolCount·contextTokens·contextWindow·cost·model)을 넓게 읽는다. 실제 서브에이전트 실행으로는 확인하지 않았다(단위 테스트만).
- 빠진 것: 백그라운드 작업 패널 — 19.1.1 RPC에는 작업 목록·이벤트·취소 명령이 없고 `get_state.hasPendingAsyncWork`(불린)뿐이다(rpc-types·wire/events·rpc-mode에 job 없음). Tern은 지원 폴더의 `daemon.state`가 `omp --resume <id>`를 PTY로 띄우는 것으로 보아 omp TUI 화면을 보여 주는 앱이라 RPC 근거가 되지 않는다. 서브에이전트 기록 "열기"는 앱에 파일 열기 브리지가 없어 경로만 보인다.

**컨텍스트 막대와 "컨텍스트" 대화상자**
- 19.1.1 RPC에는 컨텍스트를 카테고리별로 주는 명령이 없다(`get_state.contextUsage`·`get_session_stats.contextUsage`는 tokens/contextWindow/percent뿐). 대신 `prompt "/context"`를 RPC가 직접 처리한다: `executeAcpBuiltinSlashCommand` → `buildContextReportText`(slash-commands/helpers/context-report.ts)가 `command_output` 프레임 하나를 낸 뒤 `{agentInvoked:false}` 응답, `prompt_result` 없음, 모델 호출·세션 파일 기록 없음(실측: 세션 파일 바이트 그대로, 287ms). 카테고리는 pi-tui context-usage의 고정 6개(System prompt·System tools·System context·Instruction files·Skills·Messages)와 Auto-compact buffer·Free이며, 0인 카테고리는 줄이 빠진다. `electron/omp-rpc/context-report.ts`가 이 텍스트를 읽고(ANSI 막대 제거), 컨트롤러 `getContextBreakdown`이 `get_state`의 모델·`autoCompactionEnabled`를 붙인다. 자동 압축 시작점 = 창 − 버퍼(버퍼는 `min(창 − 임계값, 창 − 사용량)`이라 임계값을 넘으면 "지났습니다").
- 경로: `AgentExtrasFacet.getContextBreakdown`(GJC에는 없는 호출: 라우터가 런타임에 있으면 넘기고 없으면 unsupported) → IPC `getContextBreakdown` → `AgentBackend.getContextBreakdown?`. 화면은 새 capability `contextBreakdown`(omp 채팅만 true, GJC 기본값 false)으로 연다.
- 입력창 위 막대: 사용 %·막대·창 크기(`liveStatus.contextTokens/contextWindow`), 버튼 둘(카테고리별 보기, 지금 압축). 상태 줄의 "컨텍스트 x%"는 막대가 있을 때 숨긴다. Tern 스크린샷의 두 아이콘(점선 사각형, 망치)은 Tern UI가 Rust 바이너리+웹뷰라 코드로 확인하지 못했다. omp 19.1.1에서 망치 글리프(`cmd.hammer`)는 `/force`(다음 턴에 특정 도구 강제), 컨텍스트 아이콘은 `/context`에 쓰인다. 확인되지 않은 동작을 흉내 내지 않고 보기·압축 버튼으로 두었다.
- 빠진 것: 대화 메시지를 User/Assistant/Thinking/Tool calls/Tool output으로 나눈 값과 도구별 하위 행은 TUI 컨텍스트 뷰어(`buildSessionContextView`, session/context-view.ts)에만 있고 RPC로 나오지 않는다. Custom tools는 System tools에 합쳐져 있다.

**omp 채팅 추가 기능 (19.1.1 RPC 명령)**
- 목표 모드: `goal {op:get|create|pause|resume|drop, objective}` → `RpcGoalResult{goal, state}`(실측: create/pause/resume/drop 모두 모델 호출 없음, 세션 파일에 mode_change 기록). omp의 `/goal`은 TUI 전용이라 RPC로 보내면 모델에게 그냥 글로 간다 — 컨트롤러가 `/goal [set] <목표>`, `/goal pause|resume|drop|show`를 가로채 `goal` 명령으로 보내고 명령 목록에도 넣는다. GJC의 목표 행(GoalProgressRow)을 그대로 쓰되 `GoalSnapshot.operations`로 "완료"를 숨긴다(omp에는 complete op가 없고 goal 도구가 스스로 끝냄). 토큰 예산은 만들 때만 정할 수 있고(`token_budget`) `/goal budget`은 실행하지 않는다. `goal.continuationModes` 기본값이 `["interactive"]`라 RPC에서는 목표가 스스로 다음 턴을 시작하지 않는다(사용자가 보내는 턴이 목표를 향함). budget-limited 목표는 완료처럼(해제만) 보인다.
- 서브에이전트 제어: `cancel_subagent{subagentId}` → `{cancelled}`, `steer_subagent{subagentId, message}`(실행 중이 아니면 "Subagent not running" 오류), `get_subagent_messages{subagentId}` → `{sessionFile, fromByte, nextByte, reset, entries, messages}`. 서브에이전트 패널에서 실행·대기 중인 행에 "중지"·"지시 추가", 모든 행에 "대화 보기"(경로 대신 메시지·도구 호출·결과를 줄여 보여 줌, 메시지당 2000자). 새 capability `subagentControl`. 실측은 없는 id로 응답 모양만 확인했다(실제 서브에이전트 실행은 모델 호출이 많아 하지 않음, 단위 테스트로 확인).
- 대기열 편집: omp가 들고 있는 대기열(`queue_update`의 steering/followUp)을 `liveStatus.queued`로 입력창 위에 보여 주고, follow-up에는 "지금 보내기"(`promote_queued_message{message}` → `{promoted}`: follow-up을 steering 끝으로 옮겨 다음 단계에 읽힘), 모든 항목에 ×(`remove_queued_message{message, queue:"steering"|"followUp"}` → `{removed, images?}`). 입력창이 스스로 들고 있는 요청(QueueList)과는 별개다. 새 capability `queueEdit`. 실측은 빈 대기열에서 응답 모양만(`{promoted:false}`, `{removed:false}`), 대기열이 찬 상태는 단위 테스트.
- 다음 입력 제안·복귀 요약: omp RPC에는 TUI의 예측/recap 명령이 없다(19.2.1 바이너리의 `presentIdleRecap`·예측 설정은 TUI 쪽). 그래서 둘 다 `btw` 사이드 질문(대화에 남지 않음)으로 만든다. 제안은 완료된 턴 뒤 `suggestion` capability로 `suggestNextInput`이 1회 묻고(선택된 창·포커스·빈 입력창일 때만 렌더러가 요청), 답은 한 줄로 정리해 고스트 텍스트로 쓴다. 요약은 턴 완료 뒤 `recap.idleSeconds`(omp 기본 240초, `recapIdleMs`로 시험 단축)만큼 조용하면 1회 생성해 `While you were away` 알림 행으로 띄운다. 새 입력·steer·큐·프로세스 종료 시 타이머를 지우고, 대기열이 비어 있지 않으면 묻지 않는다. 실측은 없다(단위 테스트만).
- 실행 모드: 컨텍스트 막대의 "실행 모드" 팝오버에 빠른 모드(`set_fast_mode` → `{enabled, active}`), 느린 모드(`set_slow_mode`, `get_state.slowModeSupported`일 때만 보임), 자동 압축(`set_auto_compaction`), 자동 재시도(`set_auto_retry`). 상태는 `get_state`의 `fastModeEnabled/fastModeActive/slowModeSupported/slowModeEnabled/autoCompactionEnabled`를 `liveStatus.modes`로 보여 준다. 자동 재시도는 `get_state`에 없어 기본값(켜짐) 또는 이 창에서 마지막으로 정한 값으로 보이고 "기본값" 표시를 단다. 자동 압축·재시도는 세션에만 적용된다(persist=false). 느린 모드는 모델에 따라 전역 설정(`slowModeScope: "global"`)일 수 있어 실측하지 않았다. 실측: 자동 압축/재시도 끄기, 빠른 모드 끄기 성공, 빠른 모드 켜기는 deepseek에서 "Fast mode is unavailable for the current model." 오류(창에 오류로 보임). 새 capability `runtimeModes`.
- 세션 통계: `get_session_stats` → `SessionStats`(userMessages, assistantMessages, toolCalls, tokens{input,output,reasoning,cacheRead,cacheWrite,total}, cost, premiumRequests, contextUsage; 실측 확인, 모델 호출 없음). "컨텍스트" 대화상자 아래 "이 세션의 사용량"에 비용·모델 호출(assistant 메시지 수)·토큰·메시지·도구 호출을 보인다. 프리미엄 요청·추론 토큰은 0이 아닐 때만.
- 세션 이름: 채팅 이름을 바꾸면 `set_session_name{name}`을 보낸다(omp가 떠 있지 않으면 다음 시작 때 configure에서; 대기는 메모리에만 있어 앱을 다시 켜면 사라짐). 실측: 이름 지정 후 `get_state.sessionName`에 반영, 세션 파일에 기록. omp가 스스로 정한 이름을 행 제목으로 가져오지는 않는다.
- HTML 내보내기: 사이드바 세션 메뉴 "HTML로 내보내기" → 메인 프로세스가 저장 대화상자(기본 위치: 다운로드/<제목>.html)를 띄우고 `export_html{outputPath}` → `{path}`, 저장 뒤 Finder에서 보여 준다. 실측: 스크래치 경로에 68KB HTML 생성(모델 호출 없음). 새 capability `exportHtml`. 저장 대화상자 자체는 앱 스모크로 확인하지 않았다.
- 로그인 관리: 설정 › 에이전트 › Oh My Pi 아래 "omp 로그인". 채팅과 따로 `omp --mode rpc-ui --no-session`을 필요할 때 띄우고(2분 쉬면 종료) `get_login_providers` → `{providers:[{id,name,available,authenticated}]}`(실측 96개, 로그인된 것만 먼저 보이고 나머지는 "다른 제공자에 로그인"·검색), `get_logout_accounts{providerId}` → `{accounts:[{credentialId,provider,label,detail,type,active}]}`, `logout{providerId,credentialId}`(호스트 확인 대화상자를 거침), `login{providerId}`(OAuth: omp가 내는 `extension_ui_request` `open_url`의 launchUrl(없으면 url)을 메인이 http(s)일 때만 브라우저로 열고, 안내문·진행(`notify`)·붙여넣기 입력(`input`)·확인(`confirm`/`select`)을 시작한 창에 보내 답을 `extension_ui_response`로 돌려줌; 취소는 그 omp를 끝냄). 토큰은 창이나 앱 저장소로 오지 않는다(omp가 보관). omp는 RPC에서 비밀 입력과 URL 전 대화형 입력을 스스로 거절한다. 실측은 읽기만(제공자 목록, 로그인된 제공자의 계정 수와 필드 이름; `--no-session`이라 세션 폴더가 늘지 않음). 실제 로그인·로그아웃은 하지 않았다(단위 테스트).
- 대화 트리·포크·다시 쓰기: 헤더의 "대화 트리"(`get_tree` → `{tree: SessionTreeNode[], leafId}`)가 메시지·압축·갈래 요약을 읽는 순서로 펼쳐 보이고(현재 갈래 먼저, 다른 갈래는 들여쓰기, omp의 기록용 항목(model_change, custom)은 숨김) 내 메시지마다 "여기까지 포크"(`fork{entryId}` → `{cancelled}`)와 현재 갈래면 "여기서 다시 쓰기"(`branch{entryId}` → `{text, cancelled}`: 이 채팅이 그 메시지 앞에서 끝나는 새 파일로 옮기고 글을 입력창에 넣음). 사이드바 "현재 상태에서 포크"(GJC와 같은 메뉴, capability `fork`)도 omp 채팅에 열린다. omp의 fork는 열린 세션을 새 파일로 바꾸므로 원본 채팅의 omp를 건드리지 않게 새 채팅용 omp를 원본 파일로 띄워(`--resume`) 거기서 fork한다(`parentId`로 원본 아래에 묶임). 실측: 스크래치 세션에서 첫 메시지까지 포크(새 파일, 트리 1개), 두 번째 메시지에서 다시 쓰기(새 파일, 글 돌려받음), 모델 호출 없음. `navigate_tree`(같은 파일 안에서 갈래 이동)와 `get_branch_messages`는 쓰지 않았다: 세션 파일 판독기가 갈래를 모르고 파일을 처음부터 끝까지 이어 읽어, 같은 파일에서 갈래를 옮기면 버린 갈래까지 대화에 보이게 된다(fork/branch는 새 파일이라 괜찮음). 새 capability `sessionTree`.
- 승인 카드의 범위와 거절 사유: 19.1.1 tools/approval.ts `approvalChoiceLabels` 순서대로 카드에 옮긴다 — "Approve"(이번만; grant가 있으면 "Approve Once"), "Approve <tool> for this session"(승인 모드가 올린 프롬프트에만, 도구+tier 단위; 새 kind `allow_session` "이 세션 동안 허용"), `always-ask-cached`의 grant("Approve Directory: <폴더>"/"Approve File"/"Approve" 와 각각의 "Always …": `allow_session`/`allow_always` + `grant{scope, target}`), "Deny". 고른 omp 라벨 그대로 답하므로 세션 grant는 omp가 기억하고, 창이든 폰(원격 `resolve-tool-call`)이든 같은 경로라 어디서 답해도 이후 같은 도구는 묻지 않는다. 명령 규칙의 자동 응답은 그대로 이번만 허용/거절. 거절 사유: omp의 select는 라벨만 받고 거절은 "Tool call denied by user: <tool>"로 끝나므로, 사유가 있으면 Deny 직후 `steer`로 "[<tool> 거절 사유] …"를 보낸다. 실측(무료 모델 1턴): bash 첫 승인에서 "이 세션 동안 허용" → 두 번째 echo는 묻지 않고 실행, write 승인 거절+사유 → 대화에 사유가 steer로 들어가고 모델이 파일을 만들지 않고 DONE.
- 입력창의 `!명령`: RPC `bash{command, excludeFromContext?}` → `BashResult{output, exitCode, cancelled, …}`(출력이 도중에 오지 않고 끝날 때 한 번). 컨트롤러가 `!`/`!!`를 가로채 omp의 셸에서 돌리고, 돌아가는 동안 "직접 실행" 셸 카드에 "중지" 버튼(`abort_bash`, 이 명령만 멈춤)을 둔다. omp TUI처럼 `!!`는 `excludeFromContext`로 모델 컨텍스트에 넣지 않는다(ready 프레임의 `supportsBashExcludeFromContext: true`; 카드에 "컨텍스트 제외" 표시). 한 번에 하나만(TUI와 같음). omp는 결과를 세션에 `bashExecution` 메시지로 남기고, 세션 파일 판독기가 이를 셸 카드로 읽는다. omp는 첫 답이 나올 때 세션 파일을 쓰므로 그 전의 `!` 카드는 파일이 기록을 가질 때까지 실시간 행으로 남는다. 명령 목록에 `!`를 넣어 입력창이 이것을 프롬프트가 아닌 제어로 바로 보내게 했다(슬래시 팔레트에는 안 보임). 실측(모델 호출 1회: 파일 기록 확인용): `!echo` 완료·출력, `!sleep 30` 중지 116ms 만에 cancelled, `!!echo` excludeFromContext로 기록, 파일의 세 기록이 셸 카드로 읽힘. 새 capability `userShell`.
- 같은 세션 파일 안의 트리 이동: 세션 파일 판독기가 갈래를 안다 — 모든 기록의 `id/parentId`(행이 없는 model_change·usage 줄도 정규식으로)와 `activeLeafId`로 omp와 같은 규칙(마지막 기록의 activeLeafId, 없으면 그 기록)으로 활성 leaf를 정하고, 루트에서 leaf까지의 경로에 있는 행만 보인다(행 id는 그대로, 갈래가 없는 파일은 예전처럼). omp의 `navigate_tree`는 다음 기록까지 파일에 아무것도 쓰지 않으므로, 이동 뒤 `get_tree`의 leafId를 판독기에 알려(`setLeaf`) 다음 기록이 붙을 때까지 그 갈래를 보인다(omp를 다시 띄우면 파일의 leaf로 돌아감). 대화 트리: 아무 항목이나 "여기로 이동"(같은 파일), 내 메시지는 "여기서 다시 쓰기"(그 메시지 앞으로 옮기고 글을 입력창에) — 지난 배치의 `branch`(새 파일)는 이것으로 바꿨다. `get_branch_messages`는 omp가 다시 쓰기를 허락하는 내 메시지 목록(모든 갈래의 user 메시지)이라 "다시 쓰기" 표시에 쓴다. omp는 턴이 도는 중이면 이동을 거절한다("still running"). 실측(무료 모델 2턴, yolo): ALPHA 턴 → 첫 메시지로 이동(대화 비고 글이 돌아옴) → BETA 턴 → 대화엔 BETA만, 같은 파일 → ALPHA 답으로 이동 → ALPHA만 보임.
- Git·변경 파일 패널: omp 채팅도 capability `git`으로 GJC 채팅의 변경 파일 패널(헤더 버튼, DiffPanel)과 헤더 브랜치를 쓴다. 변경 내용은 herdr의 `workspace-diff.ts`(채팅 폴더의 `git diff HEAD`와 추적 안 된 파일, 폴더에 쓰지 않음), 상태는 GJC의 `gjc-sdk-git.ts` 리더를 채팅 폴더로 돌린다. 스테이지·커밋·푸시도 같은 함수로 가서 managed worktree에서만 허용되므로 omp 채팅에서는 GJC의 worktree 밖 세션처럼 막히고 패널에 그 안내가 나온다. 검증은 실제 git 저장소에서 단위 테스트(상태·diff 읽기, 쓰기 거절); 앱 화면은 확인하지 않았다.
- 실사용 스모크(`npm run desktop:omp-rpc-smoke`, 9·10에 11단계 추가): 기본 승인 모드의 omp 채팅에서 `sleep 12` bash 승인 대기 → permission 알림 호출, 승인 후 그 턴이 도는 동안 follow-up 두 개를 넣어 `liveStatus.queued`에 둘 다 보이고 하나는 빼고(`remove_queued_message`) 하나는 지금 보내기(`promote_queued_message`) → 대기열 비고 턴 끝 → completed 알림 호출, 작은 서브에이전트 하나(task 도구, 승인 클릭) → `listSubagents`에 완료로 보이고 `getSubagentMessages`에 지시와 "OK", 느린 모드는 기본 무료 모델(deepseek flash)이 지원하지 않아 `set_slow_mode`가 "Slow mode is unavailable for the current model."로 거절 → 전역 설정을 건드리지 않음(지원 모델이면 켰다 끄고 원래 값으로 되돌림), 스모크 전용 원격 서버로 짝지은 폰: `/api/state`에 omp 채팅(`runtime: "omp-rpc"`), transcript-page 행, 모바일 크기 창의 PWA가 대화 메시지 5개·도구 카드 1개를 그림. 알림은 macOS가 개발용 앱에 권한을 주지 않아 표시는 실패(`Notification delivery failed`)하고 호출만 확인한다. 실행 결과 9·10·11 모두 통과.

**한계 (omp RPC 채팅)**
- 열린 채팅마다 omp 프로세스가 앱이 끝날 때까지 산다(유휴 종료 없음).
- 거절 사유는 omp의 select가 라벨만 받아 steer 메시지("[도구 거절 사유] …")로 간다: 대화에 사용자 메시지로 남는다.
- 폼 판독은 흔한 부분집합만: 이미지·SVG·표 안 입력은 질문 텍스트로만 쓰고, 같은 이름 필드가 둘이면 각각 카드가 된다. 18.20식 `ask` 대화상자는 단위 테스트로만 확인(19.1.1 ask 도구는 `form`을 씀).
- 터미널↔RPC 전환은 없다(v1). 채팅 세션에는 터미널이 없고, 기존 omp 터미널 세션은 기록 채팅으로만 본다.
- fork·추천 입력·git·세션 정보·변경 파일 패널은 없다. 대화의 assistant 머리말은 다른 에이전트 채팅과 같이 "Gajae"로 나온다.
- 앱이 턴 도중 끝나면 omp도 끝나고(stdin EOF), 파일에 쓰인 만큼만 다시 읽힌다. 실시간 행의 id는 턴이 끝나야 파일 id로 바뀐다.


## 11. Peacock: 이름·정체성 바꾸기와 userData 이전

상태: 구현(2026-11-25). 앱 이름을 Gajae에서 **Peacock**(공작갯가재, peacock mantis shrimp)으로 바꾼다. 색은 바꾸지 않는다: 모든 색 토큰(`--accent` #f06416/#b8470a, `--accent-bright`, 배경)은 그대로이고, 마크·아이콘·메뉴바 글리프는 모양만 바꿔 지금 강조색으로 그린다.

**정체성**
- 마크(2026-11-25 바꿈): 장식 없는 필기체 대문자 **P**, Google 글꼴 Satisfy(Apache-2.0, Font Diner)의 "P" 글리프를 경로 하나로 바꾼 것. 글꼴 파일은 넣지 않고 경로만 둔다(`PeacockMark`, `fill: currentColor` = `--accent`). 경로는 놓이는 타일의 100단위 정사각형 위에 그린다: 글자 크기 타일의 84%, 가운데로 보이도록 x −4%·y +6% 옮김(모크 mark-eye 3안). 크로스바 셰브런과 맨 셰브런 변형은 없앴다.
- 앱 아이콘(.icns, Icon Composer `.icon`, PWA 192/512): 지금 아이콘의 배경(어두운 타일)과 주황 테두리·주황 그라데이션은 그대로, 글리프만 P. P는 헤드리스 Chromium으로 경로를 알파 마스크로 그리고 PIL로 합성, `iconutil`로 묶는다.
- 메뉴바: 같은 P를 흑백 템플릿 PNG 18/36px로. 16–18px에서 획이 끊기지 않도록 높이의 3.5%만큼 굵게 그린다.
- 글꼴: 워드마크(PEACOCK)만 Unbounded(OFL 1.1, `@fontsource/unbounded`의 latin woff2를 로컬에 둠, THIRD_PARTY_NOTICES에 기록). 본문 글꼴은 그대로.
- 화면: 마스코트 이미지(`gajae-icon-ui.png`, 진행 스프라이트)를 마크로 바꾼다. 빈 대화: 마크 + "어디를 칠까요?" + 세션의 에이전트 칩, 폴더·모델(omp 채팅에서 모델이 "확인 중…"으로 남던 버그 수정). assistant 머리말은 "Gajae" 대신 세션의 에이전트 이름(GJC, Oh My Pi, Claude Code)과 중립 아바타.
- 사이드바: 왼쪽 아래 프로필 카드와 "지난 세션 이어서 진행"을 지우고 "설정"만 남긴다. 카드가 하던 일의 새 자리: 설정 열기 → "설정" 줄, GJC 연결·로그인 필요·업데이트 → GJC 채팅의 상태와 설정 › GJC, 작업 공간 이름 → 설정에 이미 있는 이름(없으면 기본값 유지). 세션이 없을 때 "지난 세션 보기" 대신 "새 세션"(새 세션 대화상자). GJC 전용 이어 가기 선택기(ResumeSessionDialog)는 GJC 채팅 안의 `/resume`에서만 연다(메뉴·단축키에서는 뺌). P6의 "GJC 미사용 시 사이드바 하단 기본 에이전트 표시"는 카드와 함께 없어진다.

**보이는 이름**: 창 제목, 메뉴, 정보, 알림, ko/en i18n, 온보딩, 원격 PWA 이름·manifest, README·docs의 앱 이름을 Peacock으로. `productName` "Peacock", 번들 `Peacock.app`, appId `dev.peacock.app`(기존 `com.gajae.desktop`).
- appId를 바꾸면 macOS가 다른 앱으로 본다: 알림 허용, 화면 기록(빠른 입력의 캡처), 로그인 항목, Dock 고정을 다시 해야 한다. 키체인의 "Gajae Safe Storage"는 쓰지 않으므로(앱이 safeStorage를 안 씀) 영향 없음. 첫 실행에 알림 권한을 다시 묻는다.

**userData 이전** (`~/Library/Application Support/Agent Control` → `~/Library/Application Support/Peacock`)
- 언제: 앱 시작 때 userData를 정하기 전에 한 번. 격리 실행(`GAJAE_USER_DATA_DIR`/`PEACOCK_USER_DATA_DIR`, 스모크)에서는 하지 않는다.
- 조건: 새 폴더에 앱 데이터(`agent-control-settings.json` 등)도 이전 표시(`peacock-migration.json`)도 없고, 옛 폴더에 앱 데이터가 있을 때.
- 옛 앱이 실행 중이면(옛 폴더의 `SingletonLock`이 살아 있는 pid를 가리킴) 복사하지 않는다: 그 실행은 임시 userData로 떠서 "Gajae를 먼저 종료하세요" 안내를 보이고 끝난다(새 폴더를 만들지 않음).
- 방법: 옛 폴더 전체를 `Peacock.migrating-<시각>`에 복사(잠금·캐시 제외: `Singleton*`, `DevToolsActivePort`, `Cache`, `Code Cache`, `GPUCache`, `Dawn*Cache`, 그리고 첫 사용 때 앱이 다시 까는 `bin/`) → 검증(복사한 모든 파일의 크기, 핵심 파일 — 설정·세션·`terminal-sessions.json`·`omp-rpc-sessions.json`·`remote-access.json`·`agent-hooks/token`·`productivity.sqlite`(+wal/shm) — 의 sha256) → 표시 파일을 쓰고 `Peacock`으로 rename(같은 볼륨, 원자적). 새 폴더가 앱 데이터 없이 이미 있으면(크롬이 만든 빈 프로필) `Peacock.pre-migration-<시각>`으로 옮겨 둔다.
- 실패하면: 스테이징을 `Peacock.failed-<시각>`으로 남기고 이번 실행은 옛 폴더를 그대로 쓴다. 어느 경우에도 지우지 않는다.
- 구현: `electron/user-data-migration.ts`(`migrateUserData`, 테스트는 임시 폴더에서 복사·검증·실패·실행 중을 확인). 소스 실행(`electron .`, `app.isPackaged`가 아님)은 복사하지 않는다: 새 폴더에 앱 데이터가 있으면 새 폴더, 없으면 옛 폴더를 쓴다(`developmentUserData`).
- 옛 앱이 실행 중이면 이전 뒤에도 Peacock은 뜨지 않는다(같은 안내 후 종료): 두 앱이 같은 herdr-core 세션(`gajae`)의 터미널을 두 폴더에서 따로 다루게 되기 때문.
- 옛 폴더는 그대로 둔다(되돌리기: 옛 Gajae.app을 다시 열면 그 폴더로 그대로 동작). 다만 되돌린 Gajae는 자기 `terminal-sessions.json`에 없는 터미널(Peacock에서 만든 것)을 고아로 보고 끝낸다. 되돌리기 전에 Peacock에서 만든 터미널 세션의 일을 마무리해야 한다. 한 가지 예외: 이전 때 옛 `agent-hooks/relay.sh`를 새 소켓(`Peacock/agent-hooks/h.sock`)으로 다시 써서, 이전 전에 시작돼 herdr-core에서 계속 도는 Claude Code·omp의 훅이 Peacock에 닿게 한다(토큰은 같은 값을 복사). 옛 앱을 다시 열면 그 앱이 relay.sh를 자기 소켓으로 다시 쓴다.

**유지하는 내부 식별자** (사용자 데이터·실행 중인 것·스크립트와 이어져 있어 바꾸지 않음)
- herdr-core 세션 이름 `gajae`/`gajae-dev`(HC_SESSION): 바꾸면 이미 떠 있는 터미널 세션(앱을 닫아도 도는 셸·에이전트)이 다른 세션 서버에 남아 고아가 된다. 화면에 보이지 않는 이름이라 유지.
- 환경 변수 `GAJAE_*`(`GAJAE_SESSION_ID`는 이미 떠 있는 에이전트의 훅이 보냄, `GAJAE_USER_DATA_DIR`·`GAJAE_HC_SESSION`·`GAJAE_SMOKE_*`는 스크립트·스모크): 유지하고 `PEACOCK_USER_DATA_DIR`만 별칭으로 추가.
- userData 안 파일 이름(`agent-control-*.json` 등), 세션 소유 값 `ownership: "gajae"`, localStorage 키(`gajae:*`, 폰 PWA의 `gajae.remote.token` — 바꾸면 짝지은 폰이 다시 짝지어야 함), 임시 폴더 접두사(`gajae-hooks-*`, `gajae-smoke-*`), 터미널 글꼴 패밀리 이름, 소스의 Gajae* 식별자(컴포넌트·파일 이름).
- URL 스킴: `peacock://`를 등록하고 `gajae://`를 별칭으로 계속 받는다(같은 처리).
- 패키지 이름 `agent-control`, 저장소 폴더, 브랜치 이름, install.sh/릴리스 저장소 경로: 그대로.
