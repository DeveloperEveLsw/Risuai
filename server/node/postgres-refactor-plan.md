# Node Storage Refactor Plan

## Goal

`/save` 디렉터리의 파일 기반 저장을 중단하고, 개인용 self-hosting 환경에서 Docker 내부 Postgres를 기본 영속 계층으로 사용한다.

## Why This Direction

- 현재 구조는 `database/database.bin` 스냅샷과 asset blob을 파일 시스템에 직접 쓰기 때문에 백업, 마이그레이션, 무결성 관리가 거칠다.
- 프런트엔드가 `database.bin` 스냅샷 저장 모델에 강하게 결합되어 있어서, 한 번에 완전 정규화하면 범위가 과도하게 커진다.
- 따라서 1차 단계에서는 저장 매체를 Postgres로 교체하고, 2차 단계에서 실제 관계형 모델 분해를 진행하는 것이 현실적이다.

## Phase 1

- 노드 서버 저장소를 `fs`/`postgres` 드라이버로 추상화한다.
- `database.bin`, asset, backup, 시스템 메타데이터(password/authcode)를 Postgres에 저장한다.
- 기존 `/save` 볼륨이 있으면 최초 기동 시 DB로 1회 import 한다.
- 프런트엔드의 `NodeStorage` API는 그대로 유지한다.

## Phase 2

- `database.bin` 내부 도메인을 다음 단위로 분리한다.
- `app_settings`
- `characters`
- `character_assets`
- `character_chats`
- `chat_messages`
- `personas`
- `bot_presets`
- `lorebooks`
- `modules`

## Phase 3

- 부팅 시 전체 스냅샷 로드 대신 필요한 aggregate만 조회하도록 저장 계층을 분리한다.
- chat append, asset update, preset update 같은 쓰기를 부분 업데이트로 전환한다.
- `database.bin`은 export/import 및 disaster recovery 용 snapshot으로만 유지한다.

## Current Status

- 완료: Postgres 저장 드라이버 추가
- 완료: 비밀번호/토큰을 포함한 시스템 메타데이터 DB 저장
- 완료: Docker Compose에 Postgres 포함
- 완료: `app_settings`, `characters`, `character_chats`, `chat_messages`, `personas`, `bot_presets`, `lorebooks`, `modules`, `character_assets` 테이블로 정규화 저장
- 완료: 노드 서버가 relational export/import API를 통해 정규화 DB를 직접 읽고 쓸 수 있도록 변경
- 유지: `database.bin`과 `dbbackup-*`는 호환성/복구용 snapshot으로 계속 기록
- 다음 작업: Phase 3 partial update, lazy load, aggregate repository 분리
