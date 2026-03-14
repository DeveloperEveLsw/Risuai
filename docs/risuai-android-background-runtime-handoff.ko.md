# RisuAI Android 백그라운드 런타임 포팅 인수인계서

## 상태

- 문서 목적: 다른 세션과 다른 작업자가 동일한 방향성으로 즉시 작업을 이어받을 수 있도록 기준을 고정한다.
- 대상 범위: Android 앱 포팅
- 제외 범위: iOS 대응, 서버 job runtime 중심 재설계
- 문서 성격: 설계 원칙 + 단계별 작업 계획 + 실행 체크리스트 + 인수인계 기준

## 한 줄 원칙

이 작업은 새 제품을 설계하는 것이 아니라 기존 RisuAI를 Android 앱 런타임으로 포팅하는 작업이며, **오직 실행 오너와 라이프사이클만 바꾸고 요청 로직의 의미, 순서, 확장 지점, 생태계 호환성은 그대로 유지하는 것**이 제1원칙이다.

## 절대 원칙

### 1. 포팅이지 재창조가 아니다

- 기존 프로젝트의 동작 의미를 유지한다.
- 기존 캐릭터, 모듈, 플러그인, 트리거, 스크립트가 체감하는 요청 흐름을 바꾸지 않는다.
- 사용자가 “새 엔진”이 아니라 “앱이 된 RisuAI”라고 느껴야 한다.

### 2. 오너만 바뀌어야 한다

- 브라우저 UI가 소유하던 요청 라이프사이클을 Android 백그라운드 런타임이 소유하도록 바꾼다.
- 그러나 다음 파이프라인의 의미와 순서는 유지한다.
  - 입력 전처리
  - `editinput`
  - 사용자 메시지 반영
  - `sendChat`
  - 프롬프트 조립
  - lorebook / memory 삽입
  - `start` trigger
  - `editprocess`
  - `requestChatData`
  - provider dispatch
  - streaming response 처리
  - `editoutput`
  - `output` trigger
  - inlay / TTS / emotion / 후속 요청

### 3. 생태계 호환성이 최우선이다

- 기존 캐릭터 카드
- 기존 모듈
- 기존 regex script
- 기존 trigger
- 기존 Lua/Python scripting
- 기존 plugin v2 / v3
- 기존 low-level access

위 항목이 깨지는 방향은 기본적으로 실패로 간주한다.

### 4. 서버 소유 모델로 우회하지 않는다

- 본 작업의 기본 해법은 `request start -> background JS runtime ownership -> foreground UI mirror` 구조다.
- 서버 `jobId` 구조를 주 설계로 채택하지 않는다.
- Node 서버를 생성 오너로 바꾸는 방향은 본 문서의 범위 밖이다.

### 5. WebView 연장이 아니라 WebView 밖 런타임이어야 한다

- Android에서 WebView가 살아있기를 기대하는 방식은 허용하지 않는다.
- 백그라운드 실행은 별도 JS 런타임이 소유해야 한다.
- UI WebView는 화면 렌더링과 사용자 입력, 상태 구독 클라이언트 역할을 맡는다.

### 6. iOS는 고려하지 않는다

- 본 작업은 Android 기준으로만 의사결정한다.
- iOS 제약을 이유로 설계를 약화시키지 않는다.

## 이 문서가 고정하는 해석

### 현재 구조에 대한 고정 해석

- 현재 RisuAI의 생성 라이프사이클은 브라우저 UI 런타임이 소유한다.
- Node 셀프호스트는 생성 오너가 아니라 저장/프록시/호스팅 보조 계층이다.
- Tauri 데스크톱은 네트워크와 파일 권한을 네이티브로 우회하지만, 생성 오케스트레이션 자체는 여전히 프런트가 주도한다.

### 따라서 바뀌어야 하는 것

- 요청 라이프사이클 오너
- 백그라운드 실행 방식
- UI와 생성 런타임 사이의 동기화 경계

### 따라서 바뀌면 안 되는 것

- 기존 요청 로직의 의미
- hook 호출 순서
- trigger/script/plugin/module 개입 지점
- low-level access가 허용하는 실제 행위 범위
- 사용자 설정이 결과에 미치는 효과

## 현재 코드 기준 핵심 소유 지점

다음 파일은 생성 라이프사이클 소유권과 직접 연결된다.

- `src/lib/ChatScreens/DefaultChatScreen.svelte`
- `src/ts/process/index.svelte.ts`
- `src/ts/process/request/request.ts`
- `src/ts/process/scripts.ts`
- `src/ts/process/triggers.ts`
- `src/ts/process/scriptings.ts`
- `src/ts/globalApi.svelte.ts`
- `src/ts/stores.svelte.ts`
- `src/ts/storage/database.svelte.ts`

