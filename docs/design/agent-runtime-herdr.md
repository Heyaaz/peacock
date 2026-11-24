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
  - capabilities: 카탈로그 상한에서 `send = reported && live`, `approvals=false`(P4), `git=false`(GJC git 패널 미연결), `attachments/streaming=false`. 렌더러는 Claude Code·omp 세션에 GJC Composer 대신 전용 입력창(텍스트·보내기·중단만)을 쓰고, 헤더의 사이드 채팅·변경 파일·세션 정보 버튼과 goal/subagent/git/명령 목록 조회를 끈다. 세션마다 채팅/터미널 선택을 기억하고 처음엔 카탈로그 `defaultSurface`(터미널)로 연다.
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
| P6 | 검색 색인·병렬 실행의 herdr 세션 지원 | — |

## 8. 위험 / 미확인 가정
1. hc 0.1.x 변동. 버전 불일치는 0.1.18 채택으로 해소. 0.1.19~0.1.22가 이미 나와 있어 업그레이드는 hello `methods/features` 판정으로 대비.
2. TCC 권한 주체(미확인), 공증 빌드에서 Herdr Core.app 서명 보존(미확인). 확인됨: ad-hoc `codesign --deep`은 Resources 안 hc를 재서명하지 않음, 백그라운드 항목 등록 로그 없음.
3. Claude Code: `session_id`/`transcript_path`/`--session-id`는 확인(2.1.331). PermissionRequest에 tool_use_id 없음 → PreToolUse로 짝짓기. 최소 지원 버전은 미측정.
4. (해소) 0.1.17·0.1.18 모두 `terminal.send`의 `if`/`force`, labels 필터, `terminal.interrupt` 있음.
5. 앱 밖 데몬·고아 터미널, dev/smoke가 실사용 코어를 건드리는 문제(세션명 분리로 대응, 스파이크에서 `HC_SESSION`별 상태·소켓 분리 확인).
8. 코어 env 오염: 코어를 처음 띄운 클라이언트 env가 모든 터미널로 감 → 허용 목록 필수, 오염 시 `server.restart`(§5.1).
6. 원격에서 shell 세션 노출(서버 쪽 차단으로 대응), 구버전 PWA(P5: 와이어의 runtime 이름을 `"terminal"`로 유지, §5.7).
7. TerminalView가 디스플레이 질의에 응답하는지.
