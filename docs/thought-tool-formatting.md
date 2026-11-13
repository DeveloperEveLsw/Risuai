# 추론·도구 태그의 표시 비용

원본 `parseThoughtsAndTools`는 태그가 없는 긴 HTML도 문자 단위로 다시 만들고, 닫히지 않은 추론 태그가 많으면 남은 문자열을 반복 탐색한다. 서버형 표시 경로의 primitive string과 비활성 플러그인 조건에서만 literal token을 한 번 매칭하고 문자열 조각을 결합한다. 태그가 없으면 원문을 반환한다.

원본의 중첩·미완성 태그·대소문자·빈 도구 호출·HTML 속성 안의 태그 처리와 언어 getter 순서/횟수를 유지한다. 일반 모드, 활성 플러그인, boxed string은 기존 원본 함수를 사용한다. 원본 Lua/CBS/정규식 실행, CSS·HTML sanitizer, 표시 effects의 CAS, DOM 생명주기와 저장 형식은 변경하지 않는다.

검증: pinned 원본 함수와 1000개 생성 입력을 직접 비교하는 19개 앱 테스트. 실제 baseline/candidate 빌드의 원본 UI에서 11개 합성 메시지의 HTML·텍스트·추론/도구 UI·sanitizer 결과가 정확히 같다. 앱533+기존skip3, 브라우저 회귀21+빌드 비교1, 타입0/0, native/entity/ordinary 빌드, 원본 추출감사169(원본167+기존정책2). 이번 frontend 변경에 대해 서버117개 파일과 native artifact가75cfec와 같아 기존 Node22 서버385개 결과를 명시적으로 재사용한다. 배포 시 대상 Node24에서 별도로 전체 서버 검사를 수행한다.

태그 수에 비례하는 임시 메모리를 사용한다. 전체 플러그인·확장 및 peak heap 보장은 미완료다. 현재 baseline의 계측 프로파일에서 page CPU4x 갱신1626.7ms·프레임간격200ms가 관측됐지만 profiler/observer 비용이 포함된 진단이다. 이번 후보의 비계측 전후 성능 비교는 아직 하지 않았으므로 끊김 해소나 속도 개선 수치를 주장하지 않는다. 물리 모바일·일반 확장·전체 읽기계약·import/export·보관/에셋/총저장·사용자 시험 등 기존15개 완료 조건을 모두 유지한다.

근거: `thought-tool-formatting-validation.json`, 루트 `evidence/local-thought-format-20261004.json`, 관련 전체 로그와 `local-thought-format-built-fidelity-20261004.json`. 앞선75cfec의 원본 트리거 페르소나 수명 검증은 기존 문서에 보존한다.
