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

### 5.3 에이전트 실행
- 카탈로그: claude, omp, codex, gjc, shell. 감지는 PATH → 로그인 셸 PATH → install_dirs, `--version` 캐시.
- `terminal.run`의 program은 **절대 경로 강제**(argv[0]이 hc 템플릿 이름으로 해석될 수 있음, Ovis `adapter.ts:880`).
- 실행 옵션 검증: Ovis `launch-rules.ts`/`agentLaunchMode.ts` 축소 이식.
- Claude Code는 `--session-id <uuid>`로 시작해 세션을 Gajae가 정한다(실측: SessionStart의 `session_id`가 그 값). 새 폴더 첫 실행은 작업 공간 신뢰 대화상자(`blocked/permission "trust this folder"`)가 먼저 뜬다.

### 5.4 훅 채널 (P2부터)
- 실행 시 주입: Claude는 `--settings <file>`로 SessionStart / UserPromptSubmit / Stop / PermissionRequest(P4) / PostToolUse(P4) 훅, omp는 `-e <extension>`.
- SessionStart로 `session_id`, `transcript_path`를 받는다 → 기록 위치 1순위. `/clear`·`/resume`로 세션이 바뀌어도 다시 보고됨.
- 턴 시작/종료를 훅으로 받아 OSC 7501 의존을 줄인다.
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

### 5.6 승인 / 질문 (P4)
- PermissionRequest 훅 → `ToolActivity{approval-required}`, `permissionOptions`는 **allow_once / reject_once만**.
- PermissionRequest에는 `tool_use_id`가 없다(2.1.331 실측). 같은 세션의 직전 PreToolUse(같은 `tool_name`·`tool_input`)와 짝지어 id를 얻는다. 사용자 설정(예: Code Mode)에 따라 바깥 도구와 안쪽 도구의 Pre/PostToolUse가 둘 다 올 수 있다.
- 승인 대화상자 중 `terminal.send`는 hc가 `data.kind: "blocked"`로 거부한다(실측) → 채팅에는 "터미널에서 승인 대기"로 표시.
- 명령 규칙(`matchCommandRule`) 먼저 적용.
- **터미널에서 직접 답한 경우 해제 규칙**: PostToolUse/Stop 훅 또는 기록의 tool_result가 오면 카드 닫음(Ovis는 화면 판독으로 해제, 600초 타임아웃).
- 최소 지원 버전은 Gajae 기준으로 따로 측정(Ovis의 2.1.286은 화면 대조용 기준).

### 5.7 메인 라우터 / 원격
- `registerGjcIpcHandlers(controller: GjcSdkController)` → 핵심 `AgentHost` 인터페이스 + 선택 facet.
- RemoteAccess의 host를 라우터로 교체하되:
  - **agentKind `shell`은 원격 목록·조작에서 서버 쪽 제외**(폰에서 임의 명령 실행 방지).
  - `resolveToolCall(toolId)`에 sessionId가 없으므로 toolId에 네임스페이스(`<sessionId>/<id>`) 부여.
- GJC 전용 기능은 herdr 세션에서 `unsupported` 타입 오류 + UI 숨김.

### 5.8 온보딩 / 설정 (P5)
- 설치된 에이전트 감지 결과로 기본 에이전트 선택. GJC 설치/로그인은 GJC 카드 안 선택 동작.
- 환경 점검 `gjc|provider-login|model-preset`은 GJC 선택 시에만 필수.

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
| P2 | 에이전트 실행 + 훅 채널(세션·턴 보고) + 상태·알림 | Claude Code 세션 상태 표시, 완료 알림 |
| P3a/b/c | a 읽기 전용 채팅(claude) → b 채팅 입력(`terminal.send`) → c omp | 채팅/터미널 전환, 채팅 입력이 터미널에 반영 |
| P4 | 승인(claude → omp) + 규칙 + 원격 노출 정책 | 폰에서 Claude Code 도구 승인 |
| P5 | 온보딩/설정 일반화, 타입 정리, node-pty 결정, 문서 | GJC 미설치 첫 실행 → Claude Code 세션까지 |
| P6 | 검색 색인·병렬 실행의 herdr 세션 지원 | — |

## 8. 위험 / 미확인 가정
1. hc 0.1.x 변동. 버전 불일치는 0.1.18 채택으로 해소. 0.1.19~0.1.22가 이미 나와 있어 업그레이드는 hello `methods/features` 판정으로 대비.
2. TCC 권한 주체(미확인), 공증 빌드에서 Herdr Core.app 서명 보존(미확인). 확인됨: ad-hoc `codesign --deep`은 Resources 안 hc를 재서명하지 않음, 백그라운드 항목 등록 로그 없음.
3. Claude Code: `session_id`/`transcript_path`/`--session-id`는 확인(2.1.331). PermissionRequest에 tool_use_id 없음 → PreToolUse로 짝짓기. 최소 지원 버전은 미측정.
4. (해소) 0.1.17·0.1.18 모두 `terminal.send`의 `if`/`force`, labels 필터, `terminal.interrupt` 있음.
5. 앱 밖 데몬·고아 터미널, dev/smoke가 실사용 코어를 건드리는 문제(세션명 분리로 대응, 스파이크에서 `HC_SESSION`별 상태·소켓 분리 확인).
8. 코어 env 오염: 코어를 처음 띄운 클라이언트 env가 모든 터미널로 감 → 허용 목록 필수, 오염 시 `server.restart`(§5.1).
6. 원격에서 shell 세션 노출(서버 쪽 차단으로 대응), 구버전 PWA.
7. TerminalView가 디스플레이 질의에 응답하는지.
