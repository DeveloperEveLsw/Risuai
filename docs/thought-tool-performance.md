# 표시 처리 전후 측정과 폐기되는 임시 렌더

## 2026-10-04 캡처 대기 중 폐기될 표시 준비를 지연

사용자가 현재 개발본의 배포를 요청한 후, 원본 화면 소유자가 있으나 canonical capture가 없는 경우만 ParseMarkdown의 불필요한 준비를 즉시 끝내도록 수정했다. 기존 finalize는 이 결과를 이미 거절하므로 이전 DOM과 입력값을 유지한다. 일반·소유자 없는 호출·배경·번역의 기존 fallback, 정상 캡처의 원본 Lua/CBS/정규식·에셋·sanitizer·저장/CAS 정책은 유지한다.

실제 두 브라우저와 서버/IDB에서 settings 조회를 지연했다. peer의 새 설정을 받기 전 캡처가 없는 상태를 재현했고, 이전 코드는 폐기될 HTML을 끝까지 생성했다. 수정본은 빈 준비 결과/finalize 거절과 동일 row/body/input 및 입력값 유지를 확인했다. 지연을 풀면 정상 HTML과 새 설정으로 계산한 효과가 두 기기에 반영된다. 일반 호출의 plain fallback과 오래된 효과 저장 차단도 유지한다. baseline과 guard 한 줄만 제거한 대조는 같은 assertion으로 실패했고 소스는 바이트 단위로 복원했다.

앱533+기존skip3·브라우저회귀21+실제두빌드표시비교1·타입오류0/경고0·native/entity/명시적ordinary3빌드·169감사(원본167+기존정책2) 통과. 실제 메시지11개의 HTML/텍스트/sanitizer가 이전20852d7 빌드와 같다. 서버117파일과 native artifact는20852d7과 동일해 이전 Node24의385 검사를 명시적으로 재사용했다. 대상 서버의 새 검사는 배포 영수증에 별도로 기록한다.

동일 변경 없는 helper로 이전20852d7/수정본의 실제 배포용 UI를 순서대로 비교했다. 한 조건(100행/HTML96셀/추가Lua0), desktop/pageCPU4x 각6개씩 총24관측이며 매번106 labelled/94독립 callback·최종값·row/body DOM 검사를 유지했다. profiler/debugger·HMR·source override는 없다.

| 역할 | 시나리오 | 갱신 중앙값ms | 최대 프레임 간격ms |
| --- | --- | --- | --- |
| baseline | desktop | 620.9 | 100.0 |
| baseline | mobile-emulation-4x | 1554.4 | 200.0 |
| candidate | desktop | 538.2 | 66.6 |
| candidate | mobile-emulation-4x | 1579.2 | 150.1 |

한 조건·한 순서·역할/시나리오별6표본으로 통계적·보편적 속도 개선이나 끊김 해소를 보장하지 않는다. 실제 모바일/worker CPU throttle·모든 캡처 거절 원인/다른 클릭 빈도·전체 읽기계약/확장/가져오기·내보내기/보관/에셋/총저장/사용자시험 및 기존15조건은 남는다. 실제 넥서스gsub 원인은 미확정이다. 별도 문서의 과거192관측·프로파일 결과를 이번24개와 합산하지 않는다.

근거: docs/display-capture-gap-validation.json, 루트evidence/local-capture-gap-20261004.json·baseline/candidate/removal projection·browser/built-fidelity·performance-comparison/각 전체로그. 배포 결과는 current-capture-gap-deployment-20261004 보고서와 새 rollout 영수증에서 확인한다.

## 이전20852d7의 측정·진단 이력

로컬 공개 코드·합성 데이터. 이전75cfec/현재20852d7 빌드로 동일한 원본 helper를16회 실행해192개 클릭을 측정했다. 100행·HTML1/96셀·추가Lua0/600000·desktop/pageCPU4x·각6회·정순/역순. 원본106 labelled/94 독립callback·최종값·row/body DOM 검사를 모두 유지했다. CPU 프로파일러나 추가 디버거 진단은 이192관측에 포함하지 않는다. 기본 helper의 observer/counter는 그대로 사용했다.

큰HTML·추가Lua0·pageCPU4x의 갱신 중앙값은1583.2→1476.7ms,1642.7→1549.0ms. 6개 단위의 관측이며 통계적/일반적 속도 보장은 아니다. 추가Lua가 있으면 현재2042.2/2062.6ms와 최대200/233.3ms 프레임 간격이 남는다. 작은HTML+추가Lua의 역순 중앙값은1443.0→1487.7ms로 오히려 증가했다. 빠른입력 피드백·갱신 완료·프레임 간격은 별도다.

각 표의 역할별 표본6개. p95는 이 작은 표본에서 최댓값과 같으며, 조건/순서/시나리오를 합산하지 않는다. 단위ms.

