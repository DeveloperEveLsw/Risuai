# 실패한 모델 응답의 관계 저장과 상태 조회 비용

로컬 schema21 후속이다. 기존15완료 조건을 유지하며 운영 접속·조회·배포·원격푸시·실제 모델 호출을 하지 않았다. 개인 프롬프트·스토리·대화·설치 스크립트·인증값도 읽지 않았다. 이전8ce0bc5/schema20의 원문 보존은 [당시 계약](provider-output-retention.md)에 남긴다.

## 바뀐 저장 경로

schema20에서는 추가 처리 전 응답을 `jobs.progress` JSON에 함께 넣었다. 표준 상태 응답에서 원문을 빼더라도 SQLite가 매번 큰 JSON을 파싱하고, 일반 진행 상태를 저장할 때 기존 원문을 다시 직렬화하는 비용이 있었다.

schema21은 `job_provider_outputs(job_id, request)` 관계에 요청별 DTO를 저장한다. Job 외래 키·안정 요청 번호·JSON 유효성·실제 UTF-8 payload_bytes 검사를 갖춘다. 진행 JSON에는 원문을 넣지 않는다. 상태 조회의 보존 여부는 인덱스로 확인하며 소유권 검사·일반 stage/message checkpoint도 별도 원문을 읽지 않는다. 원문 조회는 실패/취소/중단의 명시적 결과 확인에서만 이루어진다.

native checkpoint는 바뀐 요청의 원문만 전송하고, 일반 진행 상태와 같은 소유자/fence/lease 확인·DB transaction·진행 버전·journal 포인터로 저장한다. 이미 저장한 다른 요청은 읽거나 다시 전송하지 않는다. 저장 중 새 청크가 오면 다음 flush에서 반영한다. 원문만 보존된 작업은 전체 복구가 불가능하며 부분 저장/자동 provider 재요청도 없다. 원본 요청/생성/CBS/정규식/트리거/Lua 알고리즘과 청크/후보 의미는 유지한다.

작업64호출·응답64후보·합계 원문 JSON UTF-8 4MiB, 기존의 원문을 포함한 논리적 checkpoint16MiB 제한을 유지한다. 합계는 행의 byte metadata로 검사한다. 진행 상태와 원문 행 저장이 함께 실패하면 새 원문·진행 버전·journal도 함께 롤백한다. 성공한 canonical 저장에서 원문 행을 같은 transaction으로 지운다. 실패/취소/중단에는 남긴다. 전체 heap/DB/WAL/에셋/누적 Job/백업의 총용량 정책은 여전히 별도 과제다.

## 비교 측정

같은 측정 helper에서 이전 공개8ce0bc5와 현재 코드를 사용했다. 실제 native checkpoint·DB worker IPC·SQLite를 연결하며, 합성 원문0/16KiB/3MiB와 동시 상태 조회2/8건 뒤 다른 대화의 변수 변경을 비교했다. 공개 progress 본문은 작은 고정 문자열이며 원문은 같은 byte 길이를 유지하되 매 저장마다16byte 꼬리를 바꾼다. 각 조건4회 warmup 뒤20표본, 이전→후보와 후보→이전의 두 순서로 실행했다. 아래 값은 실행별 수치이며 두 실행의 percentile을 합친 값이 아니다.

| 3MiB / 조회8건 / ms               | 이전 실행1 / 2  | 후보 실행1 / 2  |
| --------------------------------- | --------------- | --------------- |
| 상태 조회 median                  | 2.527 / 2.450   | 0.241 / 0.231   |
| 뒤따른 다른 대화 변수 변경 median | 21.003 / 20.378 | 4.671 / 4.595   |
| 변수 변경 p95                     | 26.133 / 26.836 | 8.330 / 5.125   |
| 원문+진행 checkpoint median       | 34.456 / 34.354 | 31.113 / 29.660 |

16KiB/조회2건의 checkpoint median은 이전3.684/3.832ms·후보3.748/3.705ms다. 최초 분리안은 진행/원문을 두 transaction으로 저장하여 작은 응답의 비용이 약3.9→7.5ms로 늘었고, 이를 확인한 뒤 한 transaction으로 묶었다. 초기 직접 progress 주입 진단과 중간안은 최종 native 경로 비교와 분리해 기록했다. 초기 baseline 추출에서 필요한 공개 preset/prompt-template 포트가 빠진 실패도 로그에 보존했다.

이 측정은 DB 경계의 불필요한 크기 비례 비용을 확인한 것이다. HTTP/브라우저 입력·long task·실물 모바일·실제 provider/캐릭터의 총 지연 측정은 아니다. 공개 streaming progress 자체나 기존 실패 write-set 결과 JSON이 크면 그 조회/전송 비용은 여전히 존재한다. 이전 모바일모사100행의 약2.28초/208ms 끊김 해소로 주장하지 않는다.

## 이관과 복원

schema20의 유효 원문 DTO를 요청별 행으로 옮기고 public progress에서 제거한다. Job 상태·fence·진행 버전·정식 메시지/변수·unknown metadata·runtime identity·journal cursor를 유지한다. 완료 Job의 원문은 기존 성공 정책대로 제거한다. 이관 전체가 하나의 transaction이므로 잘못된 원문이나 실제 SQLITE_FULL에서는 이전 schema20·JSON·커서로 롤백한다. 오류를 무시하고 원문을 버리지 않는다.

합성 이관은 running/failed/cancelled/interrupted/completed와 재시작을 검사했다. 정확한 공개8ce0bc5 코드로 만든 schema20 DB snapshot을 schema21로 이관한 뒤, 그 옛 코드는21을 SCHEMA_TOO_NEW로 거절하는 것을 확인했다. 원본20 snapshot을 별도 파일에 복원하면 identity/커서/정식 데이터/Job이 정확히 되돌아오고, 후보21 DB도 별도로 보존했다. 코드만 바꾸어 schema21 DB를 이전 코드에 붙이면 안 된다. 이관 이후 새 데이터의 이전 형식 자동 병합/다운그레이드는 제공하지 않는다. 실제 운영 이관/복원은 이번 작업에서 하지 않았다.

## 검증과 남은 범위

관계 예산·미사용 응답 미파싱·일반 checkpoint의 저장 원문 제외·commit 중 새 청크 보존·논리16MiB와 실제 SQLITE_FULL의 원자성·실패 preview/성공 정리를 검사했다. 원본 built UI와 실제 native 실패/취소/탭 종료/다중 기기/서비스 재시작을 현재 서버 코드에 연결해 다시 검사한다. 검사 수치·소스/로그/아티팩트 지문은 [검증 기록](job-output-relation-validation.json)에 둔다.

compiled TS/Svelte와 native/entity 아티팩트는8ce0bc5와 동일하므로 이전 성공한 native/entity/ordinary 빌드를 명시적으로 재사용한다. 서버·앱·브라우저·타입 검사는 새로 실행한다. 새 후보 Node24 검사는 없다. 전체 읽기 의존성·일반확장·보관/import/export/에셋·총저장예산·실물기기/대표 성능·전체 사용자시험과 기존15조건은 계속 active다. 사용자 넥서스 카드의 gsub 원인/수정은 여전히 미확정이며 제공 메시지 내용은 기록하지 않았다.