다음 파일은 생태계 호환성과 직접 연결된다.

- `src/ts/plugins/plugins.svelte.ts`
- `src/ts/plugins/apiV3/v3.svelte.ts`
- `src/ts/plugins/apiV3/factory.ts`
- `src/ts/process/modules.ts`
- `src/ts/process/mcp/*`

## 목표 아키텍처

### 상위 구조

1. 기존 Vite/Svelte UI는 가능한 한 유지한다.
2. 생성 요청의 오너는 Android 백그라운드 JS 런타임으로 옮긴다.
3. UI는 생성 엔진을 직접 돌리지 않고 요청 클라이언트가 된다.
4. UI는 상태를 직접 확정하지 않고, 백그라운드 런타임 상태를 구독하고 반영한다.

### 역할 분리

#### Foreground UI

- 화면 렌더링
- 사용자 입력
- 설정 변경
- 채팅 상태 시각화
- 플러그인 UI 표시
- 요청 시작 / 중단 / 재연결 / resume 호출

#### Background runtime

- 요청 생성 전체 소유
- `sendChat` 오케스트레이션
- 프롬프트 구성
- memory / lorebook 처리
- trigger / script / plugin 개입
- provider dispatch
- streaming 수신
- output 후처리
- 최종 상태 계산

#### Android native layer

- 백그라운드 서비스 수명 관리
- JS 런타임 부팅 및 유지
- foreground service 알림
- 앱 프로세스 / WebView / runtime 브리지
- 영속화 / 재연결 / 재개 처리

## 핵심 설계 원칙

### 1. 기존 호출 체인을 가능한 한 그대로 감싼다

- 새 파이프라인을 따로 설계하지 않는다.
- 기존 `sendChat` 계열을 분해하더라도 호출 의미는 동일해야 한다.
- “기존 함수를 background에서 호출 가능하게 재배치”하는 접근을 우선한다.

### 2. 호환성 경계는 기능이 아니라 런타임 의존성으로 나눈다

- `background-safe`
- `foreground-only`
- `mixed`

이 분류는 “중요도”가 아니라 “실행 위치 적합성” 기준이다.

### 3. UI 전용 기능과 생성 오케스트레이션을 분리한다

- 요청 결과를 바꾸는 로직은 background로 가야 한다.
- 화면을 바꾸는 로직은 foreground에 남아도 된다.
- 단, foreground로 남는 기능이 생성 결과의 의미를 바꾸면 안 된다.

### 4. 신규 제약을 사용자에게 노출하지 않는 방향을 우선한다

- 새 lane 개념을 사용자에게 직접 노출하지 않는다.
- 기존 플러그인/모듈 제작자가 새 API를 배우도록 강제하지 않는다.
- 내부 호환 레이어로 해결할 수 있으면 반드시 내부에서 해결한다.

## 반드시 유지해야 하는 불변 조건

아래 항목은 구현 중 항상 검증해야 한다.

- 동일한 캐릭터/설정/모듈/플러그인 조합이면 동일한 입력에서 동일한 요청 흐름이 형성된다.
- `pluginV2.replacerbeforeRequest`와 `pluginV2.replacerafterRequest`의 의미와 호출 타이밍이 유지된다.
- `processScriptFull(..., 'editinput' | 'editprocess' | 'editoutput')`의 의미가 유지된다.
- `runTrigger(..., 'start' | 'request' | 'output' | 'manual' | 'display')`의 의미가 유지된다.
- low-level trigger와 scripting이 내부에서 다시 `requestChatData()`를 호출할 수 있어야 한다.
- custom provider가 기존 방식으로 계속 동작해야 한다.
- streaming 중간 반영 방식이 사용자 체감상 동일해야 한다.
- abort 동작이 기존과 동일한 위치와 의미에서 작동해야 한다.
- 기존 DB 구조와 저장 의미를 깨지 않는다.

## 금지사항

다음 항목은 명시적으로 금지한다.

- 서버 job runtime을 기본 해법으로 채택하는 것
- “호환성보다 안정성”을 이유로 trigger/script/plugin 개입 지점을 축소하는 것
- 기존 hook 순서를 단순화하거나 병합하는 것
- 기존 플러그인 API 의미를 바꾸는 것
- 기존 캐릭터/모듈이 쓰는 low-level behavior를 임의 제한하는 것
- Android 포팅을 이유로 기존 UI를 대규모 재작성하는 것
- WebView가 백그라운드에서 계속 살아있기를 기대하는 것

