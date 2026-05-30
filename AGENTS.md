# AGENTS.md

## 목표

이 저장소는 Codex에서 Claude Code CLI를 호출하는 플러그인을 만든다.

이 플러그인은 `codex-plugin-cc`의 반대 방향을 목표로 한다.

- `codex-plugin-cc`: Claude Code에서 Codex 호출
- 이 플러그인: Codex에서 Claude Code 호출

MVP에서는 다음 기능만 구현한다.

- claude:setup
- claude:plan

기본 흐름이 안정화된 뒤 같은 read-only 원칙으로 claude:review를 추가했다. Claude가 현재 git diff를 검토하고, Codex가 그 결과를 반영한다.

Claude는 계획을 세우고, Codex는 구현한다.

## 역할

### Claude Code CLI

Claude는 다음을 담당한다.

- 구현 계획 수립
- 저장소 구조 이해
- 변경 대상 파악
- 구현 순서 제안
- 검증 방법 제안
- 리스크 정리

Claude는 파일을 직접 수정하면 안 된다.

### Codex

Codex는 다음을 담당한다.

- 저장소 분석
- Claude CLI 호출
- Claude 계획 검증
- 실제 파일 수정
- 테스트 실행
- 최종 결과 요약

Claude의 출력은 참고용 계획이다.
Codex는 반드시 저장소 상태와 비교해 검증한 뒤 구현한다.

## MVP 기능

## claude:setup

`claude:setup`은 Claude Code CLI 사용 가능 여부를 확인한다.

확인할 내용은 다음과 같다.

- `claude` CLI가 설치되어 있는지
- `claude` 명령을 실행할 수 있는지
- 현재 디렉터리가 유효한 프로젝트인지
- 플러그인에 필요한 파일 구조가 존재하는지
- 계획 실행에 필요한 스크립트가 존재하는지

Claude CLI가 없다면 자동 설치하지 않는다.
대신 설치가 필요하다는 메시지를 출력한다.

## claude:plan

`claude:plan`은 Claude에게 Codex의 `/plan`처럼 행동하도록 요청한다.

Claude는 다음만 수행한다.

- 관련 파일과 구조 파악
- 현재 상태 요약
- 구현 계획 작성
- 검증 방법 제안
- 리스크 정리

Claude는 다음을 하면 안 된다.

- 파일 수정
- 코드 구현
- 커밋
- destructive command 실행
- 비밀 정보 출력

기본적으로 `PLAN.md` 파일은 만들지 않는다.
계획은 stdout으로 반환한다.

사용자가 명시적으로 요청한 경우에만 계획 문서를 생성한다.

## 기대하는 Plan 출력 형식

Summary

- 무엇을 변경할지 요약한다.

Current Understanding

- 관련 파일
- 현재 동작
- 제약 사항

Plan

1. 첫 번째 구현 단계
2. 두 번째 구현 단계
3. 세 번째 구현 단계

Validation

- Codex가 실행할 검증 명령
- 기대 결과

Risks

- 주의할 점
- 사이드 이펙트
- 확인해야 할 엣지 케이스

## 저장소 구조

권장 구조는 다음과 같다.

.codex-plugin/plugin.json

plugins/claude/

plugins/claude/scripts/

plugins/claude/prompts/

README.md

AGENTS.md

MVP에서는 복잡한 구조를 피한다.

먼저 Codex가 Claude CLI를 호출하고, Claude가 계획을 반환하는 흐름을 안정화한다.

## 구현 원칙

MVP에서는 Anthropic API를 직접 호출하지 않는다.

로컬에 설치된 `claude` CLI를 사용한다.

스크립트는 가능하면 Node.js로 작성한다.

복잡한 오케스트레이션은 추가하지 않는다.

MCP는 도입하지 않는다.

백그라운드 작업도 도입하지 않는다.

먼저 동기 실행 방식으로 setup과 plan만 안정화한다.

## 보안 규칙

비밀 정보를 노출, 출력, 저장, 커밋하지 않는다.

다음 값은 절대 출력하지 않는다.

- API 키
- 토큰
- 쿠키
- SSH 키
- `.env` 값
- Claude 인증 정보
- Codex 인증 정보

`.env` 파일을 읽을 때는 변수명만 사용하고 값은 사용하지 않는다.

## 테스트

스크립트를 변경한 경우 최소한 다음을 확인한다.

node path/to/script.mjs --help

npm test

npm run lint

테스트가 없다면 최소 smoke test를 추가한다.

## README 요구사항

README에는 다음 내용을 포함한다.

- 이 플러그인이 무엇인지
- `codex-plugin-cc`와 어떤 점이 반대 방향인지
- 설치 방법
- claude:setup 사용법
- claude:plan 사용법
- 제한 사항
- 보안 주의사항

## 최종 원칙

작게 시작한다.

MVP 목표는 다음 흐름이다.

사용자가 Codex에 요청한다.

Codex가 Claude CLI를 호출한다.

Claude가 `/plan`처럼 계획을 반환한다.

Codex가 계획을 검증한다.

Codex가 구현한다.

이 흐름이 안정화된 뒤 read-only review를 추가했다. status, result, cancel, MCP, background job은 아직 추가하지 않는다.