| 순서 / 조건 / 시나리오               | 갱신 중앙값 이전→현재 | 현재p95 | 최대 프레임 이전→현재 | 현재 최대피드백 | 현재 최장long task |
| ------------------------------------ | --------------------- | ------- | --------------------- | --------------- | ------------------ |
| 1 / small-idle / desktop             | 323.2 → 323.7         | 389.2   | 50.1 → 50.0           | 25.7            | 0.0                |
| 1 / small-idle / mobile-emulation-4x | 992.1 → 893.4         | 959.8   | 133.3 → 116.6         | 34.5            | 108.0              |
| 1 / large-idle / desktop             | 595.4 → 552.5         | 603.9   | 100.0 → 100.0         | 34.3            | 0.0                |
| 1 / large-idle / mobile-emulation-4x | 1583.2 → 1476.7       | 1700.1  | 200.0 → 199.9         | 57.0            | 200.0              |
| 1 / small-cpu / desktop              | 840.4 → 848.2         | 959.4   | 33.3 → 66.7           | 72.9            | 0.0                |
| 1 / small-cpu / mobile-emulation-4x  | 1505.6 → 1475.3       | 1579.2  | 150.0 → 133.3         | 29.0            | 121.0              |
| 1 / large-cpu / desktop              | 1060.7 → 1054.8       | 1172.5  | 100.1 → 100.1         | 22.5            | 51.0               |
| 1 / large-cpu / mobile-emulation-4x  | 2063.8 → 2042.2       | 2123.0  | 216.6 → 200.0         | 48.6            | 204.0              |
| 2 / small-idle / desktop             | 321.3 → 323.0         | 353.7   | 50.0 → 49.9           | 24.2            | 0.0                |
| 2 / small-idle / mobile-emulation-4x | 966.5 → 872.3         | 1107.4  | 116.7 → 133.3         | 35.6            | 119.0              |
| 2 / large-idle / desktop             | 595.6 → 564.2         | 620.2   | 100.1 → 100.1         | 22.5            | 0.0                |
| 2 / large-idle / mobile-emulation-4x | 1642.7 → 1549.0       | 1732.3  | 250.0 → 199.9         | 58.7            | 209.0              |
| 2 / small-cpu / desktop              | 830.3 → 839.7         | 857.5   | 50.0 → 33.4           | 58.0            | 0.0                |
| 2 / small-cpu / mobile-emulation-4x  | 1443.0 → 1487.7       | 1599.5  | 133.3 → 133.4         | 33.8            | 132.0              |
| 2 / large-cpu / desktop              | 1129.7 → 1153.5       | 1188.3  | 100.0 → 100.0         | 21.3            | 52.0               |
| 2 / large-cpu / mobile-emulation-4x  | 2127.6 → 2062.6       | 2118.3  | 233.4 → 233.3         | 49.5            | 210.0              |

현재 빌드의 별도 프로파일은 소유page에서 실제risu-display-lua 워커2개를 확인하고 main2+worker2를 기록했다. 정확bundle SHA/AST line+column로 빠른 태그 처리와 기존 함수를 구분했다. pageCPU4x main의 빠른함수 self표본3.079ms·기존함수40.186ms·wire size inclusive242.333ms·capture encode inclusive232.035ms가 남았다. 표본가중치와 inclusive 범위는 중첩되며, profiler/observer/throttle 비용이 있으므로 정확CPU 비중이나 wall-time 분해로 주장하지 않는다. program/unclassified도 그대로 남겨 뭉뚱그려 다른 작업에 배정하지 않았다. worker의 throttle 적용은 미확인이다.

두 번의 독립된 조건부 debugger 진단에서 desktop의captured fixture 포맷106회, pageCPU4x의captured106회 외에 no-context100회/약1.07M문자 포맷을 확인했다. 후자는 simple 캐릭터c·messageId m-0…99·notrim·별도supplied capture 없음이다. 이 경로는 캡처가 없는 경우에도 ParseMarkdown을 진행한다. ChatBody는 finalize에서context 없는 결과를 화면에 반영하지 않으므로 임시 계산을 폐기한다. 어떤 header guard가 캡처를 거절했는지와 이후모든클릭의 빈도는 직접 측정하지 않았다. 모든 no-context 호출을 제거하거나 일반/번역/플러그인 경로를 바꾸라는 결론은 아니다.

다음 구현 후보는 화면 소유자가 있는 서버형 표시의 캡처가 확보되기 전, 이 폐기될 포맷 작업을 시작하지 않고 이전 DOM을 유지하는 것이다. 실제 projection 지연·peer 변경·재접속·initial/streaming 화면에서 정상 원본Lua/CBS/정규식의 실행/순서·private globals·최종값·CAS·오류 표시를 그대로 검증해야 한다. 아직 코드 변경이나 이 후보의 속도 개선 증거는 없다.

진단의 debugger 조건은 합성 plugin metadata를 추가로 읽고 실행을 늦춘다. 해당 두 실행의 지연은192관측과 합산하지 않는다. 첫 probe 실행의 파일경로 오류/수정 로그도 보존했고 앱·helper·제품 assertion을 완화하지 않았다.

실행코드783개와native/entity artifact가20852d7와 같아 이전 앱533+기존skip3·Node24서버385·브라우저22·타입0/0·3빌드·169감사 결과를 명시적으로 재사용한다. 새 검사로는192관측·4CPU프로파일/워커identity2·조건부진단2가 완료됐다. 실제모바일·cold/동시·single huge HTML/에셋·일반확장/전체읽기계약·import/export/보관/총저장·사용자시험과 기존15조건 모두 미완료. 실제 넥서스gsub 원인도 미확정이다.

이번 운영접속·조회·재배포·원격push·실제모델·개인본문/스크립트/인증값읽기0. 운영20852d7은 직전 완료배포 이력이며 새조회가 아니다. 목표active/at-risk·in-progress 유지.

근거: local-thought-format-performance 비교manifest/summary/16개 전체로그, profile summary/main/worker/identity, selection/selection-args 집계 및 전체로그, reuse-proof. 모든 파일은 루트evidence에 보존한다.