## 단계별 작업 계획

### Phase 0. 기준 고정 및 계측

목표:

- 기존 흐름을 깨지 않고 관측 가능하게 만든다.
- 이후 변경이 “오너 변경만 있었는지” 검증할 수 있게 한다.

작업:

- 요청 라이프사이클 로그 포인트 추가
- hook 호출 순서 로그 추가
- nested subrequest 추적 추가
- streaming chunk 처리 타이밍 로그 추가
- abort 시점 로그 추가

완료 기준:

- 단일 캐릭터 요청 로그 확보
- 그룹 채팅 요청 로그 확보
- trigger 기반 subrequest 로그 확보
- plugin provider 요청 로그 확보
- `editinput`, `editprocess`, `editoutput`, `request`, `output` 개입 순서가 로그로 보인다

### Phase 1. 런타임 의존성 분리

목표:

- 기존 생성 엔진이 UI 전역 상태에 직접 묶여 있는 부분을 식별하고, 실행 컨텍스트를 분리한다.

작업:

- request runtime이 직접 참조하는 전역 상태 목록 작성
- `DBState`, `selectedCharID`, 현재 chat/character 접근을 context adapter로 감싼다
- network/storage/runtime bridge 인터페이스 초안 작성
- UI 전용 부작용과 생성 전용 부작용을 분리한다

완료 기준:

- 생성 엔진의 직접 UI 의존 지점 목록이 문서화된다
- background runtime이 필요한 입력 데이터와 출력 이벤트 형식이 정의된다

### Phase 1 후반 체크리스트

현재 세션 기준으로 Phase 1 후반은 아래 체크리스트를 기준으로 정리한다.

- `runtime-safe request path`
- [x] `sendChat` 오케스트레이션이 `DBState`, `selectedCharID` 직접 참조 없이 context adapter를 통해 동작한다
- [x] lorebook 활성화, chat var, persona/user helper가 request runtime context를 통해 동작한다
- [x] provider dispatch, trigger, script, module, memory 경로가 동일한 context를 공유한다
- [x] request 결과를 바꾸는 helper가 foreground store를 직접 참조하지 않는다

- `foreground-only 명시`
- [ ] 파일 선택, 다운로드, alert, plugin UI, iframe/document 의존 기능은 foreground-only로 남겨도 되는 경로인지 표시한다
- [ ] foreground-only 경로가 생성 결과 의미를 바꾸지 않는지 확인한다
- [ ] foreground-only 경로가 request runtime 내부에서 호출되지 않도록 경계를 분명히 한다

- `bridge contract`
- [x] background runtime 입력 스냅샷 형식이 정의되어 있다
- [x] stage/stream/chat_update/complete/fail/aborted 이벤트 형식이 정의되어 있다
- [x] abort/resume/subscribe 인터페이스 초안이 코드 레벨로 존재한다
- [x] 메인 채팅 화면의 start/abort 진입점이 직접 `sendChat` 대신 runtime client를 통해 요청을 시작한다
- [x] hotkey preview, DevTool preview/autopilot 같은 대표 UI 진입점도 runtime client를 통해 요청을 시작한다

- `검증 기준`
- [ ] 단일 캐릭터 요청 기준으로 lorebook, trigger, script, plugin 개입 순서가 유지된다
- [ ] low-level subrequest가 기존 의미를 유지한다
- [ ] streaming/abort가 기존 체감과 동일하다
- [ ] 그룹 채팅은 현재 비사용 기능이므로 검증 우선순위에서 제외하되, 의도적으로 깨지지 않게 유지한다

### Phase 2. background-safe compatibility lane 정의

목표:

- 기존 생태계를 유지하면서도 background runtime에서 소화 가능한 영역을 식별한다.

작업:

- plugin/module/trigger/script 기능을 `background-safe`, `foreground-only`, `mixed`로 분류
- 각 분류 기준을 코드 레벨로 문서화
- `foreground-only` 기능이 생성 결과를 바꾸는지 여부를 식별

완료 기준:

- 분류 표가 완성된다
- background runtime에서 그대로 실행 가능한 요청 경로가 명확해진다
- foreground에 남겨도 되는 항목과 절대 안 되는 항목이 구분된다

### 현재 기준 1차 lane 분류

아래 분류는 현재 코드 정리 상태를 기준으로 한 1차 분류다. 이후 구현이 진행되면 더 세분화될 수 있지만, 다음 세션은 이 분류를 출발점으로 삼는다.

- `background-safe`
- `src/ts/process/index.svelte.ts`
  요청 오케스트레이션 본체. runtime context 기반으로 분리 진행 중이며 background ownership 대상이다.
- `src/ts/process/request/*`
  provider dispatch와 retry/fallback, plugin replacer 경로 포함. request 결과를 직접 바꾸므로 background-safe 유지가 필요하다.
- `src/ts/process/scripts.ts`
  `editinput` / `editprocess` / `editoutput` 훅 경로.
- `src/ts/process/triggers.ts`
  `start` / `request` / `output` 등 trigger 실행 경로.
- `src/ts/process/scriptings.ts`
  Lua/Python scripting과 low-level request helper 경로.
- `src/ts/process/lorebook.svelte.ts`
  `loadLoreBookV3Prompt()` 기준으로 lorebook 활성화와 request 주입 경로는 background-safe다.
- `src/ts/process/modules.ts`
  request 결과를 바꾸는 module toggle/lorebook/helper 경로 포함.
- `src/ts/parser/chatVar.svelte.ts`
  chat var/global var access는 request runtime context를 통해 동작해야 한다.

- `foreground-only`
- `src/lib/ChatScreens/DefaultChatScreen.svelte`
  화면 렌더링, 입력, reroll UI, modal, scroll, floating action 등 UI 소유 경로. 다만 메인 start/abort 진입은 runtime client를 통해 background ownership 경계로 넘기기 시작했다.
- `src/ts/parser/parser.svelte.ts`
  DOMPurify hook, markdown rendering, asset display policy, display CSS/quote 처리 등은 foreground-only다.
- `src/ts/globalApi.svelte.ts`의 파일 선택/다운로드/브라우저 상호작용 경로
  운영체제/브라우저 UI와 직접 상호작용한다.

- `mixed`
- `src/ts/process/lorebook.svelte.ts`
  lorebook 활성화/주입은 background-safe지만, import/export와 UI 편집 보조는 foreground-only다.
- `src/ts/process/command.ts`
  low-level chat/trigger 조작은 background-safe 후보지만, alert 기반 명령은 foreground-only 의존이 있다.
- `src/ts/process/mcp/*`
  MCP transport와 internal risuaccess data helper는 background-safe 후보지만, 접근 확인 prompt와 일부 UI 승인 흐름은 foreground-only다.
- `src/ts/process/coldstorage.svelte.ts`
  저장/압축 자체는 background-safe 후보지만, 현재 호출 위치와 preload 시점은 UI 진입과도 연결되어 있어 mixed로 본다.

현재 기준으로 직접 `sendChat`을 호출하는 잔여 지점은 `runtimeClient.ts` 자체와 runtime 내부 helper(`command.ts`, `files/multisend.ts`)에 한정한다. 다음 세션은 이 잔여 지점을 UI 진입점으로 오해해 다시 foreground ownership으로 되돌리지 말 것.

### Phase 3. background runtime 프로토타입

목표:

- 기존 요청 엔진을 최대한 그대로 사용해 별도 JS runtime에서 구동한다.

작업:

- Android 네이티브 계층에서 독립 JS runtime 호스팅
- runtime과 UI 간 RPC/이벤트 브리지 구현
- `startRequest`, `abortRequest`, `subscribeRequest`, `resumeRequest` 인터페이스 구현
- streaming event 전달 프로토타입 구현

완료 기준:

- UI 없이 background runtime 단독으로 요청 1건을 생성 가능
- streaming chunk가 UI에 중계 가능
- abort가 동작 가능

### Phase 4. 오너 전환

목표:

- 기존 UI는 유지하되 생성 오너를 background runtime으로 넘긴다.

작업:

- 기존 `sendChat` 호출부를 runtime client 호출로 치환
- foreground는 local mutation 대신 runtime state mirror를 사용
- reconnect / poll / resume 복구 처리 구현
- background service 생명주기 처리 구현

완료 기준:

- 앱 화면 전환 후에도 요청 지속
- 홈 이동 후 복귀 시 스트리밍 상태 복원
- UI 재시작 후 진행 중 요청 상태 복구

### Phase 5. 생태계 호환 검증

목표:

- 기존 생태계에서 실제 사용 가능한지 검증한다.

작업:

- 대표 캐릭터 카드 검증
- low-level trigger 검증
- nested subrequest 검증
- plugin provider 검증
- plugin v2 request/response replacer 검증
- Lua/Python helper 검증

완료 기준:

- 기존 생태계 핵심 샘플이 동작
- 회귀 목록이 문서화
- 남은 불일치가 명확히 분류됨

## 세션 시작 체크리스트

다른 세션이 작업을 이어받을 때 반드시 먼저 확인할 것:

- [ ] 이 문서를 끝까지 읽었다.
- [ ] `risuai.md`를 다시 읽어 현재 아키텍처 해석을 맞췄다.
- [ ] 이번 작업이 “오너 변경”인지 “로직 의미 변경”인지 구분했다.
- [ ] 서버 job runtime 방향으로 새로 틀지 않는다고 명확히 인지했다.
- [ ] Android만 범위이며 iOS를 고려하지 않는다고 인지했다.
- [ ] 변경 대상이 UI인지 request runtime인지 구분했다.
- [ ] 이번 세션 목표가 어느 Phase인지 명시했다.

## 구현 전 체크리스트

- [ ] 이번 변경이 기존 hook 순서를 바꾸지 않는지 확인했다.
- [ ] plugin/module/trigger/script 호환성 영향 범위를 적었다.
- [ ] nested subrequest에 영향이 없는지 확인했다.
- [ ] abort 의미가 바뀌지 않는지 확인했다.
- [ ] streaming 중간 반영 의미가 바뀌지 않는지 확인했다.
- [ ] DB 저장 의미가 바뀌지 않는지 확인했다.

## 구현 중 체크리스트

- [ ] 새 코드가 기존 요청 체인을 우회하지 않는다.
- [ ] 기존 함수 이름과 책임을 가능한 한 유지한다.
- [ ] background runtime이 직접 요청 오케스트레이션을 소유한다.
- [ ] UI는 요청 엔진이 아니라 runtime client 역할만 수행한다.
- [ ] WebView 생존을 전제로 하지 않는다.
- [ ] foreground-only 기능이 생성 결과를 바꾸지 않도록 처리했다.
- [ ] 로그/계측이 남아 있어 회귀 비교가 가능하다.

## 검증 체크리스트

- [ ] 단일 캐릭터 일반 요청이 동작한다.
- [ ] 그룹 채팅 요청이 동작한다.
- [ ] `editinput`이 동작한다.
- [ ] `editprocess`가 동작한다.
- [ ] `editoutput`이 동작한다.
- [ ] `request` trigger가 동작한다.
- [ ] `output` trigger가 동작한다.
- [ ] low-level trigger 내부 `requestChatData()` 호출이 동작한다.
- [ ] scripting helper 내부 `requestChatData()` 호출이 동작한다.
- [ ] custom provider가 동작한다.
- [ ] plugin v2 request replacer가 동작한다.
- [ ] plugin v2 response replacer가 동작한다.
- [ ] streaming 도중 앱 전환 후 복귀가 가능하다.
- [ ] abort가 동작한다.
- [ ] 앱 재진입 후 요청 상태를 복구할 수 있다.

## 인수인계 전 체크리스트

- [ ] 이번 세션이 건드린 Phase와 목표를 문서에 반영했다.
- [ ] 바뀐 점과 안 바뀐 점을 명확히 적었다.
- [ ] 기존 생태계 호환성에 미치는 영향이 있으면 반드시 적었다.
- [ ] 미완료 항목을 다음 작업자가 바로 집을 수 있게 남겼다.
- [ ] “왜 이렇게 했는가”보다 “무엇을 절대 바꾸면 안 되는가”를 더 분명히 남겼다.

## 다음 세션이 절대 잊으면 안 되는 문장

다음 세션은 이 작업을 “앱 환경에 맞춘 RisuAI 포팅”으로 이해해야 한다.  
다음 세션은 이 작업을 “새로운 생성 엔진 설계”로 해석하면 안 된다.  
다음 세션은 요청 오너를 바꾸더라도, 기존 request pipeline의 의미와 호출 순서와 생태계 호환성을 바꾸면 안 된다.

## 다음 세션 권장 시작 순서

1. 이 문서를 읽는다.
2. `risuai.md`를 읽는다.
3. 이번 세션의 목표 Phase를 선언한다.
4. 이번 변경이 “오너 변경”인지 “호환성 파괴”인지 먼저 판별한다.
5. 구현보다 먼저 계측과 영향 범위를 확인한다.

## 부록: 현재 작업의 성공 조건

이 작업이 성공했다고 말하려면 다음이 모두 충족되어야 한다.

- 기존 UI 대부분이 그대로 유지된다.
- Android 앱에서 요청이 브라우저/WebView 라이프사이클에 끊기지 않는다.
- 기존 캐릭터/모듈/플러그인 생태계가 계속 사용 가능하다.
- 사용자는 새 시스템을 배우지 않아도 된다.
- 개발자는 “로직 재작성”이 아니라 “오너 이동”으로 설명할 수 있다.
